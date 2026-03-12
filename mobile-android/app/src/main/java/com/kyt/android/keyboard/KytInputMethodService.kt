package com.kyt.android.keyboard

import android.inputmethodservice.InputMethodService
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.LinearLayout
import android.widget.TextView
import com.kyt.android.data.AuthManager
import com.kyt.android.data.SupabaseClient
import com.kyt.android.memory.MemoryModeManager
import com.kyt.android.memory.classifyIntent
import com.kyt.android.memory.Intent as KytIntent
import com.kyt.android.memory.MemoryItem
import com.kyt.android.memory.buildCompactInjection
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/**
 * K.Y.T. Keyboard IME — InputMethodService with context bar.
 *
 * Target apps: com.openai.chatgpt, com.anthropic.claude,
 *              com.google.android.apps.bard, com.google.android.apps.gemini
 *
 * Non-target apps: plain keyboard behavior, no API calls.
 *
 * Injection flow:
 * 1. User types in target app
 * 2. On 2s typing pause: pre-fetch search_memories (cached injection ready)
 * 3. On send: read text → IntentClassifier → prepend injection → send
 * 4. 3s timeout: send without injection if search exceeds budget
 * 5. After send: save user message to save_chat_turn_batch
 */
class KytInputMethodService : InputMethodService() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var contextBar: TextView? = null
    private var cachedInjection: String? = null
    private var prefetchJob: Job? = null
    private var lastInputTime = 0L

    private val TARGET_PACKAGES = setOf(
        "com.openai.chatgpt",
        "com.anthropic.claude",
        "com.google.android.apps.bard",
        "com.google.android.apps.gemini"
    )

    private fun isTargetApp(): Boolean {
        val packageName = currentInputEditorInfo?.packageName ?: return false
        return packageName in TARGET_PACKAGES
    }

    override fun onCreateInputView(): View {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        // Context bar (shows K.Y.T. status)
        contextBar = TextView(this).apply {
            text = "K.Y.T."
            setPadding(16, 8, 16, 8)
            textSize = 12f
        }
        layout.addView(contextBar)

        // TODO: Add actual keyboard keys (AOSP LatinIME fork or simple grid)
        // For spike: just the context bar + system keyboard delegation

        return layout
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        cachedInjection = null
        updateContextBar()
    }

    override fun onFinishInput() {
        super.onFinishInput()
        prefetchJob?.cancel()
        cachedInjection = null
    }

    /**
     * Called when text selection changes — proxy for typing activity.
     * Triggers pre-fetch on 2s pause.
     */
    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int,
        newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)

        if (!isTargetApp()) return
        if (!MemoryModeManager.shouldInject(this)) return

        lastInputTime = System.currentTimeMillis()

        // Cancel previous pre-fetch, schedule new one after 2s pause
        prefetchJob?.cancel()
        prefetchJob = scope.launch {
            delay(2000)
            prefetchContext()
        }
    }

    /**
     * Pre-fetch memory context based on current input text.
     */
    private suspend fun prefetchContext() {
        val ic = currentInputConnection ?: return
        val text = ic.getExtractedText(
            android.view.inputmethod.ExtractedTextRequest(), 0
        )?.text?.toString() ?: return

        if (text.isBlank()) return

        val classification = classifyIntent(text)
        if (classification.intent == KytIntent.SKIP) {
            cachedInjection = null
            return
        }

        val userId = AuthManager.getUserId(this) ?: return

        val body = JSONObject().apply {
            put("query", text.take(200))
            put("user_id", userId)
            put("top_k", 3)
            put("use_hyde", false)
            put("platform", "all")
        }

        val result = withTimeoutOrNull(3000) {
            SupabaseClient.callEdgeFunction("search_memories", body)
        } ?: return

        if (result.isSuccess) {
            val json = result.getOrThrow()
            val results = json.optJSONArray("results") ?: JSONArray()
            val items = (0 until results.length()).map { i ->
                val r = results.getJSONObject(i)
                MemoryItem(
                    id = r.optString("id"),
                    content = r.optString("content"),
                    platform = r.optString("platform", "unknown"),
                    timestamp = r.optString("created_at", ""),
                    similarity = r.optDouble("similarity", 0.0),
                    role = r.optString("role", null)
                )
            }
            val injection = buildCompactInjection(items, text.take(200))
            cachedInjection = if (injection.itemCount > 0) injection.text else null
            updateContextBar(if (cachedInjection != null) "Context ready (${injection.itemCount} items)" else null)
        }
    }

    /**
     * Handle send action — inject context and save message.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_ENTER && isTargetApp()) {
            val ic = currentInputConnection ?: return super.onKeyDown(keyCode, event)

            // If we have cached injection, prepend it
            if (cachedInjection != null && MemoryModeManager.shouldInject(this)) {
                val currentText = ic.getExtractedText(
                    android.view.inputmethod.ExtractedTextRequest(), 0
                )?.text?.toString() ?: ""

                if (currentText.isNotBlank()) {
                    // Prepend context (compact mobile format)
                    val injectedText = "${cachedInjection}\n\n${currentText}"
                    ic.deleteSurroundingText(currentText.length, 0)
                    ic.commitText(injectedText, 1)
                    cachedInjection = null
                }
            }

            // Save user message (fire-and-forget)
            if (MemoryModeManager.shouldCapture(this)) {
                val text = ic.getExtractedText(
                    android.view.inputmethod.ExtractedTextRequest(), 0
                )?.text?.toString() ?: ""

                if (text.isNotBlank()) {
                    scope.launch {
                        saveUserMessage(text)
                    }
                }
            }
        }

        return super.onKeyDown(keyCode, event)
    }

    private suspend fun saveUserMessage(text: String) {
        val userId = AuthManager.getUserId(this) ?: return
        val packageName = currentInputEditorInfo?.packageName ?: "unknown"

        val body = JSONObject().apply {
            put("user_id", userId)
            put("turns", JSONArray().apply {
                put(JSONObject().apply {
                    put("content", text)
                    put("speakers", JSONArray().apply { put("user") })
                    put("conversation_id", "kb-${packageName}-${System.currentTimeMillis()}")
                    put("platform", "mobile")
                    put("content_type", "conversation")
                })
            })
        }

        SupabaseClient.callEdgeFunction("save_chat_turn_batch", body)
    }

    private fun updateContextBar(message: String? = null) {
        contextBar?.text = message ?: if (isTargetApp()) "K.Y.T. Active" else "K.Y.T."
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}

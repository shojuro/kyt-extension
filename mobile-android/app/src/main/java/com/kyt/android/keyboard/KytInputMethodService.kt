package com.kyt.android.keyboard

import android.inputmethodservice.InputMethodService
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
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
 * K.Y.T. Keyboard IME — InputMethodService with physical keys.
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
 * 4. 18s timeout: send without injection if search exceeds budget
 * 5. After send: save user message to save_chat_turn_batch
 */
class KytInputMethodService : InputMethodService() {

    companion object {
        private const val TAG = "KYT"
    }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var keyboardView: KytKeyboardView? = null
    private var cachedInjection: String? = null
    private var prefetchJob: Job? = null
    private var lastInputTime = 0L

    // Track committed text ourselves — getExtractedText() fails on ChatGPT/Claude
    private val textBuffer = StringBuilder()

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

    // ── Input View ───────────────────────────────────────────

    override fun onCreateInputView(): View {
        val view = KytKeyboardView(this)
        view.keyActionListener = keyActionListener
        keyboardView = view
        return view
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        cachedInjection = null
        // Only clear buffer for a genuinely new input field, not keyboard hide/show
        if (!restarting) {
            textBuffer.clear()
            Log.d(TAG, "onStartInput: new field, buffer cleared")
        } else {
            Log.d(TAG, "onStartInput: restarting, buffer kept (${textBuffer.length} chars)")
        }
        keyboardView?.updateEnterKey(attribute)
        keyboardView?.setEnterGlow(false)
        updateContextBar()
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        keyboardView?.updateEnterKey(info)
    }

    override fun onFinishInput() {
        super.onFinishInput()
        prefetchJob?.cancel()
        cachedInjection = null
        // Do NOT clear textBuffer here — ChatGPT hides/shows keyboard
        // frequently for the same text field. Buffer cleared on send
        // or when a genuinely new field starts (restarting=false).
    }

    // ── Key Action Listener ──────────────────────────────────

    private val keyActionListener = object : KytKeyboardView.KeyActionListener {
        override fun onKeyPress(keyDef: KeyDef) {
            val ic = currentInputConnection ?: return

            when (keyDef.type) {
                KeyType.LETTER -> {
                    val char = if (keyboardView?.shiftState != ShiftState.OFF) {
                        keyDef.label.uppercase()
                    } else {
                        keyDef.label.lowercase()
                    }
                    ic.commitText(char, 1)
                    textBuffer.append(char)
                }

                KeyType.SPACE -> {
                    ic.commitText(" ", 1)
                    textBuffer.append(" ")
                }

                KeyType.PERIOD -> {
                    ic.commitText(keyDef.label, 1)
                    textBuffer.append(keyDef.label)
                }

                KeyType.BACKSPACE -> {
                    ic.deleteSurroundingText(1, 0)
                    if (textBuffer.isNotEmpty()) textBuffer.deleteCharAt(textBuffer.length - 1)
                }

                KeyType.ENTER -> handleSendAction(ic)

                KeyType.GLOBE -> switchToNextInputMethod(false)

                KeyType.SHIFT, KeyType.SYMBOL -> {
                    // Handled internally by KytKeyboardView
                }
            }
        }
    }

    // ── Send Action ──────────────────────────────────────────

    private fun handleSendAction(ic: InputConnection) {
        if (isTargetApp()) {
            val currentText = getCurrentText()
            Log.d(TAG, "handleSendAction: text='${currentText.take(50)}' (${currentText.length} chars)")

            // If we have cached injection, prepend it
            if (cachedInjection != null && MemoryModeManager.shouldInject(this) && currentText.isNotBlank()) {
                val injectedText = "${cachedInjection}\n\n${currentText}"
                // Clear field and rewrite with injection prepended
                ic.deleteSurroundingText(currentText.length, 0)
                ic.commitText(injectedText, 1)
                Log.d(TAG, "handleSendAction: injected context")
                cachedInjection = null
                keyboardView?.setEnterGlow(false)
            }

            // Save user message (fire-and-forget)
            if (MemoryModeManager.shouldCapture(this) && currentText.isNotBlank()) {
                scope.launch { saveUserMessage(currentText) }
            }
        }

        // Clear buffer after send
        textBuffer.clear()

        // Send the enter key event to the app
        val imeAction = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: 0
        if (imeAction != EditorInfo.IME_ACTION_UNSPECIFIED && imeAction != EditorInfo.IME_ACTION_NONE) {
            ic.performEditorAction(imeAction)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }

    // ── Pre-fetch ────────────────────────────────────────────

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int,
        newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)

        if (!isTargetApp()) return
        if (!MemoryModeManager.shouldInject(this)) {
            Log.d(TAG, "onUpdateSelection: inject disabled (mode=${MemoryModeManager.getMode(this)})")
            return
        }

        lastInputTime = System.currentTimeMillis()
        Log.d(TAG, "onUpdateSelection: scheduling prefetch in 2s")

        prefetchJob?.cancel()
        prefetchJob = scope.launch {
            delay(2000)
            prefetchContext()
        }
    }

    /**
     * Get current text from input field. Tries getExtractedText() first,
     * falls back to our tracked textBuffer (needed for ChatGPT/Claude
     * which don't support the ExtractedText protocol).
     */
    private fun getCurrentText(): String {
        val extracted = currentInputConnection?.getExtractedText(
            android.view.inputmethod.ExtractedTextRequest(), 0
        )?.text?.toString()
        return if (!extracted.isNullOrBlank()) extracted else textBuffer.toString()
    }

    private suspend fun prefetchContext() {
        Log.d(TAG, "prefetchContext: start")
        val ic = currentInputConnection
        if (ic == null) { Log.d(TAG, "prefetchContext: no InputConnection"); return }

        val text = getCurrentText()
        if (text.isBlank()) { Log.d(TAG, "prefetchContext: empty text (buffer=${textBuffer.length})"); return }

        // Guard: don't re-search our own injection output
        if (text.startsWith("(Context:") || text.startsWith("[K.Y.T.")) {
            Log.d(TAG, "prefetchContext: skipping — text is our own injection")
            return
        }

        Log.d(TAG, "prefetchContext: text='${text.take(50)}' (${text.length} chars)")

        val classification = classifyIntent(text)
        Log.d(TAG, "prefetchContext: intent=${classification.intent}")
        if (classification.intent == KytIntent.SKIP) {
            cachedInjection = null
            return
        }

        val userId = AuthManager.getUserId(this)
        if (userId == null) { Log.d(TAG, "prefetchContext: no userId (not authenticated)"); return }
        Log.d(TAG, "prefetchContext: userId=$userId")

        val body = JSONObject().apply {
            put("query", text.take(200))
            put("userId", userId)  // camelCase — search_memories destructures { userId }
            put("top_k", 8)
            put("fast", true)
            put("confidenceThreshold", classification.confidenceThreshold ?: 0.40)
            put("excludePlatforms", JSONArray().apply { put("claude-code") })
        }

        Log.d(TAG, "prefetchContext: calling search_memories...")
        updateContextBar("Searching...")
        val result = withTimeoutOrNull(18_000) {
            SupabaseClient.callEdgeFunction("search_memories", body)
        }

        if (result == null) { Log.d(TAG, "prefetchContext: timeout (18s)"); updateContextBar(); return }

        if (result.isFailure) {
            Log.e(TAG, "prefetchContext: edge function failed", result.exceptionOrNull())
            updateContextBar()
            return
        }

        val json = result.getOrThrow()
        val results = json.optJSONArray("results") ?: JSONArray()
        Log.d(TAG, "prefetchContext: got ${results.length()} results")

        val items = (0 until results.length()).map { i ->
            val r = results.getJSONObject(i)
            // Parse entities array if present (server enrichment)
            val entitiesArr = r.optJSONArray("entities")
            val entityNames = if (entitiesArr != null) {
                (0 until entitiesArr.length()).mapNotNull { j ->
                    val e = entitiesArr.optJSONObject(j)
                    e?.optString("canonical_name")?.takeIf { it.isNotBlank() }
                }
            } else null

            MemoryItem(
                id = r.optString("id"),
                content = r.optString("content"),
                platform = r.optString("platform", "unknown"),
                timestamp = r.optString("created_at", ""),
                similarity = r.optDouble("rerank_score", r.optDouble("similarity", r.optDouble("gravity_score", 0.0))),
                role = r.optString("role", null),
                entities = entityNames
            )
        }
        val injection = buildCompactInjection(items, text.take(200))
        cachedInjection = if (injection.itemCount > 0) injection.text else null
        Log.d(TAG, "prefetchContext: injection=${if (cachedInjection != null) "${injection.itemCount} items" else "none"}")
        val statusMsg = if (cachedInjection != null) {
            "Context ready (${injection.itemCount} items)"
        } else null
        updateContextBar(statusMsg)
        keyboardView?.setEnterGlow(cachedInjection != null)
    }

    // ── Save ─────────────────────────────────────────────────

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

    // ── Context bar ──────────────────────────────────────────

    private fun updateContextBar(message: String? = null) {
        val text = message ?: if (isTargetApp()) "K.Y.T. Active" else "K.Y.T."
        val mode = MemoryModeManager.getMode(this)
        val dotColor = when (mode) {
            MemoryModeManager.Mode.FULL -> KeyboardTheme.ACCENT
            MemoryModeManager.Mode.CLEAN_ROOM -> 0xFFFFBF00.toInt()  // Amber
            MemoryModeManager.Mode.INCOGNITO -> 0xFF808080.toInt()   // Gray
        }
        keyboardView?.updateContextBar(text, dotColor)
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}

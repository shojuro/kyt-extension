package com.kyt.android.keyboard

import android.inputmethodservice.InputMethodService
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import com.kyt.android.BuildConfig
import com.kyt.android.data.AuthManager
import com.kyt.android.data.SupabaseClient
import com.kyt.android.memory.ClassificationResult
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
 * 2. On send: capture text → IntentClassifier → clear field → search in background
 * 3. When search returns: inject (Context: ...) + original text → fire send
 * 4. If search fails/times out: send original text without context
 * 5. After send: save user message to save_chat_turn_batch (fire-and-forget)
 */
class KytInputMethodService : InputMethodService() {

    companion object {
        private const val TAG = "KYT"
        private const val PREFS_PENDING = "kyt_pending_send"
        private const val KEY_PENDING_TEXT = "pending_text"
        private const val KEY_PENDING_PACKAGE = "pending_package"
    }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var keyboardView: KytKeyboardView? = null

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
        if (!restarting) {
            textBuffer.clear()
            if (BuildConfig.DEBUG) Log.d(TAG, "onStartInput: new field, buffer cleared")
            recoverPendingSend()
        }
        keyboardView?.updateEnterKey(attribute)
        updateContextBar()
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        keyboardView?.updateEnterKey(info)
    }

    override fun onFinishInput() {
        super.onFinishInput()
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
        val capturedText = getCurrentText()
        val capturedPackage = currentInputEditorInfo?.packageName ?: ""
        val capturedImeAction = currentInputEditorInfo?.imeOptions
            ?.and(EditorInfo.IME_MASK_ACTION) ?: 0

        if (capturedText.isBlank()) {
            fireEnterAction(ic, capturedImeAction)
            return
        }

        if (!isTargetApp()) {
            textBuffer.clear()
            fireEnterAction(ic, capturedImeAction)
            return
        }

        if (BuildConfig.DEBUG) {
            Log.d(TAG, "handleSendAction: text (${capturedText.length} chars), pkg=$capturedPackage")
        }

        // Recursion guard
        if (capturedText.startsWith("(Context:")) {
            textBuffer.clear()
            fireEnterAction(ic, capturedImeAction)
            return
        }

        // Save user message (fire-and-forget, original text before injection)
        if (MemoryModeManager.shouldCapture(this)) {
            scope.launch { saveUserMessage(capturedText) }
        }

        // Clear input field immediately — looks "sent" to user
        ic.deleteSurroundingText(capturedText.length, 0)
        textBuffer.clear()

        // Gate: skip search for non-injection modes
        if (!MemoryModeManager.shouldInject(this)) {
            commitTextAndSend(ic, capturedText, capturedImeAction)
            return
        }

        // Intent classification (~0.06ms)
        val classification = classifyIntent(capturedText)
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "handleSendAction: intent=${classification.intent}")
        }

        if (classification.intent == KytIntent.SKIP) {
            commitTextAndSend(ic, capturedText, capturedImeAction)
            return
        }

        val userId = AuthManager.getUserId(this)
        if (userId == null) {
            commitTextAndSend(ic, capturedText, capturedImeAction)
            return
        }

        // Persist for crash recovery
        savePendingSend(capturedText, capturedPackage)

        // Launch async search-then-inject
        scope.launch {
            val injection = searchAndBuildInjection(capturedText, userId, classification)

            // Get fresh InputConnection
            val freshIc = currentInputConnection
            if (freshIc == null) {
                if (BuildConfig.DEBUG) Log.w(TAG, "handleSendAction: InputConnection gone after search")
                clearPendingSend()
                return@launch
            }

            // Verify same app
            val currentPkg = currentInputEditorInfo?.packageName ?: ""
            if (currentPkg != capturedPackage) {
                if (BuildConfig.DEBUG) {
                    Log.w(TAG, "handleSendAction: app changed ($capturedPackage → $currentPkg), sending without context")
                }
                commitTextAndSend(freshIc, capturedText, capturedImeAction)
                clearPendingSend()
                return@launch
            }

            // Guard: user typed during search
            val currentFieldText = getCurrentText()
            if (currentFieldText.isNotBlank()) {
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, "handleSendAction: user typed during search, sending original")
                }
                commitTextAndSend(freshIc, capturedText, capturedImeAction)
                clearPendingSend()
                return@launch
            }

            val finalText = if (injection != null) {
                "$injection\n\n$capturedText"
            } else {
                capturedText
            }

            commitTextAndSend(freshIc, finalText, capturedImeAction)
            clearPendingSend()

            if (BuildConfig.DEBUG) {
                Log.d(TAG, "handleSendAction: sent ${if (injection != null) "with context" else "without context"}")
            }
        }
    }

    private fun commitTextAndSend(ic: InputConnection, text: String, imeAction: Int) {
        ic.commitText(text, 1)
        fireEnterAction(ic, imeAction)
    }

    private fun fireEnterAction(ic: InputConnection, imeAction: Int) {
        if (imeAction != EditorInfo.IME_ACTION_UNSPECIFIED && imeAction != EditorInfo.IME_ACTION_NONE) {
            ic.performEditorAction(imeAction)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }

    // ── Search & Injection ────────────────────────────────────

    private suspend fun searchAndBuildInjection(
        text: String,
        userId: String,
        classification: ClassificationResult
    ): String? {
        val body = JSONObject().apply {
            put("query", text.take(200))
            put("userId", userId)
            put("top_k", 8)
            put("fast", true)
            put("confidenceThreshold", classification.confidenceThreshold ?: 0.40)
            put("excludePlatforms", JSONArray().apply { put("claude-code") })
        }

        val result = withTimeoutOrNull(18_000) {
            SupabaseClient.callEdgeFunction("search_memories", body)
        }

        if (result == null || result.isFailure) {
            if (BuildConfig.DEBUG) {
                val reason = if (result == null) "timeout" else result.exceptionOrNull()?.message
                Log.w(TAG, "searchAndBuildInjection: failed ($reason)")
            }
            return null
        }

        val json = result.getOrThrow()
        val results = json.optJSONArray("results") ?: JSONArray()

        if (results.length() == 0) return null

        val items = (0 until results.length()).map { i ->
            val r = results.getJSONObject(i)
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
                similarity = r.optDouble("rerank_score",
                    r.optDouble("similarity",
                        r.optDouble("gravity_score", 0.0))),
                role = r.optString("role", null),
                entities = entityNames
            )
        }

        val injection = buildCompactInjection(items, text.take(200))
        return if (injection.itemCount > 0) injection.text else null
    }

    // ── Pending Send (crash recovery) ─────────────────────────

    private fun savePendingSend(text: String, packageName: String) {
        getSharedPreferences(PREFS_PENDING, MODE_PRIVATE).edit()
            .putString(KEY_PENDING_TEXT, text)
            .putString(KEY_PENDING_PACKAGE, packageName)
            .apply()
    }

    private fun clearPendingSend() {
        getSharedPreferences(PREFS_PENDING, MODE_PRIVATE).edit().clear().apply()
    }

    private fun recoverPendingSend() {
        val prefs = getSharedPreferences(PREFS_PENDING, MODE_PRIVATE)
        val pendingText = prefs.getString(KEY_PENDING_TEXT, null) ?: return
        val pendingPackage = prefs.getString(KEY_PENDING_PACKAGE, null) ?: ""
        val currentPkg = currentInputEditorInfo?.packageName ?: ""
        if (currentPkg == pendingPackage && pendingText.isNotBlank()) {
            val ic = currentInputConnection
            if (ic != null) {
                if (BuildConfig.DEBUG) Log.d(TAG, "recoverPendingSend: delivering orphaned message")
                ic.commitText(pendingText, 1)
                val imeAction = currentInputEditorInfo?.imeOptions
                    ?.and(EditorInfo.IME_MASK_ACTION) ?: 0
                fireEnterAction(ic, imeAction)
            }
        }
        clearPendingSend()
    }

    // ── Text Extraction ───────────────────────────────────────

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

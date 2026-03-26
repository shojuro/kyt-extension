package com.kyt.android.keyboard

import android.inputmethodservice.InputMethodService
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import com.kyt.android.data.AuthManager
import com.kyt.android.data.SupabaseClient
import com.kyt.android.BuildConfig
import com.kyt.android.memory.MemoryModeManager
import com.kyt.android.memory.classifyIntent
import com.kyt.android.memory.Intent as KytIntent
import com.kyt.android.memory.MemoryItem
import com.kyt.android.memory.buildNaturalLanguageInjection
import com.kyt.android.memory.buildVisibleInjection
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
 * Pre-inject flow (works with ANY send button):
 * 1. User types in target app
 * 2. On 2s typing pause: search_memories in background
 * 3. Results arrive: inject context directly into text field
 * 4. User taps app's send button OR keyboard Enter → everything sends
 * 5. Field clears → save user message to save_chat_turn_batch
 */
class KytInputMethodService : InputMethodService() {

    companion object {
        private const val TAG = "KYT"
    }

    // Injection state machine: NONE → SEARCHING → INJECTED → NONE
    private enum class InjectionState { NONE, SEARCHING, INJECTED }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var keyboardView: KytKeyboardView? = null
    private var injectionState = InjectionState.NONE
    private var injectedContextLength = 0
    private var searchStartPackage: String? = null
    private var lastInjectionTime = 0L
    private var prefetchJob: Job? = null

    // Query cache — reuse results when user expands a similar query
    private var lastSearchQuery: String? = null
    private var lastSearchInjection: String? = null
    private var lastSearchTime = 0L

    // Track committed text ourselves — getExtractedText() fails on ChatGPT/Claude
    private val textBuffer = StringBuilder()

    private val TARGET_PACKAGES = setOf(
        "com.openai.chatgpt",
        "com.anthropic.claude",
        "com.google.android.apps.bard",
        "com.google.android.apps.gemini",
        "com.google.android.apps.agentspace",          // Gemini Enterprise
        "com.google.android.googlequicksearchbox"       // Gemini via Google app (Samsung/integrated)
    )

    private fun isTargetApp(): Boolean {
        val packageName = currentInputEditorInfo?.packageName ?: return false
        if (packageName in TARGET_PACKAGES) return true
        // Catch Gemini variants (Enterprise, regional, etc.)
        return packageName.contains("gemini") || packageName.contains("bard")
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
        Log.d(TAG, "onStartInput: pkg=${attribute?.packageName} isTarget=${isTargetApp()} restarting=$restarting")
        // Only clear buffer for a genuinely new input field, not keyboard hide/show
        if (!restarting) {
            textBuffer.clear()
            injectionState = InjectionState.NONE
            injectedContextLength = 0
            searchStartPackage = null
            lastSearchQuery = null
            lastSearchInjection = null
        } else {
            // Keyboard restarting on same field — check if field was cleared
            // while keyboard was hidden (user tapped app's send button).
            // Without this, injectionState stays INJECTED forever and blocks
            // new searches because onUpdateSelection never saw the field-clear.
            val currentText = getCurrentText()
            if (currentText.isBlank() || (!currentText.startsWith("(KYT:") && !currentText.startsWith("(For context:") && injectionState == InjectionState.INJECTED)) {
                if (BuildConfig.DEBUG) Log.d(TAG, "onStartInput: restarting but field changed/cleared, resetting state")
                textBuffer.clear()
                if (currentText.isNotBlank()) textBuffer.append(currentText)
                injectionState = InjectionState.NONE
                injectedContextLength = 0
                lastSearchQuery = null
                lastSearchInjection = null
            } else {
                if (BuildConfig.DEBUG) Log.d(TAG, "onStartInput: restarting, buffer kept (${textBuffer.length} chars)")
            }
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
        prefetchJob?.cancel()
        // Do NOT clear textBuffer or injectionState here — ChatGPT hides/shows
        // keyboard frequently for the same text field. State cleared on field-clear
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

    // ── Send Action (keyboard Enter key) ─────────────────────

    private fun handleSendAction(ic: InputConnection) {
        val fullText = getCurrentText()

        if (isTargetApp() && fullText.isNotBlank()) {
            // Extract user's original text (strip pre-injected context)
            val userText = if (injectionState == InjectionState.INJECTED && (fullText.startsWith("(KYT:") || fullText.startsWith("(For context:"))) {
                // Strip injected context: find the closing paren + double newline
                val end = fullText.indexOf(")\n\n")
                if (end >= 0) fullText.substring(end + 3) else fullText
            } else {
                fullText
            }

            if (BuildConfig.DEBUG) {
                Log.d(TAG, "handleSendAction: user='${userText.take(50)}' injected=${injectionState == InjectionState.INJECTED}")
            }

            // Save user message (fire-and-forget, original text only)
            if (MemoryModeManager.shouldCapture(this) && userText.isNotBlank()) {
                scope.launch { saveUserMessage(userText) }
            }
        }

        // Reset state
        textBuffer.clear()
        injectionState = InjectionState.NONE
        injectedContextLength = 0
        prefetchJob?.cancel()

        // Fire the enter action
        fireEnterAction(ic)
    }

    private fun fireEnterAction(ic: InputConnection) {
        val imeAction = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: 0
        if (imeAction != EditorInfo.IME_ACTION_UNSPECIFIED && imeAction != EditorInfo.IME_ACTION_NONE) {
            ic.performEditorAction(imeAction)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }

    // ── Pre-inject into text field ────────────────────────────

    private fun injectContextIntoField(contextText: String) {
        val ic = currentInputConnection ?: return
        val userText = getCurrentText()
        if (userText.isBlank()) return

        // Safety: verify still in same app
        val currentPkg = currentInputEditorInfo?.packageName ?: ""
        if (currentPkg != searchStartPackage) {
            if (BuildConfig.DEBUG) Log.w(TAG, "injectContext: app changed ($searchStartPackage → $currentPkg), discarding")
            injectionState = InjectionState.NONE
            return
        }

        // Safety: don't inject if user typed new content during search
        // (textBuffer diverged from what we searched)
        if (userText.startsWith("(KYT:")) {
            if (BuildConfig.DEBUG) Log.d(TAG, "injectContext: already injected, skipping")
            return
        }

        ic.beginBatchEdit()
        try {
            val fieldLength = userText.length
            ic.setSelection(fieldLength, fieldLength)
            ic.deleteSurroundingText(fieldLength, 0)

            val combined = "$contextText\n\n$userText"
            ic.commitText(combined, 1)  // cursor at end

            injectedContextLength = contextText.length + 2  // +2 for \n\n
            injectionState = InjectionState.INJECTED
            lastInjectionTime = System.currentTimeMillis()

            textBuffer.clear()
            textBuffer.append(combined)
        } finally {
            ic.endBatchEdit()
        }

        if (BuildConfig.DEBUG) Log.d(TAG, "injectContext: injected ${contextText.length} chars")
        updateContextBar("Context injected")
    }

    // ── Selection Monitoring + Prefetch Trigger ─────────────

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int,
        newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)

        if (!isTargetApp()) return

        // Detect field-clear: app sent the message (user tapped app's send button)
        if (newSelStart == 0 && newSelEnd == 0 && textBuffer.isNotEmpty()) {
            if (injectionState == InjectionState.INJECTED) {
                // Extract and save user text (strip injected context)
                val userText = if (injectedContextLength < textBuffer.length) {
                    textBuffer.substring(injectedContextLength)
                } else {
                    textBuffer.toString()
                }
                if (MemoryModeManager.shouldCapture(this) && userText.isNotBlank()) {
                    scope.launch { saveUserMessage(userText) }
                }
                if (BuildConfig.DEBUG) Log.d(TAG, "onUpdateSelection: field cleared after injection, saved user text")
            }
            textBuffer.clear()
            injectionState = InjectionState.NONE
            injectedContextLength = 0
            lastSearchQuery = null
            lastSearchInjection = null
            prefetchJob?.cancel()
            updateContextBar()
            return
        }

        // Double-injection guard
        if (injectionState == InjectionState.INJECTED) {
            val currentText = getCurrentText()
            if (!currentText.startsWith("(KYT:") && !currentText.startsWith("(For context:")) {
                // User deleted the context line — allow re-prefetch after cooldown
                if (BuildConfig.DEBUG) Log.d(TAG, "onUpdateSelection: user deleted context, resetting")
                injectionState = InjectionState.NONE
                injectedContextLength = 0
                // Fall through to schedule prefetch
            } else {
                return  // Injected and intact — don't re-prefetch
            }
        }

        if (injectionState == InjectionState.SEARCHING) return  // Already searching

        if (!MemoryModeManager.shouldInject(this)) return

        // Anti-loop: don't re-prefetch within 5s of last injection
        if (System.currentTimeMillis() - lastInjectionTime < 5000) return

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

    /**
     * Check if current query is similar enough to reuse cached results.
     * Uses word overlap (Jaccard-like) with 30s TTL.
     */
    private fun canReuseLastSearch(currentText: String): Boolean {
        val last = lastSearchQuery ?: return false
        if (System.currentTimeMillis() - lastSearchTime > 30_000) return false
        val currentWords = currentText.lowercase().split(Regex("\\s+")).filter { it.length > 2 }.toSet()
        val lastWords = last.lowercase().split(Regex("\\s+")).filter { it.length > 2 }.toSet()
        if (currentWords.isEmpty() || lastWords.isEmpty()) return false
        val overlap = currentWords.intersect(lastWords).size.toDouble() / maxOf(currentWords.size, lastWords.size)
        return overlap > 0.6
    }

    private suspend fun prefetchContext() {
        if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: start")
        val ic = currentInputConnection
        if (ic == null) { if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: no IC"); return }

        val text = getCurrentText()
        if (text.isBlank()) { if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: empty"); return }

        // Guard: don't re-search our own injection output
        if (text.startsWith("(KYT:") || text.startsWith("(For context:") || text.startsWith("[K.Y.T.")) {
            if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: skipping own injection")
            return
        }

        searchStartPackage = currentInputEditorInfo?.packageName
        injectionState = InjectionState.SEARCHING

        val classification = classifyIntent(text)
        if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: intent=${classification.intent}")
        if (classification.intent == KytIntent.SKIP) {
            injectionState = InjectionState.NONE
            return
        }

        // Cache hit: reuse last result if query is similar (saves full round-trip)
        if (canReuseLastSearch(text)) {
            val cached = lastSearchInjection
            if (cached != null) {
                if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: cache hit, reusing last result")
                withContext(Dispatchers.Main) { injectContextIntoField(cached) }
                return
            }
        }

        val userId = AuthManager.getUserId(this)
        if (userId == null) { injectionState = InjectionState.NONE; return }

        updateContextBar("Searching...")

        val isTestMode = AuthManager.isTestMode(this)
        val result = if (isTestMode) {
            // Test mode: use search_memories edge function (full vector pipeline).
            // Old: search_test_user RPC (text search, returned wrong/anemic results).
            if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: TEST MODE — using search_memories pipeline")
            val body = JSONObject().apply {
                put("query", text.take(200))
                put("userId", "b0000002-0000-4000-a000-000000000002")
                put("topK", 5)
                put("fast", true)
            }
            withTimeoutOrNull(18_000) {
                SupabaseClient.callEdgeFunction("search_memories", body)
            }
        } else {
            val body = JSONObject().apply {
                put("query", text.take(200))
                put("userId", userId)
                put("top_k", 8)
                put("fast", true)
                put("confidenceThreshold", classification.confidenceThreshold ?: 0.40)
                put("excludePlatforms", JSONArray().apply { put("claude-code") })
            }
            withTimeoutOrNull(18_000) {
                SupabaseClient.callEdgeFunction("search_memories", body)
            }
        }

        if (result == null || result.isFailure) {
            if (BuildConfig.DEBUG) {
                val reason = if (result == null) "timeout" else result.exceptionOrNull()?.message
                Log.w(TAG, "prefetchContext: failed ($reason)")
            }
            injectionState = InjectionState.NONE
            updateContextBar()
            return
        }

        val json = result.getOrThrow()
        val results = json.optJSONArray("results") ?: JSONArray()
        if (BuildConfig.DEBUG) Log.d(TAG, "prefetchContext: ${results.length()} results")

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
                similarity = r.optDouble("rerank_score", r.optDouble("similarity", r.optDouble("gravity_score", 0.0))),
                role = r.optString("role", null),
                entities = entityNames
            )
        }

        val injection = buildNaturalLanguageInjection(items, text.take(200))

        if (injection.itemCount > 0) {
            // Update cache
            lastSearchQuery = text
            lastSearchInjection = injection.text
            lastSearchTime = System.currentTimeMillis()

            // Inject directly into the text field (must be on Main thread)
            withContext(Dispatchers.Main) {
                injectContextIntoField(injection.text)
            }
        } else {
            injectionState = InjectionState.NONE
            updateContextBar()
        }
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

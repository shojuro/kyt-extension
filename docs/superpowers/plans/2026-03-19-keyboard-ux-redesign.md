# Keyboard UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prefetch-then-send keyboard flow with send-then-search (hidden latency), compact parenthetical injection format, security hardening, symbol layout fix, and keyboard height increase.

**Architecture:** On Enter tap, capture text + metadata into locals, clear field immediately, search in background, inject `(Context: ...)` + original text, fire actual send. Chat apps block further input during generation — no cancellation logic needed. Security: persist pending send to SharedPreferences, sanitize entity names, verify target package before async send, gate debug logs behind BuildConfig.DEBUG.

**Tech Stack:** Kotlin, Android InputMethodService, OkHttp, Supabase Edge Functions, JUnit 4

**Spec:** `docs/superpowers/specs/2026-03-19-keyboard-ux-redesign-design.md`
**Security Assessment:** Incorporated — see Tasks 1, 3, 5 for mitigations.

**Worktree:** `/home/penguinzyue/kyt-wt-keyboard` (branch: `feature/keyboard`)

---

### Task 1: Rewrite InjectionBuilder — `(Context: ...)` format + entity sanitization

**Files:**
- Modify: `mobile-android/app/src/main/java/com/kyt/android/memory/InjectionBuilder.kt`
- Modify: `mobile-android/app/src/test/java/com/kyt/android/memory/InjectionBuilderTest.kt`

- [ ] **Step 1: Update MemoryItem to include entities**

In `InjectionBuilder.kt`, add `entities` field:

```kotlin
data class MemoryItem(
    val id: String,
    val content: String,
    val platform: String,
    val timestamp: String,
    val similarity: Double,
    val role: String? = null,
    val entities: List<String>? = null  // canonical names from server enrichment
)
```

- [ ] **Step 2: Add entity name sanitizer**

In `InjectionBuilder.kt`, add above `buildCompactInjection`:

```kotlin
// ── Entity Name Sanitization ─────────────────────────────────
// Security: entity canonical_names come from user content via entity extractor.
// Strip characters that could be used for prompt injection in the (Context: ...) line.
private val ENTITY_UNSAFE_CHARS = Regex("[()\\[\\]<>{}|;\"'`\\\\\\n\\r]")

private fun sanitizeEntityName(name: String): String {
    return ENTITY_UNSAFE_CHARS.replace(name, "").trim().take(50)
}
```

- [ ] **Step 3: Write failing tests for new format**

Replace the `buildCompactInjection uses diversity filter` test and add new tests in `InjectionBuilderTest.kt`:

```kotlin
// ── buildCompactInjection — (Context: ...) format ────────────

@Test
fun `compact injection uses parenthetical format`() {
    val items = listOf(
        MemoryItem("1", "Walter Payton was a legendary NFL running back", "chatgpt", "", 0.85),
    )
    val result = buildCompactInjection(items, "tell me about Walter Payton")
    assertTrue(result.text.startsWith("(Context:"))
    assertTrue(result.text.contains(")"))
    assertFalse(result.text.contains("[K.Y.T."))
}

@Test
fun `compact injection uses entity names when available`() {
    val items = listOf(
        MemoryItem("1", "Walter Payton was a legendary NFL running back", "chatgpt", "", 0.85,
            entities = listOf("Walter Payton", "NFL")),
    )
    val result = buildCompactInjection(items, "tell me about Walter Payton")
    assertTrue(result.text.contains("Walter Payton"))
}

@Test
fun `compact injection falls back to content snippet without entities`() {
    val items = listOf(
        MemoryItem("1", "The tiniest chicken breeds include Serama and Malaysian", "gemini", "", 0.80),
    )
    val result = buildCompactInjection(items, "tiniest chickens")
    assertTrue(result.text.contains("tiniest") || result.text.contains("chicken") || result.text.contains("Serama"))
}

@Test
fun `compact injection returns empty for no items`() {
    val result = buildCompactInjection(emptyList(), "anything")
    assertEquals("", result.text)
    assertEquals(0, result.itemCount)
}

@Test
fun `compact injection truncates at 150 chars`() {
    val items = listOf(
        MemoryItem("1", "A very long discussion about many different topics that goes on and on with lots of detail", "chatgpt", "", 0.90,
            entities = listOf("Topic A", "Topic B")),
        MemoryItem("2", "Another very long discussion about completely different subjects with extensive coverage", "gemini", "", 0.85,
            entities = listOf("Topic C", "Topic D", "Topic E", "Topic F")),
    )
    val result = buildCompactInjection(items, "query")
    val contextLine = result.text.lines().first()
    assertTrue("Context line too long: ${contextLine.length}", contextLine.length <= 160)
}

@Test
fun `entity names are sanitized against injection`() {
    val items = listOf(
        MemoryItem("1", "Some content", "chatgpt", "", 0.90,
            entities = listOf("normal", "ignore); DROP TABLE", "<script>alert('xss')")),
    )
    val result = buildCompactInjection(items, "query")
    assertFalse(result.text.contains(");"))
    assertFalse(result.text.contains("<script>"))
}

@Test
fun `entity names with newlines are sanitized`() {
    val items = listOf(
        MemoryItem("1", "Some content", "chatgpt", "", 0.90,
            entities = listOf("normal entity", "line1\nline2\rline3")),
    )
    val result = buildCompactInjection(items, "query")
    assertFalse(result.text.contains("\n") && result.text.indexOf("\n") < result.text.indexOf(")"))
}

@Test
fun `multiple platforms noted in context`() {
    val items = listOf(
        MemoryItem("1", "Discussed topic A extensively", "chatgpt", "", 0.90,
            entities = listOf("Topic A")),
        MemoryItem("2", "Also discussed topic B here", "gemini", "", 0.85,
            entities = listOf("Topic B")),
    )
    val result = buildCompactInjection(items, "query")
    // When items span platforms, both should be attributed
    assertTrue(result.text.contains("chatgpt") || result.text.contains("gemini"))
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd /home/penguinzyue/kyt-wt-keyboard && ./gradlew test --tests "com.kyt.android.memory.InjectionBuilderTest" 2>&1 | tail -20`

Expected: Multiple FAILs — `buildCompactInjection` still produces `[K.Y.T. Context...]` format.

- [ ] **Step 5: Rewrite buildCompactInjection**

Replace the `buildCompactInjection` function in `InjectionBuilder.kt`:

```kotlin
// ── Stop words for content snippet extraction ────────────────
private val SNIPPET_STOP_WORDS = setOf(
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "like",
    "through", "after", "over", "between", "out", "up", "down", "and",
    "but", "or", "not", "no", "so", "if", "that", "this", "it", "its",
    "i", "my", "me", "we", "our", "you", "your", "he", "she", "they",
    "them", "his", "her", "their", "just", "also", "very", "really",
    "some", "any", "all", "each", "every", "user", "assistant"
)

/**
 * Extract a concise snippet from content by keeping meaningful words.
 */
private fun extractSnippet(content: String, maxWords: Int = 8): String {
    return content
        .replace(Regex("[\"'\\n\\r]+"), " ")
        .split(Regex("\\s+"))
        .filter { it.length > 2 && it.lowercase() !in SNIPPET_STOP_WORDS }
        .take(maxWords)
        .joinToString(" ")
}

/**
 * Build a compact injection block for keyboard use.
 *
 * Format: (Context: summary of items)\n\n
 * No K.Y.T. branding — looks like the AI platform's own memory feature.
 */
fun buildCompactInjection(
    items: List<MemoryItem>,
    query: String,
    maxItems: Int = 2
): InjectionResult {
    if (items.isEmpty()) {
        return InjectionResult("", 0, 0.0)
    }

    val sorted = selectDiverseItems(items.sortedByDescending { it.similarity }, maxItems)
    val confidence = calculateConfidence(sorted)

    // Build summary for each item: prefer entity names, fall back to content snippet
    val platforms = sorted.map { it.platform }.distinct()
    val showPlatform = platforms.size > 1  // only attribute when cross-platform

    val summaries = sorted.map { item ->
        val entityNames = item.entities
            ?.map { sanitizeEntityName(it) }
            ?.filter { it.isNotBlank() }

        val core = if (!entityNames.isNullOrEmpty()) {
            entityNames.take(3).joinToString(", ")
        } else {
            extractSnippet(item.content)
        }

        if (showPlatform) "$core (${item.platform})" else core
    }

    // Join and enforce 150-char limit
    var summary = summaries.joinToString("; ")
    if (summary.length > 150) {
        // Truncate at last semicolon before 150
        val truncIdx = summary.lastIndexOf(';', 147)
        summary = if (truncIdx > 0) {
            summary.substring(0, truncIdx) + "..."
        } else {
            summary.take(147) + "..."
        }
    }

    val contextLine = "(Context: $summary)"

    return InjectionResult(contextLine, sorted.size, confidence)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/penguinzyue/kyt-wt-keyboard && ./gradlew test --tests "com.kyt.android.memory.InjectionBuilderTest" 2>&1 | tail -20`

Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git add mobile-android/app/src/main/java/com/kyt/android/memory/InjectionBuilder.kt \
        mobile-android/app/src/test/java/com/kyt/android/memory/InjectionBuilderTest.kt
git commit -m "feat(keyboard): rewrite injection to (Context: ...) format with entity sanitization"
```

---

### Task 2: Send-then-search flow in KytInputMethodService

**Files:**
- Modify: `mobile-android/app/src/main/java/com/kyt/android/keyboard/KytInputMethodService.kt`

- [ ] **Step 1: Add BuildConfig import and remove old prefetch infrastructure**

Add to imports block:
```kotlin
import com.kyt.android.BuildConfig
```

Remove these fields from `KytInputMethodService`:
- `private var cachedInjection: String? = null` (line 43)
- `private var prefetchJob: Job? = null` (line 44)
- `private var lastInputTime = 0L` (line 45)

Remove the entire `onUpdateSelection` override (lines 181-202).

Remove the entire `prefetchContext()` method (lines 216-288).

Remove from `onStartInput`: `cachedInjection = null` (line 73) and `keyboardView?.setEnterGlow(false)` (line 82).

Remove from `onFinishInput`: `prefetchJob?.cancel()` (line 93) and `cachedInjection = null` (line 94).

Update class KDoc (lines 20-34) to reflect new flow.

- [ ] **Step 2: Add pending send persistence for crash recovery**

Add constants and helper methods:

```kotlin
companion object {
    private const val TAG = "KYT"
    private const val PREFS_PENDING = "kyt_pending_send"
    private const val KEY_PENDING_TEXT = "pending_text"
    private const val KEY_PENDING_PACKAGE = "pending_package"
}

private fun savePendingSend(text: String, packageName: String) {
    getSharedPreferences(PREFS_PENDING, MODE_PRIVATE).edit()
        .putString(KEY_PENDING_TEXT, text)
        .putString(KEY_PENDING_PACKAGE, packageName)
        .apply()
}

private fun clearPendingSend() {
    getSharedPreferences(PREFS_PENDING, MODE_PRIVATE).edit().clear().apply()
}

/**
 * Recover a pending send that was interrupted by a crash.
 * Called from onStartInput — if we find orphaned text, send it without context.
 */
private fun recoverPendingSend() {
    val prefs = getSharedPreferences(PREFS_PENDING, MODE_PRIVATE)
    val pendingText = prefs.getString(KEY_PENDING_TEXT, null) ?: return
    val pendingPackage = prefs.getString(KEY_PENDING_PACKAGE, null) ?: ""

    // Only recover if we're in the same app that originated the send
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
```

- [ ] **Step 3: Rewrite handleSendAction with send-then-search**

Replace the entire `handleSendAction` method:

```kotlin
private fun handleSendAction(ic: InputConnection) {
    val capturedText = getCurrentText()
    val capturedPackage = currentInputEditorInfo?.packageName ?: ""
    val capturedImeAction = currentInputEditorInfo?.imeOptions
        ?.and(EditorInfo.IME_MASK_ACTION) ?: 0

    if (capturedText.isBlank()) {
        // Empty text — just fire enter (newline in non-send fields)
        fireEnterAction(ic, capturedImeAction)
        return
    }

    if (!isTargetApp()) {
        // Non-target app — plain keyboard, no search
        textBuffer.clear()
        fireEnterAction(ic, capturedImeAction)
        return
    }

    if (BuildConfig.DEBUG) {
        Log.d(TAG, "handleSendAction: text (${capturedText.length} chars), pkg=$capturedPackage")
    }

    // Recursion guard: don't search our own injection output
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

    // Persist pending send for crash recovery (security: message loss prevention)
    savePendingSend(capturedText, capturedPackage)

    // Launch async search-then-inject
    scope.launch {
        val injection = searchAndBuildInjection(
            capturedText, userId, classification
        )

        // Get fresh InputConnection — the original `ic` may be stale after async search
        val freshIc = currentInputConnection
        if (freshIc == null) {
            if (BuildConfig.DEBUG) Log.w(TAG, "handleSendAction: InputConnection gone after search")
            clearPendingSend()
            return@launch
        }

        // Verify we're still in the same app (user might have switched during search)
        val currentPkg = currentInputEditorInfo?.packageName ?: ""
        if (currentPkg != capturedPackage) {
            if (BuildConfig.DEBUG) {
                Log.w(TAG, "handleSendAction: app changed ($capturedPackage → $currentPkg), sending without context")
            }
            commitTextAndSend(freshIc, capturedText, capturedImeAction)
            clearPendingSend()
            return@launch
        }

        // Guard: if user typed new content during search, skip injection
        val currentFieldText = getCurrentText()
        if (currentFieldText.isNotBlank()) {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "handleSendAction: user typed during search, sending original")
            }
            // Don't overwrite their new text — just send original via enter
            commitTextAndSend(freshIc, capturedText, capturedImeAction)
            clearPendingSend()
            return@launch
        }

        // Inject context + send
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
```

- [ ] **Step 4: Add searchAndBuildInjection helper**

```kotlin
private suspend fun searchAndBuildInjection(
    text: String,
    userId: String,
    classification: com.kyt.android.memory.ClassificationResult
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
```

- [ ] **Step 5: Clean up onStartInput and onFinishInput**

`onStartInput` — remove `cachedInjection = null` and `keyboardView?.setEnterGlow(false)`. Keep `updateContextBar()`:

```kotlin
override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
    super.onStartInput(attribute, restarting)
    if (!restarting) {
        textBuffer.clear()
        if (BuildConfig.DEBUG) Log.d(TAG, "onStartInput: new field, buffer cleared")
        // Recover any pending send interrupted by crash
        recoverPendingSend()
    }
    keyboardView?.updateEnterKey(attribute)
    updateContextBar()
}
```

`onFinishInput` — remove `prefetchJob?.cancel()` and `cachedInjection = null`:

```kotlin
override fun onFinishInput() {
    super.onFinishInput()
}
```

- [ ] **Step 6: Commit**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git add mobile-android/app/src/main/java/com/kyt/android/keyboard/KytInputMethodService.kt
git commit -m "feat(keyboard): send-then-search flow with crash recovery + security guards"
```

---

### Task 3: Remove enter glow from KytKeyboardView

**Files:**
- Modify: `mobile-android/app/src/main/java/com/kyt/android/keyboard/KytKeyboardView.kt`

- [ ] **Step 1: Remove enterGlow field and setEnterGlow method**

Remove field (line 46):
```kotlin
private var enterGlow: Boolean = false
```

Remove method (lines 631-636):
```kotlin
fun setEnterGlow(glow: Boolean) { ... }
```

- [ ] **Step 2: Simplify drawEnterKey**

Replace `drawEnterKey` (lines 328-348):

```kotlin
private fun drawEnterKey(
    canvas: Canvas, keyRect: KeyRect,
    cx: Float, cy: Float, density: Float, radius: Float
) {
    funcTextPaint.textSize = KeyboardTheme.FUNC_TEXT_SP * resources.displayMetrics.scaledDensity
    canvas.drawText(
        enterLabel, cx,
        cy - (funcTextPaint.descent() + funcTextPaint.ascent()) / 2f,
        funcTextPaint
    )
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git add mobile-android/app/src/main/java/com/kyt/android/keyboard/KytKeyboardView.kt
git commit -m "refactor(keyboard): remove enter glow — no longer needed with send-then-search"
```

---

### Task 4: Symbol layout — move `<` `>` to SYMBOLS row 1

**Files:**
- Modify: `mobile-android/app/src/main/java/com/kyt/android/keyboard/KeyboardLayout.kt`

- [ ] **Step 1: Update SYMBOLS_ROWS row 1**

Replace line 95 (`KeyDef("&", '&'.code),`) with `KeyDef("<", '<'.code),`
Replace line 97 (`KeyDef("+", '+'.code),`) with `KeyDef(">", '>'.code),`

New SYMBOLS row 1:
```kotlin
// Row 1: @ # $ % < - > ( )
listOf(
    KeyDef("@", '@'.code),
    KeyDef("#", '#'.code),
    KeyDef("$", '$'.code),
    KeyDef("%", '%'.code),
    KeyDef("<", '<'.code),
    KeyDef("-", '-'.code),
    KeyDef(">", '>'.code),
    KeyDef("(", '('.code),
    KeyDef(")", ')'.code)
),
```

- [ ] **Step 2: Update SYMBOLS_2_ROWS row 2**

Replace `KeyDef("<", '<'.code),` (line 160) with `KeyDef("&", '&'.code),`
Replace `KeyDef(">", '>'.code),` (line 161) with `KeyDef("+", '+'.code),`

New SYMBOLS_2 row 2:
```kotlin
// Row 2: [?123] _ \\ & + [ ] * [Backspace]
listOf(
    KeyDef("?123", KeyCodes.SYMBOL, 1.44f, KeyType.SYMBOL),
    KeyDef("_", '_'.code),
    KeyDef("\\", '\\'.code),
    KeyDef("&", '&'.code),
    KeyDef("+", '+'.code),
    KeyDef("[", '['.code),
    KeyDef("]", ']'.code),
    KeyDef("*", '*'.code),
    KeyDef("⌫", KeyCodes.BACKSPACE, 1.44f, KeyType.BACKSPACE)
),
```

- [ ] **Step 3: Update SYMBOLS switcher label**

Replace line 104 (`KeyDef("=\\<", KeyCodes.SYMBOL_2, ...`) with:
```kotlin
KeyDef("#+=", KeyCodes.SYMBOL_2, 1.44f, KeyType.SYMBOL),
```

- [ ] **Step 4: Commit**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git add mobile-android/app/src/main/java/com/kyt/android/keyboard/KeyboardLayout.kt
git commit -m "fix(keyboard): move < > to SYMBOLS row 1, update switcher label to #+=
```

---

### Task 5: Keyboard height — 48dp → 52dp

**Files:**
- Modify: `mobile-android/app/src/main/java/com/kyt/android/keyboard/KeyboardTheme.kt`

- [ ] **Step 1: Update KEY_HEIGHT_DP**

Change line 28:
```kotlin
const val KEY_HEIGHT_DP    = 52f
```

- [ ] **Step 2: Commit**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git add mobile-android/app/src/main/java/com/kyt/android/keyboard/KeyboardTheme.kt
git commit -m "fix(keyboard): increase row height 48dp → 52dp to match standard Android keyboards"
```

---

### Task 6: Final integration — push and manual verification

- [ ] **Step 1: Run all unit tests**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
./gradlew test 2>&1 | tail -30
```

Expected: All tests PASS.

- [ ] **Step 2: Push branch**

```bash
cd /home/penguinzyue/kyt-wt-keyboard
git push origin feature/keyboard
```

- [ ] **Step 3: Manual test checklist (on device)**

After pull + build on device:

1. Open ChatGPT → type "Tell me about Ladyhawke" → tap Send
   - [ ] Input clears immediately
   - [ ] Message appears in chat with `(Context: ...)` line after 3-8s
   - [ ] AI response incorporates the context
2. Type "continue" → tap Send
   - [ ] Sends immediately (SKIP intent, no delay)
3. Toggle airplane mode → type question → tap Send
   - [ ] Sends without context after timeout (no crash)
4. Open SYMBOLS (tap ?123)
   - [ ] `<` and `>` visible on row 1
   - [ ] `#+=` label on switcher key
5. Keyboard height
   - [ ] Visibly taller than before, comfortable key targets
6. Type a password with `<` and `>` in a login field
   - [ ] Characters type correctly

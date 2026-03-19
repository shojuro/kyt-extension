# K.Y.T. Keyboard UX Redesign — Design Spec

**Date:** 2026-03-19
**Status:** Approved
**Branch:** feature/keyboard

## Problem Statement

The K.Y.T. Android keyboard has four UX issues:

1. **Visible latency** — "Searching..." and "Context ready" indicators broadcast the 3-5s search time, making the keyboard feel slow and impeding conversation flow.
2. **Injection text too verbose** — The multi-line `[K.Y.T. Context...]` block consumes excessive mobile screen space and reveals the mechanism to the user.
3. **Missing special characters** — `<` and `>` are buried on SYMBOLS_2 (two taps deep), making passwords with these characters impossible to type without finding the hidden layer.
4. **Keyboard too short** — Row height of 48dp is ~1 row shorter than standard Android keyboards, making typing uncomfortable.

Design principle: **"We remain unseen, but totally felt."**

---

## Feature 1: Send-Then-Search Flow

### Current Flow (Remove)
```
Type → 2s pause → prefetch fires → "Searching..." → "Context ready" → tap Enter → inject + send
```

### New Flow
```
Type → tap Enter → input clears instantly → search runs silently → inject + send → AI responds
```

### Detailed Sequence

1. **User taps Enter** on K.Y.T. keyboard. Immediately capture into local variables:
   - `val capturedText = getCurrentText()` — the user's message
   - `val capturedImeAction = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: 0` — the send action for this field
   - These are captured synchronously because `currentInputEditorInfo` and the input field may change during the async search.
2. Clear the input field and `textBuffer` immediately (looks "sent" to the user).
3. **Save user message** (fire-and-forget): `scope.launch { saveUserMessage(capturedText) }`. This captures the original text, not the injected version.
4. **Intent classification** runs synchronously (~1ms). If `SKIP`, send `capturedText` immediately via `performEditorAction(capturedImeAction)` with no search.
5. If memory mode is `CLEAN_ROOM` or `INCOGNITO`, skip search entirely — send `capturedText` immediately. (CLEAN_ROOM captures but does not inject; INCOGNITO does neither.)
6. For `QUERY` or `PASSIVE` intents in `FULL` mode: launch a coroutine that calls `search_memories` with `fast: true`.
7. **During search (3-5s):** The user sees an empty input field — normal post-send appearance. They're looking at the chat area waiting for a response.
8. **When search returns:** Before writing to the input field, check `getCurrentText().isBlank()`. If the user has typed new content during the search window, skip injection and send `capturedText` without context (don't destroy their new typing). Otherwise, write the injected message (context + `capturedText`) to the input field, then immediately fire `performEditorAction(capturedImeAction)` or `KEYCODE_ENTER`.
9. **Chat app receives the message**, displays it as a user bubble, and starts generating. The Send button becomes a Stop button — the app itself blocks further sends.
10. **If search fails or times out:** OkHttp `readTimeout` is 15s. The coroutine wrapper uses `withTimeoutOrNull(18_000)` (slightly above OkHttp to let it throw its own exception cleanly). On timeout or error: write `capturedText` to the input field and fire the send action. Graceful degradation.

### What Gets Removed

- `prefetchJob` and the `onUpdateSelection` → `delay(2000)` → `prefetchContext()` flow (entire `prefetchContext()` method)
- `cachedInjection` field
- "Searching..." and "Context ready" context bar updates
- `setEnterGlow()` method and `enterGlow` field in `KytKeyboardView.kt`, including glow drawing code in `drawEnterKey()`
- The `updateContextBar(statusMsg)` calls from prefetch

### What the Context Bar Shows

- Target app active: `"K.Y.T. Active"` with green dot (FULL mode)
- Clean room: `"K.Y.T. Active"` with amber dot
- Incognito: `"K.Y.T."` with gray dot
- Non-target app: `"K.Y.T."`
- No status changes during search — stays static

### Cancellation Logic

**None needed.** After the actual send fires (step 8), the chat app replaces the Send button with a Stop button. The user cannot send another message until the AI finishes or they tap Stop. The chat app handles this for us.

The only vulnerable window is the 3-5s between "input clears" (step 2) and "actual send" (step 8). During this time the input field is technically editable. **Guard:** step 8 checks `getCurrentText().isBlank()` before writing — if the user typed something new, we skip injection and send the original text without context rather than destroying their new input.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| User taps Enter with empty text | No search, no send. Same as current. |
| User taps Enter in non-target app | No search, send immediately. Same as current. |
| Memory mode = INCOGNITO | No search, no capture, send immediately. |
| Memory mode = CLEAN_ROOM | No search (skipped entirely — saves bandwidth). Capture message. Send immediately. |
| Search returns 0 results | Send original text without context. |
| Search times out (18s coroutine / 15s OkHttp) | Send original text without context. |
| Network error | Send original text without context. Log error. |
| Text starts with `(Context:` | Recursion guard — skip search, send immediately. |
| User not authenticated | No search (no userId), send immediately. |
| User types during search window | Guard detects non-blank input, skips injection, sends original text. |

---

## Feature 2: Invisible-Style Injection Format

### Current Format (Remove)
```
[K.Y.T. Context — from your stored conversations]
1. [gemini] You said: "Walter Payton was a legendary..."
2. [claude] AI said: "Your favorite movie is..."
[End K.Y.T. Context]
```

### New Format
```
(Context: user previously discussed Ladyhawke on Gemini; favorite movie is Sound of Music)

What is the significance of Ladyhawke the movie to me?
```

### Design Rules

1. **No K.Y.T. branding** — no `[K.Y.T.]`, no `Ⓚ`, no product name. Looks like the AI platform's own memory feature.
2. **Parenthetical style** — `(Context: ...)` reads as a natural annotation, not injected protocol.
3. **One line** — all context on a single line, max ~150 characters. Truncate if needed.
4. **Content snippets, not verbatim quotes** — use truncated content with stop-word stripping, not full quotes. e.g., `"discussed Ladyhawke"` not `"You said: 'Ladyhawke is a movie...'"`. The summary is heuristic (no LLM call): extract first ~30 meaningful words from each item's content, strip common stop words, truncate.
5. **Entity enrichment when available** — `search_memories` returns an `entities` array on each result (from `enrichWithEntities`). When present, use `canonical_name` values instead of content snippets for a cleaner summary. e.g., entities `["Ladyhawke", "Sound of Music"]` → `"discussed Ladyhawke; favorite movie Sound of Music"`.
6. **Platform attribution optional** — include source platform only when items span multiple platforms.
7. **When no context found → nothing prepended.** The message goes through as-is. No absence to notice.
8. **Sanitization** — the `(Context: ...)` line contains generated summaries, not raw user content. Prompt injection sanitization (`sanitizeForInjection`) applies to content snippets only, not the wrapper.

### Implementation

Modify `buildCompactInjection()` in `InjectionBuilder.kt`:
- Input: `items: List<MemoryItem>`, `query: String`
- Apply mini-MMR diversity filter (existing `selectDiverseItems()`)
- For each selected item: prefer entity names if available, else extract first ~30 meaningful words from content
- Join summaries with `; `, prefix with `(Context: `, suffix with `)`
- If total > 150 chars, truncate at last `; ` boundary before 150 and append `...)`
- Output format: `(Context: {summary})\n\n{original_text}`
- Return `InjectionResult` with `text = ""` and `itemCount = 0` when no items pass confidence threshold

### MemoryItem Extension

Add optional `entities` field to `MemoryItem`:
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

Parse from `search_memories` response in `KytInputMethodService.kt` when the server includes the `entities` array.

### Examples

| Query | Context Found | Injected Message |
|-------|--------------|-----------------|
| "Tell me about Ladyhawke" | Ladyhawke discussed on Gemini, favorite movie Sound of Music | `(Context: discussed Ladyhawke on Gemini; favorite movie is Sound of Music)\n\nTell me about Ladyhawke` |
| "What's the tiniest chicken?" | Tiniest insect discussion on Gemini | `(Context: discussed tiniest insects on Gemini)\n\nWhat's the tiniest chicken?` |
| "Continue the story" | Intent = SKIP | No search, sent as-is |
| "What's 2+2?" | No relevant context | Sent as-is (nothing prepended) |

---

## Feature 3: Special Character Layout Fix

### Change

Move `<` and `>` from SYMBOLS_2 row 2 to SYMBOLS row 1. Replace `&` and `+` which move to SYMBOLS_2.

### Before (SYMBOLS row 1)
```
@ # $ % & - + ( )
```

### After (SYMBOLS row 1)
```
@ # $ % < - > ( )
```

### Before (SYMBOLS_2 row 2)
```
_ \ < > [ ] *
```

### After (SYMBOLS_2 row 2)
```
_ \ & + [ ] *
```

### SYMBOLS_2 Switcher Label

Update the SYMBOLS layer switcher key label from `=\<` to `#+=` (standard Android convention). The old label referenced `<` which is now on SYMBOLS row 1.

### File Changed

`KeyboardLayout.kt` — `SYMBOLS_ROWS`, `SYMBOLS_2_ROWS` arrays, and switcher key label.

---

## Feature 4: Keyboard Height

### Change

Increase key row height from 48dp to 52dp to match standard Android keyboard sizing (Gboard uses ~52dp rows).

### Impact

- Total keyboard height: ~229dp → ~245dp (+16dp)
  - Calculation: 4 rows × height + 3 gaps × 3dp + 28dp context bar
- Context bar remains 28dp
- Touch targets improve (48dp → 52dp visual, 52dp → 56dp touch with 4dp expansion)

### File Changed

`KeyboardTheme.kt` — `KEY_HEIGHT_DP = 52` (was 48).

---

## Files Modified

| File | Changes |
|------|---------|
| `KytInputMethodService.kt` | Replace prefetch flow with send-then-search. Remove `cachedInjection`, `prefetchJob`, `prefetchContext()`. New `handleSendWithSearch()` coroutine. Capture text + imeAction into locals at send time. Save user message at step 3 (original text). |
| `InjectionBuilder.kt` | Rewrite `buildCompactInjection()` to produce `(Context: ...)` format. Add `entities` field to `MemoryItem`. Heuristic summarization from entities or content snippets. |
| `KeyboardLayout.kt` | Swap `&`/`+` with `<`/`>` between SYMBOLS and SYMBOLS_2. Update switcher label `=\<` → `#+=`. |
| `KeyboardTheme.kt` | `KEY_HEIGHT_DP = 52` |
| `KytKeyboardView.kt` | Remove `setEnterGlow()` method, `enterGlow` field, and glow drawing code in `drawEnterKey()`. |

## Files NOT Modified

| File | Reason |
|------|--------|
| `SupabaseClient.kt` | No changes — same `callEdgeFunction` API |
| `IntentClassifier.kt` | No changes — same classification, used at send time now |
| `MemoryModeManager.kt` | No changes — same mode checks |
| `AuthManager.kt` | No changes |
| Server-side edge functions | No changes — same `search_memories` API |

---

## Testing

### Unit Tests
- `InjectionBuilderTest.kt`: Update existing tests for new `(Context: ...)` format. Test: empty results → empty string. Test: max length truncation at `; ` boundary. Test: entity-based summary vs content-based fallback.
- `SendFlowTest.kt` (new or extend existing): Test send-then-search state machine:
  - SKIP intent → immediate send, no search
  - QUERY intent → search → inject → send
  - Search timeout → send without context
  - Empty text → no action
  - User typed during search → skip injection, send original
  - CLEAN_ROOM mode → no search, send immediately
  - INCOGNITO mode → no search, no capture, send immediately

### Manual Testing
1. Type in ChatGPT → tap Send → verify message appears with parenthetical context in ~5-8s
2. Type "continue" → tap Send → verify immediate send (SKIP intent, no search)
3. Airplane mode → tap Send → verify sends without context after timeout
4. Open SYMBOLS → verify `<` and `>` are on row 1
5. Verify `#+=` switcher label on SYMBOLS layer
6. Visual check: keyboard height matches Gboard roughly

---

## Out of Scope

- Truly invisible injection via VPN/proxy (blocked by Android certificate pinning — requires platform partnerships)
- Custom chat UI / K.Y.T. chat app
- Accessibility Service integration
- Comma key addition (can be a follow-up)
- Retiring `com.google.android.apps.bard` target package (can be a follow-up)

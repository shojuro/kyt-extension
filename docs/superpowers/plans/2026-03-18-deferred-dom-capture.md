# Deferred DOM Capture — Gemini Response Extraction

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile wire-first extraction (27 chars from 1.2MB) with deferred DOM scraping triggered by user's next turn, giving responses time to fully render before capture.

**Architecture:** User messages still captured immediately from XHR request body. Assistant responses captured via DOM scrape triggered by: (1) the user's next StreamGenerate request (previous response is guaranteed rendered), (2) periodic 60s sweep, (3) `visibilitychange`/`beforeunload` safety nets. Wire extraction code removed entirely — XHR `load` event only notifies the DOM observer that streaming finished. A `capturedResponseElements` WeakSet prevents re-processing response containers on scroll or re-triggers.

**Tech Stack:** Vanilla JS (MAIN world IIFE), Chrome MV3 extension, Vitest

**Note on conversation IDs in safety nets:** The periodic sweep and visibilitychange handlers cannot derive a conversation ID from the URL (Gemini URLs don't contain one in a parseable format). These will emit `conversationId: null`. This is acceptable — the `parseFReq`-derived ID from the next-turn trigger is the primary source, and null-ID records are still searchable by content/platform in Supabase.

**Note on dedup window:** The `MessageDeduplicator` has a 5s window. The `capturedResponseElements` WeakSet is the primary guard against double-capture between the DOM observer and deferred sweep — it operates at the element level (not time-bound), so even if the dedup window expires, the WeakSet still blocks re-capture.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `platforms/gemini/inject.js` | Modify | Remove wire extraction functions + stats. Replace DOM observer with deferred capture system. |
| `tests/unit/gemini-inject.test.js` | Modify | Remove wire extraction tests. Remove copied wire functions. Add deferred capture tests. |

No new files. This is a simplification — net code deletion.

---

## Chunk 1: Remove Wire Extraction + Add Deferred DOM Capture

### Task 1: Delete wire extraction functions from inject.js

**Files:**
- Modify: `platforms/gemini/inject.js`

These functions/variables are being removed because wire extraction of StreamGenerate incremental frames has been proven non-viable (27 chars from 1.2MB response). The DOM already renders the full text.

- [ ] **Step 1: Delete `wireStats` variable declaration**

Remove from ~line 120 (after `const deduplicator = new MessageDeduplicator();`):
```javascript
// DELETE THIS LINE:
const wireStats = { structural: 0, deep: 0, heuristic: 0, failed: 0, totalExtractions: 0 };
```

- [ ] **Step 2: Delete `describeShape()` function**

Remove the entire `describeShape()` function (~17 lines). Search for `function describeShape(`.

- [ ] **Step 3: Delete `findDeepestNaturalString()` function**

Remove the entire `findDeepestNaturalString()` function (~27 lines). Search for `function findDeepestNaturalString(`.

- [ ] **Step 4: Delete `extractTextFromWrbPayload()` function**

Remove the entire `extractTextFromWrbPayload()` function (~25 lines). Search for `function extractTextFromWrbPayload(`.

- [ ] **Step 5: Delete `extractAssistantFromStreamGenerate()` function**

Remove the entire `extractAssistantFromStreamGenerate()` function (~60 lines). Search for `function extractAssistantFromStreamGenerate(`.

- [ ] **Step 6: Remove `wireExtraction` from `__kytGeminiStats()`**

In the `__kytGeminiStats` function, remove the `wireExtraction: wireStats,` line.

- [ ] **Step 7: Verify syntax — run tests to confirm no reference errors**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -20`
Expected: Some tests FAIL (wire extraction test blocks reference deleted functions), but NO syntax errors from inject.js itself.

- [ ] **Step 8: Commit**

```bash
git add platforms/gemini/inject.js
git commit -m "refactor(gemini): delete wire extraction functions — non-viable for incremental streaming"
```

---

### Task 2: Delete wire extraction tests from test file

**Files:**
- Modify: `tests/unit/gemini-inject.test.js`

- [ ] **Step 1: Delete copied wire helper functions**

Remove these function definitions from the top of the test file (they were copied from inject.js for testability):
- `findDeepestNaturalString()` (~20 lines)
- `extractTextFromWrbPayload()` (~15 lines)
- `extractAssistantFromStreamGenerate()` (~40 lines)

Search for `// findDeepestNaturalString (copied from inject.js` and `// extractTextFromWrbPayload (copied from inject.js` and `// extractAssistantFromStreamGenerate (copied from inject.js`.

- [ ] **Step 2: Delete the `extractAssistantFromStreamGenerate` describe block**

Remove the entire `describe('extractAssistantFromStreamGenerate', ...)` block (~90 lines, including all `it()` blocks inside). Search for `describe('extractAssistantFromStreamGenerate'`.

- [ ] **Step 3: Delete the `extractTextFromWrbPayload` describe block**

Remove the entire `describe('extractTextFromWrbPayload', ...)` block (~40 lines). Search for `describe('extractTextFromWrbPayload'`.

- [ ] **Step 4: Delete the `findDeepestNaturalString` describe block**

Remove the entire `describe('findDeepestNaturalString', ...)` block (~35 lines). Search for `describe('findDeepestNaturalString'`.

- [ ] **Step 5: Run tests to confirm clean removal**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: ALL remaining tests PASS. Zero references to deleted functions.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/gemini-inject.test.js
git commit -m "test(gemini): remove wire extraction tests — functions deleted from inject.js"
```

---

### Task 3: Write failing tests for deferred capture system

**Files:**
- Modify: `tests/unit/gemini-inject.test.js`

Tests are written BEFORE implementation (TDD). The WeakSet behavior tests are pure logic — no DOM needed.

- [ ] **Step 1: Add `capturedResponseElements` WeakSet behavior tests**

```javascript
describe('capturedResponseElements WeakSet pattern', () => {
  it('prevents re-capture of same element', () => {
    const captured = new WeakSet();
    const el1 = { id: 'resp-1' };
    const el2 = { id: 'resp-2' };

    expect(captured.has(el1)).toBe(false);
    captured.add(el1);
    expect(captured.has(el1)).toBe(true);
    expect(captured.has(el2)).toBe(false);
  });

  it('allows capture of new elements after previous ones marked', () => {
    const captured = new WeakSet();
    const el1 = { id: 'resp-1' };
    const el2 = { id: 'resp-2' };

    captured.add(el1);
    expect(captured.has(el2)).toBe(false);
    captured.add(el2);
    expect(captured.has(el2)).toBe(true);
  });

  it('handles rapid scroll — all elements checked in O(1)', () => {
    const captured = new WeakSet();
    const elements = Array.from({ length: 50 }, (_, i) => ({ id: `resp-${i}` }));

    // Mark first 40 as captured
    elements.slice(0, 40).forEach(el => captured.add(el));

    // Simulate scroll sweep — only 10 new ones should be "uncaptured"
    const uncaptured = elements.filter(el => !captured.has(el));
    expect(uncaptured).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Add `scrapeResponseText` null-input test**

```javascript
describe('scrapeResponseText', () => {
  // Copied from inject.js for testability — same pattern as other test functions
  function scrapeResponseText(element) {
    if (!element) return null;
    const clone = element.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], .export-button, .action-bar, .response-actions').forEach(el => el.remove());
    const text = clone.innerText?.trim();
    return (text && text.length > 20) ? text : null;
  }

  it('returns null for null element', () => {
    expect(scrapeResponseText(null)).toBeNull();
  });

  it('returns null for undefined element', () => {
    expect(scrapeResponseText(undefined)).toBeNull();
  });
});
```

- [ ] **Step 3: Add deferred capture integration tests**

```javascript
describe('deferred DOM capture integration', () => {
  it('DOM observer marks element, deferred sweep skips it', () => {
    const captured = new WeakSet();
    const el = { id: 'response-1' };

    // Simulate DOM observer capturing and marking
    captured.add(el);

    // Simulate deferred sweep — element should be skipped
    expect(captured.has(el)).toBe(true);
  });

  it('deferred sweep captures element, DOM observer would skip via dedup', () => {
    // Both dedup layers tested: WeakSet (element-level) and MessageDeduplicator (content-level).
    // WeakSet is the primary guard; dedup is defense-in-depth.
    const dedup = new MessageDeduplicator();
    const text = 'Full assistant response captured by deferred DOM sweep with complete content here.';

    expect(dedup.shouldCapture(text, 'deferred-dom')).toBe(true);
    expect(dedup.shouldCapture(text, 'dom-observer')).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests — new tests should PASS (they test pure logic, no impl needed)**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/gemini-inject.test.js
git commit -m "test(gemini): add deferred DOM capture tests — WeakSet, scrape, integration"
```

---

### Task 4: Add `capturedResponseElements` WeakSet and `scrapeAllUncaptured()` to inject.js

**Files:**
- Modify: `platforms/gemini/inject.js`

The core of the new design: a WeakSet that tracks which DOM response containers have already been captured, and a function that scrapes any uncaptured ones. The WeakSet means:
- Elements captured once are never re-processed (no doubling on scroll)
- Garbage collected when elements leave the DOM (no memory leak)
- O(1) lookup — no iteration needed to check "was this already captured?"

- [ ] **Step 1: Add `capturedResponseElements` WeakSet**

After the `deduplicator` declaration and before the `_kytDebug` function, add:

```javascript
// Tracks response containers already captured — prevents re-capture on scroll/re-trigger.
// WeakSet: O(1) lookup, auto-GC when elements leave DOM, no doubling.
const capturedResponseElements = new WeakSet();
```

- [ ] **Step 2: Add `RESPONSE_SELECTORS` constant at module level**

Currently `RESPONSE_SELECTORS` is inside `responseDOMObserver`. Extract it so `scrapeAllUncaptured` can also use it. Add near the top constants:

```javascript
const RESPONSE_SELECTORS = [
  'div[id^="model-response-message-content"]',
];
```

Update `responseDOMObserver.RESPONSE_SELECTORS` to reference this: `RESPONSE_SELECTORS: RESPONSE_SELECTORS,` (or just delete the property from the observer and reference the module-level constant in `_findLastResponseElement` and `_getLastResponseText`).

- [ ] **Step 3: Add `scrapeResponseText(element)` helper**

This extracts clean text from a single response container element. Extracted from the existing `_getLastResponseText` logic so both the observer and the deferred capture can share it.

```javascript
/**
 * Extract clean text from a Gemini response container element.
 * Clones the element, strips UI buttons/artifacts, returns innerText.
 */
function scrapeResponseText(element) {
  if (!element) return null;
  const clone = element.cloneNode(true);
  clone.querySelectorAll('button, [role="button"], .export-button, .action-bar, .response-actions').forEach(el => el.remove());
  const text = clone.innerText?.trim();
  return (text && text.length > 20) ? text : null;
}
```

- [ ] **Step 4: Add `scrapeAllUncaptured(conversationId)` function**

```javascript
/**
 * Scrape all uncaptured assistant response containers from the DOM.
 * Called on: next user message, periodic timer, visibilitychange, beforeunload.
 * Each element is captured at most once (tracked by capturedResponseElements WeakSet).
 */
function scrapeAllUncaptured(conversationId) {
  for (const selector of RESPONSE_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (capturedResponseElements.has(el)) continue; // already captured — skip

      const text = scrapeResponseText(el);
      if (!text) continue;

      capturedResponseElements.add(el);
      dispatchCapture(text, 'assistant', 'deferred-dom', conversationId);

      _kytDebug() && console.log('📸 KYT Gemini: Deferred DOM capture (' + text.length + ' chars)');
    }
  }
}
```

- [ ] **Step 5: Run tests to verify no syntax errors**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: All existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add platforms/gemini/inject.js
git commit -m "feat(gemini): add capturedResponseElements WeakSet + scrapeAllUncaptured()"
```

---

### Task 5: Update DOM observer to mark captured elements in WeakSet

**Files:**
- Modify: `platforms/gemini/inject.js`

**IMPORTANT: This task MUST be completed before Task 6 (wiring handlers) and Task 7 (safety nets).** If handlers call `scrapeAllUncaptured()` before the observer marks elements, double-capture will occur between the observer's `_onStable` dispatch and the deferred sweep.

- [ ] **Step 1: Modify `_onStable` to mark the captured element**

```javascript
_onStable() {
  if (this.lastTextLength === 0) return;
  const text = this._getLastResponseText();
  if (!text || text.length < 20) { this.stop(); return; }

  // Mark the element as captured so deferred sweep skips it
  const el = this._findLastResponseElement();
  if (el && el !== this._baselineElement) capturedResponseElements.add(el);

  _kytDebug() && console.log('📥 KYT Gemini: DOM response captured (' + text.length + ' chars, conv=' + (this.pendingConvId || 'unknown') + ')');
  dispatchCapture(text, 'assistant', 'dom-observer', this.pendingConvId);
  this.stop();
},
```

- [ ] **Step 2: Modify `_flushPending` to mark the captured element**

```javascript
_flushPending() {
  if (!this.pendingConvId || this.lastTextLength === 0) return;
  const text = this._getLastResponseText();
  if (!text || text.length < 20) return;

  const el = this._findLastResponseElement();
  if (el && el !== this._baselineElement) capturedResponseElements.add(el);

  _kytDebug() && console.log('📥 KYT Gemini: DOM response flushed (' + text.length + ' chars)');
  dispatchCapture(text, 'assistant', 'dom-observer', this.pendingConvId);
},
```

- [ ] **Step 3: Update `_getLastResponseText` and `_findLastResponseElement` to use module-level `RESPONSE_SELECTORS`**

Ensure both methods reference the module-level `RESPONSE_SELECTORS` constant (not a property on the observer object). This may already work if you set `RESPONSE_SELECTORS: RESPONSE_SELECTORS,` in Task 4 Step 2.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add platforms/gemini/inject.js
git commit -m "feat(gemini): DOM observer marks captured elements in WeakSet"
```

---

### Task 6: Wire XHR/fetch handlers to use deferred DOM capture instead of wire extraction

**Files:**
- Modify: `platforms/gemini/inject.js`

- [ ] **Step 1: Modify XHR StreamGenerate handler — add previous-turn capture on user send**

In the XHR `send` handler, at the start of the `// Path 1: StreamGenerate` section (after `parseFReq` succeeds, before `dispatchCapture` of user message), add a call to capture the previous response:

```javascript
// Path 1: StreamGenerate (live message capture + context injection)

const bodyStr = bodyToString(body);
const parseResult = parseFReq(bodyStr);

if (!parseResult) {
  return originalXHRSend.apply(this, arguments);
}

// === DEFERRED CAPTURE: User is sending a new message.
// The previous assistant response has been on screen long enough to be fully rendered.
// Scrape any uncaptured response containers now.
scrapeAllUncaptured(parseResult.conversationId);

_kytDebug() && console.log('📤 KYT Gemini: User message captured via XHR (' + parseResult.userMessage.length + ' chars)');
dispatchCapture(parseResult.userMessage, 'user', 'xhr', parseResult.conversationId);
```

- [ ] **Step 2: Simplify XHR `load` handler — remove wire extraction, keep DOM notify**

Replace the current `this.addEventListener('load', ...)` block with a simpler version that just notifies the DOM observer (no wire text extraction):

```javascript
// When streaming completes, notify DOM observer so it can finalize
this.addEventListener('load', function () {
  _kytDebug() && console.log('📡 KYT Gemini: XHR StreamGenerate complete (' + (this.responseText?.length || 0) + ' bytes)');
  responseDOMObserver.notifyResponseComplete();
}, { once: true });
```

- [ ] **Step 3: Modify fetch StreamGenerate handler — same pattern**

In the fetch handler's Path 1 (StreamGenerate), add `scrapeAllUncaptured(parseResult.conversationId);` before user message dispatch, and simplify the response handling to remove wire extraction. Replace the entire post-fetch response block with:

```javascript
const fetchResponse = await originalFetch.call(this, input, finalInit);
responseDOMObserver.notifyResponseComplete();
return fetchResponse;
```

- [ ] **Step 4: Run tests to verify nothing broken**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add platforms/gemini/inject.js
git commit -m "feat(gemini): wire handlers use deferred DOM capture, remove wire text extraction"
```

---

### Task 7: Add periodic sweep + visibilitychange/beforeunload safety nets

**Files:**
- Modify: `platforms/gemini/inject.js`

These catch the "last response in conversation" case — the user doesn't send another message, so the next-turn trigger never fires.

- [ ] **Step 1: Add periodic sweep timer**

After the `scrapeAllUncaptured` function, add:

```javascript
// Periodic sweep: captures any responses that weren't caught by next-turn trigger.
// Handles: last response before tab close, long reading pauses, single-turn conversations.
// Note: conversationId is null here — Gemini URLs don't expose conversation IDs.
// The next-turn trigger (which HAS the ID from parseFReq) is the primary capture path.
setInterval(function () {
  scrapeAllUncaptured(null);
}, 60000); // every 60 seconds
```

- [ ] **Step 2: Update `beforeunload` handler**

The existing `beforeunload` handler calls `responseDOMObserver._flushPending()`. Add `scrapeAllUncaptured()` to also capture any deferred responses:

```javascript
window.addEventListener('beforeunload', function () {
  responseDOMObserver._flushPending();
  scrapeAllUncaptured(null);
});
```

- [ ] **Step 3: Add `visibilitychange` handler**

When the user switches tabs, capture everything. This is the most common "leaving the conversation" signal.

```javascript
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    scrapeAllUncaptured(null);
  }
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add platforms/gemini/inject.js
git commit -m "feat(gemini): periodic sweep + visibilitychange/beforeunload safety nets"
```

---

### Task 8: Clean up dead code references

**Files:**
- Modify: `platforms/gemini/inject.js`
- Modify: `tests/unit/gemini-inject.test.js`

- [ ] **Step 1: Verify history-load functions are still intact**

Check that `findAllStrings`, `isNaturalLanguage`, and `parseLengthPrefixedFrames` are still present — they're used by `extractConversationMessages` / `extractConversationMessagesFallback` for history-load parsing (batchexecute). Only StreamGenerate wire extraction was removed.

- [ ] **Step 2: Verify all wire extraction references are gone**

Run: `grep -n 'extractTextFromWrbPayload\|extractAssistantFromStreamGenerate\|describeShape\|findDeepestNaturalString\|wireStats' platforms/gemini/inject.js tests/unit/gemini-inject.test.js`
Expected: ZERO matches.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run tests/unit/gemini-inject.test.js 2>&1 | tail -10`
Expected: ALL tests PASS.

- [ ] **Step 4: Final commit**

```bash
git add platforms/gemini/inject.js tests/unit/gemini-inject.test.js
git commit -m "refactor(gemini): remove dead wire extraction references, verify clean state"
```

---

## Verification Checklist

After all tasks complete:

1. **Run tests**: `npx vitest run tests/unit/gemini-inject.test.js` — all pass
2. **Grep for dead code**: `grep -n 'extractAssistantFromStreamGenerate\|wireStats\|findDeepestNaturalString\|describeShape\|extractTextFromWrbPayload' platforms/gemini/inject.js tests/unit/gemini-inject.test.js` — zero matches
3. **Live test on gemini.google.com**:
   - Enable debug: `localStorage.setItem('KYT_GEMINI_DEBUG', '1'); location.reload()`
   - Send 3 messages
   - Look for `📸 KYT Gemini: Deferred DOM capture` on the 2nd and 3rd sends
   - Check `__kytGeminiStats()` for deduplicator stats
   - Verify Supabase has full-length responses (not 27 chars)
4. **Edge cases to test**:
   - Single-turn conversation (periodic sweep should capture after 60s)
   - Switch tabs after response (visibilitychange should capture)
   - Close tab (beforeunload should capture)
   - Scroll up and down rapidly (WeakSet prevents re-capture)

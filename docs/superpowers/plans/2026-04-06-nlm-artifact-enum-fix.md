# Fix NotebookLM Artifact Enum Mismatches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 wrong enum objects in `notebooklm-constants.js` that cause infographic (and other artifact) generation to send incorrect codes to Google's API, and add test coverage to prevent regression.

**Architecture:** Pure data fix + normalization helper. Update enum values to match Python `notebooklm-py` v0.3.4 (the authoritative source), add a hyphen-to-underscore normalizer for user input, update MCP tool schema descriptions, and add unit tests via TDD.

**Tech Stack:** Node.js ESM, `node:test` runner

---

## Context

The `notebooklm-constants.js` enum values were hand-ported from the Python `notebooklm-py` library but are now significantly out of date. The infographic enums are the worst offender (orientation values swapped, style has 3 fake names vs 11 real ones), but video, quiz, and slide_deck enums are also wrong. This causes `generate_artifact` with `type=infographic` to either send wrong codes or `null` to Google's API. The Python CLI fallback was also broken (editable install at `/tmp` wiped on reboot) but was fixed by force-reinstalling during exploration.

### Exact Mismatches

| Enum | Current JS | Correct (Python v0.3.4) | Impact |
|------|-----------|------------------------|--------|
| `INFOGRAPHIC_ORIENTATION` | `{PORTRAIT:1, LANDSCAPE:2}` | `{LANDSCAPE:1, PORTRAIT:2, SQUARE:3}` | Values swapped, missing SQUARE |
| `INFOGRAPHIC_DETAIL` | `{SIMPLE:1, DETAILED:2}` | `{CONCISE:1, STANDARD:2, DETAILED:3}` | Wrong names, missing STANDARD |
| `INFOGRAPHIC_STYLE` | `{MODERN:1, CLASSIC:2, MINIMAL:3}` | 11 values: AUTO_SELECT..SCIENTIFIC | Completely wrong |
| `VIDEO_FORMAT` | `{LECTURE:1, DOCUMENTARY:2, EXPLAINER:3}` | `{EXPLAINER:1, BRIEF:2, CINEMATIC:3}` | Wrong names |
| `VIDEO_STYLE` | `{REALISTIC:1, ANIMATED:2, WHITEBOARD:3}` | 10 values: AUTO_SELECT..PAPER_CRAFT | 3 vs 10 |
| `QUIZ_QUANTITY` | `{FEW:5, STANDARD:10, MANY:15}` | `{FEWER:1, STANDARD:2}` | Wrong values entirely |
| `SLIDE_DECK_FORMAT` | `{PRESENTATION:1, SUMMARY:2}` | `{DETAILED_DECK:1, PRESENTER_SLIDES:2}` | Wrong names |
| `SLIDE_DECK_LENGTH` | `{SHORT:1, MEDIUM:2, LONG:3}` | `{DEFAULT:1, SHORT:2}` | Wrong mapping |

Enums that are already correct (no changes): `ARTIFACT_TYPE`, `ARTIFACT_STATUS`, `AUDIO_FORMAT`, `AUDIO_LENGTH`, `QUIZ_DIFFICULTY`, `QUIZ_VARIANT`.

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `mcp/src/lib/notebooklm-constants.js` | Modify:80-107 | Fix 7 enum objects |
| `mcp/src/lib/notebooklm-client.js` | Modify:971-1049 | Add `normalizeEnumKey()`, update 12 lookups, export for testing |
| `mcp/src/server.js` | Modify:396-403 | Update describe() strings with correct option names |
| `mcp/tests/test-notebooklm.js` | Modify:end | Add enum + buildArtifactParams tests |

---

### Task 1: Expose buildArtifactParams for testing

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js` (bottom of file)

- [ ] **Step 1: Add testing export**

Add at the end of `notebooklm-client.js`:

```js
// --- Exports for testing ---
export const __testing__ = { buildArtifactParams };
```

- [ ] **Step 2: Verify module still loads**

Run: `cd /home/penguinzyue/kyt-validation-sprint/mcp && node -e "import('./src/lib/notebooklm-client.js').then(m => console.log('__testing__' in m ? 'OK' : 'MISSING'))"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js
git commit -m "test: expose buildArtifactParams for unit testing"
```

---

### Task 2: Write failing tests for enum values and buildArtifactParams

**Files:**
- Modify: `mcp/tests/test-notebooklm.js`

- [ ] **Step 1: Add imports at the top of the test file**

```js
import { __testing__ as clientTesting } from '../src/lib/notebooklm-client.js';
const { buildArtifactParams } = clientTesting;

import {
  ARTIFACT_TYPE,
  INFOGRAPHIC_ORIENTATION, INFOGRAPHIC_DETAIL, INFOGRAPHIC_STYLE,
  VIDEO_FORMAT, VIDEO_STYLE,
  QUIZ_QUANTITY,
  SLIDE_DECK_FORMAT, SLIDE_DECK_LENGTH,
} from '../src/lib/notebooklm-constants.js';
```

- [ ] **Step 2: Add enum value tests**

Append a new `describe` block:

```js
describe('Artifact enum values (synced with notebooklm-py v0.3.4)', () => {
  it('INFOGRAPHIC_ORIENTATION matches Python InfographicOrientation', () => {
    assert.strictEqual(INFOGRAPHIC_ORIENTATION.LANDSCAPE, 1);
    assert.strictEqual(INFOGRAPHIC_ORIENTATION.PORTRAIT, 2);
    assert.strictEqual(INFOGRAPHIC_ORIENTATION.SQUARE, 3);
    assert.strictEqual(Object.keys(INFOGRAPHIC_ORIENTATION).length, 3);
  });

  it('INFOGRAPHIC_DETAIL matches Python InfographicDetail', () => {
    assert.strictEqual(INFOGRAPHIC_DETAIL.CONCISE, 1);
    assert.strictEqual(INFOGRAPHIC_DETAIL.STANDARD, 2);
    assert.strictEqual(INFOGRAPHIC_DETAIL.DETAILED, 3);
    assert.strictEqual(Object.keys(INFOGRAPHIC_DETAIL).length, 3);
  });

  it('INFOGRAPHIC_STYLE matches Python InfographicStyle (11 values)', () => {
    assert.strictEqual(INFOGRAPHIC_STYLE.AUTO_SELECT, 1);
    assert.strictEqual(INFOGRAPHIC_STYLE.SKETCH_NOTE, 2);
    assert.strictEqual(INFOGRAPHIC_STYLE.PROFESSIONAL, 3);
    assert.strictEqual(INFOGRAPHIC_STYLE.BENTO_GRID, 4);
    assert.strictEqual(INFOGRAPHIC_STYLE.EDITORIAL, 5);
    assert.strictEqual(INFOGRAPHIC_STYLE.INSTRUCTIONAL, 6);
    assert.strictEqual(INFOGRAPHIC_STYLE.BRICKS, 7);
    assert.strictEqual(INFOGRAPHIC_STYLE.CLAY, 8);
    assert.strictEqual(INFOGRAPHIC_STYLE.ANIME, 9);
    assert.strictEqual(INFOGRAPHIC_STYLE.KAWAII, 10);
    assert.strictEqual(INFOGRAPHIC_STYLE.SCIENTIFIC, 11);
    assert.strictEqual(Object.keys(INFOGRAPHIC_STYLE).length, 11);
  });

  it('VIDEO_FORMAT matches Python VideoFormat', () => {
    assert.strictEqual(VIDEO_FORMAT.EXPLAINER, 1);
    assert.strictEqual(VIDEO_FORMAT.BRIEF, 2);
    assert.strictEqual(VIDEO_FORMAT.CINEMATIC, 3);
    assert.strictEqual(Object.keys(VIDEO_FORMAT).length, 3);
  });

  it('VIDEO_STYLE matches Python VideoStyle (10 values)', () => {
    assert.strictEqual(VIDEO_STYLE.AUTO_SELECT, 1);
    assert.strictEqual(VIDEO_STYLE.CUSTOM, 2);
    assert.strictEqual(VIDEO_STYLE.CLASSIC, 3);
    assert.strictEqual(VIDEO_STYLE.WHITEBOARD, 4);
    assert.strictEqual(VIDEO_STYLE.KAWAII, 5);
    assert.strictEqual(VIDEO_STYLE.ANIME, 6);
    assert.strictEqual(VIDEO_STYLE.WATERCOLOR, 7);
    assert.strictEqual(VIDEO_STYLE.RETRO_PRINT, 8);
    assert.strictEqual(VIDEO_STYLE.HERITAGE, 9);
    assert.strictEqual(VIDEO_STYLE.PAPER_CRAFT, 10);
    assert.strictEqual(Object.keys(VIDEO_STYLE).length, 10);
  });

  it('QUIZ_QUANTITY matches Python QuizQuantity', () => {
    assert.strictEqual(QUIZ_QUANTITY.FEWER, 1);
    assert.strictEqual(QUIZ_QUANTITY.STANDARD, 2);
    assert.strictEqual(Object.keys(QUIZ_QUANTITY).length, 2);
  });

  it('SLIDE_DECK_FORMAT matches Python SlideDeckFormat', () => {
    assert.strictEqual(SLIDE_DECK_FORMAT.DETAILED_DECK, 1);
    assert.strictEqual(SLIDE_DECK_FORMAT.PRESENTER_SLIDES, 2);
    assert.strictEqual(Object.keys(SLIDE_DECK_FORMAT).length, 2);
  });

  it('SLIDE_DECK_LENGTH matches Python SlideDeckLength', () => {
    assert.strictEqual(SLIDE_DECK_LENGTH.DEFAULT, 1);
    assert.strictEqual(SLIDE_DECK_LENGTH.SHORT, 2);
    assert.strictEqual(Object.keys(SLIDE_DECK_LENGTH).length, 2);
  });
});
```

- [ ] **Step 3: Add buildArtifactParams integration tests**

```js
describe('buildArtifactParams', () => {
  const SOURCES = ['src-aaa', 'src-bbb'];

  it('infographic with all options produces correct array', () => {
    const result = buildArtifactParams(ARTIFACT_TYPE.INFOGRAPHIC, SOURCES, {
      instructions: 'focus on stats',
      orientation: 'portrait',
      detail: 'concise',
      style: 'sketch_note',
      language: 'en',
    });
    // Type code at [2]
    assert.strictEqual(result[2], 7);
    // Source IDs at [3] as tripleNested
    assert.deepStrictEqual(result[3], [[['src-aaa']], [['src-bbb']]]);
    // Options at [14]
    const opts = result[14];
    assert.deepStrictEqual(opts, [['focus on stats', 'en', null, 2, 1, 2]]);
    // 2=PORTRAIT, 1=CONCISE, 2=SKETCH_NOTE
  });

  it('infographic with hyphenated style (bento-grid) resolves correctly', () => {
    const result = buildArtifactParams(ARTIFACT_TYPE.INFOGRAPHIC, SOURCES, {
      style: 'bento-grid',
    });
    assert.strictEqual(result[14][0][5], 4); // BENTO_GRID = 4
  });

  it('video with cinematic format and classic style', () => {
    const result = buildArtifactParams(ARTIFACT_TYPE.VIDEO, SOURCES, {
      format: 'cinematic',
      style: 'classic',
    });
    assert.strictEqual(result[2], 3); // VIDEO type code
    // Video options at position [8], inner at [2]
    const inner = result[8][2];
    assert.strictEqual(inner[4], 3); // CINEMATIC = 3
    assert.strictEqual(inner[5], 3); // CLASSIC = 3
  });

  it('slide_deck with detailed_deck format and short length', () => {
    const result = buildArtifactParams(ARTIFACT_TYPE.SLIDE_DECK, SOURCES, {
      format: 'detailed_deck',
      length: 'short',
    });
    assert.strictEqual(result[2], 8); // SLIDE_DECK type code
    // Options at position [16]
    const opts = result[16];
    assert.strictEqual(opts[0][2], 1); // DETAILED_DECK = 1
    assert.strictEqual(opts[0][3], 2); // SHORT = 2
  });

  it('unknown options resolve to null (not throw)', () => {
    const result = buildArtifactParams(ARTIFACT_TYPE.INFOGRAPHIC, SOURCES, {
      style: 'nonexistent_style',
    });
    assert.strictEqual(result[14][0][5], null);
  });
});
```

- [ ] **Step 4: Run tests and confirm they FAIL**

Run: `cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js 2>&1 | tail -20`
Expected: Multiple failures on the new enum tests (e.g., `INFOGRAPHIC_ORIENTATION.LANDSCAPE` is 2 not 1)

- [ ] **Step 5: Commit failing tests**

```bash
git add mcp/tests/test-notebooklm.js
git commit -m "test: add failing tests for artifact enum values and buildArtifactParams"
```

---

### Task 3: Fix enum values and add normalizeEnumKey helper

**Files:**
- Modify: `mcp/src/lib/notebooklm-constants.js:49-107`
- Modify: `mcp/src/lib/notebooklm-client.js:971-1049`

- [ ] **Step 1: Fix VIDEO_FORMAT (constants.js lines 50-54)**

Replace:
```js
export const VIDEO_FORMAT = {
  LECTURE: 1,
  DOCUMENTARY: 2,
  EXPLAINER: 3,
};
```
With:
```js
export const VIDEO_FORMAT = {
  EXPLAINER: 1,
  BRIEF: 2,
  CINEMATIC: 3,
};
```

- [ ] **Step 2: Fix VIDEO_STYLE (constants.js lines 56-60)**

Replace:
```js
export const VIDEO_STYLE = {
  REALISTIC: 1,
  ANIMATED: 2,
  WHITEBOARD: 3,
};
```
With:
```js
export const VIDEO_STYLE = {
  AUTO_SELECT: 1,
  CUSTOM: 2,
  CLASSIC: 3,
  WHITEBOARD: 4,
  KAWAII: 5,
  ANIME: 6,
  WATERCOLOR: 7,
  RETRO_PRINT: 8,
  HERITAGE: 9,
  PAPER_CRAFT: 10,
};
```

- [ ] **Step 3: Fix QUIZ_QUANTITY (constants.js lines 68-72)**

Replace:
```js
export const QUIZ_QUANTITY = {
  FEW: 5,
  STANDARD: 10,
  MANY: 15,
};
```
With:
```js
export const QUIZ_QUANTITY = {
  FEWER: 1,
  STANDARD: 2,
};
```

- [ ] **Step 4: Fix INFOGRAPHIC_ORIENTATION (constants.js lines 81-84)**

Replace:
```js
export const INFOGRAPHIC_ORIENTATION = {
  PORTRAIT: 1,
  LANDSCAPE: 2,
};
```
With:
```js
export const INFOGRAPHIC_ORIENTATION = {
  LANDSCAPE: 1,
  PORTRAIT: 2,
  SQUARE: 3,
};
```

- [ ] **Step 5: Fix INFOGRAPHIC_DETAIL (constants.js lines 86-89)**

Replace:
```js
export const INFOGRAPHIC_DETAIL = {
  SIMPLE: 1,
  DETAILED: 2,
};
```
With:
```js
export const INFOGRAPHIC_DETAIL = {
  CONCISE: 1,
  STANDARD: 2,
  DETAILED: 3,
};
```

- [ ] **Step 6: Fix INFOGRAPHIC_STYLE (constants.js lines 91-95)**

Replace:
```js
export const INFOGRAPHIC_STYLE = {
  MODERN: 1,
  CLASSIC: 2,
  MINIMAL: 3,
};
```
With:
```js
export const INFOGRAPHIC_STYLE = {
  AUTO_SELECT: 1,
  SKETCH_NOTE: 2,
  PROFESSIONAL: 3,
  BENTO_GRID: 4,
  EDITORIAL: 5,
  INSTRUCTIONAL: 6,
  BRICKS: 7,
  CLAY: 8,
  ANIME: 9,
  KAWAII: 10,
  SCIENTIFIC: 11,
};
```

- [ ] **Step 7: Fix SLIDE_DECK_FORMAT (constants.js lines 98-101)**

Replace:
```js
export const SLIDE_DECK_FORMAT = {
  PRESENTATION: 1,
  SUMMARY: 2,
};
```
With:
```js
export const SLIDE_DECK_FORMAT = {
  DETAILED_DECK: 1,
  PRESENTER_SLIDES: 2,
};
```

- [ ] **Step 8: Fix SLIDE_DECK_LENGTH (constants.js lines 103-107)**

Replace:
```js
export const SLIDE_DECK_LENGTH = {
  SHORT: 1,
  MEDIUM: 2,
  LONG: 3,
};
```
With:
```js
export const SLIDE_DECK_LENGTH = {
  DEFAULT: 1,
  SHORT: 2,
};
```

- [ ] **Step 9: Add normalizeEnumKey helper (client.js, before buildArtifactParams)**

Add before `function buildArtifactParams(...)` (around line 970):

```js
/** Normalize user-supplied enum string: uppercase + hyphens→underscores. */
function normalizeEnumKey(val) {
  return val ? val.toUpperCase().replace(/-/g, '_') : null;
}
```

- [ ] **Step 10: Replace all .toUpperCase() lookups with normalizeEnumKey()**

In `buildArtifactParams`, replace every `options.X?.toUpperCase()` pattern. There are 12 lookups:

```js
// AUDIO case (lines ~984-985)
const format = AUDIO_FORMAT[normalizeEnumKey(options.format)] || null;
const length = AUDIO_LENGTH[normalizeEnumKey(options.length)] || null;

// VIDEO case (lines ~1003-1004)
const format = VIDEO_FORMAT[normalizeEnumKey(options.format)] || null;
const style = VIDEO_STYLE[normalizeEnumKey(options.style)] || null;

// QUIZ case (lines ~1012-1014)
const variant = QUIZ_VARIANT[normalizeEnumKey(options.variant)] || QUIZ_VARIANT.QUIZ;
const quantity = QUIZ_QUANTITY[normalizeEnumKey(options.quantity)] || null;
const difficulty = QUIZ_DIFFICULTY[normalizeEnumKey(options.difficulty)] || null;

// INFOGRAPHIC case (lines ~1022-1024)
const orientation = INFOGRAPHIC_ORIENTATION[normalizeEnumKey(options.orientation)] || null;
const detail = INFOGRAPHIC_DETAIL[normalizeEnumKey(options.detail)] || null;
const style = INFOGRAPHIC_STYLE[normalizeEnumKey(options.style)] || null;

// SLIDE_DECK case (lines ~1033-1034)
const format = SLIDE_DECK_FORMAT[normalizeEnumKey(options.format)] || null;
const length = SLIDE_DECK_LENGTH[normalizeEnumKey(options.length)] || null;
```

- [ ] **Step 11: Run tests**

Run: `cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js`
Expected: All tests pass (both old and new)

- [ ] **Step 12: Commit**

```bash
git add mcp/src/lib/notebooklm-constants.js mcp/src/lib/notebooklm-client.js
git commit -m "fix(nlm): sync artifact enums with notebooklm-py v0.3.4 + normalizeEnumKey"
```

---

### Task 4: Update MCP tool schema descriptions

**Files:**
- Modify: `mcp/src/server.js:396-403`

- [ ] **Step 1: Update describe() strings**

Replace the 6 option descriptions in the `generate_artifact` tool registration:

```js
format: z.string().optional().describe('Format option (audio: deep_dive/brief/critique/debate; video: explainer/brief/cinematic; slide_deck: detailed_deck/presenter_slides)'),
style: z.string().optional().describe('Style option (video: auto_select/classic/whiteboard/kawaii/anime/watercolor/retro_print/heritage/paper_craft; infographic: auto_select/sketch_note/professional/bento_grid/editorial/instructional/bricks/clay/anime/kawaii/scientific)'),
length: z.string().optional().describe('Length option (audio: short/default/long; slide_deck: default/short)'),
quantity: z.string().optional().describe('Quiz quantity: fewer/standard'),
orientation: z.string().optional().describe('Infographic orientation: landscape/portrait/square'),
detail: z.string().optional().describe('Infographic detail level: concise/standard/detailed'),
```

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add mcp/src/server.js
git commit -m "docs(nlm): update MCP tool descriptions with correct artifact options"
```

---

### Task 5: Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js
```

Expected: All tests pass including 8 enum tests + 5 buildArtifactParams tests + all pre-existing tests.

- [ ] **Step 2: Live test (manual) — generate infographic**

Via MCP tool:
```
generate_artifact notebookId=<Codebase Index ID> type=infographic style=sketch_note orientation=landscape detail=concise waitForCompletion=true
```

Confirm: API returns an artifactId (not null), artifact reaches status COMPLETED.

- [ ] **Step 3: Live test (manual) — download infographic**

Via MCP tool:
```
download_artifact notebookId=<same> type=infographic artifactId=<from step 2>
```

Confirm: PNG file downloaded to `~/.kyt/downloads/`.

## Security Assessment

<security_assessment>

### Critical -- None identified

### High -- None identified

### Medium -- None identified

### Low
**L1. Enum normalization accepts arbitrary strings without validation**
- Description: `normalizeEnumKey()` uppercases and replaces hyphens but doesn't validate against known values. Unknown keys silently resolve to `null` via `|| null`.
- Impact: Minimal. `null` values are already handled by Google's API (treated as "use default"). No injection risk since enum values are integers, not strings passed to the API.
- Mitigation: Already handled by the `|| null` fallback pattern. No action needed.

### Additional Security Considerations
- No new data flows, auth changes, or external API integrations added
- The `normalizeEnumKey` helper is pure string transformation; no injection surface
- The `__testing__` export exposes an internal pure function; no security impact (no auth, no network)
- The Python CLI fallback path passes user-supplied option strings to `execFileSync` with array args (no shell), so command injection is not possible

### Edge Cases
- User passes old enum names (e.g., `style: 'modern'`) -- resolves to `null`, uses API default. Correct behavior.
- User passes `quantity: 'few'` (old name) -- resolves to `null` because key is now `FEWER`. Acceptable; the old value `5` was wrong anyway.

</security_assessment>

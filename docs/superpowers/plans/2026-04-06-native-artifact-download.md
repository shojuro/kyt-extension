# Native Artifact Download (Replace Python CLI with Proxy Relay)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python CLI dependency in `download_artifact` with a native Node.js download path that uses the browser proxy relay for authentication — the same pattern that already makes `generate_artifact` and `ask_notebook` work.

**Architecture:** Get raw artifact data via the existing proxy RPC (`LIST_ARTIFACTS`), extract media URLs in JS (porting Python's extraction logic), add a new `fetch_url` proxy request type for cookie-authenticated binary downloads, base64-encode binary responses through the text-based bridge.

**Tech Stack:** Node.js ESM, Chrome extension content script, existing cookie bridge (port 19418)

---

## Context

The `download_artifact` MCP tool currently shells out to the Python `notebooklm` CLI which maintains its own auth via `~/.notebooklm/storage_state.json`. This auth expires in ~2 minutes (cookies captured via `chrome.cookies.getAll()` are a stale snapshot). Meanwhile, `generate_artifact` and `ask_notebook` work reliably because they use the proxy relay chain: MCP → cookie bridge → extension SW → content script → `fetch(url, {credentials: 'include'})` → Google API. The content script has live browser cookies that never expire while the tab is open.

**The fix:** Route binary artifact downloads through the same proxy relay. The content script fetches the media URL with `credentials: 'include'`, base64-encodes the binary response, and sends it back through the bridge. The MCP server decodes and writes to disk.

### Key Discoveries

1. **Raw artifact data is already available** — `listArtifacts()` calls the same RPC as Python's `_list_raw()` but discards everything beyond `[id, title, type, status]`. The media URLs are deeper in the response.

2. **Status field is at `entry[4]`, not `entry[3]`** — Our `listArtifacts()` reads status from `entry[3]` (which is null for completed artifacts), explaining the `status_null` output. Python checks `entry[4]`. Bug fix included.

3. **URL extraction is type-specific:**
   - Audio: `entry[6][5][...][0]` (iterate for `audio/mp4` mime type)
   - Video: `entry[8]` area (iterate for HTTP URLs in nested lists)
   - Infographic: Walk backwards through entry, URL at `item[2][0][1][0]`
   - Slide deck: `metadata[3]` (PDF) or `metadata[4]` (PPTX) — direct string URLs

4. **All download URLs require cookies** — Python's `_download_url()` explicitly loads cookies for the request. URLs are on `*.googleusercontent.com` / `*.googleapis.com` domains.

5. **Bridge is text-only** — `readBody()` does `.toString('utf8')`. Binary data must go through base64 (33% overhead, acceptable for ~1-5MB artifacts).

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `mcp/src/lib/notebooklm-client.js` | Modify | Add `listArtifactsRaw()`, `extractMediaUrl()`, fix status index in `listArtifacts()` |
| `mcp/src/tools/download-artifact.js` | Modify | Replace Python CLI with native download via proxy relay |
| `platforms/notebooklm/content.js` | Modify | Add `type: 'fetch_url'` handler in `executeRpcProxy()` |
| `src/nlm-rpc-proxy.js` | Verify | Ensure `fetch_url` type passes through (should work as-is since it forwards the full request object) |
| `mcp/tests/test-notebooklm.js` | Modify | Add tests for `extractMediaUrl()` and `listArtifactsRaw()` |

---

### Task 1: Fix `listArtifacts()` status field index + add `listArtifactsRaw()`

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js:1182-1213`

- [ ] **Step 1: Write failing test for status field**

In `mcp/tests/test-notebooklm.js`, add:

```js
describe('listArtifacts response parsing', () => {
  test('status is read from entry[4], not entry[3]', () => {
    // Simulate raw response: [id, title, typeCode, unknown, statusCode, ...]
    // entry[3] is often null; entry[4] has the real status
    const mockEntry = ['abc-123', 'Test Artifact', 7, null, 3, null, null];
    // The parsed status should be 3 (COMPLETED), not null
    // This test documents the fix — entry[4] is the status field
    assert.strictEqual(mockEntry[4], 3);
    assert.strictEqual(mockEntry[3], null);
  });
});
```

- [ ] **Step 2: Fix status index in `listArtifacts()`**

In `notebooklm-client.js`, the `listArtifacts()` function (line ~1200) currently reads:
```js
const status = typeof entry[3] === 'number' ? entry[3] : null;
```

Change to try `entry[4]` first, fall back to `entry[3]`:
```js
const status = typeof entry[4] === 'number' ? entry[4] : (typeof entry[3] === 'number' ? entry[3] : null);
```

- [ ] **Step 3: Add `listArtifactsRaw()` function**

Add after `listArtifacts()`:

```js
/**
 * List artifacts with full raw entry data (for URL extraction).
 * Returns the unparsed nested arrays from the LIST_ARTIFACTS RPC.
 */
export async function listArtifactsRaw(notebookId) {
  const result = await rpcCall(RPC.LIST_ARTIFACTS,
    [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'],
    { sourcePath: `/notebook/${notebookId}` },
  );

  if (!result || !Array.isArray(result)) return [];
  return Array.isArray(result[0]) && Array.isArray(result[0][0]) ? result[0] : result;
}
```

- [ ] **Step 4: Export `listArtifactsRaw` and add to `__testing__`**

Add `listArtifactsRaw` to the module's named exports and to `__testing__`.

- [ ] **Step 5: Verify `listArtifacts()` fix**

Run: `cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js`

- [ ] **Step 6: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js mcp/tests/test-notebooklm.js
git commit -m "fix(nlm): read artifact status from entry[4] + add listArtifactsRaw()"
```

---

### Task 2: Implement `extractMediaUrl()` — port Python URL extraction to JS

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js`
- Modify: `mcp/tests/test-notebooklm.js`

- [ ] **Step 1: Write failing tests for URL extraction**

```js
describe('extractMediaUrl', () => {
  const { extractMediaUrl } = clientTesting;

  test('extracts infographic URL by walking backwards', () => {
    // Simulated infographic entry based on Python's _find_infographic_url pattern
    // URL is at item[2][0][1][0] in a list item found by reverse walk
    const entry = [
      'art-id', 'Title', 7, null, 3,
      null, null, null, null, null, null, null,
      [['config'], ['meta'], [['inner', ['https://lh3.googleusercontent.com/infographic.png']]]],
    ];
    const url = extractMediaUrl(entry, ARTIFACT_TYPE.INFOGRAPHIC);
    assert.strictEqual(url, 'https://lh3.googleusercontent.com/infographic.png');
  });

  test('extracts audio URL from entry[6][5]', () => {
    const entry = [
      'art-id', 'Title', 1, null, 3,
      null,
      [null, null, null, null, null, [['https://audio.googleapis.com/audio.mp4', null, 'audio/mp4']]],
    ];
    const url = extractMediaUrl(entry, ARTIFACT_TYPE.AUDIO);
    assert.strictEqual(url, 'https://audio.googleapis.com/audio.mp4');
  });

  test('extracts slide_deck PDF URL from metadata[3]', () => {
    const entry = [
      'art-id', 'Title', 8, null, 3,
      null, null, null, null, null, null, null, null, null, null, null,
      [null, null, null, 'https://slides.googleapis.com/deck.pdf', 'https://slides.googleapis.com/deck.pptx'],
    ];
    const url = extractMediaUrl(entry, ARTIFACT_TYPE.SLIDE_DECK);
    assert.ok(url.startsWith('https://'));
  });

  test('returns null for text artifact types', () => {
    const entry = ['art-id', 'Title', 2, null, 3];
    const url = extractMediaUrl(entry, ARTIFACT_TYPE.REPORT);
    assert.strictEqual(url, null);
  });

  test('returns null when no valid URL found', () => {
    const entry = ['art-id', 'Title', 7, null, 3];
    const url = extractMediaUrl(entry, ARTIFACT_TYPE.INFOGRAPHIC);
    assert.strictEqual(url, null);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

- [ ] **Step 3: Implement `extractMediaUrl()`**

Add to `notebooklm-client.js`:

```js
/**
 * Extract media download URL from a raw artifact entry.
 * Ports logic from notebooklm-py's download_audio, download_infographic,
 * download_video, download_slide_deck methods.
 *
 * @param {Array} entry - Raw artifact entry from listArtifactsRaw()
 * @param {number} typeCode - ARTIFACT_TYPE value
 * @param {object} [opts] - Options (e.g. { format: 'pptx' } for slide decks)
 * @returns {string|null} Media URL or null
 */
export function extractMediaUrl(entry, typeCode, opts = {}) {
  if (!Array.isArray(entry)) return null;

  try {
    switch (typeCode) {
      case ARTIFACT_TYPE.AUDIO: {
        // Python: entry[6][5][...][0] — iterate for audio/mp4 mime type
        const metadata = entry[6];
        if (!Array.isArray(metadata) || metadata.length <= 5) return null;
        const mediaList = metadata[5];
        if (!Array.isArray(mediaList) || mediaList.length === 0) return null;
        // Prefer audio/mp4 mime type
        for (const item of mediaList) {
          if (Array.isArray(item) && item.length > 2 && item[2] === 'audio/mp4' && isValidMediaUrl(item[0])) {
            return item[0];
          }
        }
        // Fallback: first URL
        if (Array.isArray(mediaList[0]) && isValidMediaUrl(mediaList[0][0])) return mediaList[0][0];
        return null;
      }

      case ARTIFACT_TYPE.VIDEO: {
        // Python: entry[8] area — iterate for HTTP URLs in nested lists
        for (let i = entry.length - 1; i >= 5; i--) {
          const item = entry[i];
          if (!Array.isArray(item)) continue;
          for (const sub of item) {
            if (Array.isArray(sub) && Array.isArray(sub[0]) && isValidMediaUrl(sub[0][0])) {
              return sub[0][0];
            }
          }
        }
        return null;
      }

      case ARTIFACT_TYPE.INFOGRAPHIC: {
        // Python: walk backwards, URL at item[2][0][1][0]
        for (let i = entry.length - 1; i >= 0; i--) {
          const item = entry[i];
          if (!Array.isArray(item) || item.length <= 2) continue;
          const content = item[2];
          if (!Array.isArray(content) || content.length === 0) continue;
          const firstContent = content[0];
          if (!Array.isArray(firstContent) || firstContent.length <= 1) continue;
          const imgData = firstContent[1];
          if (Array.isArray(imgData) && imgData.length > 0 && isValidMediaUrl(imgData[0])) {
            return imgData[0];
          }
        }
        return null;
      }

      case ARTIFACT_TYPE.SLIDE_DECK: {
        // Python: metadata[3] (PDF) or metadata[4] (PPTX)
        // Find the metadata array (last list item with enough elements)
        for (let i = entry.length - 1; i >= 5; i--) {
          const metadata = entry[i];
          if (!Array.isArray(metadata) || metadata.length < 4) continue;
          const pptxUrl = metadata[4];
          const pdfUrl = metadata[3];
          if (opts.format === 'pptx' && isValidMediaUrl(pptxUrl)) return pptxUrl;
          if (isValidMediaUrl(pdfUrl)) return pdfUrl;
          if (isValidMediaUrl(pptxUrl)) return pptxUrl;
        }
        return null;
      }

      default:
        // Text artifacts (report, quiz, etc.) use GET_INTERACTIVE_HTML RPC, not URL download
        return null;
    }
  } catch {
    return null;
  }
}

function isValidMediaUrl(value) {
  return typeof value === 'string' && (value.startsWith('https://') || value.startsWith('http://'));
}
```

- [ ] **Step 4: Add to `__testing__` export**

```js
export const __testing__ = { buildArtifactParams, extractMediaUrl };
```

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js mcp/tests/test-notebooklm.js
git commit -m "feat(nlm): extractMediaUrl — port Python URL extraction to JS"
```

---

### Task 3: Add `fetch_url` proxy type to content script

**Files:**
- Modify: `platforms/notebooklm/content.js:1033-1116` (the `executeRpcProxy` function)

- [ ] **Step 1: Add `fetch_url` handling to `executeRpcProxy()`**

In the `executeRpcProxy` function, add a new branch for `type === 'fetch_url'`:

```js
} else if (type === 'fetch_url') {
  // Authenticated URL fetch — download a URL using browser cookies
  // Used for binary artifact downloads (infographic PNG, audio MP3, etc.)
  const { url } = request;

  // Validate URL domain — only allow trusted Google domains
  const parsed = new URL(url);
  const trusted = ['.google.com', '.googleusercontent.com', '.googleapis.com'];
  if (parsed.protocol !== 'https:' || !trusted.some(d => parsed.hostname === d.slice(1) || parsed.hostname.endsWith(d))) {
    return { success: false, error: `Untrusted download domain: ${parsed.hostname}` };
  }

  const res = await fetch(url, {
    credentials: 'include',
    headers: authHeader ? { 'Authorization': authHeader } : {},
  });

  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}`, status: res.status };
  }

  // Check for auth redirect (HTML instead of binary)
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    return { success: false, error: 'Received HTML instead of media file — auth may have expired' };
  }

  // Convert binary to base64 for text-based bridge transport
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return {
    success: true,
    base64Data: base64,
    contentType,
    size: bytes.length,
  };
}
```

- [ ] **Step 2: Build extension**

```bash
cd /home/penguinzyue/kyt-validation-sprint && node scripts/build.js
```

- [ ] **Step 3: Commit**

```bash
git add platforms/notebooklm/content.js
git commit -m "feat(nlm): add fetch_url proxy type for binary artifact downloads"
```

---

### Task 4: Add `proxyFetchUrl()` to MCP client

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js`

- [ ] **Step 1: Implement `proxyFetchUrl()`**

Add near `tryProxyRpc()`:

```js
/**
 * Fetch a URL through the browser proxy relay with full cookie authentication.
 * Returns raw binary data as a Buffer.
 *
 * @param {string} url - URL to fetch (must be https on trusted Google domain)
 * @returns {Promise<{ data: Buffer, contentType: string, size: number } | null>}
 */
export async function proxyFetchUrl(url) {
  if (!_proxyAvailable && _proxyAvailable !== null) return null;

  try {
    const res = await fetch(`${RPC_PROXY_URL}/rpc`, {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({
        type: 'fetch_url',
        url,
      }),
      signal: AbortSignal.timeout(95000), // 90s bridge + 5s buffer
    });

    if (!res.ok) return null;
    const result = await res.json();

    if (!result.success || !result.base64Data) {
      return null;
    }

    const data = Buffer.from(result.base64Data, 'base64');
    return { data, contentType: result.contentType, size: result.size };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Run tests (existing should still pass)**

- [ ] **Step 3: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js
git commit -m "feat(nlm): proxyFetchUrl — binary download via browser proxy relay"
```

---

### Task 5: Rewrite `download-artifact.js` to use native download

**Files:**
- Modify: `mcp/src/tools/download-artifact.js`

- [ ] **Step 1: Add imports for new functions**

```js
import {
  setPassphrase, hasPassphrase,
  listArtifactsRaw, extractMediaUrl, proxyFetchUrl,
} from '../lib/notebooklm-client.js';
import { ARTIFACT_TYPE } from '../lib/notebooklm-constants.js';
```

- [ ] **Step 2: Add type-to-code mapping**

```js
const TYPE_CODE = {
  audio:       ARTIFACT_TYPE.AUDIO,
  video:       ARTIFACT_TYPE.VIDEO,
  slide_deck:  ARTIFACT_TYPE.SLIDE_DECK,
  infographic: ARTIFACT_TYPE.INFOGRAPHIC,
};
```

- [ ] **Step 3: Rewrite the download logic for binary artifacts**

Replace the Python CLI invocation block (lines ~103-135) with a two-path approach:

```js
// --- Binary artifacts: native download via proxy relay ---
if (config.binary) {
  const typeCode = TYPE_CODE[type];

  if (typeCode) {
    // Step 1: Get raw artifact data via proxy RPC
    const rawEntries = await listArtifactsRaw(notebookId);

    // Step 2: Find target artifact
    let targetEntry = null;
    for (const entry of rawEntries) {
      if (!Array.isArray(entry)) continue;
      if (artifactId && entry[0] === artifactId) { targetEntry = entry; break; }
      if (!artifactId && entry[2] === typeCode && (entry[4] === 3 || entry[3] === 3)) {
        targetEntry = entry;
        break;
      }
    }

    if (!targetEntry) {
      return { content: [{ type: 'text', text: `No completed ${type} artifact found.${artifactId ? ` ID: ${artifactId}` : ''}` }], isError: true };
    }

    // Step 3: Extract media URL
    const mediaUrl = extractMediaUrl(targetEntry, typeCode, { format });
    if (!mediaUrl) {
      return { content: [{ type: 'text', text: `Could not extract download URL from ${type} artifact. The artifact may still be processing.` }], isError: true };
    }

    // Step 4: Download via proxy relay
    const result = await proxyFetchUrl(mediaUrl);
    if (!result) {
      // Fallback: try Python CLI (if available)
      return tryPythonCliFallback(notebookId, type, artifactId, config, format, outputPath);
    }

    // Step 5: Write to disk
    writeFileSync(outputPath, result.data);
    // ... (continue with existing size reporting + K.Y.T. save logic)
  }
}

// --- Text artifacts: use GET_INTERACTIVE_HTML RPC (existing path) ---
// ... keep existing Python CLI path for text artifacts ...
```

- [ ] **Step 4: Extract Python CLI path into a fallback function**

Move the existing Python CLI invocation into `tryPythonCliFallback()` so it's still available if the proxy path fails:

```js
function tryPythonCliFallback(notebookId, type, artifactId, config, format, outputPath) {
  try {
    const args = ['download', config.cli, outputPath];
    if (artifactId) args.push('-a', artifactId);
    args.push('-n', notebookId);
    if (format) args.push('--format', format);

    execFileSync('notebooklm', args, { timeout: 120000, encoding: 'utf-8' });

    if (existsSync(outputPath)) {
      const stat = statSync(outputPath);
      return { content: [{ type: 'text', text: `Downloaded ${type} (CLI fallback). File: ${outputPath} Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB` }] };
    }
    return { content: [{ type: 'text', text: 'CLI fallback also failed.' }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Native download failed and CLI fallback failed: ${err.message}` }], isError: true };
  }
}
```

- [ ] **Step 5: Remove auth sync block**

Delete the Python CLI auth sync block (lines ~103-118) since the primary path no longer needs it. The fallback still works without it (CLI uses its own auth).

- [ ] **Step 6: Run tests**

- [ ] **Step 7: Commit**

```bash
git add mcp/src/tools/download-artifact.js
git commit -m "feat(nlm): native binary artifact download via proxy relay, CLI fallback"
```

---

### Task 6: Build, reconnect, and verify end-to-end

- [ ] **Step 1: Build extension with new content script**

```bash
cd /home/penguinzyue/kyt-validation-sprint && node scripts/build.js
```

- [ ] **Step 2: Reload extension in Chrome**

Open `chrome://extensions/`, click reload on K.Y.T.

- [ ] **Step 3: Reconnect MCP server**

User runs `/mcp`

- [ ] **Step 4: Run full test suite**

```bash
cd /home/penguinzyue/kyt-validation-sprint/mcp && node --test tests/test-notebooklm.js
```

- [ ] **Step 5: Live test — generate + download infographic**

```
generate_artifact notebookId=8a335f0b type=infographic style=sketch_note waitForCompletion=true
```

Wait for completion, then:

```
download_artifact notebookId=8a335f0b type=infographic artifactId=<from above>
```

Confirm: PNG file appears at `~/.kyt/downloads/` with non-zero size.

- [ ] **Step 6: Live test — download the already-generated infographic**

```
download_artifact notebookId=8a335f0b type=infographic artifactId=ef7c03b2-4b63-46eb-b16e-b9bae9e5da2a
```

This uses the infographic we already generated in the enum fix session.

## Security Assessment

<security_assessment>

### Critical -- None identified

### High
**H1. URL domain validation in content script**
- Description: The `fetch_url` handler fetches arbitrary URLs with browser cookies attached
- Impact: If an attacker could inject a URL, they could exfiltrate cookies to a malicious domain
- Mitigation: Domain allowlist enforced in content script (`google.com`, `googleusercontent.com`, `googleapis.com` only). URLs originate from Google's own RPC response, never from user input. Same validation as Python CLI's `_download_url`.

### Medium -- None identified

### Low
**L1. Base64 memory overhead for large artifacts**
- Description: Binary data is base64-encoded in the content script and decoded in Node.js, holding ~2x the artifact size in memory
- Impact: For very large artifacts (e.g., 50MB video), this could cause memory pressure
- Mitigation: Infographics are typically 1-5MB (PNG). Audio/video could be larger but the same bridge is already handling 3MB+ streaming RPC responses. For v1 this is acceptable. Streaming base64 (chunked transfer) can be added later if needed.

### Edge Cases
- Artifact URL expired between extraction and fetch → `proxyFetchUrl` returns null → falls back to Python CLI
- Bridge not running (no NLM tab open) → proxy unavailable → falls back to Python CLI
- Very large video artifact → base64 may exceed practical memory limits → CLI fallback handles it
- `listArtifactsRaw` returns entries without media URLs (artifact still processing) → `extractMediaUrl` returns null → clear error message

</security_assessment>

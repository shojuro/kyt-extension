# NLM Proxy Reliability Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix intermittent read failures (listSources/listNotebooks) that break ask_notebook and generate_artifact.

**Architecture:** Two-phase fix. Phase 1 adds a source ID cache in the MCP client so read failures don't cascade to tool operations. Phase 2 adds a chrome.alarms watchdog to the service worker's RPC poll loop so it survives SW termination.

**Tech Stack:** Node.js (MCP server), Chrome MV3 service worker APIs

---

### Task 1: Add source ID cache to notebooklm-client.js

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js`

- [ ] **Step 1: Add cache data structure after the existing module-level state**

Insert after line 47 (`let _proxyAvailable = null;`):

```js
// ── Source ID cache ─────────────────────────────────────────
// Prevents cascading failures when listSources RPC is flaky.
// Populated on successful listSources(), consumed by askQuestion() and tool handlers.
const _sourceCache = new Map(); // Map<notebookId, { sources: Array, fetchedAt: number }>
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

- [ ] **Step 2: Modify listSources to populate cache on success**

Replace the existing `listSources` function body (starts at line 664). The function signature stays the same. Add cache population at the end, and prefer cache over empty results:

```js
export async function listSources(notebookId) {
  const result = await rpcCall(RPC.GET_NOTEBOOK, [notebookId, null, [2], null, 0], {
    sourcePath: `/notebook/${notebookId}`,
  });

  if (!result || !Array.isArray(result)) {
    // RPC returned empty — use cache if available (stale > wrong-empty)
    const cached = _sourceCache.get(notebookId);
    if (cached && cached.sources.length > 0) {
      process.stderr.write(`[listSources] RPC returned empty, using cached ${cached.sources.length} sources\n`);
      return cached.sources;
    }
    return [];
  }

  // Sources are at result[0][1] — array of source entries
  const rawSources = result?.[0]?.[1];
  if (!Array.isArray(rawSources)) {
    const cached = _sourceCache.get(notebookId);
    if (cached && cached.sources.length > 0) {
      process.stderr.write(`[listSources] No sources in result structure, using cached ${cached.sources.length} sources\n`);
      return cached.sources;
    }
    return [];
  }

  const sources = [];
  for (const src of rawSources) {
    if (!Array.isArray(src)) continue;
    let id = null;
    if (Array.isArray(src[0]) && typeof src[0][0] === 'string') {
      id = src[0][0];
    } else if (typeof src[0] === 'string') {
      id = src[0];
    }
    const title = typeof src[1] === 'string' ? src[1] : 'Untitled';
    if (id) {
      sources.push({
        id,
        title,
        type: detectSourceType(src),
        status: null,
        url: extractSourceUrl(src),
      });
    }
  }

  // Cache on success
  if (sources.length > 0) {
    _sourceCache.set(notebookId, { sources, fetchedAt: Date.now() });
  }

  return sources;
}
```

- [ ] **Step 3: Add getCachedSourceIds and invalidateSourceCache exports**

Add after the `listSources` function:

```js
/**
 * Get cached source IDs for a notebook (no RPC call).
 * Returns null if cache is empty or expired.
 *
 * @param {string} notebookId
 * @returns {{ ids: string[], stale: boolean } | null}
 */
export function getCachedSourceIds(notebookId) {
  const cached = _sourceCache.get(notebookId);
  if (!cached || cached.sources.length === 0) return null;
  const stale = Date.now() - cached.fetchedAt > SOURCE_CACHE_TTL_MS;
  return { ids: cached.sources.map(s => s.id), stale };
}

/**
 * Invalidate the source cache for a notebook.
 * Call after adding/removing sources.
 *
 * @param {string} notebookId
 */
export function invalidateSourceCache(notebookId) {
  _sourceCache.delete(notebookId);
}
```

- [ ] **Step 4: Modify askQuestion to use cache**

Replace lines 475-483 (the sourceIds fetching block inside `askQuestion`) with:

```js
  // Use cached source IDs if available, fall back to live fetch
  let sourceIds = [];
  const cached = getCachedSourceIds(notebookId);
  if (cached && !cached.stale) {
    sourceIds = cached.ids.map(id => [[id]]);
  } else {
    try {
      const sources = await listSources(notebookId);
      sourceIds = sources.map(s => [[s.id]]);
    } catch (e) {
      // listSources failed — try stale cache as last resort
      if (cached) {
        sourceIds = cached.ids.map(id => [[id]]);
        process.stderr.write(`[askQuestion] listSources failed, using stale cache (${cached.ids.length} sources)\n`);
      } else {
        process.stderr.write(`[askQuestion] Warning: could not fetch sources: ${e.message}\n`);
      }
    }
  }
```

- [ ] **Step 5: Invalidate cache in addTextSource**

Add at the end of the `addTextSource` function, before the `return { sourceId }` line (around line 424):

```js
  // Invalidate source cache — source list has changed
  invalidateSourceCache(notebookId);

  return { sourceId };
```

- [ ] **Step 6: Invalidate cache in addSource**

Add at the end of the `addSource` function, before the `return { sourceId }` line (around line 655):

```js
  // Invalidate source cache — source list has changed
  invalidateSourceCache(notebookId);

  return { sourceId };
```

- [ ] **Step 7: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js
git commit -m "fix(nlm): add source ID cache to prevent read-flakiness cascading

listSources RPC intermittently returns empty through the proxy.
Cache successful results so askQuestion and generateArtifact don't
fail when the next listSources call hits a dead poll cycle.
Stale cache preferred over wrong-empty results."
```

### Task 2: Wire cache into tool handlers

**Files:**
- Modify: `mcp/src/tools/generate-artifact.js`
- Modify: `mcp/src/tools/generate-mind-map.js`
- Modify: `mcp/src/tools/add-source.js`

- [ ] **Step 1: Update generate-artifact.js to use cache fallback**

Replace lines 7-8 (the import) with:

```js
import { generateArtifact, listSources, getCachedSourceIds, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
```

Replace lines 60-68 (the source resolution block) with:

```js
    if (!resolvedSourceIds || resolvedSourceIds.length === 0) {
      const sources = await listSources(notebookId);
      resolvedSourceIds = sources.map(s => s.id);
      if (resolvedSourceIds.length === 0) {
        // listSources returned empty — try cache
        const cached = getCachedSourceIds(notebookId);
        if (cached) {
          resolvedSourceIds = cached.ids;
        } else {
          return {
            content: [{ type: 'text', text: 'Error: Notebook has no sources. Add sources before generating artifacts.' }],
            isError: true,
          };
        }
      }
    }
```

- [ ] **Step 2: Read the current import line in generate-artifact.js**

Read the file to find the exact current import line before editing.

- [ ] **Step 3: Update generate-mind-map.js with same pattern**

Read the file's import line, then update imports to include `getCachedSourceIds`:

```js
import { generateMindMap, listSources, getCachedSourceIds, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
```

Update the source resolution block (lines 33-41) with the same cache-fallback pattern as generate-artifact.js.

- [ ] **Step 4: Update add-source.js to invalidate cache**

Add `invalidateSourceCache` to the import:

```js
import { addSource, invalidateSourceCache, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
```

Add after the `addSource` call succeeds (after line 68):

```js
    // Invalidate source cache so next listSources call gets fresh data
    invalidateSourceCache(notebookId);
```

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/generate-artifact.js mcp/src/tools/generate-mind-map.js mcp/src/tools/add-source.js
git commit -m "fix(nlm): wire source ID cache into tool handlers

generate-artifact and generate-mind-map fall back to cached source IDs
when listSources returns empty. add-source invalidates the cache after
adding so the next fetch gets the updated list."
```

### Task 3: Reduce proxy poisoning window

**Files:**
- Modify: `mcp/src/lib/notebooklm-client.js`

- [ ] **Step 1: Reduce PROXY_RECHECK_MS from 60s to 10s**

Find and replace:

```js
const PROXY_RECHECK_MS = 60_000;
```

with:

```js
const PROXY_RECHECK_MS = 10_000;
```

- [ ] **Step 2: Add write-success proxy reset in rpcCall**

In the `rpcCall` function, after a successful proxy decode (around line 258), add a comment and ensure `_proxyAvailable` is set:

The existing code already sets `_proxyAvailable = true` in `tryProxyRpc` on success (line 226). No change needed there. The 10s reduction alone eliminates the 60s blackout.

- [ ] **Step 3: Commit**

```bash
git add mcp/src/lib/notebooklm-client.js
git commit -m "fix(nlm): reduce proxy poisoning window from 60s to 10s

One failed proxy call previously disabled the proxy for 60 seconds.
This caused cascading failures for all subsequent NLM operations.
10s is enough to avoid hammering a dead proxy while recovering faster."
```

### Task 4: Add alarm-backed polling watchdog

**Files:**
- Modify: `src/nlm-rpc-proxy.js`
- Modify: `background.js`

- [ ] **Step 1: Add alarm watchdog to nlm-rpc-proxy.js**

Add a new exported function after `stopRpcProxy()`:

```js
/**
 * Alarm watchdog handler — restarts polling if SW was terminated and restarted.
 * Called from background.js alarm listener.
 */
export function handleRpcPollAlarm() {
  if (!_polling) return; // proxy was intentionally stopped
  // If no active poll timer, the SW was terminated and restarted.
  // setTimeout timers don't survive SW termination, so restart polling.
  if (!_pollTimer) {
    console.log('[KYT RPC Proxy] Watchdog: restarting poll loop after SW restart');
    schedulePoll();
  }
}
```

- [ ] **Step 2: Update the import in background.js**

Find the existing import line:

```js
import { startRpcProxy, stopRpcProxy, isRpcProxyRunning, getRpcProxyStatus } from './src/nlm-rpc-proxy.js';
```

Replace with:

```js
import { startRpcProxy, stopRpcProxy, isRpcProxyRunning, getRpcProxyStatus, handleRpcPollAlarm } from './src/nlm-rpc-proxy.js';
```

- [ ] **Step 3: Create the watchdog alarm**

Find the line `startRpcProxy();` (around line 1055) and add the alarm after it:

```js
startRpcProxy();
chrome.alarms.create('kytRpcPoll', { delayInMinutes: 0.5, periodInMinutes: 0.5 });
```

- [ ] **Step 4: Add alarm handler in the consolidated listener**

In the `chrome.alarms.onAlarm.addListener` switch statement, add a new case before the `default`:

```js
    case 'kytRpcPoll':
      handleRpcPollAlarm();
      break;
```

- [ ] **Step 5: Commit**

```bash
git add src/nlm-rpc-proxy.js background.js
git commit -m "fix(nlm): add alarm watchdog for RPC proxy polling

MV3 service workers can be terminated at any time, killing setTimeout-
based poll loops. A 30-second chrome.alarm acts as a watchdog — if the
SW restarts and the poll timer is gone, the alarm handler restarts it.
Ensures RPC proxy stays alive across SW termination cycles."
```

### Task 5: Rebuild and verify

**Files:**
- Run: `scripts/build-extension.sh`

- [ ] **Step 1: Rebuild the extension**

```bash
bash scripts/build-extension.sh /mnt/c/kyt-extension
```

- [ ] **Step 2: Reload extension in Chrome and verify**

1. Reload the extension in `chrome://extensions`
2. Open NotebookLM tab
3. Test `list_sources` for the Co-Work Education notebook
4. Test `ask_notebook` — should use cached source IDs
5. Check SW console for `[KYT RPC Proxy] Watchdog` logs after 30s idle

- [ ] **Step 3: Final commit with build script**

```bash
git add -A
git commit -m "chore: rebuild extension with NLM proxy reliability fixes"
```

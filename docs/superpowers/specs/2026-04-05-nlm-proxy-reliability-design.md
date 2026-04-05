# NotebookLM Proxy Reliability Fix

**Date:** 2026-04-05
**Status:** Approved

## Problem

Read RPCs through the NLM proxy (listSources, listNotebooks) fail intermittently while write RPCs (createNotebook, addSource, startResearch) succeed. This breaks `ask_notebook` (depends on listSources for source IDs) and `generate_artifact` (same dependency).

### Root Causes

1. **No source ID caching** — Every `askQuestion` and `generateArtifact` call triggers a fresh `listSources` RPC. If that single call fails, the entire operation fails.
2. **setTimeout-based polling** — `nlm-rpc-proxy.js` uses `setTimeout(fn, 1000)` which Chrome MV3 can kill when the service worker terminates. Polling stops until the SW restarts.
3. **_proxyAvailable poisoning** — One failed proxy call disables the proxy for 60 seconds, cascading to all subsequent calls.

## Fix 1: Source ID Cache (immediate)

### Design

Add a per-notebook cache in `notebooklm-client.js`:

```js
// Map<notebookId, { sourceIds: string[], fetchedAt: number }>
const _sourceCache = new Map();
const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

**Cache population:** After any successful `listSources(notebookId)` call, store the result.

**Cache consumption:**
- `askQuestion()` — use cached source IDs if fresh, skip the `listSources` call entirely
- Tool handlers (`generate-artifact.js`, `generate-mind-map.js`) — try cache first, fall back to live `listSources`

**Cache invalidation:**
- `addTextSource()` / `addTextSources()` — delete cache entry for that notebook (source list changed)
- `addSource()` (from tool handler) — same
- TTL expiry — 5 minutes, after which the next call refreshes
- New export: `invalidateSourceCache(notebookId)` for external callers

**Cache-miss retry:** If `listSources` returns empty AND the cache has a non-expired entry with sources, prefer the cache (stale > wrong-empty).

### Files Modified

- `mcp/src/lib/notebooklm-client.js` — add cache Map, populate in `listSources`, consume in `askQuestion`, invalidate in `addTextSource`/`addTextSources`, export `invalidateSourceCache`
- `mcp/src/tools/generate-artifact.js` — import and try `getCachedSourceIds()` before calling `listSources`
- `mcp/src/tools/generate-mind-map.js` — same pattern
- `mcp/src/tools/add-source.js` — call `invalidateSourceCache()` after adding

## Fix 2: Alarm-Backed Polling (root cause)

### Design

Replace the pure-setTimeout poll loop with a hybrid approach:

**chrome.alarms as watchdog:** Create a `kytRpcPoll` alarm at 30-second intervals. The alarm handler checks if polling is active; if not (SW was terminated and restarted), it restarts the poll loop.

**setTimeout for actual polling:** Keep the 1s `setTimeout` loop for responsiveness during active sessions. The alarm is just a safety net.

**Keepalive during active relay:** When processing an RPC request, extend the SW lifetime using the `chrome.runtime.getContexts` API (Chrome 116+) or a self-ping pattern to prevent termination mid-relay.

### _proxyAvailable fix

Reduce the poison duration from 60s to 10s. Add a successful-write bypass: if a write RPC succeeds through the proxy, immediately reset `_proxyAvailable = true` (proves the proxy is alive even if a read failed).

### Files Modified

- `src/nlm-rpc-proxy.js` — add `chrome.alarms` watchdog, keepalive during relay
- `background.js` — register alarm handler for `kytRpcPoll`
- `mcp/src/lib/notebooklm-client.js` — reduce `PROXY_RECHECK_MS` from 60s to 10s, add write-success reset

## Verification

1. **Cache fix:** Call `ask_notebook` immediately after `list_sources` — should use cached IDs, not re-fetch
2. **Cache invalidation:** Call `add_source`, then `list_sources` — should show updated list
3. **Alarm fix:** Let the extension sit idle for 60s (SW terminates), then call `ask_notebook` — should still work
4. **Parallel calls:** Generate 3 artifacts simultaneously — all should succeed

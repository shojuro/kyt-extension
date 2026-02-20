# KYT RAG System — Complete Pipeline Flowchart v2

> **Last updated:** 2026-02-20 | **Branch:** `feature/history-import` | **HEAD:** `9ab9563`

---

## System Architecture Overview

The KYT extension operates across **four security boundaries**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BROWSER TAB (ChatGPT / Claude)                                              │
│                                                                             │
│  ┌──────────────────────┐      ┌──────────────────────────────────┐        │
│  │  PAGE CONTEXT (MAIN)  │      │  CONTENT SCRIPT (ISOLATED)       │        │
│  │  inject.js            │◄────►│  content.js / content_bridge.js  │        │
│  │  • fetch() intercept  │ DOM  │  • queue-manager.js              │        │
│  │  • DOM injection      │events│  • Message routing               │        │
│  └──────────────────────┘      └─────────────┬────────────────────┘        │
│                                               │ chrome.runtime.sendMessage  │
└───────────────────────────────────────────────┼─────────────────────────────┘
                                                │
                    ┌───────────────────────────┼──────────────────────────┐
                    │  BACKGROUND SERVICE WORKER │                         │
                    │  background.js             ▼                         │
                    │  • GET_CONTEXT handler (retrieval)                   │
                    │  • SAVE_MESSAGE handler (capture)                    │
                    │  • browser-search.js (client hybrid search)          │
                    │  • browser-sync.js (Supabase sync)                   │
                    │  • edge-search.js (server pipeline caller)           │
                    │  • All post-processing modules                       │
                    └────────────────────────┬─────────────────────────────┘
                                             │ HTTPS
                    ┌────────────────────────┼─────────────────────────────┐
                    │  SUPABASE BACKEND      ▼                             │
                    │  • Edge Functions (search_memories, backfill_entities)│
                    │  • PostgreSQL RPCs (match_messages_v2, graph_walk)   │
                    │  • PostgREST (messages, chat_turns tables)           │
                    └──────────────────────────────────────────────────────┘
```

Two parallel pipelines share this architecture:

| Pipeline | Trigger | Direction | Purpose |
|----------|---------|-----------|---------|
| **Retrieval** (Read) | User submits a message | Page → Background → Supabase → Background → Page | Find and inject relevant memories |
| **Capture/Sync** (Write) | LLM responds | Page → Background → Supabase | Store conversations for future retrieval |

---

## PIPELINE 1: RETRIEVAL (User Input → LLM Injection)

### Master Flowchart

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  USER TYPES MESSAGE & HITS SEND on ChatGPT/Claude                   │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ STEP 1: FETCH INTERCEPT (inject.js, MAIN world)                     │
  │ window.fetch() wrapper intercepts POST to /backend-api/conversation │
  │ Extracts userMessage from body.messages[last].content.parts[0]      │
  │ Dispatches KYT_CONTEXT_REQUEST CustomEvent to page                  │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ DOM CustomEvent
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ STEP 2: CONTENT SCRIPT BRIDGE (content.js, ISOLATED world)          │
  │ Listens for KYT_CONTEXT_REQUEST                                     │
  │ Sends chrome.runtime.sendMessage({ type: 'GET_CONTEXT' })           │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ chrome.runtime.sendMessage
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ STEP 3: BACKGROUND HANDLER (background.js)                          │
  │ case 'GET_CONTEXT' → getContextForInjection(userMessage, config)    │
  │ 20s timeout (Promise.race)                                          │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
         ┌───────────────────┐     ┌───────────────────┐
         │ ROUTING MODE:     │     │ ROUTING MODE:     │
         │ 'edge'            │     │ 'legacy'          │
         │ (authenticated)   │     │ (no auth / local) │
         └────────┬──────────┘     └────────┬──────────┘
                  │                         │
                  ▼                         ▼
  ┌──────────────────────────┐  ┌──────────────────────────┐
  │ STEP 5a: EDGE SEARCH     │  │ STEP 4: QUERY TRANSFORM  │
  │ searchViaEdgeFunction()  │  │ transformQuery() via      │
  │ (src/edge-search.js)     │  │ GPT-3.5-turbo (3s limit)  │
  │ Calls search_memories    │  │ (src/query-transformer.js)│
  │ edge function            │  │                           │
  │ topK=15, useHyde=true    │  │ then:                     │
  │                          │  │ STEP 5b: CLIENT SEARCH    │
  │ ┌──────────────────────┐│  │ searchHybrid()            │
  │ │ SERVER-SIDE PIPELINE ││  │ (src/browser-search.js)   │
  │ │ (Steps 6.1 → 6.9)   ││  │ BM25+semantic+graph+HyDE  │
  │ │ See below            ││  │ +RRF+Jina rerank          │
  │ └──────────────────────┘│  └─────────────┬─────────────┘
  └────────────┬─────────────┘               │
               │                              │
               └──────────┬───────────────────┘
                          │ (merged results array)
                          ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ STEP 7: CLIENT POST-PROCESSING (background.js)                      │
  │ 7.1  Recency multiplier (30-day half-life)                          │
  │ 7.2  Recursion guard (strip KYT injection echoes)                   │
  │ 7.3  Meta flag filter (drop meta=true items)                        │
  │ 7.4  Deflection penalty (assistant-quality-detector.js)             │
  │ 7.5  KYT meta-conversation penalty (0.3×)                          │
  │ 7.6  Echo penalty (0.4×)                                           │
  │ 7.7  Exact dedup (normalized content hash)                          │
  │ 7.8  Entity-aware recency resolution (newest 1.5×, older 0.8×)     │
  │ 7.9  MMR diversity selection (λ=0.5, maxContextItems=3)             │
  │ 7.10 Keyword boost (+30% for keyword coverage)                      │
  │ 7.11 Confidence filter (adaptive: 0.40 Jina / 0.25 BM25-only)      │
  │      + low-confidence rescue tier (≥0.15: keep top 2)               │
  │      + deflection guard on rescued items                            │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
               ┌─────────────────┴─────────────────┐
               ▼                                   ▼
    ┌─────────────────────┐             ┌─────────────────────┐
    │ Items found          │             │ No items survived    │
    │ (filteredItems > 0)  │             │ filters              │
    └──────────┬──────────┘             └──────────┬──────────┘
               ▼                                   ▼
  ┌──────────────────────┐             ┌──────────────────────┐
  │ STEP 8: BUILD        │             │ formattedContext=null │
  │ INJECTION BLOCK      │             │ (no injection)       │
  │ buildMemoryInjection │             │ buildEmptyInjection  │
  │ (kyt-memory-         │             │ returns null         │
  │  injection-builder.js│             └──────────┬──────────┘
  └──────────┬───────────┘                        │
             │                                     │
             └──────────────┬──────────────────────┘
                            │ sendResponse(contextData)
                            ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ STEP 9: DOM INJECTION (inject.js, MAIN world)                       │
  │ Receives KYT_CONTEXT_RESPONSE via CustomEvent                       │
  │ If formattedContext != null:                                         │
  │   Insert system message at body.messages[n-1] (before user msg)     │
  │   { author: { role: 'system' }, content: { parts: [context] } }     │
  │ Resolve pending fetch() with modified body → sent to LLM API        │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Detail

---

### STEP 1: Fetch Intercept

**File:** `platforms/chatgpt/inject.js` (MAIN world, injected via `web_accessible_resources`)

**What happens:**
The script wraps `window.fetch` at page load. When ChatGPT's frontend calls `fetch()` to POST the user's message to `/backend-api/conversation`, the wrapper fires first.

**Flow:**
1. Intercepts the outgoing `fetch()` POST to ChatGPT's `/backend-api/conversation`
2. Parses the request body JSON
3. Extracts `userMessage` from `body.messages[last].content.parts[0]`
4. Calls `getAndInjectContext(bodyString)` **before** the original fetch proceeds
5. Dispatches a `KYT_CONTEXT_REQUEST` CustomEvent to the page DOM with `{ requestId, userMessage, config }`
6. Holds the fetch in a pending Promise — the real API call is delayed until context arrives or timeout (25s)

**Config (hardcoded in inject.js):**
```javascript
threshold: 0.5,
maxContextItems: 5   // page-side default; overridden to 3 in background.js
```

**Why MAIN world?** Only MAIN world scripts can wrap `window.fetch`. Content scripts in ISOLATED world cannot access page JS globals.

---

### STEP 2: Content Script Bridge

**File:** `platforms/chatgpt/content.js` (ISOLATED world)

**What happens:**
The content script acts as the security bridge between the page context (MAIN world, untrusted) and the background service worker (trusted, full extension APIs).

**Flow:**
1. Listens for `KYT_CONTEXT_REQUEST` CustomEvent on `window`
2. Forwards the request to the background via `chrome.runtime.sendMessage({ type: 'GET_CONTEXT', userMessage, config })`
3. Receives the response from the background's `sendResponse` callback
4. Dispatches `KYT_CONTEXT_RESPONSE` CustomEvent back to the page with the formatted context

**Why this bridge exists:** Chrome MV3 content scripts in ISOLATED world can call `chrome.runtime.sendMessage()`, but MAIN world scripts cannot. The content script is the only layer that spans both worlds.

---

### STEP 3: Background Handler

**File:** `background.js`, `case 'GET_CONTEXT'` (line ~1894)

**What happens:**
The background service worker receives the GET_CONTEXT message and invokes the main retrieval orchestration function.

**Flow:**
```javascript
case 'GET_CONTEXT':
  const contextData = await Promise.race([
    getContextForInjection(message.userMessage, config),
    timeout(20000)  // 20s hard timeout
  ]);
  sendResponse(contextData);
```

**Timeout budget:**
- Background: 20s for entire retrieval pipeline
- Page-side (inject.js): 25s (5s margin above background)
- If timeout: `formattedContext = null`, original message sent unmodified

---

### STEP 4: Query Transformation (Legacy Path Only)

**File:** `src/query-transformer.js`

**When it runs:** Only in `legacy` routing mode (unauthenticated users / no edge function access), AND when the OpenAI API key is available AND the HyDE circuit breaker is not open.

**What happens:**
Transforms the user's natural-language message into optimized search terms using GPT-3.5-turbo.

**Flow:**
1. **Fetch recent topics:** `fetchRecentTopicsFromSupabase(apiConfig)` — gets recent conversation topics for context
2. **Check if already optimized:** `isAlreadyOptimized(query)` — if query already has 2+ technical/emotional terms, skip LLM call
3. **LLM call:** Sends to GPT-3.5-turbo with system prompt: *"Transform vague query into 5-10 specific search terms"*
4. **Pollution detection:** `detectQueryPollution()` — if >50% of words in the transformed query are new (semantic drift), fall back to original query. Catches garbage like *"Friend function YC Combinator"* from a *"Who is my friend?"* query
5. **Return:** `{ optimizedQuery, transformed: true/false }`

**Timeout:** 3 seconds. On any failure, silently falls back to original user message.

**Example:**
```
Input:  "what's my favorite car?"
Output: "favorite car vehicle automobile preference personal"
```

---

### STEP 5a: Edge Search Path (Authenticated Users)

**File:** `src/edge-search.js`, `searchViaEdgeFunction()`

**When it runs:** When `routingMode === 'edge'` (user is authenticated with Supabase).

**What happens:**
Calls the Supabase `search_memories` edge function which runs the full server-side pipeline (Steps 6.1–6.9).

**Call:**
```javascript
callEdgeFunction('search_memories', {
  query: userMessage,   // original message (no client-side transformation)
  userId,
  useHyde: true,
  hydeWeight: 0.6,
  topK: 15              // candidatePoolSize
});
// timeoutMs = 25000
```

**Result mapping:** Each server result is mapped to a standardized format:
```javascript
{
  content,
  role,                    // often 'unknown' (server drops speakers[])
  timestamp,               // mapped from: created_at || timestamp || start_timestamp
  cross_encoder_score,     // Jina reranker score (0-1, calibrated)
  distance,                // cosine distance from vector search
  weighted_score,          // RRF weighted score
  rrf_score,               // reciprocal rank fusion score
  entities: [],            // canonical names from GPT-4o-mini extraction
  source: 'edge'
}
```

---

### STEP 5b: Client-Side Hybrid Search (Legacy Path)

**File:** `src/browser-search.js`, `searchHybrid()` (line 742)

**When it runs:** When `routingMode === 'legacy'`.

**What happens:**
Runs up to 5 parallel search strategies, merges via RRF, then reranks with Jina cross-encoder.

**Call:**
```javascript
searchHybrid(queryToUse, {
  limit: 15,                // candidatePoolSize
  semanticThreshold: 0.50,
  bm25Threshold: 0.1,
  enableBM25: true,
  enableSemantic: apiAvailable,
  enableHyDE: apiAvailable && !!apiConfig.openaiKey,
  enableGraph: true,
  maxTimestamp: Date.now() - 120000   // exclude last 2 minutes
});
```

**Parallel search strategies:**

```
                    queryToUse
                        │
            ┌───────────┼───────────┬───────────────┬──────────────┐
            ▼           ▼           ▼               ▼              ▼
       ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌────────────┐
       │ Local   │ │Supabase │ │ Semantic │ │  Graph    │ │   HyDE     │
       │ BM25    │ │ Text    │ │ Vector   │ │  Walk     │ │  Search    │
       │         │ │ Search  │ │ Search   │ │           │ │            │
       │keyword  │ │ilike    │ │match_    │ │entity     │ │GPT hypo-   │
       │match vs │ │keyword  │ │messages  │ │relation-  │ │thetical    │
       │chrome.  │ │fallback │ │_v2 RPC   │ │ship       │ │doc → embed │
       │storage  │ │(when    │ │(Qwen3    │ │traversal  │ │→ vector    │
       │.local   │ │BM25=0)  │ │4096-dim) │ │           │ │search      │
       └────┬────┘ └────┬────┘ └─────┬────┘ └─────┬─────┘ └─────┬──────┘
            │           │            │             │              │
            └───────────┴────────────┴─────────────┴──────────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │  mergeResultsRRF()   │
                          │  Reciprocal Rank     │
                          │  Fusion with adaptive│
                          │  weights by query    │
                          │  length              │
                          └──────────┬──────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │  rerankResults()     │
                          │  Jina cross-encoder  │
                          │  (api.jina.ai)       │
                          └──────────┬──────────┘
                                     │
                                     ▼
                          Return with metadata:
                          { semanticAvailable,
                            jinaReranked }
```

**Retry logic:** If the transformed query returns 0 results, the system retries with the original `userMessage` (Fix E1).

---

### STEP 6: Server-Side Retrieval Pipeline (Edge Function)

**Files:**
- `supabase/functions/search_memories/index.ts` — edge function entry point
- `supabase/functions/_shared/get_relevant_memories.ts` — full pipeline

**When it runs:** Called by edge search path (Step 5a).

```
  query + userId
       │
       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.1: RAW QUERY EMBEDDING                                        ║
║  hfClient.generateEmbeddings(query)                                    ║
║  Model: Qwen3-Embedding-8B (4096-dim) via HuggingFace Router/Scaleway ║
╚══════════════════════════════════════════╦═══════════════════════════════╝
                                           │ rawEmbedding [4096]
       ┌───────────────────────────────────┼──────────────────────────┐
       ▼                                   ▼                          ▼
╔═══════════════════╗    ╔═══════════════════════════╗   ╔═══════════════════╗
║ 6.2a: ENTITY      ║    ║ 6.2b: HyDE GENERATION     ║   ║ 6.2c: CONCEPT     ║
║ SEARCH             ║    ║ GPT generates hypothetical ║   ║ DETECTION          ║
║                    ║    ║ answer document            ║   ║                    ║
║ search_entities_   ║    ║                            ║   ║ search_entities_   ║
║ by_embedding       ║    ║ shouldSkipHyDE():          ║   ║ by_text filtered   ║
║ (threshold: 0.8)   ║    ║ if entity conf > 0.85     ║   ║ to CONCEPT/ANALOGY ║
║                    ║    ║ → skip HyDE entirely       ║   ║ /THEME types       ║
║ Fallback: search_  ║    ║                            ║   ║                    ║
║ entities_by_text   ║    ║ Then embed the hypo doc    ║   ║                    ║
║ (trigram+keyword)  ║    ║ → hydeEmbedding [4096]     ║   ║                    ║
╚════════╤══════════╝    ╚════════════╤═══════════════╝   ╚════════╤══════════╝
         │                            │                             │
         └────────────────────────────┼─────────────────────────────┘
                                      │
                                      ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.3: GRAPH WALK (if entities found)                              ║
║  RPC: graph_walk_from_entities                                         ║
║  Traverses entity_relationships table                                  ║
║  max_depth=2, max_intermediate=20                                      ║
║  Returns conceptually related chat_turns via entity links              ║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.4: ADAPTIVE SHORT-CIRCUIT CHECK                                ║
║  if shouldSkipHyDE(entityConfidences, 0.85):                           ║
║    → Single vector search (rawEmbedding only) + graph merge            ║
║    → Jump directly to Step 6.7                                         ║
║  else:                                                                 ║
║    → Continue to dual vector search (Step 6.5)                         ║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
               ╔════════════════════╗    ╔════════════════════╗
               ║ 6.5a: VECTOR SEARCH║    ║ 6.5b: VECTOR SEARCH║
               ║ (raw embedding)    ║    ║ (HyDE embedding)   ║
               ║                    ║    ║                     ║
               ║ RPC: match_        ║    ║ RPC: match_         ║
               ║ messages_with_     ║    ║ messages_with_      ║
               ║ gravity            ║    ║ gravity             ║
               ║                    ║    ║                     ║
               ║ match_threshold:   ║    ║ match_threshold:    ║
               ║ 0.70               ║    ║ 0.70                ║
               ║ match_count:       ║    ║ match_count:        ║
               ║ max(topK, 20)      ║    ║ max(topK, 20)       ║
               ║ boost_entity_ids   ║    ║ boost_entity_ids    ║
               ╚═════════╤══════════╝    ╚═════════╤══════════╝
                         │                         │
                         └───────────┬─────────────┘
                                     ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.6: RRF MERGE                                                   ║
║                                                                         ║
║  3-way merge (if graph results present):                                ║
║    HyDE weight:  0.6 × 0.8 = 0.48                                      ║
║    Raw weight:   0.4 × 0.8 = 0.32                                      ║
║    Graph weight: 0.2                                                    ║
║                                                                         ║
║  2-way merge (no graph):                                                ║
║    mergeHydeAndRawResults(hydeResults, rawResults, hydeWeight=0.6)      ║
║    via src/rrf.ts                                                       ║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.7: ENTITY TIMELINE GUARANTEE ("Jerry Problem" fix)             ║
║                                                                         ║
║  RPC: get_newest_turns_for_entities                                     ║
║  For each entity found in Step 6.2a:                                    ║
║    Find the NEWEST chat_turn mentioning that entity                     ║
║    that is NOT already in the candidate pool                            ║
║    Inject it into candidates before reranking                           ║
║                                                                         ║
║  Purpose: Guarantees the most recent factual update per entity          ║
║  is always considered. Prevents older, richer content from              ║
║  permanently outranking short corrections like "Jerry is not real".     ║
║                                                                         ║
║  Params: p_entity_ids, p_user_id, p_exclude_turn_ids, p_max_per_entity=1║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.8: SERVER RERANK + BM25 BOOST + CONFIDENCE FILTER              ║
║                                                                         ║
║  rerankAndFilter(query, candidates, hfClient, requestId, topK=20):      ║
║    1. hfClient.rerank(query, docs)  — Jina cross-encoder reranker       ║
║    2. applyBm25Boost(query, ordered) — BM25 up to +30%, entity +0.1    ║
║    3. filter(c => c.rerank_score >= 0.4) — confidence threshold         ║
║    4. return filtered.slice(0, returnCount)                             ║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                                       ▼
╔══════════════════════════════════════════════════════════════════════════╗
║  STEP 6.9: ENTITY ENRICHMENT                                           ║
║                                                                         ║
║  enrichWithEntities(supabase, results):                                 ║
║    SELECT chat_turn_id, entity_id, entities(canonical_name, entity_type)║
║    FROM entity_mentions WHERE chat_turn_id IN (resultIds)               ║
║                                                                         ║
║  Attaches entities[] array to each result. Used by client-side          ║
║  applyRecencyResolution() to avoid regex-based entity extraction.       ║
╚══════════════════════════════════════╦═══════════════════════════════════╝
                                       │
                                       ▼
                              Return to client
                        (up to topK=15 candidates)
```

**Full server pipeline summary:**
```
embed → entity search → HyDE → graph walk → adaptive short-circuit →
vector search(×2) → RRF → entity timeline guarantee →
rerank → BM25 boost → confidence filter → entity enrichment
```

---

### STEP 7: Client-Side Post-Processing

**File:** `background.js`, lines 1327–1654

All results (from either edge or legacy path) pass through 11 sequential post-processing stages.

---

#### 7.1 Recency Multiplier

**Purpose:** Mild bias toward recent content (time decay).

```
half_life = 30 days
daysSince = (now - item.timestamp) / 86400000
recencyMultiplier = exp(-daysSince / 30)
score = score × 0.85 + score × recencyMultiplier × 0.15
```

Items from 30 days ago get ~15% × 0.5 = ~7.5% penalty. Very old items get ~15% penalty max. This is intentionally gentle — recency is not a strong signal for factual preferences.

---

#### 7.2 Recursion Guard

**Purpose:** Prevents KYT's own injection blocks from being retrieved and re-injected (feedback loop prevention).

**Filters items containing any of:**
- `"K.Y.T. MEMORY INJECTION PROTOCOL"`
- `"K.Y.T. — User's Personal Knowledge Base"`
- `"[RETRIEVAL_CONTEXT]"`, `"[SESSION_CONTEXT]"`
- `"[RESPONSE_PRIORITY]"`, `"[DATA_PROVENANCE]"`

If an earlier injection was captured and synced to Supabase, this ensures it's never fed back into the LLM.

---

#### 7.3 Meta Flag Filter

**Purpose:** Drops items with `item.meta === true` — conversations *about* KYT itself (debugging, configuration).

---

#### 7.4 Deflection Penalty (Layer 2 — Retrieval Time)

**File:** `src/assistant-quality-detector.js`

**Purpose:** Detects and penalizes "deflection" responses — cases where the LLM previously said *"I don't have that information"* and that response was captured. Without this, deflections get retrieved and injected, causing a feedback loop.

**Flow:**
1. For each item, extract assistant text blocks using regex: `/(^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi`
2. If `role === 'unknown'` (edge path, server drops speakers): assume `role = 'assistant'` (Fix A — Phase 3c)
3. Run `detectDeflection(content, role)`:
   - 20+ DEFLECTION_PATTERNS: *"I don't have access to..."*, *"no stored data about..."*, *"the only item found is the query itself"*, etc.
   - 5 ECHO_PATTERNS: *"So you're asking about..."*, *"you mentioned..."*
   - Confidence scoring: `0.95` (short+match), `0.85` (multi-pattern), `0.65` (single match), `0.30` (opening-only in long text)
4. Apply penalty: `multiplier = 1 - (confidence × 0.9)`
   - Applied to: `cross_encoder_score`, `weighted_score`, `rrf_score`, `distance`
5. Hard drop: if `confidence >= 0.85` → `item._deflectionDropped = true`

---

#### 7.5 KYT Meta-Conversation Penalty (0.3×)

**Purpose:** Penalizes conversations *about* the KYT extension itself.

**Pattern:** `/\bK\.?Y\.?T\.?\b.*\b(extension|memory|capture|inject|sync)\b/i`

Score multiplied by 0.3 (70% penalty).

---

#### 7.6 Echo Penalty (0.4×)

**Purpose:** Penalizes assistant responses that merely echo back the user's query.

**Patterns:**
- `/\byou (?:said|mentioned|noted)\b/i`
- `/\bfrom your stored conversations\b/i`
- `/\bbased on (?:your|the) (?:stored|captured)\b/i`

Score multiplied by 0.4 (60% penalty).

---

#### 7.7 Exact Dedup

**Purpose:** Removes duplicate content.

```javascript
const uniqueContent = new Set();
filteredItems = filteredItems.filter(item => {
  const normalized = item.content.trim().toLowerCase();
  if (uniqueContent.has(normalized)) return false;
  uniqueContent.add(normalized);
  return true;
});
```

---

#### 7.8 Entity-Aware Recency Resolution

**File:** `background.js`, `applyRecencyResolution()` (line 1058)

**Purpose:** Solves the "Jerry Problem" — when a user says *"Jerry is real"* then later *"Jerry is not real"*, the older richer conversation about Jerry dominates vector search. This step ensures the newest mention of each entity wins.

**Flow:**
1. Group items by shared entities (prefers server-provided `item.entities[]` canonical names from GPT-4o-mini; falls back to regex via `mmr.extractEntities()`)
2. For each entity with 2+ items:
   - **Newest item:** `score × 1.5` (recency boost)
   - **All older items:** `score × 0.8` (recency penalty)
3. This happens *before* MMR, so the newest factual update is preferentially selected

---

#### 7.9 MMR (Maximal Marginal Relevance)

**File:** `src/mmr.js`, `applyMMR()`

**Purpose:** Selects the final `maxContextItems` (3) items from the candidate pool (up to 15), balancing relevance to the query against diversity between selected items.

**Parameters:**
```javascript
applyMMR(filteredItems, maxContextItems=3, lambda=0.5, {
  boostFunction: (item) => {
    // Type-based boosts:
    //   reference_data + explicit_save: +0.25
    //   instruction: +0.20
    //   user_preference: +0.15
    //   factual_note: +0.15
    //   cli/terminal source: +0.50
  }
});
```

**Lambda = 0.5** — 50/50 balance between relevance and diversity. Prevents 3 near-identical items from being injected.

---

#### 7.10 Keyword Boost

**File:** `src/keyword-boost.js`, `applyKeywordBoost()`

**Purpose:** Boosts items that contain keywords from the original user message (exact word overlap).

```javascript
applyKeywordBoost(userMessage, filteredItems, { boostFactor: 0.3 });
// Up to +30% score increase based on keyword coverage
```

This runs after MMR to ensure selected items have keyword relevance to the actual query.

---

#### 7.11 Confidence Threshold Filter

**File:** `src/confidence-filter.js`, `filterByConfidence()`

**Purpose:** Final quality gate. Adaptive threshold based on the quality of search signals available.

**Thresholds:**
| Condition | Threshold |
|-----------|-----------|
| Jina reranked + semantic available | 0.40 |
| BM25-only (no semantic) | 0.25 |
| Uncalibrated RRF (no Jina) | 0.01 |

**Low-confidence rescue tier:**
```
If no items pass the main threshold:
  If highest score >= 0.15:
    Keep top 2 items, tag with { lowConfidence: true }
    Run deflection guard on rescued items (Phase 3c Fix B)
      → Drop any rescued item where detectDeflection() fires
  If highest score < 0.15:
    Drop everything (truly irrelevant)
```

**Confidence score selection hierarchy:**
```
cross_encoder_score (Jina reranker, calibrated 0-1)
  → distance (semantic cosine)
    → weighted_score / rrf_score
      → 0.5 fallback
```

---

### STEP 8: Injection Building

**File:** `kyt-memory-injection-builder.js`, `buildMemoryInjection()` (line 231)

**Purpose:** Formats the surviving items into a structured ASCII block that the LLM can interpret.

**Output structure:**
```
================================================================================
K.Y.T. — User's Personal Knowledge Base
================================================================================

[SESSION_CONTEXT]
  Current date/time, platform, session metadata

[RETRIEVAL_CONTEXT]
  confidence: 0.85
  results_found: 3
  query: "what is my favorite car?"
  query_transformed: "favorite car vehicle automobile preference"

[DATA_PROVENANCE]
  "These items are from YOUR OWN conversations..."
  "Use this data to respond to the user's current message."
  "Present it directly as known information."

[RESPONSE_PRIORITY]
  (3-tier directive based on aggregate confidence)

  >= 0.50: "ALWAYS use these items FIRST. Do NOT search the web or
            use general knowledge. Present as established facts."
  0.25–0.50: "Review and incorporate relevant information.
              Supplement with general knowledge where needed."
  < 0.25: "Only mention if clearly related to the user's question."

================================================================================

┌─ Item 1 ─────────────────────────────────────────────────────
│ type: user_preference
│ subtype: technical_preference
│ timestamp: 2026-01-15T14:32:00.000Z
│ confidence: 0.87
│ content: "My favorite car is the Porsche 911 GT3..."
└──────────────────────────────────────────────────────────────

┌─ Item 2 ─────────────────────────────────────────────────────
│ type: factual_note
│ timestamp: 2026-01-20T09:15:00.000Z
│ confidence: 0.72
│ content: "I've been looking at Porsche dealerships..."
└──────────────────────────────────────────────────────────────
```

**Confidence formula for aggregate:**
```javascript
overallConfidence = (maxSimilarity × 0.7) + (avgSimilarity × 0.3)
```

**If no items survived filtering:** Returns `null` (no injection). This is intentional — injecting an empty block with "no results found" would be a negative signal that degrades the LLM response.

Items are sorted newest-first before rendering.

---

### STEP 9: DOM Injection

**File:** `platforms/chatgpt/inject.js` (MAIN world)

**Purpose:** Inserts the memory context into the actual API request to the LLM.

**Flow:**
1. Receives `KYT_CONTEXT_RESPONSE` CustomEvent from content script
2. If `formattedContext !== null`:
   ```javascript
   const contextMessage = {
     author: { role: 'system' },
     content: { content_type: 'text', parts: [formattedContext] },
     metadata: { kyt_context: true }
   };
   // Insert as second-to-last message (before user's message)
   body.messages.splice(body.messages.length - 1, 0, contextMessage);
   ```
3. Resolve the pending Promise with the modified body JSON
4. The wrapped `fetch()` sends the modified body to ChatGPT's API
5. The LLM sees the memory block as a system message immediately preceding the user's question

**If `formattedContext === null`:**
The original body is sent unmodified. The user's experience is seamless — no injection, no latency penalty beyond the failed search.

**For Claude platform:** Same pattern using `platforms/claude/content_test.js` + `inject.js` with `content_bridge.js` as the ISOLATED world bridge.

---

## PIPELINE 2: CAPTURE/SYNC (Conversations → Supabase)

### Capture Flowchart

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  LLM RESPONDS (ChatGPT streams / returns JSON)                      │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ inject.js: Parse LLM response                                       │
  │ • SSE stream → captureResponseStream()                              │
  │ • JSON response → processConversationTree()                         │
  │ • stripInjectionPrefix() — remove KYT blocks from captured content  │
  │ Dispatch KYT_MESSAGE_CAPTURED CustomEvent                           │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ content.js / queue-manager.js (ISOLATED world)                      │
  │ MessageQueueManager.capture(messageData):                           │
  │   1. Create queuedMessage with flattened structure                  │
  │   2. Check circuit breaker (5 failures → open 10s)                  │
  │   3. Send { type: 'SAVE_MESSAGE', data: message }                   │
  │   4. On failure: persist to encrypted chrome.storage.local          │
  │   5. Emergency fallback: window.localStorage                        │
  │   6. Recovery: 5s interval retries pending queue                    │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ chrome.runtime.sendMessage
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ background.js: case 'SAVE_MESSAGE' → saveMessage()                  │
  │   1. Duplicate detection (content hash against recent messages)     │
  │   2. stripInjectionPrefix() — double-check removal                  │
  │   3. detectDeflection() [Layer 1 — capture time tagging]            │
  │   4. detectIsQuestion() — tag with is_question: true                │
  │   5. Append to captured_messages in chrome.storage.local            │
  │   6. Set kyt_sync_pending flag                                      │
  │   7. Schedule debounced sync (5s debounce + 30s max-wait)           │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ (after debounce timer fires)
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ browser-sync.js: syncToSupabase() / syncMessages()                  │
  │                                                                      │
  │ S1. getNewMessages()                                                 │
  │     Load chrome.storage.local messages                               │
  │     Filter by capturedAt > lastSyncTime                             │
  │     Query Supabase for existing messageIds (batch ≤50)              │
  │     Return only unseen messages                                      │
  │                                                                      │
  │ S2. Deflection pre-filter                                            │
  │     Drop messages with deflection >= 0.70                            │
  │     (High-confidence deflections never reach Supabase)               │
  │                                                                      │
  │ S3. Embedding generation                                             │
  │     Qwen3-Embedding-8B via HuggingFace Router/Scaleway              │
  │     4096-dimensional vectors                                         │
  │     Batched by ~4000 tokens                                          │
  │     Circuit breaker: 403→immediate open(5min),                       │
  │                      429/500/503→3 failures→escalating cooldown      │
  │     Graceful degradation: error → embedding=null (still syncs)       │
  │                                                                      │
  │ S4. Upsert to `messages` table                                       │
  │     POST supabase/rest/v1/messages?on_conflict=message_id            │
  │     Prefer: resolution=merge-duplicates                              │
  │                                                                      │
  │ S5. Conversation chunking                                            │
  │     (src/conversation-chunker.js) messagesToTurnChunks()             │
  │     Groups messages into chat_turns (multi-message exchanges)        │
  │                                                                      │
  │ S6. HyDE preprocessing                                               │
  │     (src/hyde-preprocessor.js) generateHypotheticalQuestions()        │
  │     For each turn: GPT generates questions users might ask           │
  │     Indexes WHAT users might search for                              │
  │                                                                      │
  │ S7. Turn embedding generation                                        │
  │     Same Qwen3 endpoint, same circuit breaker                        │
  │     null if unavailable                                               │
  │                                                                      │
  │ S8. Upsert to `chat_turns` table                                     │
  │     on_conflict=user_id,conversation_id,platform,start_timestamp     │
  │     Prefer: resolution=ignore-duplicates                             │
  │                                                                      │
  │ S9. Entity backfill (authenticated users only)                       │
  │     callEdgeFunction('backfill_entities', { limit: 20 })             │
  │     Fire-and-forget: GPT-4o-mini extracts entity names               │
  │     Populates: entities, entity_mentions, entity_relationships       │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Key Parameters & Thresholds Reference

| Parameter | Value | Location |
|-----------|-------|----------|
| **Retrieval** | | |
| Candidate pool size (retrieval) | 15 | `background.js:1129` |
| Max injected items (injection) | 3 | `background.js:1128` |
| Exclude recent seconds | 120 (2 min) | `background.js:1131` |
| GET_CONTEXT timeout (background) | 20s | `background.js:1920` |
| GET_CONTEXT timeout (page) | 25s | `inject.js:366` |
| Query transform timeout | 3s | `background.js:1166` |
| **Search — Client** | | |
| Semantic threshold (hybrid) | 0.50 | `background.js:1278` |
| BM25 threshold | 0.10 | `background.js:1279` |
| **Search — Server** | | |
| Vector search threshold | 0.70 | `get_relevant_memories.ts:80` |
| Entity search threshold | 0.80 | `get_relevant_memories.ts:108` |
| HyDE weight (RRF) | 0.6 | `search_memories/index.ts:37` |
| HyDE skip if entity confidence > | 0.85 | `get_relevant_memories.ts:311` |
| Graph walk depth | 2 | `get_relevant_memories.ts:283` |
| Entity timeline per entity | 1 | `get_relevant_memories.ts:447` |
| Server rerank threshold | >= 0.40 | `get_relevant_memories.ts:613` |
| **Post-Processing** | | |
| Recency half-life | 30 days | `background.js:1340` |
| Deflection hard-drop | >= 0.85 confidence | `background.js:1419` |
| KYT meta penalty | 0.3× | `background.js:1445` |
| Echo penalty | 0.4× | `background.js:1460` |
| Entity recency boost (newest) | 1.5× | `background.js:1099` |
| Entity recency penalty (older) | 0.8× | `background.js:1107` |
| MMR lambda | 0.5 | `background.js:1511` |
| Keyword boost factor | +30% | `background.js:1560` |
| Confidence threshold (Jina+semantic) | 0.40 | `background.js:1585` |
| Confidence threshold (BM25-only) | 0.25 | `background.js:1583` |
| Low-confidence rescue minimum | >= 0.15 | `background.js:1600` |
| **Sync** | | |
| Sync debounce | 5s + 30s max-wait | `background.js:800` |
| Deflection pre-sync filter | >= 0.70 | `browser-sync.js:447` |
| Embedding batch size | ~4000 tokens | `browser-sync.js:160` |
| **Models** | | |
| Embedding model | Qwen3-Embedding-8B (4096-dim) | `browser-sync.js:135` |
| Embedding endpoint | HuggingFace Router → Scaleway | `browser-sync.js:135` |
| Reranker (client) | Jina cross-encoder (api.jina.ai) | `browser-search.js:1001` |
| Reranker (server) | HF Jina reranker | `huggingface-client.ts` |
| Query transform model | GPT-3.5-turbo | `query-transformer.js:68` |
| Entity extraction model | GPT-4o-mini | `entity-extractor.ts` |
| HyDE generation model | GPT (via OpenAI) | `get_relevant_memories.ts` |

---

## File Reference

| File | Role |
|------|------|
| `platforms/chatgpt/inject.js` | MAIN world: fetch intercept, DOM injection |
| `platforms/chatgpt/content.js` | ISOLATED world bridge (page ↔ background) |
| `platforms/claude/inject.js` | MAIN world for Claude platform |
| `platforms/claude/content_test.js` | ISOLATED world bridge for Claude |
| `src/content/queue-manager.js` | Content-side message queue with encryption + fallbacks |
| `background.js` | Service worker: GET_CONTEXT, SAVE_MESSAGE, getContextForInjection, all post-processing |
| `src/query-transformer.js` | GPT-3.5-turbo query rewriting + pollution detection |
| `src/edge-search.js` | Edge function caller (authenticated path) |
| `src/browser-search.js` | Client hybrid search: BM25 + semantic + graph + HyDE + RRF + Jina rerank |
| `src/browser-sync.js` | Supabase sync: embeddings, messages, chat_turns, entity backfill |
| `src/assistant-quality-detector.js` | Deflection/echo pattern detection (capture + retrieval layers) |
| `src/mmr.js` | MMR diversity selection + entity extraction |
| `src/keyword-boost.js` | Keyword coverage score boost |
| `src/confidence-filter.js` | Adaptive confidence threshold filtering |
| `src/embedding-circuit-breaker.js` | Shared persistent circuit breaker (chrome.storage.local) |
| `src/conversation-chunker.js` | Groups messages into chat_turn chunks |
| `src/hyde-preprocessor.js` | Generates hypothetical questions for indexing |
| `kyt-memory-injection-builder.js` | Formats memory block for system message injection |
| `supabase/functions/search_memories/index.ts` | Edge function entry point for server search |
| `supabase/functions/_shared/get_relevant_memories.ts` | Full server pipeline: embed → entity → HyDE → graph → RRF → rerank → enrich |
| `supabase/functions/_shared/entity-extractor.ts` | GPT-4o-mini entity extraction pipeline |
| `supabase/functions/_shared/huggingface-client.ts` | HF embedding + reranking client |
| `supabase/functions/_shared/rrf.ts` | Reciprocal Rank Fusion merge |
| `supabase/migrations/20260217100000_entity_timeline_guarantee.sql` | `get_newest_turns_for_entities` RPC |
| `manifest.json` | MV3 manifest: content_scripts, web_accessible_resources, background |

---

## Deflection Prevention — Three-Layer Defense

Deflections are LLM responses like *"I don't have that information"* — if captured and re-injected, they create a self-reinforcing garbage loop. KYT has three defense layers:

| Layer | When | Where | Action |
|-------|------|-------|--------|
| **Layer 1: Capture-time** | Message saved | `background.js` `saveMessage()` | Tags with `deflection` confidence score |
| **Layer 2: Sync-time** | Before Supabase write | `browser-sync.js` | Drops items with `deflection >= 0.70` |
| **Layer 3: Retrieval-time** | During post-processing | `background.js` Step 7.4 | Penalizes/drops deflections from results (0.3× to hard-drop at ≥0.85) + rescue tier guard |

**Phase 3c additions (commit `9ab9563`):**
- Fix A: `role='unknown'` (edge path) → assume `'assistant'` for deflection detection
- Fix B: Deflection guard in low-confidence rescue tier — blocks garbage loop via rescue path
- Fix C: 2 new patterns (*"the only item found is the query itself"*, *"rather than an actual answer"*)
- Fix D: Widened `any` in subject-agnostic pattern

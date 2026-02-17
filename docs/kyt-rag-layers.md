# KYT RAG System — Layer-by-Layer Reference

> Step-by-step breakdown of the four canonical RAG layers with file:function references,
> data schemas, configuration constants, and degradation paths.
> All references accurate against the codebase as of 2026-02-17.

---

## Layer 1: Ingestion

**Goal:** Capture every user and assistant message from ChatGPT and Claude, persist to `chrome.storage.local`, and survive extension reloads without message loss.

### 1.1 ChatGPT Fetch Interception

**File:** `platforms/chatgpt/inject.js` (runs in PAGE_CONTEXT)

The page-level script monkey-patches `window.fetch` and `window.WebSocket` before ChatGPT's own code loads.

**Fetch override** intercepts:
- `POST /backend-api/conversation` — user messages + assistant SSE stream
- `GET /backend-api/conversation/{id}` — mobile sync / full conversation tree

**Flow:**
1. `window.fetch` override detects ChatGPT API calls via URL pattern matching.
2. User message extracted from `body.messages[-1].content.parts[0]`.
3. `stripInjectionBlock()` removes any prior K.Y.T. context from the saved message.
4. `MessageDeduplicator` (5s window, content hash) prevents duplicate captures.
5. `captureResponseStream(response, metadata)` reads SSE chunks, accumulates assistant text deltas, dispatches `KYT_MESSAGE_CAPTURED` when stream completes.
6. `processConversationTree(response)` handles GET responses (parses `response.mapping` for full history).

**WebSocket override** intercepts `wss://ws.chatgpt.com` for voice mode transcripts.

**DOM fallback** (`platforms/chatgpt/dom-observer.js`):
- `MutationObserver` on conversation container (100ms throttle + 50ms debounce).
- `processMessageNode()` reads `data-message-author-role` attribute.
- Buffers split user messages (1.5s merge delay).
- Dispatches `KYT_DOM_MESSAGE_CAPTURED` — same schema, `source: 'dom'`.
- Active only as fallback when fetch interception misses messages (e.g., client-side navigation).

### 1.2 Claude Fetch Interception

**File:** `platforms/claude/inject.js` (runs in PAGE_CONTEXT)

Simpler than ChatGPT — single `window.fetch` override:
- Intercepts `POST claude.ai/api/.../chat_conversations/{id}/completion`
- User prompt extracted from `body.prompt`
- GET requests handled via `processClaudeConversation()` which parses `chat_messages` array, mapping `sender: 'human'` → `role: 'user'`

### 1.3 Content Script Bridge

**ChatGPT:** `platforms/chatgpt/content.js` (ISOLATED_WORLD)
- Listens for `KYT_MESSAGE_CAPTURED` custom event from page context.
- Routes to Queue Manager (`src/content/queue-manager.js`) if available, else falls back to direct `chrome.runtime.sendMessage()`.
- Handles `KYT_CONTEXT_REQUEST` / `KYT_CONTEXT_RESPONSE` event pair for retrieval (see Layer 4).

**Claude:** `platforms/claude/content_bridge.js` (ISOLATED_WORLD)
- `captureMessage(messageData)` with 3-tier fallback:
  - **Tier 1:** `chrome.runtime.sendMessage()` — service worker alive
  - **Tier 2:** `chrome.storage.local` → `kyt_pending_unencrypted_queue`
  - **Tier 3:** `window.localStorage` → `kyt_emergency_localStorage_queue` (max 50 items)
- Escalating cooldown on consecutive `sendMessage` failures: 5s → 15s → 30s → 60s
- Auto-reset on successful delivery; localStorage recovery runs on bridge initialization.

### 1.4 Queue Manager

**File:** `src/content/queue-manager.js` (ES module, content script)

- `capture(messageData)` — circuit breaker check → context validation → `processQueue()`
- `persistDirectly(message)` — same 3-tier fallback as Claude bridge (encrypted → unencrypted → localStorage)
- `retryPendingQueue()` — runs every 5s, drains encrypted and unencrypted queues to background
- Circuit breaker: opens after 5 consecutive failures, resets after 10s

### 1.5 Background Persistence

**File:** `background.js:saveMessage()` (service worker)

1. **Validate** — `messageData` must be object with non-empty `content` string.
2. **Load** — `captured_messages` array + `kyt_stats` from `chrome.storage.local`.
3. **Deduplicate** — `hashContent()` generates content hash; `findDuplicate()` scans last 200 messages.
4. **Deflection detect** — Tags assistant messages that are echoes/deflections with a confidence score.
5. **Persist** — Appends to `captured_messages`, updates `kyt_stats`, writes to `chrome.storage.local`.
6. **Quota management** — Every 50th save, checks storage quota and evicts oldest messages if exceeded.

### 1.6 Message Schema (Internal)

```javascript
{
  content: string,              // Message text (injection blocks stripped)
  role: 'user' | 'assistant',
  conversationId: string,       // Thread/conversation ID
  model: string,                // e.g., 'gpt-4', 'claude-3-opus'
  timestamp: number,            // Date.now() at capture
  messageId: string,            // 'msg_{timestamp}_{random}'
  platform: 'chatgpt' | 'claude',
  captureMethod: 'fetch' | 'websocket' | 'fetch_tree' | 'sse_stream' | 'dom',
  contentHash: string,          // Added by saveMessage()
  capturedAt: number,           // Added by saveMessage()
  isVoice?: boolean,            // True for voice mode (ChatGPT WebSocket)
  deflection?: number           // 0-1 echo confidence (added by saveMessage())
}
```

### 1.7 Degradation Paths

| Failure | Fallback | Impact |
|---------|----------|--------|
| Extension context invalidated | Queue Manager 3-tier persistence | Messages queued, retried on reconnect |
| Service worker terminated | `kyt_sync_pending` flag + alarm recovery | Sync resumes on next alarm/startup |
| Fetch interception missed | DOM observer fallback | Delayed capture via mutation observation |
| Content hash collision | Supabase upsert on `message_id` | DB-level dedup |
| Storage quota exceeded | Evict oldest messages | Recent messages preserved |

---

## Layer 2: Storage & Indexing

**Goal:** Sync captured messages to Supabase with embeddings, create conversation-turn chunks with topics, and maintain searchable indexes.

### 2.1 Sync Trigger

**File:** `background.js`

Sync is triggered via a debounced mechanism:
- **5s debounce** — each new message resets the timer
- **30s max-wait** — prevents indefinite deferral during rapid capture
- **`kyt_sync_pending` flag** — persisted in `chrome.storage.local` as safety net for SW termination
- **Startup recovery** — `onStartup` and `onInstalled` listeners check `kyt_sync_pending`
- **Periodic alarm** — `process_queue` alarm (5 min) checks for orphaned pending state

### 2.2 Routing Decision

**File:** `background.js:getRoutingMode()`

```
auth_session exists + access_token valid + expires_at > now → 'edge'
api_config.supabaseUrl + supabaseKey exist                 → 'legacy'
otherwise                                                  → 'unconfigured'
```

### 2.3 Edge Sync Path

**File:** `src/edge-sync.js:syncViaEdgeFunction()`

- Batches messages into groups of 50
- Calls Supabase Edge Function `save_chat_turn_batch` with `{turns: [...], skip_ai_processing: bool}`
- Server handles embedding generation, entity extraction, classification
- Returns `{success, synced, duplicates, errors}`

### 2.4 Legacy Sync Path (Client-Side)

**File:** `src/browser-sync.js:syncMessages(messagesToSync)`

**Step-by-step flow:**

1. **Load config** — `getConfig()` from `chrome.storage.local['api_config']`

2. **Generate message embeddings**
   - Extract text from each message
   - `batchByTokens(texts, maxTokensPerBatch=8000)` — group by estimated token count
   - `generateEmbeddings(texts, apiKey)`:
     - Check `isEmbeddingCircuitOpen()` — throw if open
     - POST to `https://router.huggingface.co/scaleway/v1/embeddings` with model `qwen3-embedding-8b`
     - Returns 4096-dimensional vectors
     - 429 handling: wait 10s, retry once with 2x timeout
     - Records success/failure in circuit breaker
     - 200ms delay between batches
   - **Fallback:** On any embedding error, `embeddings = [null, null, ...]` — messages sync without vectors

3. **Prepare messages for Supabase**
   - Map to schema: `{content, role, conversation_id, model, timestamp, message_id, embedding, source, user_id, synced_from_extension}`
   - `user_id` from `auth_session.user.id` or fallback `'00000000-0000-0000-0000-000000000000'`
   - Platform normalized via `normalizePlatform()` → `'chatgpt'` | `'claude'` | `'cli'`

4. **Batch insert to `messages` table**
   - Batches of 5 (BATCH_SIZE)
   - POST to `/rest/v1/messages?on_conflict=message_id`
   - Header: `Prefer: resolution=merge-duplicates,return=representation`
   - 1s delay between batches

5. **Create conversation-turn chunks**
   - `messagesToTurnChunks(messagesToSync, userId)` from `conversation-chunker.js`:
     - Group by `conversation_id`
     - Pair into user→assistant turns
     - Sliding window: 5 turns per chunk, 2-turn overlap
     - Extract topics via regex (programming languages, tech terms — max 10 per chunk)
   - Generate HyDE questions: `generateHypotheticalQuestions(chunk, apiKey, 5)` with 100ms delay between chunks
   - Generate turn embeddings (same HF pipeline, with null fallback)

6. **Insert to `chat_turns` table**
   - POST to `/rest/v1/chat_turns?on_conflict=user_id,conversation_id,platform,start_timestamp`
   - Header: `Prefer: resolution=ignore-duplicates,return=minimal`
   - Non-fatal on error

7. **Update sync metadata**
   - `last_successful_sync_time`, `last_sync_status` → `chrome.storage.local`

8. **Trigger entity backfill** (fire-and-forget)
   - Calls `backfill_entities` edge function (limit: 20) if auth_session exists

### 2.5 Embedding Backfill

**File:** `src/browser-sync.js:backfillNullEmbeddings(options)`

Queries Supabase for messages with `embedding=is.null`, generates embeddings, and PATCHes them back.
- Triggered by: extension update handler, `KYT_DEBUG.backfillEmbeddings()`, retry alarm
- Respects circuit breaker and userId filtering

### 2.6 Embedding Circuit Breaker

**File:** `src/embedding-circuit-breaker.js`

Factory: `createCircuitBreaker(storageKey, cooldownSteps)` — returns `{getState, updateState, isOpen, recordSuccess, recordFailure}`

**Instances:**
- Embedding: `kyt_embedding_circuit_breaker`, cooldowns `[60s, 120s, 300s, 600s]`
- Jina: `kyt_jina_circuit_breaker`, cooldowns `[60s, 120s, 300s]`

**State schema (persisted in `chrome.storage.local`):**
```javascript
{
  isOpen: boolean,
  openedAt: number | null,
  consecutiveFailures: number,
  lastFailureCode: number | null,
  lastFailureMessage: string | null,
  cooldownMs: number,
  totalTrips: number
}
```

**Trigger rules:**
- 403 → immediate open, 5min cooldown
- 429/500/503 → open after 3 consecutive failures, escalating cooldown
- After cooldown expires → half-open state, allow one probe request
- Probe success → reset all; probe failure → re-open with next cooldown step

### 2.7 Database Schema

**`messages` table** (`supabase_schema.sql`, migrated to 4096-dim via `20260212000000`):
```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  conversation_id TEXT,
  model TEXT,
  timestamp BIGINT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,
  embedding VECTOR(4096),       -- Qwen3-Embedding-8B (migrated from 1536)
  source TEXT,                   -- 'chatgpt', 'claude', 'cli'
  user_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW()
);
-- Indexes: hnsw(embedding), timestamp DESC, conversation_id, role
```

**`chat_turns` table** (`supabase_chat_turns_schema.sql`):
```sql
CREATE TABLE chat_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_range TEXT NOT NULL,                    -- e.g., "1-5"
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude', 'cli')),
  content TEXT NOT NULL,                       -- "User: ...\nAssistant: ..."
  speakers TEXT[] NOT NULL,                    -- ['user', 'assistant']
  turn_count INTEGER NOT NULL,
  start_timestamp BIGINT NOT NULL,
  end_timestamp BIGINT NOT NULL,
  topics TEXT[],                               -- ['python', 'rls', 'supabase']
  hypothetical_questions TEXT[],               -- HyDE-generated questions
  embedding VECTOR(4096),                      -- Qwen3-Embedding-8B
  user_id UUID NOT NULL,
  entities_extracted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, conversation_id, platform, start_timestamp)
);
-- RLS: user_id = auth.uid()
-- Indexes: hnsw(embedding), platform+user_id, conversation_id, timestamp DESC, GIN(topics)
```

**`entities` table** (via `entity_memory.sql`, migrated to 4096-dim via `20260211000000`):
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT,              -- 'person', 'project', 'concept', etc.
  description TEXT,
  embedding VECTOR(4096),        -- For entity similarity search
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Key RPC functions** (`supabase_search_function.sql`):
```sql
-- Vector search with filters
match_messages_v2(query_embedding VECTOR(4096), match_threshold FLOAT, match_count INT,
                  filter JSONB, min_timestamp BIGINT)

-- Entity search
search_entities_by_embedding(p_user_id UUID, p_query TEXT, p_embedding VECTOR(4096),
                             p_entity_type TEXT, p_threshold FLOAT)

-- Graph traversal
graph_walk_from_entities(entity_ids UUID[], max_depth INT, max_intermediate INT)
```

### 2.8 Degradation Paths

| Failure | Fallback | Impact |
|---------|----------|--------|
| Embedding API down | Messages sync with `embedding: null` | No vector search until backfill |
| Embedding circuit open | Skip embedding generation entirely | BM25 + text search only |
| Supabase insert fails | Error thrown, messages stay in `chrome.storage.local` | Retried on next sync |
| Turn chunking fails | Non-fatal, messages still synced | No multi-turn context |
| Entity backfill fails | Fire-and-forget, logged | Entities extracted later |

---

## Layer 3: Retrieval

**Goal:** Given a user's new message, find the most relevant previously stored memories using multiple parallel search strategies, then rank, filter, and deduplicate them.

### 3.1 Entry Point

**File:** `background.js:getContextForInjection(userMessage, config)`

Called via `chrome.runtime.onMessage` handler for `{type: 'GET_CONTEXT'}`.

**Default config:**
```javascript
{
  threshold: 0.5,
  maxContextItems: 3,
  excludeRecentSeconds: 120,    // Context pollution prevention
  debugMode: false,
  disableQueryTransformation: false
}
```

### 3.2 Query Transformation (Legacy Mode Only)

**File:** `src/query-transformer.js:transformQuery(userQuery, context, apiKey)`

Skipped in edge mode (server handles expansion).

1. **Early exit** if query already contains 2+ technical/emotional terms.
2. **Fetch recent topics** — `fetchRecentTopicsFromSupabase(apiConfig, 10)` queries last 20 messages, extracts tech/emotional keywords.
3. **LLM call** — GPT-3.5-turbo, temperature 0.3, max_tokens 50.
   - System prompt instructs dual-ICP optimization (Developer Tool + AI Companion).
   - Output: 5-10 word optimized search terms.
4. **Pollution detection** — `detectQueryPollution(original, transformed, recentTopics)`:
   - Semantic drift: >50% new words → polluted
   - Technical term injection: 2+ irrelevant tech terms from recent topics → polluted
   - On pollution: return original query unchanged.
5. **3s timeout** — on timeout, original query used.

**Example:** `"that python thing from last week"` → `"python RLS policy Supabase database configuration"`

### 3.3 Sync-Before-Search

**File:** `background.js` (within `getContextForInjection`)

Fire-and-forget flush of pending messages to Supabase. Ensures cross-platform memories are available (captured on ChatGPT, searched from Claude). Does not block the search pipeline.

### 3.4 Search Execution

#### Edge Path

**File:** `src/edge-search.js:searchViaEdgeFunction(query, options)`

Single call to Supabase Edge Function `search_memories`. Server runs the full pipeline: HyDE generation, dual embedding (original + HyDE), dual vector search, RRF merge, Jina reranking, entity boost, confidence filtering.

Options: `{topK: 5, useHyde: true, hydeWeight: 0.6, timeoutMs: 25000}`

#### Legacy Path (Client-Side)

**File:** `src/browser-search.js:searchHybrid(query, options)`

Five parallel search strategies launched concurrently:

**Strategy 1: BM25 (Local)**
- **File:** `src/bm25-search.js:searchBM25(query, messages, options)`
- Loads messages from `chrome.storage.local`
- Tokenizes query, builds corpus IDF
- BM25 formula: `IDF(qi) * (f(qi,D) * (k1+1)) / (f(qi,D) + k1 * (1 - b + b*|D|/avgdl))`
- Constants: k1=1.5, b=0.75, threshold=0.1
- Query expansion: generates synonym variants before scoring

**Strategy 2: Supabase Text Search (Remote)**
- **File:** `src/browser-search.js:searchSupabaseText(query, options)`
- Extracts keywords: lowercase, strip punctuation (keep hyphens), filter stopwords, min length 2
- Per-keyword: `GET /messages?content=ilike.*{keyword}*&user_id=eq.{userId}`
- Deduplicates by `message_id`, scores by keyword coverage (hitCount / totalKeywords)
- Client-side `maxTimestamp` filter applied after fetch

**Strategy 3: Semantic Vector Search (Remote)**
- **File:** `src/browser-search.js:searchMessages(query, options)` called within `searchHybrid`
- `generateQueryEmbedding(query)` → Qwen3-Embedding-8B → 4096-dim vector
- Supabase RPC: `match_messages_v2(query_embedding, threshold=0.5, limit, filter, min_timestamp=0)`
- Returns items with `distance` (cosine 0-2)
- Client-side `maxTimestamp` filter applied after results return

**Strategy 4: Graph Walk (Remote)**
- **File:** `src/browser-search.js:searchGraphWalk(query, options)`
- Generate query embedding
- `search_entities_by_embedding(threshold=0.8, limit=5)` — find related entities
- Fallback: `search_entities_by_text` if 0 vector results
- `graph_walk_from_entities(entity_ids, max_depth=2, max_intermediate=20)` — traverse relationships
- Maps to `{graph_score: relationship_strength, traversal_depth, connected_entity_text}`

**Strategy 5: HyDE Search (Remote, Parallel)**
- **File:** `src/hyde-search-generator.js:generateHyDEDocument(query, openaiKey)`
- GPT-4o-mini generates hypothetical conversation snippet (2-3 turns, 100-200 words)
- Temperature 0.7, max_tokens 300, 4s timeout
- Separate circuit breaker (`kyt_hyde_circuit_breaker`)
- Generated document fed to `searchMessages()` for semantic search
- Bridges vocabulary gap: user's vague query → rich hypothetical conversation → matches real stored conversations

### 3.5 Adaptive Weighting

**File:** `src/browser-search.js` (within `searchHybrid`)

```
Query < 5 words  → BM25 weight: 0.7, Semantic weight: 0.3  (keyword-focused)
Query >= 5 words → BM25 weight: 0.4, Semantic weight: 0.6  (semantic-focused)
```

### 3.6 RRF Fusion

**File:** `src/browser-search.js` (within `searchHybrid`)

All strategy results merged via Reciprocal Rank Fusion:
```
rrf_score(item) = Σ 1/(K + rank_in_list)   where K = 60
```

Each list's contribution is weighted by the adaptive weight. Items appearing in multiple lists accumulate higher scores.

### 3.7 Jina Reranking

**File:** `src/browser-search.js:rerankResults(query, results)`

1. Check Jina circuit breaker (`jinaCB`).
2. Top 10 candidates sent to `https://api.jina.ai/v1/rerank` with model `jina-reranker-v2-base-multilingual`.
3. Timeout: 5s, max 2 attempts.
4. Returns `cross_encoder_score` (0-1 calibrated).
5. **Fallback on failure:** min-max normalize `weighted_score` → `cross_encoder_score`, mark `jinaReranked: false`.

### 3.8 Post-Processing Pipeline

**File:** `background.js:getContextForInjection()` (after search results return)

Applied sequentially:

1. **Retry with original query** — If transformed query returned 0 results, re-run search with `userMessage`.

2. **Recency boost** — Exponential decay with 30-day half-life:
   ```
   score = 0.85 * score + 0.15 * (score * e^(-daysSince/30))
   ```

3. **Recursion guard** — Filter items containing K.Y.T. injection block markers (`K.Y.T. — User's Personal Knowledge Base`, `[RETRIEVAL_CONTEXT]`, `[SESSION_CONTEXT]`, `[DATA_PROVENANCE]`, `[Retrieved Items]`).

4. **Meta flag filter** — Drop items where `meta === true` (debug/meta conversations).

5. **Deflection penalty** — `detectDeflection(content, role)` → `applyDeflectionPenalty(item, confidence)`. Penalizes assistant echo/deflection messages.

6. **Meta-conversation penalty** — Regex match against KYT/extension patterns → `score *= 0.3`. Patterns: `K.Y.T. ... extension|memory|capture`, `chrome.runtime|storage`, `service worker`, etc.

7. **Echo penalty** — Assistant messages matching "you said/mentioned/noted" patterns → `score *= 0.4`. Patterns: `you (?:said|mentioned|noted|discussed)`, `from your stored conversations`, etc.

8. **Content deduplication** — Exact normalized content match via `Set`.

9. **Entity-aware recency resolution** — `applyRecencyResolution(items)`:
   - Group items by shared entities (extracted from content via proper noun regex).
   - Sort each group by timestamp (newest first).
   - If newest item contains negation words (`not`, `isn't`, `never`, `no longer`, `changed`, `actually`, etc.):
     - **Contradiction detected:** newest `*= 1.5`, older items `*= 0.6`
   - Otherwise: mild boost, newest `*= 1.15`

10. **MMR reranking** — `src/mmr.js:applyMMR(candidates, maxItems, lambda=0.5, options)`:
    - Selects items maximizing `λ * relevance - (1-λ) * max_similarity_to_selected`
    - Entity deduplication (prevents "sister Jennifer" vs "dog Jenn" confusion)
    - Taxonomy boost function:
      - `reference_data` (explicit save): +0.25
      - `instruction`: +0.20
      - `user_preference` / `factual_note`: +0.15
      - CLI source: +0.50

11. **Keyword boost** — `applyKeywordBoost(query, items, {boostFactor: 0.3})`:
    - 0-30% score increase based on query keyword coverage in item content.

12. **Confidence filtering** — `src/confidence-filter.js:filterByConfidence(items, threshold)`:
    - Jina reranked: threshold = 0.40
    - BM25-only (no semantic): threshold = 0.25
    - Uncalibrated (no Jina): threshold = 0.01
    - **Low-confidence tier:** highest score >= 0.15 → keep top 2 items with `lowConfidence: true` tag
    - Highest score < 0.15 → drop everything

### 3.9 Confidence Score Priority

**File:** `background.js` (when mapping items to injection format)

Similarity score used for injection builder is selected in priority order:
1. `cross_encoder_score` — Jina reranker (calibrated 0-1) ← preferred
2. `distance` → `Math.max(0, 1 - distance)` — semantic cosine
3. `weighted_score` or `rrf_score` — RRF fusion score
4. `0.5` — fallback

### 3.10 Degradation Paths

| Failure | Fallback | Impact |
|---------|----------|--------|
| Embedding API down (circuit open) | BM25 + Supabase text search only | Adaptive threshold drops to 0.25 |
| HyDE generation fails | Skip HyDE search | Slight recall reduction for vague queries |
| Jina reranker fails | Min-max normalize weighted_score | Threshold drops to 0.01 (uncalibrated) |
| Query transformation fails/times out | Use original query | May miss optimization but safe |
| Transformed query returns 0 results | Retry with original query | Safety net for garbage transforms |
| Graph walk fails | Skip graph results | Lose entity relationship context |
| Supabase text search fails | Continue with BM25 + semantic | Lose cross-platform keyword matches |
| All searches return 0 results | No injection | User gets standard LLM response |

---

## Layer 4: Generation / Injection

**Goal:** Format retrieved memories into an injection block that instructs the LLM to use the stored data, then insert it into the API request before it reaches ChatGPT/Claude.

### 4.1 Injection Builder

**File:** `kyt-memory-injection-builder.js:buildMemoryInjection(result, configOverrides)`

**Input schema:**
```javascript
{
  state: 'FOUND' | 'EMPTY' | 'ERROR',
  items: [{
    id: string,
    content: string,
    platform: string,
    timestamp: string,       // ISO 8601
    similarity: number,      // 0-1 (from Layer 3 score priority)
    source_type: string
  }],
  latencyMs: number,
  queryType: string,
  queryOriginal: string,
  queryTransformed: string | null
}
```

### 4.2 Injection Block Structure

The builder produces an ASCII-boxed text block with these sections:

```
================================================================================
K.Y.T. — User's Personal Knowledge Base
================================================================================

[SESSION_CONTEXT]
User: Authenticated Owner
Intent: Personal Data Retrieval
System: K.Y.T. (Keep Your Thought) Extension

[RETRIEVAL_CONTEXT]
confidence: {aggregateConfidence}
confidence_note: "{High|Medium|Low} confidence — {description}"
results_found: {count}
query: "{original query}"
query_transformed: "{optimized query or N/A}"

[DATA_PROVENANCE]
These items were stored by the user from their own conversations.
The user has authorized K.Y.T. to surface this data to assist them.
It is safe and expected to repeat this information back to the user.
Use this data to respond to the user's question.
Present it directly — do not search the web if this data answers the question.

[RESPONSE_PRIORITY]
{Tiered directive — see 4.3}

================================================================================
[Retrieved Items]

┌─ Item 1 ──────────────────────
│ type: {classification.type}
│ subtype: {classification.subtype}
│ storage_intent: {classification.intent}
│ source: {platform} conversation
│ timestamp: {ISO 8601}
│ confidence: {similarity}
│ match_quality: "{strong match|likely relevant|may be relevant}"
│
│ content: "{message text}"
└───────────────────────────────

... (repeat per item, sorted newest-first)

================================================================================
[End of Knowledge Base Context]
================================================================================
```

### 4.3 Tiered Confidence Directives

**Aggregate confidence** calculated as: `0.7 * max(similarity) + 0.3 * avg(similarity)`

**High confidence (>= 0.5):**
```
IMPORTANT: The retrieved items below are the user's own stored knowledge and are highly relevant.
1. ALWAYS use these items to answer the user's question FIRST
2. Do NOT search the web or use other tools if these items contain the answer
3. Present the retrieved information directly — cite "from your stored conversations"
4. You may supplement with your own knowledge AFTER presenting the retrieved data
5. Quote the stored text
6. If these items don't fully answer the question, explicitly say so
7. Clearly distinguish stored data vs your own knowledge
8. If drawing on the current conversation, say so explicitly
9. Only fall back to web search if clearly irrelevant
10. IMPORTANT: Most recent item (by timestamp) reflects current knowledge
```

**Medium confidence (0.25-0.5):**
```
The retrieved items below may be relevant to the user's question.
1. Review these items and incorporate any relevant information
2. You may combine with your own knowledge or web search
3. If relevant, mention they come from the user's stored conversations
4. Do NOT present as definitive recall — frame as "possibly related"
5. If items conflict, prefer the most recent one
```

**Low confidence (< 0.25):**
```
The items below MAY be from the user's stored conversations but match confidence is low.
1. Only mention these if the user's question clearly relates
2. Frame as "you may have discussed something similar" — do NOT present as certain
3. Ask the user to confirm before relying on this data
4. You may freely use web search or your own knowledge instead
```

### 4.4 Content Classification

**File:** `kyt-memory-injection-builder.js:classifyContent(content)`

Heuristic classification of each retrieved item:

| Content Pattern | type | subtype | intent |
|----------------|------|---------|--------|
| Contains "password" / "api key" | `reference_data` | `credential` | `explicit_save` |
| Contains "prefer" / "favorite" | `user_preference` | `technical_preference` | `user_annotated` |
| Contains "always" / "never" | `instruction` | `response_format` | `explicit_save` |
| Default | `conversation_excerpt` | `discussion` | `auto_captured` |

**Match quality labels:**
- similarity >= 0.70 → `"strong match"`
- similarity >= 0.50 → `"likely relevant"`
- otherwise → `"may be relevant"`

### 4.5 ChatGPT Injection

**File:** `platforms/chatgpt/inject.js`

**`getAndInjectContext(bodyString)`** — called inside the fetch override before the request is sent.

1. Parse request body (JSON).
2. Extract user message from `messages[-1].content.parts[0]`.
3. Generate unique `requestId` (`ctx_{timestamp}_{random}`).
4. Dispatch `KYT_CONTEXT_REQUEST` custom event with `{requestId, userMessage, config}`.
5. Wait for `KYT_CONTEXT_RESPONSE` event (25s timeout).
6. On success: create system message and splice into `body.messages` array at index `length - 1` (before the user's message):
   ```javascript
   {
     author: { role: 'system' },
     content: { content_type: 'text', parts: [formattedContext] },
     metadata: { kyt_context: true }
   }
   ```
7. Return modified `body` as string (`JSON.stringify`).
8. On timeout/error: return original body unchanged.

**Retry on recoverable errors:**
- "Extension context invalidated", "Service worker disconnected", "Service worker cooling down"
- Retries once after 3s delay.

### 4.6 Claude Injection

**File:** `platforms/claude/inject.js`

Similar fetch interception, but Claude uses a `prompt` field rather than a `messages` array. Context is prepended to the user's prompt directly.

### 4.7 Response Capture (Post-Injection)

After the modified request is sent:
- **ChatGPT:** `captureResponseStream(response, metadata)` reads the SSE stream, accumulates assistant text deltas, and dispatches `KYT_MESSAGE_CAPTURED` with the full assistant response. The response contains the LLM's answer informed by the injected context.
- **Claude:** Similar SSE/JSON response parsing for assistant capture.

The captured assistant response is then processed through the same ingestion pipeline (Layer 1), with `stripInjectionBlock()` ensuring the K.Y.T. context block is not saved as part of the message content.

### 4.8 Degradation Paths

| Failure | Fallback | Impact |
|---------|----------|--------|
| Context retrieval timeout (20s) | Proceed without injection | Standard LLM response |
| Content script disconnected | Retry once after 3s | Brief delay, may succeed on reconnect |
| 0 items pass confidence filter | No injection | Standard LLM response |
| Low-confidence items only | Inject top 2 with lowConfidence tag | Cautious tier directive |
| Builder error | Proceed without injection | Standard LLM response |

---

## Appendix: File Index

| File | Layer | Key Functions |
|------|-------|--------------|
| `platforms/chatgpt/inject.js` | 1, 4 | fetch/WebSocket override, `getAndInjectContext()`, `captureResponseStream()` |
| `platforms/chatgpt/content.js` | 1, 4 | `KYT_MESSAGE_CAPTURED` listener, `KYT_CONTEXT_REQUEST` bridge |
| `platforms/chatgpt/dom-observer.js` | 1 | `MutationObserver`, `processMessageNode()` |
| `platforms/claude/inject.js` | 1, 4 | fetch override, prompt injection |
| `platforms/claude/content_bridge.js` | 1 | `captureMessage()`, 3-tier fallback |
| `src/content/queue-manager.js` | 1 | `capture()`, `persistDirectly()`, `retryPendingQueue()` |
| `background.js` | 1, 2, 3 | `saveMessage()`, `getContextForInjection()`, `getRoutingMode()`, `applyRecencyResolution()` |
| `src/browser-sync.js` | 2 | `syncMessages()`, `generateEmbeddings()`, `backfillNullEmbeddings()` |
| `src/edge-sync.js` | 2 | `syncViaEdgeFunction()` |
| `src/conversation-chunker.js` | 2 | `messagesToTurnChunks()`, `extractTopics()` |
| `src/embedding-circuit-breaker.js` | 2, 3 | `createCircuitBreaker()`, embedding CB, Jina CB |
| `src/browser-search.js` | 3 | `searchHybrid()`, `searchMessages()`, `searchSupabaseText()`, `searchGraphWalk()`, `rerankResults()` |
| `src/edge-search.js` | 3 | `searchViaEdgeFunction()` |
| `src/bm25-search.js` | 3 | `searchBM25()` |
| `src/query-transformer.js` | 3 | `transformQuery()`, `detectQueryPollution()`, `fetchRecentTopicsFromSupabase()` |
| `src/hyde-search-generator.js` | 3 | `generateHyDEDocument()` |
| `src/mmr.js` | 3 | `applyMMR()` |
| `src/confidence-filter.js` | 3 | `filterByConfidence()` |
| `kyt-memory-injection-builder.js` | 4 | `buildMemoryInjection()`, `classifyContent()` |
| `supabase_schema.sql` | 2 | `messages` table DDL |
| `supabase_chat_turns_schema.sql` | 2 | `chat_turns` table DDL |
| `supabase_search_function.sql` | 3 | `match_messages_v2` RPC |
| `migrations/entity_memory.sql` | 2, 3 | `entities` table, `search_entities_by_embedding`, `graph_walk_from_entities` |

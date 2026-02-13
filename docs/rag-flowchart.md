# KYT RAG System — Comprehensive Flowchart

## System Overview

```
 USER TYPES MESSAGE                              USER SENDS MESSAGE
  on ChatGPT/Claude                               on ChatGPT/Claude
        │                                               │
        ▼                                               ▼
┌─────────────────┐                          ┌─────────────────┐
│  INGEST PIPELINE │                          │ RETRIEVAL PIPELINE│
│  (Write Path)    │                          │  (Read Path)     │
└────────┬────────┘                          └────────┬────────┘
         │                                            │
         ▼                                            ▼
┌─────────────────┐                          ┌─────────────────┐
│ Content Script   │                          │ Content Script   │
│ captures message │                          │ intercepts submit│
│ → chrome.storage │                          │ → GET_CONTEXT    │
│ → background.js  │                          │ → background.js  │
└────────┬────────┘                          └────────┬────────┘
         │                                            │
         ▼                                            ▼
┌─────────────────┐                          ┌─────────────────┐
│ Supabase Sync    │                          │ getContextFor    │
│ + Entity Extract │                          │ Injection()      │
│ + Embeddings     │                          │ (12s timeout)    │
└─────────────────┘                          └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │ Memory Injection │
                                             │ Block → prepended│
                                             │ to user's message│
                                             └─────────────────┘
```

---

## A. INGEST PIPELINE (Write Path)

### Overview

```
Content Script → SAVE_MESSAGE → chrome.storage.local
                                       │
                              scheduleDebouncedSync()
                              (5s debounce / 30s max-wait)
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Routing Decision │
                              └──┬──────────┬───┘
                          edge   │          │  legacy
                                 ▼          ▼
                     ┌──────────────┐ ┌──────────────┐
                     │save_chat_turn│ │  messages     │
                     │_batch (Edge) │ │  table (REST) │
                     └──────┬───────┘ └──────────────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
        ┌──────────┐ ┌───────────┐ ┌────────────────┐
        │ Embedding│ │ Gravity   │ │ Entity         │
        │ (Qwen3)  │ │ Classify  │ │ Extraction     │
        │ 4096-dim │ │(GPT-4o-m) │ │ (GPT-4o-mini)  │
        └──────────┘ └───────────┘ └───────┬────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                    ┌──────────┐   ┌────────────┐   ┌────────────┐
                    │ entities │   │  entity_   │   │  entity_   │
                    │  table   │   │  mentions  │   │  relation- │
                    │          │   │  table     │   │  ships     │
                    └──────────┘   └────────────┘   └────────────┘
```

### Step-by-Step

#### A1. Message Capture (Content Script)

**Files**: `platforms/chatgpt/inject.js`, `platforms/claude/content_bridge.js`

The content script runs in the MAIN world of the chat page. It intercepts messages via:
- **Fetch interception**: Hooks `window.fetch` to capture API requests/responses (ChatGPT `POST /backend-api/conversation`, Claude `POST /chat`)
- **GET conversation tree**: Captures `GET /backend-api/conversation/{id}` for mobile sync (messages sent via voice/mobile have no POST body)
- **DOM mutation observer**: Fallback capture from rendered DOM elements

Each captured message includes: `content`, `role` (user/assistant), `conversationId`, `messageId`, `platform`, `timestamp`.

#### A2. Background Storage (Service Worker)

**File**: `background.js:1441` (case `SAVE_MESSAGE`)

Content script sends `chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data })`. The background service worker:
1. Saves to `chrome.storage.local` (key: `captured_messages`)
2. Calls `scheduleDebouncedSync()` — 5-second debounce with 30-second max-wait timer
3. Returns `{ success: true, queued: true }`

If `chrome.runtime` is invalidated (extension reload), the **queue-manager** (`src/content/queue-manager.js`) stores messages in encrypted `chrome.storage.local` with a fallback chain. Background recovers these on startup via `processPendingLocalQueues()`.

#### A3. Sync to Supabase

**File**: `background.js:141` (`executeDebouncedSync`) → `src/browser-sync.js:629` (`syncToSupabase`)

Routing decision (`getRoutingMode()`):
- **Edge path** (authenticated users with JWT): Calls `save_chat_turn_batch` edge function
- **Legacy path** (API key users): Direct REST upsert to `messages` table

##### A3a. Edge Path — save_chat_turn_batch

**File**: `supabase/functions/save_chat_turn_batch/index.ts`

For each turn in the batch, runs three operations **in parallel**:

1. **Embedding generation** (`HuggingFaceClient.generateEmbeddings`):
   - Model: Qwen3-Embedding-8B via `router.huggingface.co/scaleway/v1/embeddings`
   - Output: 4096-dimensional vector
   - Stored in `chat_turns.embedding` column

2. **Gravity classification** (`classifyMemory`):
   - Model: GPT-4o-mini
   - Produces `impact_score` (0-100) and `intimacy_level` (0-5)
   - Used later for gravity-based retrieval ranking

3. **Entity extraction** (`extractEntities`):
   - Model: GPT-4o-mini
   - Extracts entities with types: PERSON, ORG, LOCATION, PROJECT, TECH, MISC, **CONCEPT, ANALOGY, THEME**
   - Each entity gets: `entity_text`, `normalized_name`, `entity_type`, `relationship`, `context_category`

Then `saveEntitiesWithMentions()` processes each extracted entity:

##### A3b. Entity Save Pipeline (saveEntitiesWithMentions)

**File**: `supabase/functions/_shared/entity-extractor.ts:245`

For each entity:

```
1. Build canonical_name = normalized_name + "_" + relationship
   Example: "jennifer_trainer", "walking_analogy_for_learning_illustrates"

2. EXACT MATCH CHECK
   Query: entities WHERE user_id AND canonical_name AND entity_type
   ┌─────────────┐
   │ Match found? │
   └──┬───────┬───┘
    Yes│       │No
      ▼       ▼
   Update   3. FUZZY DEDUP (Phase 5)
   count       Generate embedding for candidate
   + last_     Call find_similar_entities(4096-dim)
   seen        Threshold: 0.90 similarity
               Guard: same entity_type + same relationship suffix
               ┌──────────────────┐
               │ Merge candidate? │
               └──┬────────────┬──┘
                Yes│            │No
                  ▼            ▼
               Update       4. CREATE NEW ENTITY
               existing        Generate embedding
               entity          Insert to entities table
               count

4. Create entity_mention linking entity → chat_turn

5. For all entity pairs in same turn:
   classifyRelationshipType() → derives type from metadata:
     - PERSON + family relation → 'family_of'
     - PERSON + work/service   → 'works_with'
     - CONCEPT/ANALOGY pairs   → 'illustrates'
     - CONCEPT/THEME pairs     → 'discussed_together'
     - Default                 → 'co_occurrence'
   Call upsert_entity_relationship(type)
     - Increments co_occurrence_count
     - Updates relationship_strength = min(1.0, count/20)
     - Keeps more-specific type on conflict

6. Set chat_turns.entities_extracted = true (Phase 0A fix)
```

##### A3c. Legacy Path — Direct REST

**File**: `src/browser-sync.js:391` (`syncMessages`)

1. Generate embeddings via Scaleway (Qwen3-Embedding-8B, 4096-dim)
2. Circuit breaker check — if open, sync with `embedding: null`
3. Upsert to `messages` table via PostgREST (`POST /rest/v1/messages?on_conflict=message_id`)
4. No entity extraction (legacy path only stores embeddings)

---

## B. RETRIEVAL PIPELINE (Read Path)

### Overview

```
User types message on ChatGPT/Claude
            │
            ▼
   Content script intercepts
   submit event (before send)
            │
            ▼
   chrome.runtime.sendMessage
   { type: 'GET_CONTEXT', userMessage }
            │
            ▼
   background.js (12s timeout)
   getContextForInjection()
            │
    ┌───────┴────────────────────────────────────────────┐
    │                                                     │
    ▼                                                     ▼
  ┌─────────────────────┐                    ┌────────────────────────┐
  │ SECTION B1           │                    │ SECTION B2              │
  │ Query Preprocessing  │                    │ Routing Decision        │
  │                      │                    │                         │
  │ • Circuit breaker    │                    │ JWT valid? → Edge path  │
  │ • Query transform    │                    │ API keys?  → Legacy path│
  │ • Sync flush         │                    │                         │
  └──────────┬──────────┘                    └──────┬──────┬───────────┘
             │                                  edge│      │legacy
             └──────────────────┬────────────────────┘      │
                                │                           │
                    ┌───────────┴──┐              ┌────────┴───────────┐
                    ▼              ▼              ▼                    │
              ┌──────────┐  ┌──────────────────────────────────┐      │
              │ EDGE     │  │ LEGACY CLIENT-SIDE               │      │
              │ FUNCTION │  │ searchHybrid()                   │      │
              │ search_  │  │                                  │      │
              │ memories │  │ ┌──────────────────────────────┐ │      │
              │          │  │ │ SECTION B3: Search Lanes     │ │      │
              │ Runs     │  │ │ (5 parallel lanes)           │ │      │
              │ server-  │  │ │                              │ │      │
              │ side     │  │ │ B3a. BM25 local              │ │      │
              │ pipeline │  │ │ B3b. Supabase text           │ │      │
              │ (see B5) │  │ │ B3c. Semantic vector         │ │      │
              └─────┬────┘  │ │ B3d. HyDE semantic           │ │      │
                    │       │ │ B3e. Graph walk               │ │      │
                    │       │ └──────────────────────────────┘ │      │
                    │       │                                  │      │
                    │       │ ┌──────────────────────────────┐ │      │
                    │       │ │ SECTION B4: Post-Processing  │ │      │
                    │       │ │                              │ │      │
                    │       │ │ B4a. RRF merge               │ │      │
                    │       │ │ B4b. Jina reranking          │ │      │
                    │       │ └──────────────────────────────┘ │      │
                    │       └──────────────────────────────────┘      │
                    │                      │                          │
                    └──────────┬───────────┘                          │
                               ▼                                      │
                ┌──────────────────────────────┐                      │
                │ SECTION B6: Final Filtering   │◄─────────────────────┘
                │                               │
                │ • Recursion guard             │
                │ • Meta filter                │
                │ • Deflection penalty         │
                │ • Content dedup              │
                │ • MMR diversity reranking    │
                │ • Keyword boost              │
                │ • Confidence threshold       │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │ SECTION B7: Injection        │
                │                               │
                │ buildMemoryInjection()        │
                │ → Prepended to user message   │
                │ → Anti-Defiance Protocol      │
                └──────────────────────────────┘
```

---

### B1. Query Preprocessing

**File**: `background.js:975` (`getContextForInjection`)

```
userMessage arrives
       │
       ▼
┌──────────────────────────┐
│ B1a. Circuit Breaker     │  background.js:994
│ Check                     │
│                           │
│ If consecutive API        │
│ failures > threshold →    │
│ skip injection entirely   │
│ Return empty context      │
└──────────┬───────────────┘
           │ (open)
           ▼
┌──────────────────────────┐
│ B1b. Query Transformation│  background.js:1011
│ (3s timeout)              │
│                           │
│ fetchRecentTopicsFrom     │
│   Supabase() → recent    │
│   conversation topics     │
│                           │
│ transformQuery()          │
│ (GPT-4o-mini via OpenAI)  │
│                           │
│ Rewrites vague queries:   │
│ "what did we discuss"  →  │
│ "fitness training plan"   │
│                           │
│ Pollution detection:      │
│ If >50% new words added   │
│ → reject transformation   │
│ → use original query      │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│ B1c. Sync Flush          │  background.js:1065
│ (fire-and-forget)         │
│                           │
│ If kyt_sync_pending flag  │
│ is set, trigger           │
│ executeDebouncedSync()    │
│ non-blocking. Ensures     │
│ cross-platform memories   │
│ are available for search. │
└──────────┬───────────────┘
           │
           ▼
      queryToUse ready
```

**Detailed explanation**:

- **B1a. Circuit Breaker**: A local circuit breaker in background.js tracks consecutive API failures. When open, the entire retrieval pipeline is skipped and an empty context is returned immediately, preventing wasted API calls during outages.

- **B1b. Query Transformation**: Uses GPT-4o-mini to rewrite the user's query into more searchable terms. For example, "what was that thing we talked about" becomes "fitness training plan Jennifer" based on recent conversation topics fetched from Supabase. Has a 3-second timeout — if it takes too long, the original query is used unchanged. A pollution detector checks if the transformation drifted too far (>50% new words) and rejects garbage transformations.

- **B1c. Sync Flush**: Before searching, checks if there are unsynchronized messages. If so, triggers a background sync (fire-and-forget, non-blocking) so that messages just captured on this platform are available for cross-platform retrieval.

---

### B2. Routing Decision

**File**: `background.js:543` (`getRoutingMode`)

```
┌────────────────────────────────────┐
│ Check auth_session in              │
│ chrome.storage.local               │
│                                    │
│ JWT valid & not expired?           │
│   → 'edge' (server-side pipeline) │
│                                    │
│ api_config has supabaseUrl+Key?    │
│   → 'legacy' (client-side hybrid) │
│                                    │
│ Neither?                           │
│   → 'unconfigured' (no search)    │
└────────────────────────────────────┘
```

**Detailed explanation**: The system supports two authentication modes. Authenticated users (who signed in via Supabase Auth) get routed to the edge function path, which runs the full HyDE + entity + graph pipeline server-side. Legacy users (who manually entered API keys) use the client-side hybrid search, which runs BM25 + semantic + graph walk from the browser.

---

### B3. Search Lanes (Legacy Client-Side Path)

**File**: `src/browser-search.js:680` (`searchHybrid`)

Five search strategies run in parallel (where enabled):

```
               queryToUse
                   │
    ┌──────────────┼──────────────────────────────────────┐
    │              │              │              │         │
    ▼              ▼              ▼              ▼         ▼
┌────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌────────┐
│ B3a    │  │ B3b      │  │ B3c      │  │ B3d    │  │ B3e    │
│ BM25   │  │ Supabase │  │ Semantic │  │ HyDE   │  │ Graph  │
│ Local  │  │ Text     │  │ Vector   │  │ Search │  │ Walk   │
└────┬───┘  └────┬─────┘  └────┬─────┘  └───┬────┘  └───┬────┘
     │           │             │             │           │
     ▼           ▼             ▼             ▼           ▼
  ranked      ranked        ranked        ranked      ranked
  list #1     list #2       list #3       list #4     list #5
     │           │             │             │           │
     └───────────┴──────┬──────┴─────────────┴───────────┘
                        │
                        ▼
                   RRF Merge (B4a)
```

#### B3a. BM25 Local Keyword Search

**File**: `src/browser-search.js:735` → `src/bm25-search.js`

```
queryToUse
    │
    ▼
Query Expansion (src/query-expansion.js)
  • Synonym expansion ("NYC" → "New York City")
  • Abbreviation expansion ("JS" → "JavaScript")
  • Currency/unit normalization
  • Returns multiple query variants
    │
    ▼
For each variant:
  searchBM25(variant, localMessages)
    • TF-IDF scoring on chrome.storage.local messages
    • Term frequency × inverse document frequency
    • Threshold: 0.1 minimum score
    │
    ▼
Merge results (keep highest score per message_id)
Sort by score, cap at limit × 2
```

**Detailed explanation**: BM25 is the fastest search lane — it runs entirely locally against messages stored in `chrome.storage.local`. No network calls. The query is first expanded into multiple variants using synonym/abbreviation dictionaries, and BM25 is run against each variant. Results are deduplicated, keeping the highest score for each message. This catches exact keyword matches that semantic search might miss (e.g., "Kobe Bryant" as a proper noun).

#### B3b. Supabase Text Search

**File**: `src/browser-search.js:405` (`searchSupabaseText`)

```
queryToUse
    │
    ▼
Extract keywords:
  • Split on whitespace
  • Remove stop words (the, a, is, are, etc.)
  • Filter words < 2 chars
    │
    ▼
For each keyword:
  GET /rest/v1/messages?content=ilike.*{keyword}*
    • PostgREST ilike filter on content column
    • Filtered by user_id, role, source
    • maxTimestamp filter (exclude recent 2min)
    │
    ▼
Deduplicate results:
  Score = hitCount / totalKeywords
  (keyword coverage ratio)
    │
    ▼
Sort by score, cap at limit
```

**Detailed explanation**: This lane searches the Supabase `messages` table directly using PostgreSQL's `ILIKE` operator. It's the cross-platform recall safety net — messages synced from other devices/platforms only exist in Supabase, not in local `chrome.storage`. Each keyword is searched independently, and results are scored by how many keywords matched (coverage ratio). This catches messages that exist on the server but not locally.

#### B3c. Semantic Vector Search

**File**: `src/browser-search.js:212` (`searchMessages`)

```
queryToUse
    │
    ▼
Circuit Breaker Check (embedding-circuit-breaker.js)
  If open → return [] immediately
    │
    ▼
Generate query embedding:
  POST router.huggingface.co/scaleway/v1/embeddings
  Model: qwen3-embedding-8b
  Output: 4096-dimensional vector
  Timeout: 8s, 2 retries (429/503 retryable)
    │
    ▼
Call Supabase RPC:
  match_messages_v2(query_embedding, threshold=0.6)
    • Cosine similarity search on messages.embedding
    • Filtered by user_id
    • Returns top-K with distance scores
    │
    ▼
Results with distance field (lower = more similar)
```

**Detailed explanation**: This is the core semantic search. The user's query is embedded into a 4096-dimensional vector using Qwen3-Embedding-8B, then compared against all stored message embeddings using cosine distance. The circuit breaker tracks embedding API failures (403, 429, 500, 503) and opens after repeated failures, causing this lane to be skipped entirely. When skipped, the system degrades to BM25-only mode with lower confidence thresholds.

#### B3d. HyDE (Hypothetical Document Embeddings) Search

**File**: `src/browser-search.js:722` → `src/hyde-search-generator.js`

```
queryToUse
    │
    ▼
HyDE Circuit Breaker Check
  If open → skip HyDE entirely
    │
    ▼
Generate hypothetical document:
  GPT-4o-mini generates a fake "answer"
  to the user's query as if it had the data
  Example: "walking analogy" →
    "The walking analogy compares learning to
     a child's first steps..."
    │
    ▼
Use HyDE document as search query:
  searchMessages(hydeDoc, {skipTransformation: true})
    • Generates embedding of the hypothetical doc
    • Searches against stored embeddings
    • HyDE embedding is closer to stored answers
      than the raw query embedding would be
    │
    ▼
Results (closer to actual stored content
 because query↔answer gap is bridged)
```

**Detailed explanation**: HyDE addresses the query-document mismatch problem. When a user asks "what was the walking analogy?", the raw query embedding is far from the stored text about children learning to walk. HyDE generates a hypothetical answer using GPT-4o-mini, embeds that answer, and searches with the answer's embedding instead. This bridges the semantic gap because the hypothetical answer is linguistically similar to the actual stored content. Has its own circuit breaker to skip when GPT-4o-mini is slow/down.

#### B3e. Graph Walk (Entity Traversal)

**File**: `src/browser-search.js:511` (`searchGraphWalk`)

```
queryToUse
    │
    ▼
Generate query embedding (reuses B3c path)
  If circuit breaker open → skip graph walk
    │
    ▼
Step 1: Find matching entities
  POST /rpc/search_entities_by_embedding
    query_embedding, threshold=0.8, count=5
    │
    ├─ Found entities? ──Yes──▶ entityIds
    │
    └─ 0 results? ──▶ TEXT FALLBACK (NEW - Phase 1)
                       POST /rpc/search_entities_by_text
                       p_query_text = queryToUse
                       │
                       ├─ Strategy 1: Trigram similarity
                       │  similarity(canonical_name, query) > 0.15
                       │  "walking analogy" ↔ "walking_analogy_for_learning_illustrates"
                       │
                       ├─ Strategy 2: ILIKE substring
                       │  canonical_name ILIKE '%walking_analogy%'
                       │
                       └─ Strategy 3: Keyword splitting
                          Split query into words, match each against
                          canonical_name tokens individually
                       │
                       ▼
                    entityIds (or empty)
    │
    ▼
Step 2: Walk the graph (if entityIds found)
  POST /rpc/graph_walk_from_entities
    p_entity_ids, p_user_id
    p_max_depth=2, p_max_intermediate=20

  ┌───────────────────────────────────────────┐
  │         RECURSIVE GRAPH WALK              │
  │                                           │
  │  Seed: input entity IDs (depth 0)         │
  │    │                                      │
  │    ▼                                      │
  │  Depth 0: Direct entity mentions          │
  │    entity_mentions → chat_turns           │
  │    strength = 1.0                         │
  │    │                                      │
  │    ▼                                      │
  │  Depth 1: Related entities (1 hop)        │
  │    entity_relationships → entity_mentions │
  │    → chat_turns                           │
  │    strength = parent_strength             │
  │              × edge_strength              │
  │              × temporal_decay_factor()    │
  │    │                                      │
  │    ▼                                      │
  │  Depth 2: 2-hop relationships             │
  │    Same traversal, further decay          │
  │    strength continues multiplying         │
  │    │                                      │
  │    ▼                                      │
  │  Dedup: per entity (keep highest          │
  │    cumulative_strength), cap at 20        │
  │  Dedup: per chat_turn (keep highest)      │
  │  Sort by relationship_strength DESC       │
  │  Limit to p_max_results                   │
  └───────────────────────────────────────────┘
  │
  ▼
  Temporal Decay Formula:
    temporal_decay_factor(last_seen, half_life=90 days)
    = 0.5 ^ (age_seconds / (90 × 86400))

    Examples:
    • 7 days old  → 0.95
    • 30 days old → 0.79
    • 90 days old → 0.50
    • 180 days    → 0.25
    • 365 days    → 0.06
    │
    ▼
Results: chat_turns connected via entity graph
  Each result has: chat_turn_id, content,
  traversal_depth, relationship_strength,
  connected_entity_text, connected_entity_type
```

**Detailed explanation**: This is the core GraphRAG innovation. It solves the concept labeling problem: "walking analogy" has no embedding similarity to "you don't tell a child who took 4 steps to scratch everything." But at ingest time, GPT-4o-mini labeled that content with an ANALOGY entity `walking_analogy_for_learning_illustrates`. At query time:

1. **Entity search** first tries embedding similarity (threshold 0.8). If that fails (which it will for concept queries), it falls back to **text search** using PostgreSQL's `pg_trgm` extension. Trigram matching catches `walking_analogy` → `walking_analogy_for_learning_illustrates` even though the embeddings are dissimilar.

2. **Graph walk** then traverses from the found entity through `entity_relationships` to find all `chat_turns` that mention this entity or related entities. The recursive walk goes up to depth 2, with **multiplicative strength decay** at each hop (parent strength × edge strength × temporal decay). The temporal decay factor uses a 90-day half-life, so recently-discussed connections rank higher.

3. **Fan-out control**: `p_max_intermediate=20` caps the total entities traversed to prevent explosion on highly-connected nodes.

---

### B4. Post-Processing (Legacy Path)

#### B4a. Reciprocal Rank Fusion (RRF)

**File**: `src/browser-search.js:625` (`mergeResultsRRF`)

```
ranked list #1 (BM25 local)
ranked list #2 (Supabase text)
ranked list #3 (Semantic vector)
ranked list #4 (HyDE semantic)
ranked list #5 (Graph walk)
    │
    ▼
For each list, for each item at rank r:
  RRF_score += 1 / (k + r + 1)   where k = 60

  Items appearing in multiple lists
  accumulate higher RRF scores
    │
    ▼
Adaptive weighting:
  • Items with bm25_score → boost × (1 + bm25Weight)
  • Items with distance   → boost × (1 + semanticWeight)

  Weights adapt to query length:
  • Short queries (<5 words): BM25=0.7, Semantic=0.3
  • Long queries (≥5 words): BM25=0.4, Semantic=0.6
    │
    ▼
Quality threshold:
  Drop items where semantic similarity < 0.5
    │
    ▼
Cap at limit (default 5)
```

**Detailed explanation**: RRF is a rank-based fusion technique from information retrieval research. It combines multiple ranked lists by giving each item a score based on its rank position in each list: `1/(60+rank)`. Items that appear in multiple lists get scores summed, naturally bubbling up. The constant `k=60` (from the original RRF paper) controls how much rank position matters. After RRF, adaptive weighting gives extra credit based on which search method found the item — short keyword-like queries boost BM25 matches more, while longer natural language queries boost semantic matches.

#### B4b. Jina Cross-Encoder Reranking

**File**: `src/browser-search.js:966` (`rerankResults`)

```
RRF-merged results (up to 10 docs)
    │
    ▼
Jina Circuit Breaker Check
  If open → fallback (min-max normalize weighted_score)
    │
    ▼
POST api.jina.ai/v1/rerank
  Model: jina-reranker-v2-base-multilingual
  Input: query + document pairs
  Timeout: 5s (single attempt)
    │
    ▼
cross_encoder_score (0.0 - 1.0, calibrated)
  Re-sort by cross_encoder_score DESC
    │
    ▼
If Jina fails:
  Fallback: normalize weighted_score to 0-1
  Mark jinaReranked = false
  (Affects confidence threshold in B6)
```

**Detailed explanation**: The Jina reranker is a cross-encoder model that scores each (query, document) pair jointly, unlike bi-encoders which embed query and document separately. Cross-encoders are more accurate but slower (can't precompute). The `cross_encoder_score` is calibrated between 0-1, making it reliable for confidence thresholding downstream. The 5-second timeout is tight because this runs within the 12-second overall injection budget. Has its own circuit breaker for when Jina is consistently slow or down.

---

### B5. Edge Function Path (Server-Side Pipeline)

**File**: `supabase/functions/search_memories/index.ts` → `supabase/functions/_shared/get_relevant_memories.ts`

```
query + userId arrive at search_memories edge function
    │
    ▼
┌────────────────────────────────────────────────┐
│ STEP 1: Raw query embedding                    │
│   HuggingFaceClient.generateEmbeddings(query)  │
│   → 4096-dim vector                            │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 2: PARALLEL (3 concurrent operations)     │
│                                                │
│ ┌──────────────────┐ ┌─────────────────┐       │
│ │ Entity Search    │ │ HyDE Generation │       │
│ │                  │ │                 │       │
│ │ search_entities_ │ │ GPT-4o-mini     │       │
│ │ by_embedding()   │ │ generates       │       │
│ │ threshold=0.8    │ │ hypothetical    │       │
│ │                  │ │ document        │       │
│ │ If 0 results →   │ │                 │       │
│ │ TEXT FALLBACK:   │ │                 │       │
│ │ search_entities_ │ │                 │       │
│ │ by_text()        │ │                 │       │
│ │ (trigram+ilike)  │ │                 │       │
│ └────────┬─────────┘ └───────┬─────────┘       │
│          │                   │                 │
│ ┌────────┴───────────────────┘                 │
│ │                                              │
│ │ ┌──────────────────────────────────────┐     │
│ │ │ Concept Detection (Phase 6)          │     │
│ │ │                                      │     │
│ │ │ search_entities_by_text(query)       │     │
│ │ │ Filter to CONCEPT/ANALOGY/THEME only │     │
│ │ │                                      │     │
│ │ │ "walking analogy" → finds            │     │
│ │ │ walking_analogy_for_learning (ANALOGY)│     │
│ │ │                                      │     │
│ │ │ Merge concept IDs into boostEntityIds│     │
│ │ └──────────────────────────────────────┘     │
│ │                                              │
│ └──────────────────────────────────────────────┘
│                                                │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 2b: Graph Walk (if entities found)        │
│                                                │
│ graph_walk_from_entities(                      │
│   boostEntityIds,   ← includes concept IDs     │
│   p_max_depth=2,                               │
│   p_max_intermediate=20                        │
│ )                                              │
│                                                │
│ Recursive traversal with temporal decay        │
│ Returns conceptually related chat_turns        │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 3: Adaptive Short-Circuit                 │
│                                                │
│ If top entity confidence ≥ 0.85:               │
│   Skip HyDE entirely (entity match is strong)  │
│   → single vector search + graph results       │
│   → rerank and return                          │
│                                                │
│ If < 0.85:                                     │
│   Continue to dual vector search               │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 4: Dual Vector Search (parallel)          │
│                                                │
│ Search A: rawEmbedding → match_messages_with_  │
│           gravity(boost_entity_ids)            │
│                                                │
│ Search B: hydeEmbedding → same RPC             │
│           (only if HyDE doc was generated)     │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 5: RRF Merge                              │
│                                                │
│ If HyDE + Graph results exist:                 │
│   3-way RRF: HyDE(0.48) + Raw(0.32) + Graph   │
│              (0.20)                            │
│                                                │
│ If only HyDE:                                  │
│   2-way RRF: HyDE(0.6) + Raw(0.4)             │
│                                                │
│ If only Raw + Graph:                           │
│   Raw results + Graph results (deduped)        │
│                                                │
│ If only Raw:                                   │
│   Fallback to raw results only                 │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│ STEP 6: Rerank + BM25 Boost + Filter           │
│                                                │
│ HuggingFace Reranker (cross-encoder)           │
│ + BM25 keyword boost (max 30% of score)        │
│ + Entity boost (+0.1 for entity-connected)     │
│ Confidence filter: ≥ 0.70                      │
│ Return top 5                                   │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
              Return to caller
```

**Detailed explanation**: The edge function path runs the same logical pipeline as the client-side path but entirely server-side, with several advantages:

- **Concept Detection** (Phase 6) runs in parallel with entity search and HyDE generation. It uses `search_entities_by_text` to find CONCEPT/ANALOGY/THEME entities matching the query text. These are merged into `boostEntityIds` so the graph walk picks them up even when embedding search misses them. This is the key innovation for the "walking analogy" problem.

- **Adaptive Short-Circuit**: If entity search finds a high-confidence match (≥0.85), HyDE is skipped entirely because the entity match is strong enough. This saves ~2-3s of GPT-4o-mini latency.

- **3-way RRF Merge**: When all three sources contribute results, they're merged with reduced weights: HyDE gets 48% (was 60%), Raw gets 32% (was 40%), and Graph gets 20%. Graph results carry conceptual connections that vector search alone would miss.

---

### B6. Final Filtering & Reranking

**File**: `background.js:1153-1336`

This section applies to BOTH the edge and legacy paths. Results from the search pipeline pass through a series of filters:

```
Raw search results (from B3+B4 or B5)
    │
    ▼
┌──────────────────────────────────┐
│ B6a. Recursion Guard             │  background.js:1156
│                                  │
│ Remove items containing KYT      │
│ injection protocol headers:      │
│ • "K.Y.T. MEMORY INJECTION"     │
│ • "[RETRIEVAL_CONTEXT]"         │
│ • "[SESSION_CONTEXT]"           │
│                                  │
│ Prevents "turtles all the way    │
│ down" if injected blocks were    │
│ accidentally saved to DB         │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6b. Meta Filter                 │  background.js:1184
│                                  │
│ Remove items with meta=true      │
│ (debug/meta-conversations about  │
│ the system itself)               │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6c. Deflection Penalty          │  background.js:1194
│                                  │
│ detectDeflection(content, role)  │
│ Penalizes assistant deflections: │
│ • "I don't have access to..."   │
│ • "As an AI, I can't..."        │
│ • Generic echoes of user input  │
│                                  │
│ Multiplies score by penalty      │
│ factor → naturally falls below   │
│ confidence threshold             │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6d. Content Deduplication       │  background.js:1213
│                                  │
│ Exact string dedup:              │
│ normalize(content) → Set         │
│ Drop duplicates (keep first)     │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6e. MMR Diversity Reranking     │  background.js:1225
│ (Maximal Marginal Relevance)     │
│                                  │
│ λ = 0.5 (balanced relevance/    │
│          diversity)              │
│                                  │
│ Iteratively selects items that   │
│ are relevant to query BUT        │
│ dissimilar to already-selected   │
│ items. Prevents 3 results about  │
│ the same topic.                  │
│                                  │
│ Taxonomy boost function:         │
│ • reference_data + explicit_save │
│   → +0.25                       │
│ • instruction → +0.20           │
│ • user_preference → +0.15       │
│ • CLI source → +0.50            │
│   (deliberate saves > chat logs) │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6f. Keyword Coverage Boost      │  background.js:1273
│                                  │
│ applyKeywordBoost(query, items)  │
│ Boost factor: 0-30% based on    │
│ how many query keywords appear   │
│ in each result's content         │
│                                  │
│ Counteracts MMR diversity from   │
│ de-ranking keyword-rich results  │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│ B6g. Confidence Threshold        │  background.js:1289
│                                  │
│ Adaptive threshold based on      │
│ available signal quality:        │
│                                  │
│ • Jina reranked (calibrated):    │
│   threshold = 0.40               │
│                                  │
│ • Jina unavailable (uncalib.):   │
│   threshold = 0.01               │
│                                  │
│ • Semantic unavailable (BM25):   │
│   threshold = 0.25               │
│                                  │
│ Score source priority:           │
│ cross_encoder_score (Jina) >     │
│ distance (semantic) >            │
│ weighted_score (RRF) >           │
│ rrf_score > 0.5 fallback         │
│                                  │
│ Philosophy:                      │
│ NO RESULTS > WRONG RESULTS       │
│ If all items below threshold →   │
│ return empty (no injection)      │
└────────────┬─────────────────────┘
             │
             ▼
      filteredItems (0-3 items)
```

**Detailed explanation**:

- **B6a-b**: Safety filters. The recursion guard prevents the system from retrieving its own injection blocks (which would create infinite recursion). The meta filter removes conversations about the system itself.

- **B6c**: Deflection penalty targets low-value assistant responses like "I don't have that information" or "As an AI..." that are semantically similar to many queries but add no value. Their scores are penalized so they fall below the confidence threshold.

- **B6d-e**: Quality reranking. Exact dedup removes duplicate content. MMR then selects a diverse set — if three results are about Jennifer's training, MMR picks the best one and replaces the other two with results about different topics. The taxonomy boost prioritizes deliberately saved facts and instructions over casual conversation logs.

- **B6f**: Keyword boost counteracts a known MMR side effect: diversity reranking can de-prioritize the most keyword-relevant result in favor of a diverse but less relevant one. This boost ensures keyword-rich matches maintain their rank.

- **B6g**: The final gate. Adaptive thresholds account for score calibration differences. Jina's cross-encoder scores are calibrated 0-1, so 0.40 is a meaningful threshold. When Jina is unavailable, scores are uncalibrated RRF values normalized to 0-1, so the threshold drops to 0.01. When semantic search is entirely unavailable (BM25-only), 0.25 is used. The philosophy is explicit: returning nothing is better than returning wrong information.

---

### B7. Memory Injection

**File**: `background.js:1338` → `kyt-memory-injection-builder.js`

```
filteredItems (0-3 high-confidence results)
    │
    ├─ 0 items → return null (no injection)
    │            Silence > negative signal
    │
    └─ 1+ items → buildMemoryInjection()
                    │
                    ▼
    ┌──────────────────────────────────────┐
    │ Anti-Defiance Injection Block        │
    │                                      │
    │ [K.Y.T. MEMORY INJECTION PROTOCOL]   │
    │                                      │
    │ [DATA_PROVENANCE]                    │
    │ "This is the user's own data from    │
    │  previous conversations. Use this    │
    │  data to respond. Present it         │
    │  directly — do not search the web."  │
    │                                      │
    │ [RETRIEVAL_CONTEXT]                  │
    │ Query: "walking analogy"             │
    │ Type: HYBRID                         │
    │ Latency: 3420ms                      │
    │                                      │
    │ [Retrieved Items]                    │
    │ 1. [Platform: chatgpt]              │
    │    [Date: 2026-01-15]               │
    │    [Confidence: 0.847]              │
    │    Content: "You don't tell a child  │
    │    who took 4 steps to scratch       │
    │    everything and start over..."     │
    │                                      │
    │ 2. [Platform: claude]               │
    │    [Date: 2026-01-20]               │
    │    [Confidence: 0.782]              │
    │    Content: "The walking analogy     │
    │    really resonated with me..."      │
    └──────────────────────────────────────┘
                    │
                    ▼
    Prepended to user's message before
    it reaches ChatGPT/Claude API
    │
    ▼
    LLM sees: [injection block] + [user message]
    LLM responds using retrieved personal context
```

**Detailed explanation**: The injection block is prepended to the user's message before it's sent to the LLM. The Anti-Defiance Protocol includes explicit directives telling the LLM to use this data directly rather than searching the web or disclaiming knowledge. The DATA_PROVENANCE section establishes that this is the user's own data, not fabricated content. Each retrieved item includes platform origin, timestamp, and confidence score for transparency. When no results pass the confidence threshold, NO injection block is generated — silence is better than a block saying "no memories found", which would actively signal the LLM to skip personal context.

---

## C. ENTITY GRAPH DATA MODEL

```
┌─────────────────────────────────────────────────────────────┐
│                         entities                             │
│                                                              │
│  id (UUID)                                                   │
│  user_id (UUID)              ← FK to auth.users              │
│  entity_text ("Jennifer")                                    │
│  normalized_name ("jennifer")                                │
│  canonical_name ("jennifer_trainer")                         │
│  display_name ("Jennifer")                                   │
│  entity_type (PERSON|ORG|LOCATION|PROJECT|TECH|MISC|         │
│               CONCEPT|ANALOGY|THEME)                         │
│  relationship ("trainer"|"sister"|"illustrates"|"discussed") │
│  context_category ("fitness"|"family"|"parenting")           │
│  embedding (VECTOR(4096))    ← Qwen3-Embedding-8B           │
│  mention_count (INT)                                         │
│  first_seen / last_seen (TIMESTAMPTZ)                        │
│                                                              │
│  GIN indexes: canonical_name, normalized_name, entity_text   │
│               (trigram indexes for text search)               │
└──────────────────┬──────────────────────────────┬────────────┘
                   │                              │
            ┌──────┴──────┐                ┌──────┴──────┐
            ▼             ▼                ▼             ▼
┌──────────────────┐  ┌───────────────────────────────────────┐
│  entity_mentions │  │        entity_relationships            │
│                  │  │                                        │
│  entity_id  ─────┤  │  entity_a_id ──────┐                  │
│  chat_turn_id    │  │  entity_b_id ──────┤  (a < b always)  │
│  conversation_id │  │  user_id           │                  │
│  mention_text    │  │  co_occurrence_count                  │
│  timestamp       │  │  relationship_strength (0.0-1.0)      │
│                  │  │    = min(1.0, count/20)               │
│  Links entities  │  │  relationship_type:                   │
│  to specific     │  │    • co_occurrence (default)          │
│  chat_turns      │  │    • family_of                        │
│                  │  │    • works_with                        │
└──────────────────┘  │    • illustrates                      │
                      │    • discussed_together                │
                      │  first_seen / last_seen                │
                      │                                        │
                      │  last_seen used for temporal_decay:     │
                      │  0.5^(age / (90 days))                 │
                      └────────────────────────────────────────┘
```

---

## D. COMPLETE END-TO-END EXAMPLE

### Query: "What was the walking analogy?"

```
1. Content script intercepts user's submit on ChatGPT
   → sends GET_CONTEXT to background.js

2. Query preprocessing:
   transformQuery("What was the walking analogy?")
   → "walking analogy learning" (removes filler words)

3. Routing: legacy path (API key user)

4. searchHybrid("walking analogy learning") launches 5 lanes:

   B3a. BM25 local: 0 results (no local messages match)
   B3b. Supabase text: 1 result (ilike *walking*)
   B3c. Semantic vector: 0 results (embedding too distant)
   B3d. HyDE: generates "The walking analogy compares
        learning to a toddler's first steps..."
        → semantic search finds 2 results
   B3e. Graph walk:
        → search_entities_by_embedding: 0 results
        → TEXT FALLBACK: search_entities_by_text("walking analogy")
           → trigram match: walking_analogy_for_learning_illustrates
             (ANALOGY entity, similarity=0.45)
        → graph_walk_from_entities([entity_id], depth=2)
           → Depth 0: chat_turn containing the analogy (strength=1.0)
           → Depth 1: related chat_turns via entity relationships
             (strength=0.7 × 0.95 temporal = 0.665)

5. RRF merge: 4 results from 3 lists
   Graph walk result gets highest combined score
   (appears in graph list + boosted by entity_boost)

6. Jina reranking: cross_encoder_score = 0.847

7. Final filtering:
   Recursion guard: pass
   Deflection filter: pass
   MMR: selects top 2 diverse results
   Confidence threshold (0.40): 0.847 passes

8. buildMemoryInjection() creates injection block

9. Block prepended to user's message → ChatGPT sees the
   original conversation about walking and children learning

10. ChatGPT responds: "You used the walking analogy to describe
    how learning should be incremental — just like you don't tell
    a child who took 4 steps to scratch everything and start over."
```

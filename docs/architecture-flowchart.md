# KYT Architecture: Complete Data Flow

**Audience:** Junior developers onboarding to the KYT codebase
**Last updated:** 2026-02-22

KYT (Keep Your Thought) is a Chrome extension that captures your conversations on ChatGPT and Claude, stores them in a database with semantic embeddings, and automatically retrieves relevant memories when you start a new conversation — so the LLM "remembers" what you've told it before.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      HIGH-LEVEL DATA FLOW                          │
│                                                                    │
│   ChatGPT / Claude page                                            │
│         │                                                          │
│         ▼                                                          │
│   Content Script  ──captures messages──▶  Service Worker           │
│   (inject.js)        via chrome API       (background.js)          │
│                                               │                    │
│                           ┌───────────────────┤                    │
│                           ▼                   ▼                    │
│                     chrome.storage       Supabase DB               │
│                       (local)          (chat_turns, entities,      │
│                                         preferences, embeddings)   │
│                                               │                    │
│   User sends new message                      │                    │
│         │                                     │                    │
│         ▼                                     │                    │
│   Service Worker  ──search query──────────────┘                    │
│   (background.js)                                                  │
│         │                                                          │
│         ▼                                                          │
│   Post-processing pipeline (rank, filter, deduplicate)             │
│         │                                                          │
│         ▼                                                          │
│   Inject formatted context block into the user's message           │
│   before it reaches the LLM                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Stage 1: Message Capture](#stage-1-message-capture)
2. [Stage 2: Local Storage](#stage-2-local-storage)
3. [Stage 3: Sync to Supabase](#stage-3-sync-to-supabase)
4. [Stage 4: Server-Side Processing](#stage-4-server-side-processing)
5. [Stage 5: Search & Retrieval](#stage-5-search--retrieval)
6. [Stage 6: Post-Retrieval Processing](#stage-6-post-retrieval-processing)
7. [Stage 7: Context Injection](#stage-7-context-injection)
8. [Glossary](#glossary)

---

## Stage 1: Message Capture

**What happens:** When you chat on ChatGPT or Claude, content scripts running inside the page intercept every message (yours and the assistant's) and send them to the extension's service worker.

```
┌──────────────────────────────────────────────────────────────┐
│  ChatGPT / Claude webpage                                    │
│                                                              │
│  ┌──────────────┐     CustomEvent          ┌──────────────┐ │
│  │  inject.js   │──KYT_MESSAGE_CAPTURED──▶│  content.js  │ │
│  │ (page world) │                          │  (isolated)  │ │
│  │              │     CustomEvent          │              │ │
│  │ dom-observer │──KYT_DOM_MESSAGE_──────▶│              │ │
│  │  .js (GPT)   │    CAPTURED              │              │ │
│  └──────────────┘                          └──────┬───────┘ │
│                                                   │         │
└───────────────────────────────────────────────────│─────────┘
                                                    │
                           chrome.runtime.sendMessage
                             { type: 'SAVE_MESSAGE' }
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │  background.js   │
                                          │ (service worker) │
                                          └─────────────────┘
```

### How capture works

1. **API interception** — `inject.js` patches the page's `fetch()` and `XMLHttpRequest` to intercept HTTP traffic to the LLM API. When it sees a conversation response, it fires a `KYT_MESSAGE_CAPTURED` CustomEvent containing the message content, role, conversation ID, and model name.

2. **DOM fallback** (ChatGPT only) — `dom-observer.js` watches for new chat bubbles in the DOM. This catches messages on mobile browsers where fetch interception is unreliable. It fires `KYT_DOM_MESSAGE_CAPTURED`.

3. **Content script routing** — `content.js` listens for both events and forwards them to the service worker via `chrome.runtime.sendMessage({ type: 'SAVE_MESSAGE', data })`.

### Three-tier fallback (if the service worker is asleep)

Chrome MV3 can terminate the service worker at any time. The Queue Manager (`src/content/queue-manager.js`) handles this with escalating fallbacks:

| Tier | Transport | When used |
|------|-----------|-----------|
| 1 | `chrome.runtime.sendMessage` | Service worker is alive (normal path) |
| 2 | `chrome.storage.local` | Service worker is disconnected (key: `kyt_pending_unencrypted_queue`) |
| 3 | `window.localStorage` | Extension context is fully invalid (key: `kyt_emergency_localStorage_queue`, max 50 items) |

Recovery: a 5-second interval checks if the service worker is back, then flushes any queued messages from Tier 2/3.

**Key files:**
- `platforms/chatgpt/content.js` — ChatGPT content script
- `platforms/chatgpt/inject.js` — ChatGPT API interceptor
- `platforms/chatgpt/dom-observer.js` — ChatGPT DOM fallback
- `platforms/claude/content.js` — Claude content script
- `platforms/claude/content_bridge.js` — Claude isolated-world bridge (same 3-tier fallback, inlined because MV3 classic scripts can't use ES6 imports)
- `platforms/claude/inject.js` — Claude API interceptor
- `src/content/queue-manager.js` — Queue with circuit breaker and tiered fallback

---

## Stage 2: Local Storage

**What happens:** The service worker receives the message, stores it in `chrome.storage.local`, and schedules a batched sync.

```
                    { type: 'SAVE_MESSAGE', data }
                                │
                                ▼
                  ┌──────────────────────────┐
                  │  background.js            │
                  │                           │
                  │  saveMessage(data)         │
                  │    ├─ strip injection      │
                  │    │  prefix (if present)  │
                  │    ├─ detect if question   │
                  │    ├─ append to            │
                  │    │  captured_messages    │
                  │    └─ schedule sync        │
                  │                           │
                  │  chrome.storage.local:     │
                  │    captured_messages: [...]│
                  │    kyt_sync_pending: true  │
                  └──────────────────────────┘
```

### What gets stored per message

```
{
  id:              "msg_1708612345678_a3f2"
  messageId:       same as id
  content:         "Tell me about Python decorators"
  role:            "user" or "assistant"
  platform:        "chatgpt" or "claude"
  conversationId:  "abc123-def456"
  model:           "gpt-4o"
  timestamp:       1708612345678
  is_question:     true
}
```

### Debounced sync scheduling

Instead of syncing after every single message, the service worker batches them:

- **5-second debounce** — After the last message, wait 5s of silence before syncing.
- **30-second max-wait** — If messages keep arriving, force a sync after 30s regardless.
- **`kyt_sync_pending` flag** — Persisted in storage so that if the service worker is terminated mid-debounce, the next startup or alarm recovers the unsent messages.
- **1-minute alarm** — `chrome.alarms.create('processQueue', { periodInMinutes: 1 })` provides a safety-net periodic retry.

**Key file:** `background.js`

---

## Stage 3: Sync to Supabase

**What happens:** When the debounce fires, messages are synced to Supabase. There are two paths — which one runs depends on whether the user is authenticated with a JWT.

```
                      executeDebouncedSync()
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
           ┌──────────────┐    ┌──────────────┐
           │  Edge Path   │    │ Legacy Path  │
           │ (edge-sync)  │    │(browser-sync)│
           │              │    │              │
           │ JWT required │    │ Anon key OK  │
           │              │    │              │
           │ Calls        │    │ Client-side  │
           │ save_chat_   │    │ embeddings   │
           │ turn_batch   │    │ + REST       │
           │ edge fn      │    │ upsert       │
           └──────┬───────┘    └──────┬───────┘
                  │                   │
                  ▼                   ▼
           ┌─────────────────────────────────┐
           │         Supabase DB              │
           │                                  │
           │  chat_turns  ─  entities         │
           │  messages    ─  user_preferences │
           └─────────────────────────────────┘
```

### Edge Path (`src/edge-sync.js`)

Used when the user has a JWT access token (from Google OAuth login).

1. Batches up to **50 messages** per request.
2. Calls the `save_chat_turn_batch` Supabase Edge Function.
3. The server handles embedding generation, entity extraction, preference extraction, and classification (see Stage 4).
4. Returns `{ success, processed, inserted, duplicates_skipped }`.

### Legacy Path (`src/browser-sync.js`)

Used when the user only has the anon API key (not logged in).

1. **De-duplicates** — Queries Supabase in chunks of 50 IDs to check which messages already exist.
2. **Generates embeddings client-side** — Calls the HuggingFace router endpoint (`https://router.huggingface.co/scaleway/v1/embeddings`) for Qwen3-Embedding-8B. Returns 4096-dimensional vectors.
3. **Upserts to `messages` table** — REST POST with `on_conflict=message_id`, batch size 5, 1-second pause between batches.
4. **Upserts to `chat_turns` table** — Groups messages into conversation-turn chunks, adds hypothetical questions via HyDE generator.
5. **Triggers entity backfill** — Fire-and-forget call to `backfill_entities` edge function for server-side entity extraction.

### Embedding Circuit Breaker (`src/embedding-circuit-breaker.js`)

If the embedding API starts failing, a circuit breaker prevents hammering it:

| HTTP Status | Response |
|---|---|
| 403 | Open immediately, 5-minute cooldown |
| 429 / 500 / 503 | Open after 3 consecutive failures, escalating cooldown (1m → 2m → 5m → 10m) |

When the circuit is open, messages sync with `embedding: null`. A separate `backfillNullEmbeddings()` function retries later.

State is persisted in `chrome.storage.local` under key `kyt_embedding_circuit_breaker`, so it survives service worker restarts.

**Key files:**
- `src/edge-sync.js` — Edge function wrapper
- `src/browser-sync.js` — Client-side sync with embeddings
- `src/embedding-circuit-breaker.js` — Shared circuit breaker

---

## Stage 4: Server-Side Processing

**What happens:** When the Edge Path is used, the `save_chat_turn_batch` Edge Function does all the heavy lifting on the server.

```
save_chat_turn_batch Edge Function
         │
         │  For each turn:
         │
         ├──▶ 1. Generate embedding
         │       Qwen3-Embedding-8B (4096 dims)
         │       via HuggingFace/Scaleway
         │
         ├──▶ 2. Classify memory
         │       GPT-4o-mini → impact_score, intimacy_level
         │
         ├──▶ 3. Extract entities + preferences
         │       GPT-4o-mini (temp=0.2, JSON mode)
         │       │
         │       ├─▶ Entities: people, orgs, locations, projects...
         │       │     saved to entities + entity_mentions tables
         │       │     with embedding-based fuzzy dedup (≥0.90)
         │       │
         │       └─▶ Preferences: "likes Python", "favorite car is..."
         │             saved to user_preferences table
         │             ON CONFLICT DO NOTHING (preserves temporal order)
         │
         └──▶ 4. Upsert to chat_turns
                 ON CONFLICT handled
                 Mark entities_extracted = true
                 Mark preferences_extracted = true
```

### Entity extraction details

The entity extractor (`supabase/functions/_shared/entity-extractor.ts`) uses GPT-4o-mini with 12 extraction patterns and 7 few-shot examples. It returns:

- **Entities** — `{ entity_text, normalized_name, entity_type, relationship, context_category }`. Types include PERSON, ORG, LOCATION, PROJECT, TECH, CONCEPT, ANALOGY, THEME. Relationship-aware naming (e.g., `jennifer_trainer` vs `jennifer_sister`) prevents entity collisions.
- **Preferences** — `{ category, value, sentiment }`. Only extracted from user statements (not questions). Example: `{ category: "car", value: "Lamborghini", sentiment: "positive" }`.

Entity deduplication:
1. **Exact match** — Same `canonical_name` + `entity_type` → merge.
2. **Fuzzy match** — Embedding cosine similarity ≥ 0.90 with same type and matching relationship → merge.

### Database tables written

| Table | Purpose |
|---|---|
| `chat_turns` | Conversation chunks with embeddings, scores, timestamps |
| `entities` | Unique named entities (people, places, concepts) with embeddings |
| `entity_mentions` | Links entity → chat_turn (many-to-many) |
| `user_preferences` | Extracted user likes/dislikes per category |

**Key files:**
- `supabase/functions/save_chat_turn_batch/index.ts` — Batch save orchestrator
- `supabase/functions/_shared/entity-extractor.ts` — Entity + preference extraction
- `supabase/functions/_shared/huggingface-client.ts` — Embedding generation + reranking
- `supabase/functions/_shared/openai-client.ts` — Classification calls

---

## Stage 5: Search & Retrieval

**What happens:** When the user types a new message in ChatGPT/Claude, the extension searches the database for relevant memories before the message is sent. This runs entirely in the background — the user doesn't see it.

```
User types a new message
         │
         ▼
    inject.js sends
    { type: 'GET_CONTEXT', userMessage: "..." }
         │
         ▼
    background.js: getContextForInjection(userMessage)
         │
         │  STEP 0: Preference Router
         │    detectPreferenceQuery("what is my favorite car?")
         │      → match! category = "car"
         │      → lookupPreferencesViaREST("car")
         │      → return immediately (skip vector search)
         │
         │  If no preference match, continue:
         │
         │  STEP 1: Check embedding circuit breaker
         │    → if open: BM25-only mode
         │
         │  STEP 2: Route (edge vs legacy)
         │
         │  STEP 3: Query transformation (optional)
         │    → GPT-3.5 rewrites vague queries
         │    → Pollution detection rejects bad rewrites
         │
         │  STEP 4: Search
         │    ├─▶ Edge search (searchViaEdgeFunction)
         │    └─▶ OR Legacy search (searchHybrid)
         │
         ▼
    Return 15 candidates (candidatePoolSize)
```

### Step 0: Preference Router

A zero-cost regex check that short-circuits the entire vector pipeline for preference queries:

```
"What is my favorite car?"     → match, category = "car"
"What kind of music do I like?" → match, category = "music"
"Tell me my favorite movie"     → match, category = "movie"
"How do transformers work?"     → no match, fall through
```

When matched, it calls the `lookup_user_preferences` RPC directly and returns formatted results without ever touching embeddings.

### Step 3: Query Transformation (`src/query-transformer.js`)

Vague queries get rewritten by GPT-3.5-turbo for better search results:

```
"what did I say about that?"  →  "user discussion about [recent topic]"
"the Python thing"            →  "Python programming discussion"
```

**Pollution detection** rejects bad rewrites (>50% new words = semantic drift):
```
"Tell me about Jerry"  →  "Jerry Seinfeld comedian NBC" ← REJECTED (polluted)
```

If the rewritten query returns 0 results, the system retries with the original query as a safety net.

### Step 4a: Edge Search (`supabase/functions/_shared/get_relevant_memories.ts`)

The full server-side pipeline:

```
Query
  │
  ├──▶ Embed query (Qwen3, 4096 dims)
  │
  ├──▶ [PARALLEL]
  │      ├─ Entity search (embedding + text)
  │      ├─ HyDE generation (GPT-4o-mini writes hypothetical answer)
  │      └─ Concept entity detection
  │
  ├──▶ Graph walk (follow entity relationships)
  │
  ├──▶ Short-circuit check
  │      if top entity confidence ≥ 0.85:
  │        skip HyDE, use raw query only
  │
  ├──▶ [PARALLEL] Vector Search
  │      ├─ Raw query embedding → match_messages_with_gravity RPC
  │      └─ HyDE embedding → match_messages_with_gravity RPC
  │
  ├──▶ RRF Merge (3-way: HyDE 0.48 + Raw 0.32 + Graph 0.20)
  │
  ├──▶ Entity Timeline Guarantee
  │      For each entity found, ensure its NEWEST mention
  │      is in the candidate pool (solves the "Jerry problem" —
  │      where semantic similarity prefers old rich content
  │      over short recent corrections)
  │
  ├──▶ Rerank (Jina cross-encoder, calibrated 0–1 scores)
  │
  ├──▶ BM25 Boost (keyword coverage bonus)
  │
  ├──▶ Confidence Filter (threshold ≥ 0.40)
  │
  └──▶ Entity Enrichment
         Attach entities[] array to each result
         (used by client for recency resolution)
```

### Step 4b: Legacy Search (`src/browser-search.js`)

The client-side pipeline (when not using edge functions):

```
Query
  │
  ├──▶ [PARALLEL]
  │      ├─ BM25 Search (local in-memory, from chrome.storage)
  │      ├─ Vector Search (Supabase match_messages_v2 RPC)
  │      ├─ Text Fallback (ilike keyword search, if BM25 = 0 results)
  │      └─ Graph Walk (if entities found)
  │
  └──▶ RRF Merge → return merged candidates

Adaptive weighting by query length:
  Short queries (<5 words):  BM25 0.7, Semantic 0.3
  Long queries (≥5 words):   BM25 0.4, Semantic 0.6
```

**Key files:**
- `background.js` — `getContextForInjection()` orchestrator
- `src/query-transformer.js` — LLM query rewriting + pollution detection
- `src/edge-search.js` — Edge function wrapper
- `supabase/functions/_shared/get_relevant_memories.ts` — Server search pipeline
- `src/browser-search.js` — Client-side hybrid search
- `src/bm25-search.js` — BM25 scoring algorithm
- `src/embedding-circuit-breaker.js` — Circuit breaker (shared by sync + search)

---

## Stage 6: Post-Retrieval Processing

**What happens:** The raw search results (15 candidates) go through a multi-stage pipeline in `background.js` that ranks, filters, and selects the best 3 items.

```
15 candidates from search
         │
         ▼
    ┌─ Recency Multiplier ──────────────────────────────────┐
    │  Exponential decay: half-life = 30 days               │
    │  score = 0.85 * base + 0.15 * base * decay_factor    │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Recursion Guard ─────────────────────────────────────┐
    │  Remove items containing injection markers            │
    │  (K.Y.T., [RETRIEVAL_CONTEXT])                        │
    │  Prevents "turtles all the way down"                  │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Meta Filter ─────────────────────────────────────────┐
    │  Exclude meta=true items (conversations ABOUT         │
    │  the KYT system itself)                               │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Deflection Penalty ──────────────────────────────────┐
    │  Penalize assistant echoes ("you mentioned...")        │
    │  0.5–0.8x penalty; hard-drop if confidence ≥ 0.85    │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Deduplication ───────────────────────────────────────┐
    │  Exact match on lowercased+trimmed content            │
    │  Keep first occurrence                                │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Entity Recency Resolution ───────────────────────────┐
    │  Group items by shared entities (server-provided      │
    │  or regex-extracted)                                  │
    │  Newest per entity: 1.5x boost                        │
    │  All older:         0.8x penalty                      │
    │  Ensures latest info about "Jerry" wins               │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ MMR Reranking (src/mmr.js) ──────────────────────────┐
    │  Maximal Marginal Relevance (λ = 0.5)                 │
    │  Balances relevance vs diversity                      │
    │  Selects top 3 items (maxContextItems)                │
    │  Content-type boosts:                                 │
    │    +0.50 explicit saves (CLI)                         │
    │    +0.25 reference data                               │
    │    +0.20 instructions                                 │
    │    +0.15 user preferences                             │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Keyword Boost (src/keyword-boost.js) ────────────────┐
    │  Up to 30% score increase for keyword coverage        │
    │  coverage = matched_terms / total_query_terms         │
    │  boost = coverage * 0.3                               │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    ┌─ Confidence Filtering (src/confidence-filter.js) ─────┐
    │  Adaptive threshold by search type:                   │
    │    Jina-reranked + semantic:  ≥ 0.40                  │
    │    BM25-only:                 ≥ 0.25                  │
    │    Fallback:                  ≥ 0.01                  │
    │                                                       │
    │  If 0 items pass, rescue top 2 if score ≥ 0.15       │
    │  Philosophy: "no results > wrong results"             │
    └───────────────────────────────────────────────────────┘
         │
         ▼
    0–3 final items ready for injection
```

**Key files:**
- `background.js` — `getContextForInjection()` contains the pipeline
- `src/mmr.js` — MMR diversity reranking
- `src/keyword-boost.js` — Keyword coverage scoring
- `src/confidence-filter.js` — Adaptive confidence thresholds
- `src/assistant-quality-detector.js` — Deflection detection

---

## Stage 7: Context Injection

**What happens:** The winning items are formatted into a structured text block and prepended to the user's message before it reaches the LLM.

```
    0–3 final items
         │
         ▼
    buildMemoryInjection()
    (kyt-memory-injection-builder.js)
         │
         ▼
    ┌─────────────────────────────────────────────────────┐
    │  K.Y.T. — User's Personal Knowledge Base            │
    │                                                     │
    │  [SESSION_CONTEXT]                                  │
    │  User: Authenticated Owner                          │
    │  Intent: Personal Data Retrieval                    │
    │                                                     │
    │  [RETRIEVAL_CONTEXT]                                │
    │  confidence: 0.72                                   │
    │  results_found: 2                                   │
    │  query: "what is my favorite car"                   │
    │                                                     │
    │  [DATA_PROVENANCE]                                  │
    │  These items were stored by the user from their     │
    │  own conversations. Use this data to respond.       │
    │                                                     │
    │  ┌─ Item 1 ──────────────────────────────────────┐  │
    │  │ type: user_preference                         │  │
    │  │ source: chatgpt conversation                  │  │
    │  │ confidence: 0.85                              │  │
    │  │                                               │  │
    │  │ "My dream car is a Lamborghini Aventador"     │  │
    │  └───────────────────────────────────────────────┘  │
    │                                                     │
    │  [End of Knowledge Base Context]                    │
    └─────────────────────────────────────────────────────┘
         │
         ▼
    inject.js prepends this block to the user's
    actual message, then submits to the LLM
         │
         ▼
    On capture, saveMessage() strips the injection
    prefix to prevent recursion (don't store the
    injection as a "memory")
```

### Confidence tiers

The injection instructions adapt based on how confident the retrieval is:

| Confidence | Tier | Instruction to LLM |
|---|---|---|
| ≥ 0.50 | HIGH | "ALWAYS use these items to answer FIRST. Present directly." |
| 0.25–0.50 | MEDIUM | "Review and incorporate if relevant. May combine with other knowledge." |
| < 0.25 | LOW | "MAY be from stored conversations. Only mention if clearly related." |

If no items pass filtering, `formattedContext` is set to `null` — no injection block is added. Silence is better than an empty block (which would confuse the LLM).

**Key file:** `kyt-memory-injection-builder.js`

---

## Glossary

| Term | One-sentence explanation |
|---|---|
| **Embedding** | A list of numbers (vector) that represents the meaning of a piece of text — similar texts have similar vectors. KYT uses Qwen3-Embedding-8B to produce 4096-dimensional embeddings. |
| **BM25** | A classic keyword-matching algorithm (Best Matching 25) that scores documents by how well their words overlap with the query, with diminishing returns for repeated terms. |
| **RRF** | Reciprocal Rank Fusion — a way to merge multiple ranked lists into one by giving each item a score of `1/(k + rank)` from each list, then summing. |
| **HyDE** | Hypothetical Document Embeddings — instead of searching with the raw query, GPT-4o-mini first writes a hypothetical "perfect answer," which is then embedded and used as the search vector. |
| **MMR** | Maximal Marginal Relevance — a reranking method that balances relevance (pick the best match) against diversity (don't pick items that are too similar to each other). |
| **Circuit Breaker** | A pattern borrowed from electrical engineering — after N consecutive API failures, stop calling the API for a cooldown period instead of hammering a broken service. |
| **RPC** | Remote Procedure Call — in this project, Supabase PostgreSQL functions called via the PostgREST API (e.g., `match_messages_v2`, `lookup_user_preferences`). |
| **Jina Reranker** | A cross-encoder model that scores query-document pairs with calibrated 0–1 confidence, more accurate than embedding cosine similarity but slower. |
| **Entity Timeline Guarantee** | After vector search, for each detected entity, ensure the newest chat turn mentioning it is in the candidate pool — prevents semantic bias from burying recent corrections. |
| **Service Worker (MV3)** | Chrome's background process for extensions. Unlike MV2's persistent background page, it can be terminated at any time, so all state must be persisted in `chrome.storage.local`. |
| **Debounce** | Wait for a pause in activity before executing — if new messages keep arriving within 5s, reset the timer (but force after 30s max). |
| **Deflection** | When the assistant echoes back or rephrases the user's own words — these are penalized in search because the original user statement is more valuable. |

---

## Quick Reference: Key Constants

| Constant | Value | Where |
|---|---|---|
| Sync debounce | 5 seconds | `background.js` |
| Sync max-wait | 30 seconds | `background.js` |
| Edge batch size | 50 messages | `src/edge-sync.js` |
| Legacy batch size | 5 messages | `src/browser-sync.js` |
| Embedding dimensions | 4096 | Qwen3-Embedding-8B |
| Candidate pool size | 15 | `background.js` |
| Max context items (injected) | 3 | `background.js` |
| Exclude recent | 120 seconds | Prevents self-referencing |
| MMR lambda | 0.5 | `src/mmr.js` |
| Keyword boost max | 30% | `src/keyword-boost.js` |
| Confidence threshold (Jina) | 0.40 | `src/confidence-filter.js` |
| Confidence threshold (BM25-only) | 0.25 | `src/confidence-filter.js` |
| Recency half-life | 30 days | `background.js` |
| Entity recency boost | 1.5x newest | `background.js` |
| Circuit breaker cooldown steps | 1m, 2m, 5m, 10m | `src/embedding-circuit-breaker.js` |
| Queue recovery interval | 5 seconds | `src/content/queue-manager.js` |
| Emergency localStorage cap | 50 items | `src/content/queue-manager.js` |

---

## File Map

```
kyt-validation-sprint/
├── background.js                          # Service worker: orchestrates everything
├── kyt-memory-injection-builder.js        # Formats injection blocks
├── platforms/
│   ├── chatgpt/
│   │   ├── content.js                     # ChatGPT content script
│   │   ├── inject.js                      # ChatGPT API interceptor (page world)
│   │   └── dom-observer.js                # ChatGPT DOM fallback capture
│   └── claude/
│       ├── content.js                     # Claude content script
│       ├── content_bridge.js              # Claude isolated-world bridge
│       └── inject.js                      # Claude API interceptor
├── src/
│   ├── content/
│   │   └── queue-manager.js               # 3-tier fallback queue
│   ├── browser-sync.js                    # Client-side sync + embeddings
│   ├── edge-sync.js                       # Edge function sync wrapper
│   ├── browser-search.js                  # Client-side hybrid search
│   ├── edge-search.js                     # Edge function search wrapper
│   ├── embedding-circuit-breaker.js       # Shared circuit breaker
│   ├── query-transformer.js               # LLM query rewriting
│   ├── bm25-search.js                     # BM25 scoring algorithm
│   ├── mmr.js                             # MMR diversity reranking
│   ├── keyword-boost.js                   # Keyword coverage boost
│   ├── confidence-filter.js               # Adaptive confidence thresholds
│   └── assistant-quality-detector.js      # Deflection detection
└── supabase/functions/
    ├── save_chat_turn_batch/index.ts       # Server-side batch save
    ├── search_memories/index.ts            # Server-side search endpoint
    └── _shared/
        ├── get_relevant_memories.ts        # Server search pipeline
        ├── entity-extractor.ts            # Entity + preference extraction
        ├── huggingface-client.ts          # Embeddings + Jina reranker
        ├── openai-client.ts               # Classification calls
        ├── hyde-generator.ts              # HyDE document generation
        └── rrf.ts                         # RRF merge algorithm
```

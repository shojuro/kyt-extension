# KYT RAG Pipeline — Full Flowchart

> Visual reference for the complete data flow from user input through retrieval to context injection.
> All function names, file paths, and constants are accurate against the codebase as of 2026-02-17.

---

## 1. End-to-End Pipeline Overview

```mermaid
flowchart TB
    subgraph INGESTION ["1. INGESTION (Page Context + Content Script)"]
        A[User types message\non ChatGPT / Claude] --> B{Platform?}
        B -->|ChatGPT| C["inject.js: fetch override\n(intercepts POST /backend-api/conversation)"]
        B -->|Claude| D["inject.js: fetch override\n(intercepts POST /completion)"]
        C --> E["KYT_MESSAGE_CAPTURED event"]
        D --> E
        E --> F["content.js / content_bridge.js\n(ISOLATED world bridge)"]
        F --> G["chrome.runtime.sendMessage\n{type: 'SAVE_MESSAGE'}"]
        G --> H["background.js: saveMessage()\nvalidate → dedupe → persist"]
    end

    subgraph STORAGE ["2. STORAGE & INDEXING (Service Worker + Supabase)"]
        H --> I["chrome.storage.local\n(captured_messages array)"]
        I --> J["Debounced sync trigger\n(5s debounce / 30s max-wait)"]
        J --> K{Routing Mode?}
        K -->|edge| L["edge-sync.js: syncViaEdgeFunction()\nSupabase Edge Function: save_chat_turn_batch"]
        K -->|legacy| M["browser-sync.js: syncMessages()"]
        M --> N["generateEmbeddings()\nQwen3-Embedding-8B via HF Router → Scaleway\n4096-dim vectors"]
        N --> O["Supabase REST: POST /messages\n(upsert on message_id)"]
        M --> P["conversation-chunker.js: messagesToTurnChunks()\nwindow=5, overlap=2"]
        P --> Q["Supabase REST: POST /chat_turns\n(upsert on composite key)"]
        L --> O
    end

    subgraph RETRIEVAL ["3. RETRIEVAL (Service Worker)"]
        R[User sends new message\n→ inject.js intercepts] --> S["background.js: getContextForInjection()"]
        S --> T{Routing Mode?}
        T -->|edge| U["edge-search.js: searchViaEdgeFunction()\nServer-side HyDE + dual embedding + Jina"]
        T -->|legacy| V["browser-search.js: searchHybrid()"]
        V --> W["Parallel search strategies\n(BM25 + Semantic + Text + Graph + HyDE)"]
        W --> X["RRF Fusion → Jina Reranker"]
        U --> Y["Post-processing pipeline"]
        X --> Y
        Y --> Z["MMR → Confidence Filter → Injection Builder"]
    end

    subgraph INJECTION ["4. INJECTION (Page Context)"]
        Z --> AA["kyt-memory-injection-builder.js\nbuildMemoryInjection()"]
        AA --> AB["Formatted injection block\n(ASCII box + tiered directives)"]
        AB --> AC{Platform?}
        AC -->|ChatGPT| AD["inject.js: splice system message\nbefore user message in messages array"]
        AC -->|Claude| AE["inject.js: prepend context\nto prompt field"]
        AD --> AF["Modified fetch request\nsent to ChatGPT API"]
        AE --> AG["Modified fetch request\nsent to Claude API"]
    end

    INGESTION --> STORAGE
    STORAGE -.->|"Supabase (source of truth)"| RETRIEVAL
    RETRIEVAL --> INJECTION
```

---

## 2. ChatGPT Ingestion Path

```mermaid
flowchart LR
    subgraph PAGE_CONTEXT ["PAGE_CONTEXT (inject.js)"]
        A["window.fetch override"] -->|"POST /backend-api/conversation"| B["Extract user message\nfrom body.messages[-1].content.parts[0]"]
        C["window.WebSocket override"] -->|"wss://ws.chatgpt.com"| D["Capture voice transcripts\nfrom realtime API messages"]
        E["captureResponseStream()"] -->|"SSE stream chunks"| F["Accumulate assistant\ntext deltas"]
        B --> G["stripInjectionBlock()\nremove prior K.Y.T. context"]
        D --> G
        F --> G
        G --> H["MessageDeduplicator\n(5s window, content hash)"]
        H --> I["dispatch: KYT_MESSAGE_CAPTURED"]
    end

    subgraph ISOLATED_WORLD ["ISOLATED_WORLD (content.js)"]
        I --> J["Queue Manager ready?"]
        J -->|yes| K["queueManager.capture()\n3-tier persistence"]
        J -->|no| L["Direct sendMessage()\nfallback"]
        K --> M["chrome.runtime.sendMessage\n{type: 'SAVE_MESSAGE', data}"]
        L --> M
    end

    subgraph DOM_FALLBACK ["PAGE_CONTEXT (dom-observer.js)"]
        N["MutationObserver\non conversation container"] --> O["processMessageNode()\ndata-message-author-role attr"]
        O --> P["Buffer user messages\n(1.5s merge delay)"]
        P --> Q["dispatch: KYT_DOM_MESSAGE_CAPTURED"]
        Q --> I
    end

    subgraph SERVICE_WORKER ["SERVICE_WORKER (background.js)"]
        M --> R["saveMessage()"]
        R --> S["Validate content exists"]
        S --> T["hashContent() → findDuplicate()\nscan last 200 messages"]
        T --> U["detectDeflection()\ntag echo confidence"]
        U --> V["chrome.storage.local.set\n{captured_messages}"]
        V --> W["Quota check every 50th save\nevict old if exceeded"]
    end
```

---

## 3. Claude Ingestion Path

```mermaid
flowchart LR
    subgraph PAGE_CONTEXT ["PAGE_CONTEXT (inject.js)"]
        A["window.fetch override"] -->|"POST /chat_conversations/{id}/completion"| B["Extract user prompt\nfrom body.prompt"]
        A -->|"GET /chat_conversations/{id}"| C["processClaudeConversation()\nparse chat_messages array"]
        B --> D["stripInjectionBlock()"]
        C --> D
        D --> E["dispatch: KYT_MESSAGE_CAPTURED"]
    end

    subgraph ISOLATED_WORLD ["ISOLATED_WORLD (content_bridge.js)"]
        E --> F["captureMessage() — 3-Tier Fallback"]
        F -->|"Tier 1"| G["chrome.runtime.sendMessage()"]
        F -->|"Tier 2"| H["chrome.storage.local\nkyt_pending_unencrypted_queue"]
        F -->|"Tier 3"| I["window.localStorage\nkyt_emergency_localStorage_queue\n(max 50 items)"]
        G --> J["background.js: saveMessage()"]
        H -.->|"Recovery interval (5s)"| J
        I -.->|"Bridge init recovery"| J
    end

    subgraph COOLDOWN ["Service Worker Cooldown"]
        K["Consecutive sendMessage failures"] --> L["Escalating cooldown\n5s → 15s → 30s → 60s"]
        L --> M["Auto-reset on success"]
    end
```

---

## 4. Edge vs Legacy Routing

```mermaid
flowchart TB
    A["getRoutingMode()"] --> B{auth_session exists?\naccess_token valid?\nexpires_at > now?}
    B -->|yes| C["EDGE mode"]
    B -->|no| D{api_config has\nsupabaseUrl + supabaseKey?}
    D -->|yes| E["LEGACY mode"]
    D -->|no| F["UNCONFIGURED\n(no sync, no search)"]

    subgraph EDGE ["Edge Mode"]
        C --> G["Sync: syncViaEdgeFunction()\n→ save_chat_turn_batch edge fn"]
        C --> H["Search: searchViaEdgeFunction()\n→ search_memories edge fn"]
        H --> I["Server-side pipeline:\nHyDE + dual embedding + RRF + Jina"]
        C --> J["Query transformation: SKIPPED\n(server handles expansion)"]
    end

    subgraph LEGACY ["Legacy Mode (Client-Side)"]
        E --> K["Sync: browser-sync.js syncMessages()\nHF embeddings + Supabase REST"]
        E --> L["Search: browser-search.js searchHybrid()\nParallel strategies + client-side Jina"]
        E --> M["Query transformation: transformQuery()\nGPT-3.5-turbo (3s timeout)"]
    end
```

---

## 5. Parallel Search Strategy Execution

```mermaid
flowchart TB
    A["searchHybrid(query, options)"] --> B["Determine adaptive weights"]
    B --> C{"Query length?"}
    C -->|"< 5 words"| D["BM25: 0.7 / Semantic: 0.3\n(keyword-focused)"]
    C -->|">= 5 words"| E["BM25: 0.4 / Semantic: 0.6\n(semantic-focused)"]

    D --> F["Launch parallel searches"]
    E --> F

    F --> G["BM25 (local)\nbm25-search.js: searchBM25()\nk1=1.5, b=0.75\nQuery expansion (synonyms)"]
    F --> H["Supabase Text (remote)\nsearchSupabaseText()\nilike keyword search\nStopword filter, coverage scoring"]
    F --> I["Semantic Vector (remote)\ngenerateQueryEmbedding()\n→ match_messages_v2 RPC\nCosine distance, threshold=0.50"]
    F --> J["Graph Walk (remote)\nsearchGraphWalk()\nsearch_entities_by_embedding\n→ graph_walk_from_entities\ndepth=2"]
    F --> K["HyDE (remote, parallel)\nhyde-search-generator.js\nGPT-4o-mini, 4s timeout\n→ searchMessages(hydeDoc)"]

    G --> L["RRF Merge\nscore = Σ 1/(60 + rank)\nWeighted by adaptive weights"]
    H --> L
    I --> L
    J --> L
    K --> L

    L --> M["Jina Reranker\nrerankResults()\njina-reranker-v2-base-multilingual\nTop 10 docs, 5s timeout"]
    M -->|success| N["cross_encoder_score (0-1 calibrated)\njinaReranked = true"]
    M -->|failure| O["Min-max normalize weighted_score\njinaReranked = false"]

    N --> P["Return results + metadata"]
    O --> P
```

---

## 6. Post-Search Processing Pipeline (`getContextForInjection`)

```mermaid
flowchart TB
    A["Raw search results\nfrom searchHybrid() or searchViaEdgeFunction()"] --> B["Retry with original query\nif transformed returned 0 results"]
    B --> C["Recency Boost\nscore = 0.85*original + 0.15*(original * e^(-days/30))\nhalf-life: 30 days"]
    C --> D["Recursion Guard\nfilter items containing\nK.Y.T. injection block markers"]
    D --> E["Meta Flag Filter\ndrop items where meta === true"]
    E --> F["Deflection Penalty\ndetectDeflection() → applyDeflectionPenalty()\npenalizes assistant echoes"]
    F --> G["Meta-Conversation Penalty\nregex match KYT/extension patterns\nscore *= 0.3"]
    G --> H["Echo Penalty\nregex match 'you said/mentioned' patterns\nassistant messages only\nscore *= 0.4"]
    H --> I["Content Deduplication\nexact normalized content match\nSet-based filter"]
    I --> J["Entity-Aware Recency Resolution\napplyRecencyResolution()\ngroup by shared entities\ncontradiction: newest *= 1.5, older *= 0.6\nno contradiction: newest *= 1.15"]
    J --> K["MMR Reranking\napplyMMR(candidates, maxItems, λ=0.5)\nTaxonomy boost:\nreference_data +0.25\ninstruction +0.20\nuser_preference +0.15\nCLI source +0.50"]
    K --> L["Keyword Boost\napplyKeywordBoost(query, items, factor=0.3)\n0-30% score increase by keyword coverage"]
    L --> M{"Confidence Filter\nfilterByConfidence()"}
    M -->|"Jina reranked"| N["threshold = 0.40"]
    M -->|"BM25-only"| O["threshold = 0.25"]
    M -->|"uncalibrated"| P["threshold = 0.01"]
    N --> Q{Items pass?}
    O --> Q
    P --> Q
    Q -->|">=1 pass"| R["Use filtered items"]
    Q -->|"0 pass, highest >= 0.15"| S["Low-confidence tier\nkeep top 2 with lowConfidence tag"]
    Q -->|"0 pass, highest < 0.15"| T["Empty — no injection"]
    R --> U["buildMemoryInjection()"]
    S --> U
```

---

## 7. Injection Block Insertion

```mermaid
sequenceDiagram
    participant Page as inject.js (Page Context)
    participant CS as content.js (Content Script)
    participant BG as background.js (Service Worker)
    participant Builder as injection-builder.js
    participant API as ChatGPT / Claude API

    Page->>Page: Intercept fetch() — user message detected
    Page->>Page: Extract user message from request body
    Page->>CS: dispatch KYT_CONTEXT_REQUEST {requestId, userMessage, config}
    CS->>BG: chrome.runtime.sendMessage({type: 'GET_CONTEXT'})
    BG->>BG: getContextForInjection(userMessage, config) [20s timeout]
    BG->>BG: Search + Post-process pipeline
    BG->>Builder: buildMemoryInjection(result)
    Builder-->>BG: formattedContext (ASCII box string)
    BG-->>CS: sendResponse({success, formattedContext, items})
    CS->>Page: dispatch KYT_CONTEXT_RESPONSE {requestId, formattedContext}

    alt ChatGPT
        Page->>Page: body.messages.splice(-1, 0, {role:'system', content: formattedContext})
    else Claude
        Page->>Page: Prepend formattedContext to body.prompt
    end

    Page->>API: Forward modified fetch request
    API-->>Page: Response stream (assistant reply)
    Page->>Page: captureResponseStream() — capture assistant output
    Page->>CS: dispatch KYT_MESSAGE_CAPTURED (assistant message)
```

---

## 8. Circuit Breaker State Machine

```mermaid
stateDiagram-v2
    [*] --> Closed: Initial state

    Closed --> Closed: Success → reset failures
    Closed --> Open_403: 403 (provider auth fail)
    Closed --> Tracking: 429/500/503 → increment failures

    Tracking --> Closed: Success → reset
    Tracking --> Open_Escalating: failures >= 3

    Open_403 --> HalfOpen: After 5min cooldown
    Open_Escalating --> HalfOpen: After escalating cooldown\n(1m → 2m → 5m → 10m)

    HalfOpen --> Closed: Probe succeeds → reset all
    HalfOpen --> Open_Escalating: Probe fails → re-open\nwith next cooldown step

    note right of Open_403: Immediate open\n5min fixed cooldown
    note right of Open_Escalating: Open after 3 failures\nCooldown escalates per trip
    note right of HalfOpen: Allow single probe request
```

Three separate circuit breaker instances:
- **Embedding CB** (`kyt_embedding_circuit_breaker`) — HuggingFace/Scaleway Qwen3
- **Jina CB** (`kyt_jina_circuit_breaker`) — Jina reranker API
- **HyDE CB** (`kyt_hyde_circuit_breaker`) — OpenAI GPT-4o-mini

---

## 9. Score Evolution Through Pipeline

```
                          ┌─────────────────────────────────────────────────┐
Source Scores             │  BM25: bm25_score (TF-IDF, k1=1.5, b=0.75)    │
(parallel search)         │  Semantic: distance (cosine 0-2) via pgvector  │
                          │  Graph: graph_score (relationship_strength)     │
                          │  Text: keyword coverage (hits / totalKeywords)  │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
RRF Merge                 │  rrf_score = Σ 1/(60 + rank) per result list   │
                          │  weighted_score = rrf_score * adaptive_weight   │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Jina Reranker             │  cross_encoder_score = relevance_score (0-1)    │
(or fallback)             │  OR min-max normalized weighted_score           │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Recency Boost             │  score = 0.85*score + 0.15*(score * e^(-d/30)) │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Penalties                 │  Meta-conversation: score *= 0.3               │
                          │  Echo (assistant): score *= 0.4                │
                          │  Deflection: score *= (1 - confidence)         │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Recency Resolution        │  Contradiction detected: newest *= 1.5,        │
(entity-aware)            │                          older   *= 0.6        │
                          │  No contradiction:       newest *= 1.15        │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
MMR (λ=0.5)               │  MMR = 0.5*relevance - 0.5*max_sim_to_selected │
                          │  + taxonomy boost (+0.15 to +0.50)             │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Keyword Boost             │  score += score * (keywordCoverage * 0.3)      │
                          └─────────────────────┬───────────────────────────┘
                                                │
                          ┌─────────────────────▼───────────────────────────┐
Confidence Gate           │  Jina reranked:  threshold = 0.40              │
                          │  BM25-only:      threshold = 0.25              │
                          │  Uncalibrated:   threshold = 0.01              │
                          │  Low tier:       >= 0.15 → top 2 with caveat  │
                          │  Below 0.15:     dropped entirely              │
                          └─────────────────────────────────────────────────┘
```

---

## 10. Key Constants Reference

| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| **Embedding model** | `qwen3-embedding-8b` | `browser-sync.js`, `browser-search.js` | 4096-dim vectors |
| **Embedding URL** | `https://router.huggingface.co/scaleway/v1/embeddings` | `browser-sync.js`, `browser-search.js` | HF Router → Scaleway |
| **Jina model** | `jina-reranker-v2-base-multilingual` | `browser-search.js` | Cross-encoder reranker |
| **Jina URL** | `https://api.jina.ai/v1/rerank` | `browser-search.js` | Reranking API |
| **HyDE model** | GPT-4o-mini | `hyde-search-generator.js` | Hypothetical doc generation |
| **Query transform model** | GPT-3.5-turbo | `query-transformer.js` | Query optimization |
| **BM25 k1** | 1.5 | `bm25-search.js` | TF saturation |
| **BM25 b** | 0.75 | `bm25-search.js` | Length normalization |
| **RRF K** | 60 | `browser-search.js` | Reciprocal rank fusion constant |
| **MMR lambda** | 0.5 | `background.js` | Relevance/diversity balance |
| **Semantic threshold** | 0.50 | `background.js` | Supabase RPC match_threshold |
| **Confidence threshold (Jina)** | 0.40 | `background.js` | Calibrated score gate |
| **Confidence threshold (BM25)** | 0.25 | `background.js` | BM25-only fallback |
| **Low-confidence tier** | 0.15 | `background.js` | Keep top 2 with caveat |
| **Recency half-life** | 30 days | `background.js` | Exponential decay boost |
| **Exclude recent** | 120s | `background.js` | Context pollution prevention |
| **Sync debounce** | 5s / 30s max | `background.js` | Batch sync timing |
| **Chunk window/overlap** | 5 / 2 | `conversation-chunker.js` | Turn chunking params |
| **Embedding batch tokens** | 8000 | `browser-sync.js` | Max tokens per HF batch |
| **Messages batch size** | 5 | `browser-sync.js` | Supabase insert batch |
| **Dedup scan window** | 200 | `background.js` | Last N messages for dedup |
| **CB cooldowns (embedding)** | 1m, 2m, 5m, 10m | `embedding-circuit-breaker.js` | Escalating cooldown steps |
| **CB cooldowns (Jina)** | 1m, 2m, 5m | `embedding-circuit-breaker.js` | Escalating cooldown steps |
| **CB 403 cooldown** | 5min | `embedding-circuit-breaker.js` | Auth failure fixed cooldown |
| **Queue Manager recovery** | 5s interval | `queue-manager.js` | Retry pending messages |
| **Queue Manager CB threshold** | 5 failures | `queue-manager.js` | Open after N failures |

---

## 11. Timeout Cascade

```
Content Script (25s)
  └─ Background GET_CONTEXT handler (20s)
       ├─ Query Transformation (3s)
       │    └─ fetchRecentTopicsFromSupabase + transformQuery (GPT-3.5)
       ├─ Search Execution
       │    ├─ HuggingFace embedding (8s, 2 retries)
       │    ├─ Supabase RPC (default fetch timeout)
       │    ├─ Supabase text search (default)
       │    ├─ Graph walk (default)
       │    ├─ HyDE generation (4s, GPT-4o-mini)
       │    └─ Jina reranker (5s, 2 attempts)
       └─ Post-processing (< 50ms, all in-memory)
```

All timeouts are designed so inner operations expire before outer ones, preventing orphaned work.

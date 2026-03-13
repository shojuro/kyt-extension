# Timestamp Preservation & Recency Scoring — Technical Documentation

<documentation>

## DELIVERABLE 1: FLOWCHART

```
═══════════════════════════════════════════════════════════════════════
                    MESSAGE CAPTURE LAYER
═══════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────┐
│                          USER ACTIVITY                              │
│  1. Types a NEW message in an EXISTING conversation                 │
│  2. Opens an OLD conversation (history load)                        │
│  3. Receives an assistant response to a live prompt                 │
└─────────────┬───────────────────┬───────────────────┬───────────────┘
              │                   │                   │
              ▼                   ▼                   ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │  ChatGPT inject  │ │  Gemini inject   │ │  Claude inject   │
   │                  │ │                  │ │                  │
   │ LIVE TYPING:     │ │ LIVE TYPING:     │ │ LIVE TYPING:     │
   │  Date.now() ✓    │ │  Date.now() ✓    │ │  Date.now() ✓    │
   │                  │ │                  │ │                  │
   │ SSE STREAM:      │ │ HISTORY LOAD:    │ │ MOBILE SYNC:     │
   │  create_time×1000│ │  turn[idx] epoch │ │  msg.created_at  │
   │  (from API JSON) │ │  (probed 0..7)   │ │  (from API JSON) │
   │                  │ │                  │ │                  │
   │ DOM OBSERVER:    │ │ LIVE RESPONSE:   │ │                  │
   │  <time datetime> │ │  Date.now() ✓    │ │                  │
   │  (fallback: now) │ │                  │ │                  │
   │                  │ │                  │ │                  │
   │ CONV TREE:       │ │                  │ │                  │
   │  create_time×1000│ │                  │ │                  │
   │  (already works) │ │                  │ │                  │
   └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
            │                    │                     │
            ▼                    ▼                     ▼
   ┌──────────────────────────────────────────────────────────────┐
   │              KYT_MESSAGE_CAPTURED CustomEvent                │
   │                                                              │
   │  detail: {                                                   │
   │    content: "...",                                           │
   │    role: "user"|"assistant",                                 │
   │    timestamp: <ms epoch — original time OR Date.now()>,     │
   │    conversationId: "...",                                    │
   │    platform: "chatgpt"|"gemini"|"claude",                   │
   │    captureMethod: "sse_stream"|"history"|"dom"|"fetch_tree" │
   │  }                                                           │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
═══════════════════════════════════════════════════════════════════════
                    CONTENT SCRIPT → BACKGROUND
═══════════════════════════════════════════════════════════════════════
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                 QUEUE MANAGER (content script)               │
   │  src/content/queue-manager.js:299                            │
   │                                                              │
   │  queuedMessage = {                                          │
   │    timestamp: messageData.timestamp || Date.now(),  ← KEY   │
   │    content, role, conversationId, platform, ...              │
   │  }                                                           │
   │                                                              │
   │  ► If inject.js provided a real timestamp → preserved       │
   │  ► If no timestamp from inject → Date.now() (live typing)   │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  │ chrome.runtime.sendMessage
                                  │ { type: 'SAVE_MESSAGE', data: ... }
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │              BACKGROUND.JS — _saveMessageCore()              │
   │  background.js:266                                           │
   │                                                              │
   │  timestamp = messageData.timestamp || Date.now()             │
   │  capturedAt = Date.now()  ← always NOW (when BG received)   │
   │                                                              │
   │  newMessage = {                                             │
   │    ...messageData,                                          │
   │    timestamp,    ← original time (preserved from inject)     │
   │    capturedAt,   ← ingestion time (always current)           │
   │    contentHash,  ← SHA-256 for dedup                        │
   │    is_question, deflection, is_injection                     │
   │  }                                                           │
   │                                                              │
   │  Stored → chrome.storage.local (captured_messages array)     │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  │ scheduleDebouncedSync()
                                  │ (5s debounce, 30s max-wait)
                                  ▼
═══════════════════════════════════════════════════════════════════════
                    SYNC TO SUPABASE
═══════════════════════════════════════════════════════════════════════
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │              BROWSER-SYNC — syncMessages()                   │
   │  src/browser-sync.js:494                                     │
   │                                                              │
   │  messagesWithEmbeddings = filtered.map(msg => ({            │
   │    content, role, conversation_id, model,                   │
   │    timestamp: msg.timestamp || msg.capturedAt,  ← preserved │
   │    embedding: [...1024d],                                   │
   │    user_id, is_question, deflection                          │
   │  }))                                                         │
   │                                                              │
   │  Groups into conversation turns (messagesToTurnChunks)       │
   │  start_timestamp = first message timestamp in turn           │
   │  end_timestamp = last message timestamp in turn              │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  │ POST /save_chat_turn_batch
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │         EDGE FUNCTION — save_chat_turn_batch                 │
   │  supabase/functions/save_chat_turn_batch/index.ts            │
   │                                                              │
   │  For each turn:                                              │
   │    ts = turn.timestamp ? new Date(turn.timestamp).getTime()  │
   │         : Date.now()                                         │
   │                                                              │
   │  ┌─────────────────────────────────────────────────────┐     │
   │  │ RATE LIMIT CHECK (Phase 6)                          │     │
   │  │                                                     │     │
   │  │ Is turn "resurfaced"?                               │     │
   │  │   (Date.now() - turnTimestamp) > 90 days → YES      │     │
   │  │                                                     │     │
   │  │ ┌─ YES ──────────────────────────────────────────┐  │     │
   │  │ │ Check: count_resurfaced_conversations(user)    │  │     │
   │  │ │ free: 10, pro: 50, dev: 200 per 90-day window │  │     │
   │  │ │ Over limit? → SKIP old turns, save new ones   │  │     │
   │  │ │ Return rate_limited: true in response          │  │     │
   │  │ └───────────────────────────────────────────────┘  │     │
   │  │                                                     │     │
   │  │ ┌─ NO ───────────────────────────────────────────┐  │     │
   │  │ │ Save normally                                  │  │     │
   │  │ └───────────────────────────────────────────────┘  │     │
   │  └─────────────────────────────────────────────────────┘     │
   │                                                              │
   │  DB record = {                                              │
   │    start_timestamp: ts,         ← ms epoch (dedup key)      │
   │    created_at: ISO(ts),         ← ORIGINAL MESSAGE TIME     │
   │    ingested_at: NOW(),          ← WHEN K.Y.T. LEARNED IT   │
   │    last_accessed: NOW(),                                    │
   │    access_count: 0,                                         │
   │    impact_score: 0,             ← backfilled by gravity     │
   │    intimacy_level: 0,           ← backfilled by gravity     │
   │  }                                                           │
   │                                                              │
   │  Dedup: ON CONFLICT (user_id, conversation_id,              │
   │                       platform, start_timestamp)             │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                    SUPABASE — chat_turns                     │
   │                                                              │
   │  Columns relevant to recency:                                │
   │  ┌───────────────────┬────────────────────────────────────┐  │
   │  │ created_at        │ When content was ORIGINALLY said   │  │
   │  │ ingested_at       │ When K.Y.T. first LEARNED it      │  │
   │  │ last_accessed     │ When last RETRIEVED (rehearsal)    │  │
   │  │ access_count      │ # times retrieved (rehearsal)      │  │
   │  │ impact_score      │ Holmes-Rahe life-event scale 0-100│  │
   │  │ intimacy_level    │ Aron's 36 Questions scale 0-3     │  │
   │  │ start_timestamp   │ Epoch ms (dedup key, = created_at)│  │
   │  └───────────────────┴────────────────────────────────────┘  │
   │                                                              │
   │  KEY SCENARIO — Old Chat Brought Forward:                    │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ Conversation from Jan 2025 opened in Mar 2026          │  │
   │  │                                                        │  │
   │  │ OLD turns (Jan 2025):                                  │  │
   │  │   created_at = 2025-01-15   ← original time preserved │  │
   │  │   ingested_at = 2026-03-13  ← when captured by K.Y.T. │  │
   │  │   Gap: 423 days → "revisited" signal                   │  │
   │  │                                                        │  │
   │  │ NEW turn (user types today):                           │  │
   │  │   created_at = 2026-03-13   ← genuinely recent         │  │
   │  │   ingested_at = 2026-03-13  ← same (live capture)      │  │
   │  │                                                        │  │
   │  │ Result: Old turns decay correctly by ORIGINAL date.    │  │
   │  │ New turn gets proper recency boost. No corruption.     │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
═══════════════════════════════════════════════════════════════════════
              RETRIEVAL & GRAVITY SCORING PIPELINE
═══════════════════════════════════════════════════════════════════════
                                  │
    When user sends a new message on ANY platform...
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  CLIENT: getContextForInjection()                            │
   │  src/context-retrieval.js                                    │
   │                                                              │
   │  STEP 0: Preference Router (0ms regex)                       │
   │    "What is my favorite movie?" → short-circuit to prefs DB  │
   │    ► If pure preference query → return immediately            │
   │    ► If has qualifier ("and why") → save prefs, continue      │
   │                                                              │
   │  Query Transformation (3s timeout)                            │
   │    HyDE expansion (if circuit breaker not open)               │
   │    Recent topic enrichment (≤6 words or temporal hint)        │
   │                                                              │
   │  Dual-Path Search:                                            │
   │    ┌─ Edge mode (authenticated) ─────────────────────────┐   │
   │    │  searchViaEdgeFunction() → server-side pipeline      │   │
   │    └──────────────────────────────────────────────────────┘   │
   │    ┌─ Legacy mode (fallback) ────────────────────────────┐   │
   │    │  searchHybrid() → client-side vector + BM25          │   │
   │    │  maxTimestamp = Date.now() - 120s (exclusion window)  │   │
   │    └──────────────────────────────────────────────────────┘   │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              ▼ (Edge Path)                           ▼ (Legacy Path)
   ┌─────────────────────────┐             ┌─────────────────────────┐
   │  SERVER: search_memories │             │  CLIENT: searchHybrid   │
   │  get_relevant_memories.ts│             │  browser-search.js      │
   │                          │             │  Local IndexedDB +      │
   │  (see server pipeline    │             │  BM25 keyword matching  │
   │   detail below)          │             │  Gravity from local     │
   └────────────┬─────────────┘             └────────────┬────────────┘
                │                                        │
                └────────────────┬───────────────────────┘
                                 │
                                 ▼
═══════════════════════════════════════════════════════════════════════
              SERVER-SIDE RETRIEVAL PIPELINE (Edge Path)
              get_relevant_memories.ts
═══════════════════════════════════════════════════════════════════════
                                 │
                                 ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 1: Embed query (Qwen3-8B → 1024d Matryoshka)          │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 2: Entity extraction from query                        │
   │    "Walter Payton" → entity search → boostEntityIds          │
   │    Platform names excluded from boost (filter, not topic)     │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 3: HyDE — hypothetical doc embedding (if not skipped)  │
   │    Claude Haiku 4.5 generates hypothetical answer             │
   │    Embedded separately for dual-embedding RRF                 │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 4: Vector Search via match_messages_with_gravity       │
   │                                                              │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  SQL: GRAVITY SCORE COMPUTATION                        │  │
   │  │                                                        │  │
   │  │  vector_similarity = 1 - (embedding <=> query_emb)     │  │
   │  │                                                        │  │
   │  │  importance = 1 + impact/100 + intimacy×0.2            │  │
   │  │              Range: [1.0, 2.6]                         │  │
   │  │                                                        │  │
   │  │  ┌────────────────────────────────────────────────┐    │  │
   │  │  │  ADAPTIVE TIME DECAY (uses created_at)         │    │  │
   │  │  │  days = (NOW - created_at) / 86400             │    │  │
   │  │  │                                                │    │  │
   │  │  │  HIGH importance (>1.5):                       │    │  │
   │  │  │    1 / (1 + ln(1 + days/30))                   │    │  │
   │  │  │    "Wedding day" → 20% after 1 year            │    │  │
   │  │  │                                                │    │  │
   │  │  │  LOW importance (<1.2):                        │    │  │
   │  │  │    e^(-days/30)                                │    │  │
   │  │  │    "Weather chat" → 13.5% after 60 days        │    │  │
   │  │  │                                                │    │  │
   │  │  │  MEDIUM importance (1.2-1.5):                  │    │  │
   │  │  │    1 / (1 + days/60)                           │    │  │
   │  │  │    "Project discussion" → 50% after 60 days    │    │  │
   │  │  └────────────────────────────────────────────────┘    │  │
   │  │                                                        │  │
   │  │  rehearsal = min(1 + access_count × 0.05, 1.5)        │  │
   │  │              Each retrieval → +5% boost (max 50%)      │  │
   │  │                                                        │  │
   │  │  GRAVITY = similarity × importance × decay × rehearsal │  │
   │  │  ORDER BY gravity DESC                                 │  │
   │  │                                                        │  │
   │  │  EXCLUSION: WHERE created_at < NOW() - 120s            │  │
   │  │  (prevents injecting back the context we just added)    │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 5a: RRF Merge — raw + HyDE + graph results            │
   │  STEP 5b: Entity Timeline Guarantee                          │
   │    → inject newest mention of each query entity               │
   │    → prevents "Jerry problem" (old rich content hides         │
   │      short factual correction)                                │
   │  STEP 5c: Filter query echoes                                │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 6: Rerank (cross-encoder) + Quality Penalties          │
   │                                                              │
   │  6a. Cross-encoder reranking                                  │
   │  6b. Quality penalties (applyQualityPenalties):               │
   │      1. Hard drops: recursion guard, meta flag, artifacts     │
   │      2. Substance penalty                                     │
   │      3. Deflection penalty                                    │
   │      4. Meta-conversation penalty (0.3×)                      │
   │      5. Diagnostic penalty (0.5×)                             │
   │      6. Echo penalty (0.5×–0.9×)                              │
   │      7. Bare question filter                                  │
   │   ► 8. RECENCY MULTIPLIER ◄                                  │
   │      │  half_life = 30 days                                   │
   │      │  multiplier = e^(-days/30)                             │
   │      │  blend: 85% original + 15% recency-adjusted            │
   │      │  Uses: created_at (= original message time)            │
   │      │                                                        │
   │      │  Example (old chat brought forward):                   │
   │      │  Jan 2025 msg: days=423 → mult=0.0000007 → ~0% boost │
   │      │  Today msg:    days=0   → mult=1.0       → 15% boost  │
   │      │  Correct: old msg stays low, new msg gets boost        │
   │      └────────────────────────────────────────────────        │
   │                                                              │
   │  6c. Content dedup → MMR → Keyword boost                     │
   │  6d. Platform-mismatch penalty (Gap 3)                        │
   │  6e. Platform-filtered rescue (if all penalized away)         │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  STEP 7: Entity enrichment + BM25 boost + confidence filter  │
   │    → Return top-K results with scores                         │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
═══════════════════════════════════════════════════════════════════════
              CLIENT-SIDE POST-PROCESSING
═══════════════════════════════════════════════════════════════════════
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  FALLBACKS (context-retrieval.js)                            │
   │                                                              │
   │  Temporal+Platform Fallback:                                  │
   │    "What did I discuss recently on Gemini?" + 0 Gemini items │
   │    → recentByPlatform query → ORDER BY created_at DESC       │
   │                                                              │
   │  Synthesis+Platform Fallback:                                 │
   │    "Connect my ChatGPT and Gemini discussions"                │
   │    → platform-specific recency query                          │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  CONFIDENCE FILTER (context-retrieval.js:637)                │
   │                                                              │
   │  Adaptive thresholds:                                         │
   │    Jina reranked:       0.40 (calibrated scores)              │
   │    No Jina:             0.01 (uncalibrated)                   │
   │    BM25-only:           0.25                                  │
   │    Classifier override:  confidenceThreshold from intent      │
   │                                                              │
   │  Low-confidence rescue:                                       │
   │    0.25+ with platform mention → keep top 2                   │
   │    0.10+ → keep top 2 (marked lowConfidence)                  │
   │    <0.10 → drop everything                                    │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  PREFERENCE + VECTOR MERGE                                   │
   │    If preference router found results AND query had qualifier │
   │    → preferences get score floor above highest vector score   │
   │    → merged into filteredItems                                │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  BUILD MEMORY INJECTION                                      │
   │  kyt-memory-injection-builder.js                             │
   │                                                              │
   │  Format items into injection block with:                      │
   │    [RETRIEVAL_CONTEXT]                                        │
   │    Per item: content, platform, timestamp, confidence         │
   │    [/RETRIEVAL_CONTEXT]                                       │
   │                                                              │
   │  Injected into next outbound prompt to LLM                   │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
                          CONTEXT INJECTED
                       ─── PIPELINE DONE ───


═══════════════════════════════════════════════════════════════════════
              REVISITED SIGNAL (ingested_at - created_at)
═══════════════════════════════════════════════════════════════════════

  ┌─────────────────────────────────────────────────────────────────┐
  │  The gap between ingested_at and created_at is a metadata       │
  │  signal — NOT used in scoring, but queryable:                   │
  │                                                                 │
  │  Gap < 2 min  → Live capture (user typing right now)            │
  │  Gap 2min-24h → Same-day capture (sync delay, page refresh)     │
  │  Gap > 24h    → User revisited an old conversation              │
  │  Gap > 90d    → User resurfaced a very old memory               │
  │                                                                 │
  │  Rate-limited:                                                  │
  │    count_resurfaced_conversations(user, 90 days)                │
  │    free: 10 / pro: 50 / dev: 200 convos per 90-day window      │
  │                                                                 │
  │  Future uses:                                                   │
  │    - "Recently revisited" boost in retrieval                    │
  │    - UI indicator in search results                             │
  │    - Analytics: which old conversations users return to         │
  │    - Upsell signal ("Upgrade for unlimited history recall")     │
  └─────────────────────────────────────────────────────────────────┘
```

---

## DELIVERABLE 2: TECHNICAL WALKTHROUGH

### Section 1: Message Capture — Timestamp Assignment

The pipeline begins in platform-specific inject scripts running in the page's MAIN world. Each script intercepts API calls (fetch/XHR) and DOM mutations to capture messages.

**The core problem**: When a user opens an old conversation, the platform loads historical messages through the same API endpoints as live messages. Without intervention, all captured messages get `Date.now()` — a January 2025 conversation appears as March 2026 data in K.Y.T., corrupting gravity decay.

**The fix**: Each capture path now extracts the **original message timestamp** from the platform's API response:

| Platform | Capture Path | Timestamp Source | Format |
|----------|-------------|-----------------|--------|
| ChatGPT | SSE stream (assistant) | `json.message.create_time` | seconds epoch |
| ChatGPT | SSE stream (user voice) | `messageNode.create_time` | seconds epoch |
| ChatGPT | DOM observer | `<time datetime="...">` | ISO 8601 |
| ChatGPT | Conversation tree | `node.message.create_time` | seconds epoch |
| ChatGPT | User outbound POST | `Date.now()` | ms epoch (correct — live) |
| Gemini | History load (batchexecute) | `turn[idx]` epoch probe | seconds or ms epoch |
| Gemini | Live StreamGenerate | `Date.now()` | ms epoch (correct — live) |
| Claude | Mobile sync / conv tree | `msg.created_at` | ISO 8601 |
| Claude | User outbound POST | `Date.now()` | ms epoch (correct — live) |

All timestamps are normalized to **milliseconds epoch** before dispatch via `KYT_MESSAGE_CAPTURED`.

**Error handling**: Every extraction is wrapped in try/catch. If parsing fails or the expected field is missing, the code falls back to `Date.now()`. This means live messages are always correct (they ARE happening now), and historical messages get the best-effort original timestamp.

**Gemini timestamp heuristic**: Gemini's batchexecute response structure is undocumented. The parser probes indices 0–7 of each turn array looking for numbers in the 2020–2030 epoch range (seconds: 1577836800–1893456000, milliseconds: ×1000). This is fragile but bounded by range validation, and falls back to `Date.now()` if nothing matches.

---

### Section 2: Message Flow — Content Script to Chrome Storage

The captured message flows through three layers before reaching Supabase:

1. **Queue Manager** (`src/content/queue-manager.js:299`): Creates the canonical message object. `timestamp` is preserved from the inject script's `KYT_MESSAGE_CAPTURED` event. If absent, `Date.now()` fills in.

2. **Background Service Worker** (`background.js:266`): Receives via `chrome.runtime.sendMessage`. Adds `capturedAt: Date.now()` (always current time — when the background script processed the message) alongside the preserved `timestamp`. Also computes `contentHash` (SHA-256) and classifies the turn (question detection, deflection detection, injection detection).

3. **Chrome Storage**: The enriched message is persisted to `chrome.storage.local`. The two timestamps (`timestamp` and `capturedAt`) travel together but serve different purposes:
   - `timestamp` → becomes `created_at` in the DB (original message time)
   - `capturedAt` → used as a fallback and for sync filtering

---

### Section 3: Sync to Supabase — The Two-Timestamp Split

When `executeDebouncedSync()` fires (after 5s debounce):

1. **Browser Sync** (`src/browser-sync.js:494`) batches messages, generates embeddings (Qwen3-8B, 1024d Matryoshka), and groups messages into conversation turns. The `timestamp` field flows through untouched.

2. **Edge Function** (`save_chat_turn_batch/index.ts`) receives the batch and performs the critical timestamp split:

```
created_at = new Date(turn.timestamp).toISOString()  ← original message time
ingested_at = new Date().toISOString()                ← always NOW
```

This is the point where the "revisited" signal is born. For a live message, `created_at ≈ ingested_at` (difference < seconds). For a resurfaced old message, `created_at` could be months or years before `ingested_at`.

**Deduplication**: The conflict key is `(user_id, conversation_id, platform, start_timestamp)`. Since `start_timestamp` uses the original timestamp, a message captured twice with the same original time deduplicates correctly. However, a message first captured with `Date.now()` (before this fix) and later with its real `create_time` would have different `start_timestamp` values and insert as a new row. The old row decays naturally via gravity — no cleanup needed.

---

### Section 4: Re-Ingestion Rate Limiting

Before inserting turns in the fast path, the edge function checks whether the batch contains "resurfaced" turns:

```typescript
function isResurfacedTurn(turn): boolean {
    return (Date.now() - turn.timestamp) > 90_days;
}
```

If any resurfaced turns exist, it queries `count_resurfaced_conversations()` — a SQL function that counts distinct conversations where `ingested_at - created_at > 90 days` within the last 90-day window.

| Tier | Limit per 90 days | Use case |
|------|-------------------|----------|
| free | 10 conversations | Casual browsing |
| pro | 50 conversations | Active curation |
| dev | 200 conversations | Development/testing |

When rate-limited, old turns are filtered out but new turns in the same batch are saved. The response includes `rate_limited: true` so the extension can surface a notification. This is also an upsell signal — the same pattern as the LIFBG premium tier for backfill speed.

---

### Section 5: Gravity Scoring — How Recency Affects Retrieval

The gravity score is the core ranking signal. It's computed in PostgreSQL during vector search:

```
gravity = vector_similarity × importance × time_decay × rehearsal
```

**Time decay uses `created_at`** — the original message time, NOT `ingested_at`. This is the critical design decision: a January 2025 message resurfaced in March 2026 decays based on its January 2025 date (423 days of decay), not its March 2026 ingestion date (0 days).

The three decay curves are importance-adaptive:

- **High importance (>1.5)** — Logarithmic: `1 / (1 + ln(1 + days/30))`. "My grandmother passed away" retains ~20% strength after 1 year. These are life events that should persist.

- **Low importance (<1.2)** — Exponential: `e^(-days/30)`. "The weather is nice" retains ~13.5% after 60 days. Surface-level content fades fast.

- **Medium importance (1.2–1.5)** — Hyperbolic: `1 / (1 + days/60)`. Work discussions, project details. Moderate fade.

The **rehearsal bonus** (`1 + access_count × 0.05`, capped at 1.5×) rewards memories that are frequently retrieved. Each time a memory appears in a retrieval result, its `access_count` increments and `last_accessed` updates, slowing future decay.

**120-second exclusion window**: `WHERE created_at < NOW() - 120s` prevents the context injection itself from being retrieved on the next message. Without this, K.Y.T. would retrieve its own injected context in a feedback loop.

---

### Section 6: Server-Side Quality Penalties — Recency Multiplier

After cross-encoder reranking, `applyQualityPenalties()` runs 11 filters/adjustments. The **recency multiplier** (step 8 of 11) is a mild 30-day exponential boost:

```typescript
const recencyMultiplier = Math.exp(-daysSince / 30);
item.rerank_score = item.rerank_score * 0.85 + item.rerank_score * recencyMultiplier * 0.15;
```

This is a **15% blend** — 85% of the score comes from semantic relevance + gravity, 15% from pure recency. The two recency mechanisms stack:

1. **Gravity decay** (SQL, coarse): Determines whether the message even makes it into the candidate pool. Old low-importance messages may not clear the similarity threshold at all.

2. **Recency multiplier** (TypeScript, fine): Among candidates that DO make it through, gives a tiebreaker advantage to newer content. A message from yesterday gets `e^(-1/30) ≈ 0.967 → 14.5% boost`. A message from 6 months ago gets `e^(-180/30) ≈ 0.0025 → 0.04% boost`.

Together, these ensure that when old and new content are semantically similar, the new content wins — but a highly relevant old memory can still surface if nothing recent matches.

---

### Section 7: The Complete Scenario — Old Chat With New Turn

A user has a ChatGPT conversation from January 2025 about their favorite books. In March 2026, they open it and add a new message: "Actually, I changed my mind — my favorite is now Dune."

**What happens per turn**:

| Turn | Role | Original Date | created_at | ingested_at | Gravity Decay |
|------|------|--------------|-----------|------------|--------------|
| "I love Lord of the Rings" | user | Jan 15, 2025 | 2025-01-15 | 2026-03-13 | 423 days → very low |
| "Great choice! Tolkien's..." | assistant | Jan 15, 2025 | 2025-01-15 | 2026-03-13 | 423 days → very low |
| "Actually, I changed my mind..." | user | Mar 13, 2026 | 2026-03-13 | 2026-03-13 | 0 days → maximum |

The old turns:
- `created_at` preserves the original January 2025 date (extracted from ChatGPT's `create_time` in the SSE stream or conversation tree)
- `ingested_at` = NOW (March 2026) — records when K.Y.T. learned about them
- Gravity decay treats them as 14-month-old content — they won't compete with genuinely recent memories
- The `ingested_at - created_at` gap (423 days) marks this as a "revisited" conversation

The new turn:
- `created_at` = March 2026 (user typing right now, `Date.now()` is correct)
- `ingested_at` = March 2026 (same — live capture)
- Gets full recency boost in gravity and the 15% recency multiplier
- If someone later asks "What's my favorite book?", the Dune turn wins because (a) it's the most recent entity mention for "favorite book" and (b) the entity timeline guarantee ensures the newest mention of matched entities is injected into the candidate pool

---

## DELIVERABLE 3: EXPERT OPINION

### Strengths

**1. Two-timestamp design is elegant.** Separating `created_at` (semantic time) from `ingested_at` (ingestion time) preserves both signals without requiring any changes to the gravity scoring function. The existing `calculate_gravity_score()` already uses `created_at` — the fix is entirely in the capture layer, not the scoring layer. This is a clean separation of concerns.

**2. Fail-open on timestamp extraction.** Every platform's timestamp extraction is wrapped in try/catch with `Date.now()` fallback. This means the worst case for a failed extraction is the pre-fix behavior (using current time), not a crash. Live messages already get `Date.now()` correctly, so the failure mode only affects historical messages — and those were already broken before the fix.

**3. Rate limiting at the conversation level, not per-turn.** Counting distinct conversations rather than individual turns is correct — opening one old chat surfaces 50+ turns but is a single user action. Per-turn limits would punish long conversations unfairly.

**4. The revisited signal is a free byproduct.** No extra tracking needed — `ingested_at - created_at > threshold` answers "did the user return to this topic?" This is valuable metadata for future features (relevance boosting, UI indicators, analytics) without adding complexity now.

### Weaknesses and Risks

**1. Gemini timestamp heuristic is fragile.** Probing array indices for epoch-range numbers is a heuristic that will break when Google changes their response format. The 2020–2030 range validation helps, but a random large integer in the turn structure could be misidentified as a timestamp. Mitigation: the fallback is `Date.now()`, which is the pre-fix behavior — no regression, just a missed opportunity.

**2. ChatGPT DOM selector fragility.** `<time datetime>` elements may move in the DOM tree. The `closest('[data-testid*="conversation-turn"]')` selector depends on ChatGPT's test ID convention. When it breaks, it silently falls back to `Date.now()` — acceptable but worth monitoring.

**3. Duplicate rows on re-capture.** A message captured before this fix (with `Date.now()` as `start_timestamp`) and captured again after (with real `create_time`) will have different dedup keys and insert as a new row. The old row decays via gravity, so this is eventually consistent, but temporarily there will be near-duplicate content in the DB. This is explicitly called out as "acceptable" in the plan.

**4. Rate limit check adds latency to the fast path.** The `count_resurfaced_conversations()` RPC adds a database round-trip to every batch that contains old turns. The index on `ingested_at DESC` should keep this fast, but it's worth monitoring query time. If it becomes a bottleneck, an in-memory counter (reset per edge function cold start) could approximate the check.

### Scalability Considerations

The `ingested_at` index adds write overhead to every insert. For a personal memory system (hundreds of messages per day), this is negligible. At scale (thousands of users), the backfill `UPDATE chat_turns SET ingested_at = created_at` in the migration could lock the table briefly — run during low-traffic hours.

The rate limit RPC scans `chat_turns` filtered by `user_id` and `ingested_at`. With the descending index and user-scoped filter, this should remain fast (<10ms) for any reasonable data volume. If chat_turns grows to millions of rows per user, a materialized count table would be more efficient.

### Architecture Assessment

The single-pipeline approach (gravity scoring → quality penalties → MMR → platform penalty → confidence filter) is well-structured. Each stage has a clear responsibility and the ordering is principled: coarse filtering first (gravity threshold), fine adjustments after reranking (recency multiplier, platform penalty), diversity last (MMR). The two-timestamp fix integrates cleanly because it only changes what feeds INTO the pipeline, not the pipeline itself.

---

## DELIVERABLE 4: RESOURCES

### RAG Fundamentals

1. **"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"** — Lewis et al., NeurIPS 2020. The foundational RAG paper. Establishes the retrieve-then-generate paradigm that K.Y.T. implements across platforms.

2. **"A Survey on Retrieval-Augmented Text Generation"** — Gao et al., 2024. Comprehensive survey covering pre-retrieval, retrieval, and post-retrieval techniques. Useful for understanding where quality penalties and MMR fit in the landscape.

### Time-Aware Retrieval & Memory Systems

3. **"Time-Aware Language Models as Temporal Knowledge Bases"** — Dhingra et al., TACL 2022. Directly relevant to K.Y.T.'s adaptive time decay — explores how temporal signals should modulate retrieval relevance.

4. **"MemoryBank: Enhancing Large Language Models with Long-Term Memory"** — Zhong et al., AAAI 2024. Implements Ebbinghaus forgetting curves for LLM memory — similar inspiration to K.Y.T.'s gravity decay (exponential/logarithmic curves based on importance).

5. **"Generative Agents: Interactive Simulacra of Human Behavior"** — Park et al., UIST 2023 (Stanford). Their memory system uses recency × importance × relevance scoring — the same three-factor model K.Y.T.'s gravity score implements (time_decay × importance_multiplier × vector_similarity).

### Gravity & Decay Models

6. **"The Holmes-Rahe Life Stress Inventory"** — Holmes & Rahe, 1967. The psychological scale behind K.Y.T.'s `impact_score` (0–100). Maps life events to stress units — adapted here as "memory importance" for decay curve selection.

7. **"Ebbinghaus Forgetting Curve"** — Ebbinghaus, 1885. The original exponential memory decay model. K.Y.T.'s low-importance decay (`e^(-days/30)`) is a direct implementation with a 30-day time constant.

8. **"Spaced Repetition and Memory Consolidation"** — various. The theoretical basis for K.Y.T.'s rehearsal bonus (`access_count × 0.05`). Each retrieval strengthens the memory trace, slowing future decay.

### Hybrid Search & Reranking

9. **"Reciprocal Rank Fusion"** — Cormack et al., SIGIR 2009. The RRF algorithm used in K.Y.T.'s Step 5a to merge raw, HyDE, and graph results into a single ranked list.

10. **"Matryoshka Representation Learning"** — Kusupati et al., NeurIPS 2022. The technique enabling K.Y.T.'s 1024d truncation from Qwen3-8B's native 4096d embeddings without quality loss. Critical for HNSW index performance.

11. **"Maximal Marginal Relevance (MMR)"** — Carbonell & Goldstein, SIGIR 1998. The diversity algorithm used in K.Y.T.'s Step 6c to prevent near-duplicate content from dominating the injection context.

### Vector Database & Indexing

12. **pgvector documentation** — Supabase/pgvector. K.Y.T. uses pgvector's `<=>` cosine distance operator with HNSW indexes for approximate nearest neighbor search. The `match_messages_with_gravity` RPC wraps pgvector queries with gravity scoring.

13. **"Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs"** — Malkov & Yashunin, IEEE TPAMI 2020. The HNSW algorithm behind K.Y.T.'s vector index. Explains the logarithmic search complexity that keeps vector search at ~82ms.

### Personal Knowledge Management

14. **"Building a Second Brain"** — Tiago Forte, 2022. The conceptual framework K.Y.T. implements technically — capturing, organizing, and retrieving personal knowledge across platforms. The "revisited signal" (`ingested_at - created_at`) aligns with Forte's concept of "progressive summarization" through repeated engagement.

15. **"How to Take Smart Notes"** — Sönke Ahrens, 2017. The Zettelkasten method's principle of atomic, interconnected notes maps to K.Y.T.'s entity graph and cross-conversation linking. The entity timeline guarantee (Step 5b) ensures corrections and updates supersede older information — a digital version of "always link to the latest note."

</documentation>

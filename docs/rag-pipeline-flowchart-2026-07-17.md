# K.Y.T. RAG Pipeline — Architecture Flowchart & Technical Documentation

**Snapshot date:** 2026-07-17 · **Branch:** `feature/projects-vault`
**Verified against source:** `supabase/functions/_shared/get_relevant_memories.ts` (1,928 lines), `src/context-retrieval.js` (901 lines), `supabase/functions/save_chat_turn_batch/index.ts`, `_shared/huggingface-client.ts`, `_shared/mmr.ts`, `_shared/quality-penalties.ts`, `_shared/conversation-chunker.ts`, `_shared/entity-extractor.ts`, `mcp/src/hooks/prompt-inject.js`.

K.Y.T. ("Keep Your Thoughts") is a cross-platform conversation memory system: a Chrome extension (MV3) captures ChatGPT / Claude / Gemini conversations, an MCP server captures Claude Code sessions, everything syncs to Supabase with embeddings, and a retrieval pipeline injects relevant memories back into the user's next prompt on any platform.

---

# DELIVERABLE 1: FLOWCHART

## 1.0 Embedding Layers (summary table)

| # | Layer | Model / Method | Dims | Storage / Index | Purpose |
|---|-------|----------------|------|-----------------|---------|
| E1 | **Turn embeddings** | Qwen3-Embedding-8B via HF Router → Scaleway (`qwen3-embedding-8b`), Matryoshka-truncated 4096d → 1024d, L2-renormalized | 1024 | `chat_turns.embedding`, HNSW (pgvector caps HNSW at 2000d — hence 1024) | Primary semantic search surface. Embeds `contextual_content` (LLM context prefix + raw text) when available, else raw content. |
| E2 | **Entity embeddings** | Same Qwen3 1024d, embedding of entity canonical name | 1024 | `entities.embedding`, HNSW | Entity similarity search (`search_entities_by_embedding`, threshold 0.8) and fuzzy dedup at ingestion (merge if same type AND ≥0.90 similarity). |
| E3 | **Query embeddings** (ephemeral) | Same Qwen3 1024d — raw query + optional HyDE document | 1024 | Not stored | Dual-embedding retrieval. HyDE embedding passes a drift gate: discarded if cosine(raw, hyde) < 0.3. |
| E4 | **Cross-encoder reranker** | `BAAI/bge-reranker-v2-m3` via HF Router → Scaleway | n/a (scoring, not embedding) | Not stored | Query×document relevance scoring on `contextual_content`; produces `rerank_score`, the pipeline's spine score. |
| L1 | **Lexical: keyword FTS** | Postgres full-text (`search_turns_by_keywords` RPC) + BM25-style boost in-pipeline | — | tsvector | Buried-clause evidence recovery + rank boost for exact term matches. |
| L2 | **Lexical: emotion keywords** | `emotion_keywords text[]` GIN overlap | — | GIN | Emotional-query recall lane (grief/anxiety/etc. + synonym clusters). |
| L3 | **Lexical: entity trigram** | `search_entities_by_text` (trigram) + static/dynamic synonym expansion | — | pg_trgm | Catches entities embeddings miss ("NFL" ↛ "Walter Payton"). |
| G1 | **Graph layer** | `entity_relationships` (co-occurrence counts + strength; no relationship types) | — | relational | Graph walk (depth ≤ 3) from matched entities to related turns; also source of *dynamic synonyms* (strength ≥ 0.7). |

Embedding resilience: single provider (Scaleway is the only host of qwen3-embedding-8b) with 5 retries / 15s timeout; on total failure a circuit breaker opens and turns sync with **null embeddings**, later filled by the `backfill_embeddings` alarm. BM25 acts as the retrieval fallback when embeddings are unavailable.

---

## 1.1 WRITE PATH — Capture & Ingestion

```
═══════════════════════ CAPTURE ═══════════════════════

[USER CONVERSATION]
  ChatGPT / Claude / Gemini web ──► content scripts (DOM/live capture)
  Claude Code sessions ──────────► MCP SessionEnd hook (session-ingest.js, JSONL parser)
        │
        ▼
[CONTENT QUEUE  (src/content/queue-manager.js)]
  Function: buffers captured messages; strips prior K.Y.T. injection
  blocks from user messages (stripInjectionPrefix, 4 legacy formats)
  so stored data isn't polluted by the system's own injections.
        │
        ▼
[SYNC CONTROLLER  (src/sync-controller.js)]
  Function: debounced sync scheduling/flush; `kyt_sync_pending`
  safety net in chrome.storage.local (MV3 service worker can die anytime).
        │
        ▼
[CONVERSATION CHUNKER  (conversation-chunker)]
  Function: sliding-window chunking — 5 turns per chunk, 2-turn overlap
  (chunk1: turns 1–5, chunk2: 4–8, …). Pairs user+assistant turns so
  answers stay attached to their questions ("full-context chunking").
  Position: before embedding — the chunk is the retrieval unit.

═══════════════════════ INGESTION (edge: save_chat_turn_batch) ═══════════════════════

        │  batch ≤ 50 turns
        ▼
[AUTH & TRUST GATE  (resolveUserId)]
  Real user JWT → pin all turns to that user · service-role → trust
  body user_id (benchmark ingest) · anon/other → 401.
  Then: project-ownership validation → tier-aware rate limit.
        │
        ▼
[CLASSIFICATION  (per turn, parallel)]
  ├─ detectIsQuestion / detectDeflection  — heuristic flags stored on the
  │    row; used later as *scoring* signals (not hard filters)
  ├─ classifyMemory (Haiku)  — impact_score (Holmes-Rahe 0-100),
  │    intimacy_level (0-3), valence, arousal, emotion_keywords[]
  ├─ extractEntities (Haiku) — entities + preferences; skipped for
  │    emotional-category content
  └─ generateChunkContext   — contextual retrieval: LLM-generated context
       prefix + raw content → `contextual_content`
        │
        ▼
[EMBEDDING  (E1)]
  Embed contextual_content if present, else raw content.
  Qwen3-8B → 1024d Matryoshka + L2 renorm. 5 retries; on failure the
  row is upserted with a null embedding and backfilled later.
        │
        ▼
[UPSERT chat_turns]
  content, contextual_content, embedding, speakers[], platform,
  impact/intimacy/valence/arousal/emotion_keywords, is_question,
  deflection, gravity inputs, project_id. (No `role` column —
  `speakers text[]`.) skip_ai_processing=true → fast bulk upsert path
  (history imports) with classification deferred to backfill alarms.
        │
        ├──► [saveEntitiesWithMentions]  entities + entity_mentions;
        │      entity embedding (E2) + fuzzy dedup (≥0.90 same-type merge);
        │      co-occurrence updates feed entity_relationships (G1)
        └──► [savePreferences]  structured user_preferences rows
               (category, value, sentiment, confidence) — powers the
               preference router short-circuit at read time
        │
        ▼
[BACKFILL ALARMS]  embeddings / entities / emotions / contextual /
  gravity / preferences — repair lanes for nulls left by fast paths.

                                (write path done — data is retrievable)
```

---

## 1.2 READ PATH — Retrieval & Injection

```
[USER INPUT]  new prompt on ChatGPT / Claude / Gemini / Claude Code
        │
        ├── extension platforms → content script pre-send hook
        │     → background.js → getContextForInjection()
        └── Claude Code → MCP UserPromptSubmit hook (prompt-inject.js)
              → ~10% of prompts pass its local gate → search_memories
              (fast mode) → injects compact `[KYT:v1] {json}` context

═══════════════ SECTION A: CLIENT ORCHESTRATOR (src/context-retrieval.js) ═══════════════

[PIPELINE TIMEOUT WRAPPER]
  Function: whole pipeline raced against 22s (content.js port dies at 26s).
  Benefit: an overloaded backend degrades to "no injection", never a hang.
        │
        ▼
[STEP 0: PREFERENCE ROUTER  (client)]
  Function: regex classifier for "what's my favorite X?" (6 patterns) →
  direct `lookup_user_preferences` RPC (cap 3 rows).
  Position rationale: 0ms, before any embedding — cheapest possible win.
  Short-circuits the whole vector pipeline UNLESS the query has a trailing
  qualifier ("…and why") — then prefs are held and merged after retrieval.
        │
        ▼
[CIRCUIT BREAKERS]
  API CB (consecutive-failure) · embedding CB (shared HF rate limit) ·
  HyDE CB. Open breakers reroute stages (vector → BM25 fallback) instead
  of failing the pipeline.
        │
        ▼
[ROUTING MODE]  edge (authenticated, default) vs legacy (client-side)
        │
        ├─ legacy only: [QUERY TRANSFORMATION] (3s timeout, recent-topic
        │   aware rewrite; skipped in edge mode — server HyDE covers it)
        ▼
[SYNC-BEFORE-SEARCH]  flush pending turns so cross-platform memories
  from seconds ago are searchable now.
        │
        ▼
[RECENT-TOPIC ENRICHMENT]
  Function: if query is short (≤6 words) or temporal ("what did we talk
  about earlier"), attach up to 5 recent topics as grounding hints.
        │
        ▼
[SEARCH DISPATCH]
  ├─ edge mode ──► search_memories edge fn, **fast:true** (Section B fast path)
  │     └─ 0 results + transformed query → retry with original query
  ├─ legacy ────► searchHybrid() client-side (BM25 + vector + HyDE + graph)
  └─ test mode ─► search_test_user RPC (SECURITY DEFINER)
        │
        ▼
[TEMPORAL + PLATFORM FALLBACK]     [SYNTHESIS + PLATFORM FALLBACK]
  Query names a platform with        Query has synthesis language
  temporal intent and search          ("connect", "relate") + platform
  found nothing from it →             and none present → fetch 5 recent
  recentByPlatform (pure               platform items for the LLM to
  ORDER BY created_at DESC).           bridge topics.
        │
        ▼
[CONFIDENCE FILTER  (client)]
  Threshold 0.40 (reranked) / 0.25 (BM25-only) / 0.01 (unreranked).
  Rescue tiers: platform-mention rescue (top 2 ≥ 0.25) → low-confidence
  tier (top 2 ≥ 0.10, flagged) → below 0.10 drop all.
  Change note: quality penalties, MMR, keyword boost, echo/meta/deflection
  filters MOVED SERVER-SIDE (unified pipeline); client keeps only this
  threshold + fallbacks.
        │
        ▼
[PREFERENCE + VECTOR MERGE]  qualifier queries: pref items floored just
  above the best vector score so they rank first, deduped.
        │
        ▼
[INJECTION BUILDER  (buildNaturalLanguageInjection)]
  Natural-language parenthetical block "(For context: I've talked about
  things like this before …)" prepended to the user's message —
  platform-specific phrasing. No results → NO injection (no negative signal).
        │
        ▼
[FINAL OUTPUT]  context-enriched prompt → platform LLM answers with memory
  → the new exchange is captured by the WRITE PATH (loop closes).

═══════ SECTION B: SERVER UNIFIED PIPELINE (edge: search_memories → get_relevant_memories.ts) ═══════

[ENTRY]  resolveUserId (JWT / service-role) · profile + project scoping
  (projects-vault: p_project_id threads through every RPC)
        │
        ▼
[STEP 0: PREFERENCE ROUTER  (server twin)]
  Same regex + lookup_user_preferences; short-circuit on hit.
  Kept in both layers so MCP/API callers get it without the extension.
        │
        ▼
[STEP 0.3: COREFERENCE RESOLUTION]
  Function: Haiku resolves "it/that/the other one" using the conversation
  window. Gated: only fires on implicit-pronoun signals AND no named
  entity/tech keyword in the query. Skipped in fast mode.
        │
        ▼
[STEP 0.5: QUERY DECOMPOSITION]
  Function: multi-hop regex gate ("compare X and Y", two platform mentions)
  → Haiku splits into 2-3 sub-queries → parallel recursive retrievals
  (decomposition disabled inside) → RRF merge → dedup → platform penalty.
  Benefit: compound questions get per-facet recall instead of one muddy
  embedding.
        │
        ▼
[TECHNICAL QUERY DETECTOR]
  queryType:'technical' from client, or server regex auto-detect.
  Effects: HyDE OFF (hallucinates code entities), BM25 max boost
  0.3 → 0.5, decision-entity injection ON.
        │
        ▼
[STEP 1: RAW QUERY EMBEDDING  (E3)]  always generated (Qwen3 1024d)
        │
        ├──────────────────────────────────────────────────────────┐
        ▼                                                          ▼
╔═ FAST PATH (fast:true — extension default, <300ms) ═╗   ╔═ FULL PATH (deep search: MCP query_memory, benchmarks) ═╗
║ [VECTOR SEARCH ×1]                                   ║   ║ [RECALL INTENT DETECTOR]  regex score >0.3 tightens      ║
║   match_messages_with_gravity RPC: HNSW cosine,      ║   ║   echo-filter thresholds (recall queries echo heavily)   ║
║   threshold 0.5, exclude last 120s (context-         ║   ║        │                                                  ║
║   pollution fix), candidate pool 50, gravity-        ║   ║        ▼                                                  ║
║   aware, entity-boost ids, profile+project scoped    ║   ║ [PARALLEL FAN-OUT  (Promise.all, 5 lanes)]                ║
║        │                                             ║   ║  ├─ ENTITY SEARCH: embedding (≥0.8) ∥ trigram text with   ║
║        ▼                                             ║   ║  │    static concept/emotion synonyms + DYNAMIC synonyms  ║
║ [excludePlatforms / speakerFilter]                   ║   ║  │    mined from entity_relationships (strength ≥0.7)     ║
║   assistant-only chunks dropped for 'user' filter;   ║   ║  ├─ HYDE GENERATION (Haiku, w/ fallback chain)            ║
║   multi-speaker kept (weighted, not binary)          ║   ║  ├─ CONCEPT ENTITY DETECTION: CONCEPT/ANALOGY/THEME/TOPIC ║
║        │                                             ║   ║  │    via trigram — "walking analogy" bypasses vector gap ║
║        ▼                                             ║   ║  ├─ EMOTION KEYWORD SEARCH (L2 GIN lane, ≤10, recency)    ║
║ [3-LAYER ECHO FILTER]  (see full path)               ║   ║  └─ KEYWORD POOL (L1 FTS, precision-gated: user turns +   ║
║        │                                             ║   ║       ≥60% distinct-keyword co-occurrence)                ║
║        ▼                                             ║   ║        │                                                  ║
║ [SCORING]  rerank_score := gravity_score             ║   ║        ▼                                                  ║
║   → BM25 boost (0.3 / 0.5 tech)                      ║   ║ [PLATFORM-ENTITY EXCLUSION]  "Gemini" in query = filter,  ║
║   → gravity boost (+0.15 max, additive)              ║   ║   not topic — platform-name entities removed from boost   ║
║   → is_question penalty (×0.7, ×0.5 recall)          ║   ║        │                                                  ║
║        │                                             ║   ║        ▼                                                  ║
║        ▼                                             ║   ║ [GRAPH WALK  (G1)]  entity_relationships traversal,       ║
║ [QUALITY PENALTIES]  (same 11-stage battery)         ║   ║   depth ≤3, related turns tagged entity_boost             ║
║        │                                             ║   ║        │                                                  ║
║        ▼                                             ║   ║        ▼                                                  ║
║ [DECISION ENTITIES]  (technical queries)             ║   ║ [ADAPTIVE SHORT-CIRCUIT]  entity confidence ≥0.85 →       ║
║   search_decision_entities RPC → structured          ║   ║   skip HyDE entirely: single raw-query vector search +    ║
║   "DECISION/Value/Rationale" synthetic candidates    ║   ║   graph merge → rerank → penalties → MMR → return         ║
║   prepended at 0.85-1.0                              ║   ║        │ (no short-circuit)                               ║
║        │                                             ║   ║        ▼                                                  ║
║        ▼                                             ║   ║ [HYDE EMBED + DRIFT GATE]  cos(raw,hyde) <0.3 → discard   ║
║ [THRESHOLD 0.15 → topK]                              ║   ║        │                                                  ║
║   (gravity-scale scores, not rerank-scale —          ║   ║        ▼                                                  ║
║    hence lower bar than full path's 0.40)            ║   ║ [PARALLEL VECTOR SEARCH ×2]  raw embedding ∥ HyDE         ║
╚══════════════════════════════════════════════════════╝   ║   embedding, same gravity RPC                             ║
   Change note: fast path bypasses HyDE, reranking,        ║        │                                                  ║
   entity search, graph walk, decomposition — the          ║        ▼                                                  ║
   documented benchmark-readiness gap (2026-06-16).        ║ [RRF MERGE  (k=60)]                                       ║
                                                           ║   HyDE 0.48 · Raw 0.32 · Graph 0.20; emotion lane          ║
                                                           ║   +0.15 (others scaled). No-HyDE variant reweights.        ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [ENTITY TIMELINE GUARANTEE]  newest turn per matched      ║
                                                           ║   entity force-added to pool — the "Jerry problem":       ║
                                                           ║   short factual corrections lose to rich old content      ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [excludePlatforms / speakerFilter]                        ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [3-LAYER ECHO FILTER]                                     ║
                                                           ║   A lexical overlap (0.70 / 0.50 recall; skipped for      ║
                                                           ║     short queries)                                        ║
                                                           ║   B semantic: vector_sim >0.72 AND new-info ratio <0.25   ║
                                                           ║     (0.60/0.35 recall) — kills rephrased self-echoes      ║
                                                           ║   C verbatim containment (≥10 chars)                      ║
                                                           ║   Multi-speaker chunks: only USER portion analyzed        ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [RERANK  (E4)]  bge-reranker-v2-m3 cross-encoder on       ║
                                                           ║   contextual_content; fallback to gravity/rrf order       ║
                                                           ║   on API failure                                          ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [BOOST STACK]  BM25 boost (≤0.3 / ≤0.5 tech)              ║
                                                           ║   + entity boost (+0.1) + gravity boost (≤ +0.15)         ║
                                                           ║   + decision entities (technical) → CONFIDENCE ≥0.40      ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [QUALITY PENALTIES  (11 stages, post-rerank)]             ║
                                                           ║   deflection ×0.145–0.73 · meta-conversation ×0.3 ·       ║
                                                           ║   diagnostic ×0.5 · stored-echo ×0.5–0.9 · bare-question  ║
                                                           ║   filter · recursion guard · recency multiplier ·         ║
                                                           ║   meta-flag / claude-code-artifact / raw-JSON filters ·   ║
                                                           ║   substance ×0.5–drop · research ×0.7                     ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [DEDUP → MMR → KEYWORD BOOST]                             ║
                                                           ║   content dedup · MMR λ=0.5 (0.35 synthesis), per-pair    ║
                                                           ║   cosine-or-Jaccard diversity · post-MMR keyword boost    ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [PLATFORM PENALTY ×0.3 → PLATFORM RESCUE]                 ║
                                                           ║   wrong-platform demotion; if it empties the set,         ║
                                                           ║   re-search filtered to the named platform (thr 0.35)     ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [KEYWORD FILL-ONLY GUARANTEE]  strong keyword matches     ║
                                                           ║   fill EMPTY topK slots only — never displace results     ║
                                                           ║        │                                                  ║
                                                           ║        ▼                                                  ║
                                                           ║ [ENTITY ENRICHMENT]  attach canonical entity names per    ║
                                                           ║   turn for client-side recency resolution                 ║
                                                           ╚═══════════════════════════════════════════════════════════╝
        │
        ▼
[RESULTS → Section A confidence filter → injection → FINAL OUTPUT / DONE]
```

---

# DELIVERABLE 2: TECHNICAL WALKTHROUGH

## 2.1 Capture & Ingestion (write path)

**Entry format:** raw platform messages (DOM-scraped or live-captured; Gemini uses deferred DOM capture since wire frames are incremental). **Exit format:** `chat_turns` rows with 1024d embeddings, emotional/gravity metadata, entity mentions, and preference rows.

1. **Injection stripping at capture.** Content scripts capture the user message *after* K.Y.T. prepends its context block, so `stripInjectionPrefix()` removes all four historical injection formats before storage. This is the anti-feedback-loop seal; the retrieval side has a second seal (echo filter + recursion guard).
2. **Chunking.** `messagesToTurnChunks()` builds sliding windows of 5 turns with 2-turn overlap. The overlap guarantees a Q→A pair is never split across a chunk boundary without also appearing intact in an adjacent chunk. Because sync batches can carry user and assistant messages separately, the sync layer re-gathers *all* local messages for affected conversations before chunking so speakers pair correctly.
3. **Trust model.** `save_chat_turn_batch` runs with the service-role key (bypasses RLS), so identity is enforced in code: a user JWT pins every turn to that user; service-role callers (benchmark harness) may impersonate; anonymous callers are rejected (`verify_jwt=true`). This closed a real anon-key IDOR (2026-06-11).
4. **Classification fan-out.** Per turn, three LLM calls run in `Promise.allSettled`: memory classification (Haiku → Holmes-Rahe impact, Aron intimacy, valence/arousal, emotion keywords), entity+preference extraction (skipped for emotional content), and contextual-retrieval prefix generation. Failures degrade to defaults; nothing blocks the upsert.
5. **Embedding.** The contextual variant is embedded when available — Anthropic-style contextual retrieval, where a chunk carries an LLM-written situating sentence. One 1024d vector per chunk (E1). Failure → null embedding + backfill alarm; retrieval falls back to BM25 for those rows.
6. **Entity graph maintenance.** New entities get name embeddings (E2) with fuzzy dedup (≥0.90 same-type merge prevents "Walter Payton"/"walter payton" splits). Co-occurrence updates maintain `entity_relationships` (`co_occurrence_count`, `relationship_strength` — no typed edges), which later powers both graph walk and dynamic synonyms.
7. **Fast bulk path.** `skip_ai_processing=true` (90-day history import) does a single batch upsert with only heuristic flags; the backfill alarm family repairs embeddings/entities/emotions/context later. Gotcha: imports set `created_at` to the original message time — operational queries should use `ingested_at`.

**Performance:** batch cap 50; tier-aware rate limits; per-call cost logged to `CostMonitor` with edge-function attribution.

## 2.2 Client orchestrator (Section A)

**Entry:** raw user prompt + platform config. **Exit:** `{items[], formattedContext, diagnostics}`.

The client is deliberately thin post-unification: routing, breakers, fallbacks, and formatting. All content-quality logic (penalties, MMR, echo filtering, keyword boost) migrated server-side so extension, MCP, and benchmark callers share one behavior. Notable mechanics:

- **Timeout discipline at every layer:** 22s pipeline race, 10s preference RPC, 3s query transformation. Any stage that misses its budget resolves `undefined` and is skipped — the pipeline is designed to lose features, not fail.
- **Diagnostics bag** accumulates per-stage counts (`edgeItems`, `preFilterItems`, `hydeCBOpen`, …) — essential for debugging "0 items injected" reports because the pipeline has ~10 places that can legitimately empty the set.
- **The confidence filter is adaptive to degradation state:** 0.40 when the cross-encoder ran, 0.25 for BM25-only mode, 0.01 when scores are uncalibrated. Two rescue tiers keep marginal results (flagged `lowConfidence`) instead of injecting nothing, with extra leniency when the user explicitly named a platform.
- **Injection contract:** results are rendered as a natural-language parenthetical rather than a structured block — platform LLMs treat it as user-provided context, and it dodges "system-prompt-looking text" heuristics. Zero results → zero injection; the system never says "I found nothing."

## 2.3 Server unified pipeline (Section B)

**Entry:** `{query, topK=20, fast, confidenceThreshold, mmrLambda, conversationWindow, recentTopics, excludePlatforms, speakerFilter, queryType, projectId}`. **Exit:** `CandidateWithScore[]` (id, content, rerank_score, platform, speakers, entities, emotional metadata).

**Pre-retrieval.** Three graduated query-understanding stages, each behind a cheap gate so the expensive step (a Haiku call) fires rarely: preference regex (0ms, short-circuits everything), coreference resolution (pronoun signal AND no named entity), decomposition (multi-hop regex). Decomposition recurses into the pipeline itself with `_skipDecomposition` to prevent infinite regress, then RRF-fuses sub-results. Technical-query detection flips retrieval strategy (HyDE off, lexical up) because HyDE hallucinates plausible-but-wrong code entities.

**Retrieval.** The full path runs five recall lanes concurrently — dense (raw), dense (HyDE), entity (dense + trigram + synonyms), graph walk, and two lexical lanes (emotion GIN, keyword FTS). The design principle: each lane covers a failure mode of another. Vector search misses buried clauses → keyword pool; misses cross-name associations → entity text + graph; misses affect language → emotion lane; over-anchors on query phrasing → HyDE. The gravity-aware RPC (`match_messages_with_gravity`, HNSW, threshold 0.5, 120s recency exclusion, candidate pool 50) is the common substrate, profile- and project-scoped (vault projects never surface without explicit project scoping — the `feature/projects-vault` work threads `p_project_id` through every RPC).

**Post-retrieval.** RRF (k=60) with fixed lane weights, then a series of *guarantees* that patch known systematic biases before scoring: entity-timeline injection (recency-vs-richness bias), speaker filtering (weighted, not binary — multi-speaker chunks carry the actual answers), and the 3-layer echo filter. Layer B is the subtle one: high query-vector similarity *plus* low new-information ratio identifies a candidate that is semantically the query restated — the signature of the system retrieving its own past injections or the user's own recall attempts. Reranking (bge-reranker-v2-m3 over `contextual_content`) then produces the calibrated score all downstream math operates on; every boost is bounded and additive (BM25 ≤0.3/0.5, entity +0.1, gravity ≤+0.15) so no boost can promote an irrelevant item past the 0.40 confidence gate. The 11-stage penalty battery runs *after* reranking so multipliers act on calibrated scores. MMR (λ=0.5; 0.35 for synthesis queries wanting breadth) uses per-pair cosine when both items have embeddings, Jaccard otherwise. Final safety nets — platform rescue and keyword fill-only guarantee — only *add* when the set is empty or starved, never displace.

**Error handling.** Every lane is `try/catch`-wrapped and logs-and-continues; the reranker falls back to gravity ordering; embeddings retry 5× then trip a breaker. The pipeline's invariant is "return the best available list, degrade silently, log loudly."

**Performance.** Fast path <300ms (one embed, one HNSW probe ~82ms, local math). Full path 16–18s worst case — dominated by 3 sequential external API round-trips (coref/decomposition/HyDE Haiku calls + embed + rerank), not the database.

## 2.4 Integration points

- **Extension** → `search_memories` (fast) → injection into web prompt.
- **MCP server** (Claude Code) → `UserPromptSubmit` hook gates ~90% of prompts locally, remainder hit fast mode and inject `[KYT:v1]` compact JSON; `query_memory` tool exposes the full path on demand; `SessionEnd` ingests the session (write path).
- **Benchmark harness** (`benchmarks/longmemeval/`) → service-role calls into the same edge functions (required post-IDOR-fix).
- **Backfill/poller alarms** close the loop on deferred processing.

---

# DELIVERABLE 3: EXPERT OPINION

**Strengths.** The architecture's best property is *bounded degradation*: circuit breakers, per-stage timeouts, additive-capped boosts, fill-only guarantees, and rescue tiers mean nearly any component can fail and the system ships a smaller, honest result instead of an error or a hallucinated one. The unified server pipeline was the right consolidation — one scoring brain, three thin clients — and it shows in maintainability (the client file's own header documents what moved). Multi-lane recall with RRF is a genuinely sound answer to the known blind spots of pure dense retrieval, and the precision gates on the newer lanes (keyword pool's co-occurrence threshold, fill-only semantics) show discipline learned from earlier regressions. The echo filter's Layer B (semantic similarity × new-information ratio) is an elegant solution to a problem most RAG systems don't even name: a memory system that re-ingests its own injections will otherwise converge on retrieving itself.

**Weaknesses.** Three stand out. (1) *The fast/full split is a fork in disguise.* The extension's default path bypasses HyDE, reranking, entity search, graph walk, and decomposition — so the components that justify the architecture serve the minority of traffic, and production behavior diverges from benchmark behavior (the documented hard-category readiness gap). (2) *Regex accumulation.* Recall intent, technical detection, preference routing, multi-hop gating, platform mention, temporal scoring — each is individually cheap and reasonable, but collectively they form a brittle English-only decision layer that will silently misroute paraphrases and other languages; the stated project preference (embeddings > LLM > heuristics > regex) is inverted at the gates. (3) *Single-provider embedding dependency* — Scaleway is the only host of the embedding model; the null-embedding + backfill fallback protects writes, but a provider outage degrades all reads to BM25 ("one is none" is already on the pre-launch list, correctly).

**On the single-pipeline approach.** For a consumer product with no per-query API budget, one pipeline with a fast/full switch beats parallel specialized pipelines: one scoring model, one place to fix bugs, cost attribution per stage. The alternative pattern — agentic/iterative retrieval where an LLM inspects results and re-queries — would raise ceiling accuracy but violates the latency and cost constraints; the current design gets a useful fraction of that via one-shot decomposition. The main structural suggestion: rather than two hard-coded paths, make stage activation *budget-driven* (score the query once, spend latency where the query earns it), which would let graph walk and reranking reach production traffic for the queries that need them.

**Scalability.** Reads scale well (HNSW at 1024d, per-user partitioning by RLS/user_id, candidate pools capped). The in-memory rate limiter and dynamic-synonym per-request load (50-row scan) are fine at 10K users but should move to shared storage/cache beyond that. Write-side LLM classification (3 Haiku calls per turn) is the real cost driver at scale; batching turns per classification call is the obvious first optimization. The 16–18s full path is acceptable only because it's off the interactive path; if it ever fronts the keyboard/mobile surface, the sequential Haiku stages need to collapse into one combined call (coref + decomposition + HyDE share a prompt shape and could be one request).

---

# DELIVERABLE 4: RESOURCE SECTION

## RAG Fundamentals
- **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks** — paper, Lewis et al. (2020), arXiv:2005.11401. The original RAG formulation; the conceptual baseline this system extends with memory-specific machinery.
- **Anthropic — "Introducing Contextual Retrieval"** — blog/documentation, Anthropic (2024). Directly implemented here as `generateChunkContext` → `contextual_content`; explains why the pipeline embeds and reranks the contextualized text.
- **pgvector documentation** — docs, GitHub (pgvector/pgvector). Covers HNSW indexing and the 2000-dim HNSW cap that drives the 1024d Matryoshka decision.

## Single-Pipeline Architecture
- **Lost in the Middle: How Language Models Use Long Contexts** — paper, Liu et al. (2023), arXiv:2307.03172. Justifies small topK + aggressive filtering over dumping context: more injected items ≠ better answers.
- **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory** — paper, Chhikara et al. (2025), arXiv:2504.19413. The closest competitor's single-pipeline memory architecture; useful for reader-vs-retriever confound analysis (their headline numbers are reader-dependent).

## Pre-Retrieval Techniques
- **Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)** — paper, Gao et al. (2022), arXiv:2212.10496. The HyDE lane; the drift gate and technical-query disablement here are practical patches to its known hallucination mode.
- **Query decomposition / multi-hop QA: "Least-to-Most Prompting"** — paper, Zhou et al. (2022), arXiv:2205.10625. Background for the sub-query decomposition stage.

## Retrieval Methods
- **Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods** — paper, Cormack, Clarke & Buettcher (SIGIR 2009). The exact fusion method (k=60) used for all lane merging.
- **The Probabilistic Relevance Framework: BM25 and Beyond** — monograph, Robertson & Zaragoza (2009). Foundation for the lexical lanes and BM25 boost.
- **Efficient and robust approximate nearest neighbor search using HNSW graphs** — paper, Malkov & Yashunin (2016), arXiv:1603.09320. The index behind every vector search call.
- **Matryoshka Representation Learning** — paper, Kusupati et al. (2022), arXiv:2205.13147. Why truncating Qwen3's 4096d to the first 1024 dims (plus renorm) is valid.
- **Qwen3 Embedding technical report / model card** — documentation, Qwen team (2025), arXiv:2506.05176 & Hugging Face. The embedding model's MRL support and instruction-aware usage.

## Post-Retrieval Processing
- **The Use of MMR, Diversity-Based Reranking** — paper, Carbonell & Goldstein (SIGIR 1998). The MMR implementation is a faithful λ-tradeoff variant with hybrid similarity.
- **BAAI/bge-reranker-v2-m3 model card** — documentation, Hugging Face. The cross-encoder producing `rerank_score`; multilingual, long-context.

## Generation Strategies
- **Anthropic prompt engineering documentation** — docs, docs.anthropic.com. Relevant to the natural-language injection format and the Haiku classification/coref/decomposition prompts.

## Evaluation & Monitoring
- **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory** — paper, Wu et al. (2024), arXiv:2410.10813. The project's primary benchmark (harness in `benchmarks/longmemeval/`; baseline 0.41 → 0.574).
- **RAGAS: Automated Evaluation of Retrieval Augmented Generation** — paper, Es et al. (2023), arXiv:2309.15217. General-purpose faithfulness/relevance metrics complementing the accuracy benchmarks.
- **LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents** — paper, Maharana et al. (2024), arXiv:2402.17753. Next benchmark target for hard categories.

## Advanced Topics
- **Supabase Edge Functions & RLS documentation** — docs, supabase.com. The deployment substrate; the trust-model section (service-role vs JWT) is a direct application of its security model.
- **Graph-enhanced retrieval: "From Local to Global: A GraphRAG Approach"** — paper, Edge et al. (2024), arXiv:2404.16130. The maximalist version of what the entity graph-walk lane does cheaply.

---

*Generated 2026-07-17 from source on branch `feature/projects-vault`. Every stage, threshold, weight, and model name above was read from the code, not recalled from prior documentation.*

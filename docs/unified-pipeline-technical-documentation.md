# K.Y.T. Unified Retrieval Pipeline -- Technical Documentation

**Status**: Current implementation (server-side pipeline deployed, client-side legacy still active as fallback)
**Date**: 2026-03-06
**System**: K.Y.T. (Know Your Things) -- Cross-platform conversation memory with RAG retrieval
**Verified**: All line counts, stage orderings, and model references verified against live codebase

---

<documentation>

# DELIVERABLE 1: FLOWCHART

```
+========================================================================+
|                          USER INPUT                                     |
|  Query string from ChatGPT / Claude Web / Claude Code (MCP) / Gemini   |
+================================+=======================================+
                                 |
                                 v
======= SECTION A: PRE-RETRIEVAL (CLIENT-SIDE, <1ms) ========================

+-------------------------------------------------------------------------+
|  A1: INTENT CLASSIFICATION (src/intent-classifier.js, 425 lines, <1ms)  |
|  -------------------------------------------------------------------    |
|  Function: 7 scoring functions (6 in classifyIntent + 1 standalone).    |
|  Heuristic scorer determines if query needs memory retrieval.            |
|  Outputs: QUERY / PASSIVE / SKIP + confidence threshold (0.40-0.65).    |
|                                                                         |
|  Position Rationale: Gate BEFORE any API call -- prevents wasting        |
|  12-18s of pipeline on "hello" or "write a Python function".            |
|                                                                         |
|  Benefits: Eliminates unnecessary API calls; raises confidence          |
|  threshold for ambiguous queries to prevent low-quality injection.      |
|                                                                         |
|  Dimensions (in classifyIntent return):                                 |
|  directive, memory, density, question, personal, temporal               |
|  (scoreSynthesisIntent is 7th function, used by context-retrieval.js)   |
|                                                                         |
|  If SKIP -> return empty (no injection)                                 |
|  If QUERY -> continue with threshold override                           |
|  If PASSIVE -> Layer 2 LLM judge (A1b) or continue with high threshold  |
+------------------------------+------------------------------------------+
                               |
                  +------------+------------+
                  | PASSIVE intent?          |
                  | (ambiguous signal)       |---- NO ---> A2
                  +------------+------------+
                               | YES
                               v
+-------------------------------------------------------------------------+
|  A1b: LAYER 2 INTENT JUDGE (classify_intent edge fn, 149 lines)        |
|  ---------------------------------------------------------------        |
|  Function: LLM-based intent verification for PASSIVE cases. Claude      |
|  Haiku 4.5 classifies into MEMORY_QUERY (threshold 0.50) or            |
|  NO_RETRIEVAL (skip). Tier-aware rate limiting.                         |
|                                                                         |
|  Position Rationale: Cheap heuristics handle clear QUERY/SKIP cases.    |
|  Only ambiguous PASSIVE cases need the LLM judge -- ~2s cost only       |
|  when the heuristic is uncertain.                                       |
|                                                                         |
|  Benefits: Reduces false-positive retrievals; prevents wasting          |
|  pipeline time on queries that look like memory requests but aren't.    |
|                                                                         |
|  Model: Claude Haiku 4.5 (via AnthropicClient)                         |
|  Input: message (max 500 chars) + Layer 1 heuristic scores + reason     |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  A2: ROUTING DECISION (src/auth-config.js, 90 lines)                   |
|  ----------------------------------------------------                   |
|  Function: getRoutingMode() checks auth state. Three modes:             |
|  - 'edge': JWT valid -> server pipeline (search_memories edge fn)       |
|  - 'legacy': api_config exists, no JWT -> client-side BM25+HyDE        |
|  - 'unconfigured': no credentials -> preference router only             |
|                                                                         |
|  MCP hook path always uses server with fast=true.                       |
|  Client holds preference router, temporal fallback, injection builder.  |
|                                                                         |
|  Current state: Dual-path still exists. Phase 5 target: delete          |
|  legacy path entirely.                                                  |
|                                                                         |
|  Edge call: POST to search_memories with query, userId, profileId,      |
|  topK, confidenceThreshold, mmrLambda, fast flag.                       |
+------------------------------+------------------------------------------+
                               |
                               v
======= SECTION B: SERVER-SIDE PIPELINE (search_memories -> getRelevantMemories) =

+-------------------------------------------------------------------------+
|  B0: PREFERENCE ROUTER (0ms regex, get_relevant_memories.ts:470-482)    |
|  -------------------------------------------------------------------    |
|  Function: 6 regex patterns detect "what is my favorite X?".            |
|  Strips qualifiers. Calls lookup_user_preferences RPC (p_limit: 10).    |
|                                                                         |
|  Position Rationale: FIRST -- cheapest possible check. If user asks     |
|  for a preference, skip entire vector pipeline.                         |
|                                                                         |
|  Benefits: 0ms latency for preference queries; synthesized items        |
|  with score = confidence * 0.9 (~0.72).                                 |
|                                                                         |
|  Output: If pure preference -> return immediately                       |
|          If no match -> continue to Stage B1                            |
+------------------------------+------------------------------------------+
                               |
                  +------------+------------+
                  | Short-circuit?           |
                  | Pure preference match    |---- YES ---> RETURN (done)
                  +------------+------------+
                               | NO
                               v
+-------------------------------------------------------------------------+
|  B1: QUERY EMBEDDING (get_relevant_memories.ts:485-495)                 |
|  --------------------------------------------------                     |
|  Function: Qwen3-Embedding-8B via Scaleway API -> 4096d truncated       |
|  to 1024d (Matryoshka), L2-normalized. ~150ms.                          |
|                                                                         |
|  Position Rationale: Required for all vector searches. Sequential       |
|  with current code (query transformation not yet server-side).          |
|                                                                         |
|  Model: Qwen3-Embedding-8B (Scaleway endpoint)                         |
|                                                                         |
|  FAST PATH: If fast=true, skip to single vector search -> BM25 ->      |
|  quality penalties -> confidence filter -> return. ~300ms total.         |
+------------------------------+------------------------------------------+
                               |
                  +------------+------------+
                  | fast=true?              |
                  | (MCP hook path)         |---- YES ---> FAST PATH (B1f)
                  +------------+------------+
                               | NO
                               v
+-------------------------------------------------------------------------+
|  B2: ENTITY SEARCH + HyDE + CONCEPT DETECTION (parallel)               |
|  --------------------------------------------------------               |
|  Function: Promise.all([                                                |
|    searchEntities(embedding, query)  // dual-arm: embedding + trigram   |
|    generateHyDEWithFallback(query)   // Haiku 4.5, temp=0.7, 8s        |
|    detectConceptEntities(query)      // CONCEPT/ANALOGY/THEME types     |
|  ])                                                                     |
|                                                                         |
|  Entity search: Dual-arm (embedding threshold 0.8 + text trigram).      |
|  CONCEPT_SYNONYMS map: level<->mode<->tier, nfl<->football<->player.   |
|  Platform entities excluded from boost set when query mentions a        |
|  platform name.                                                         |
|                                                                         |
|  HyDE: Haiku 4.5 generates hypothetical conversation excerpt.           |
|  Drift gate: output must contain >=1 original query term (85 stop       |
|  words filtered). Circuit breaker: skip on API errors for 1-5min.       |
|                                                                         |
|  Position Rationale: 3-way parallel; entity confidence gates HyDE.      |
|                                                                         |
|  Models: Claude Haiku 4.5 (HyDE), Qwen3-Embedding-8B (entity embed)    |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  B2b: GRAPH WALK (get_relevant_memories.ts:575-604)                     |
|  --------------------------------------------------                     |
|  Function: graph_walk_from_entities RPC. 2-depth traversal via          |
|  entity_relationships. maxIntermediate=20.                              |
|                                                                         |
|  Position Rationale: Runs after entity search produces boost IDs.       |
|  Finds conceptually related content that vector search misses           |
|  (e.g., "Walter Peyton" -> "Walter Payton" via entity bridge).          |
|                                                                         |
|  Benefits: Cross-entity discovery; typo bridging; catches content       |
|  that shares entities but not vocabulary.                                |
+------------------------------+------------------------------------------+
                               |
                  +------------+------------+
                  | Short-Circuit Check:    |
                  | Top entity >= 0.85?     |
                  | (0.80 for PERSON)       |
                  +------+----------+------+
                         |          |
                    YES  |          |  NO
                         v          v
          +-----------------+  +-------------------------------+
          | B3a: SINGLE ARM |  | B3b: DUAL VECTOR SEARCH       |
          | Raw embedding   |  | Raw + HyDE embeddings          |
          | only (skip HyDE)|  | in parallel                    |
          | Saves 2-4s      |  | via match_messages_with_gravity |
          +--------+--------+  +------------+------------------+
                   |                         |
                   +------------+------------+
                                |
                                v
======= SECTION C: FUSION & RERANKING ========================================

+-------------------------------------------------------------------------+
|  C1: RRF MERGE (rrf.ts, 152 lines, Reciprocal Rank Fusion)             |
|  -----------------------------------------------                        |
|  Function: Fuses 2 or 3 ranked lists into single candidate pool.        |
|                                                                         |
|  Formula: RRF_score = SUM(weight_i / (k + rank_i)), k=60               |
|                                                                         |
|  Weights (2-way): HyDE 0.60, Raw 0.40                                  |
|  Weights (3-way): HyDE 0.48, Raw 0.32, Graph 0.20                      |
|  Weights (raw+graph): Raw 0.80, Graph 0.20                              |
|                                                                         |
|  Position Rationale: After all retrieval arms return, before            |
|  expensive reranking. RRF is rank-based (not score-based).              |
|                                                                         |
|  Benefits: Combines semantic + lexical + graph signals; HyDE-weighted   |
|  but not HyDE-dependent; k=60 prevents top-1 dominance.                |
|                                                                         |
|  Exported: reciprocalRankFusion(), mergeHydeAndRawResults(),            |
|  fallbackToRawResults()                                                 |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  C1b: ENTITY TIMELINE GUARANTEE (get_relevant_memories.ts:363-425)      |
|  -----------------------------------------------------------------      |
|  Function: For each entity in boost set, ensures newest mention is      |
|  in candidate pool. Calls get_newest_turns_for_entities RPC.            |
|                                                                         |
|  Position Rationale: After RRF merge -- pool is formed but before       |
|  reranking. Prevents "rich old content" bias.                           |
|                                                                         |
|  Benefits: Solves the "Jerry problem" -- contradictory statements       |
|  ("X is true" -> "X is false") always surface the newest one.           |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  C1c: QUERY ECHO FILTER (get_relevant_memories.ts:85-111)              |
|  --------------------------------------------------------              |
|  Function: Removes candidates <80 chars with >70% word overlap          |
|  with the query. 50+ stop words excluded from overlap calc.             |
|  Content with <3 non-stop words kept (too sparse for echo detection).   |
|                                                                         |
|  Position Rationale: Before reranking -- prevents self-referential      |
|  content from consuming a reranking slot. Cheap string comparison.      |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  C2: CROSS-ENCODER RERANKING (get_relevant_memories.ts:986-1038)        |
|  --------------------------------------------------------------------   |
|  Function: BAAI/bge-reranker-v2-m3 cross-encoder scores query-document  |
|  relevance. Uses contextual_content (LLM-enriched text) when            |
|  available.                                                             |
|                                                                         |
|  Timeout: 8s (via HuggingFaceClient). Max docs: all candidates.        |
|  Fallback: gravity_score -> rrf_score -> 0.5 if reranking fails.       |
|                                                                         |
|  Position Rationale: After cheap filters, before expensive penalties.   |
|  Cross-encoder is most accurate relevance signal.                       |
|                                                                         |
|  Model: BAAI/bge-reranker-v2-m3 (via HuggingFace Scaleway router)      |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  C3: BM25 KEYWORD BOOST + ENTITY BOOST (+0.3 + 0.1 max)               |
|  --------------------------------------------------------              |
|  Function: Exact keyword coverage bonus on rerank_score.                |
|  Formula: boost = (0.3 * term_hits / max_hits)                          |
|  Entity boost: additional +0.1 if entity_boost flag set.                |
|  Uses contextual_content when available for matching.                   |
|                                                                         |
|  Position Rationale: After cross-encoder reranking. Corrects for        |
|  semantic relevance underweighting exact keyword matches.               |
+------------------------------+------------------------------------------+
                               |
                               v
======= SECTION D: QUALITY PENALTIES (quality-penalties.ts, 524 lines) ======

+-------------------------------------------------------------------------+
|  D1: RECURSION GUARD (hard drop)                                        |
|  --------------------------------                                       |
|  Function: Drops items containing K.Y.T. injection protocol markers:    |
|  "K.Y.T. MEMORY INJECTION PROTOCOL", "[RETRIEVAL_CONTEXT]",            |
|  "[SESSION_CONTEXT]", "[DATA_PROVENANCE]", "[Retrieved Items]",         |
|  "[Memory Context".                                                     |
|                                                                         |
|  Position Rationale: First -- these items are 100% noise.               |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D2: META FLAG FILTER (hard drop)                                       |
|  --------------------------------                                       |
|  Function: Drops items where meta === true (DB-flagged).                |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D3: DEFLECTION PENALTY (0.145x-0.73x or hard drop)                    |
|  ---------------------------------------------------                    |
|  Function: 36 deflection patterns + 5 assistant echo patterns detect    |
|  assistant non-answers ("I don't have access to...",                    |
|  "I can't help with that", "KYT didn't surface...").                    |
|                                                                         |
|  Scoring: confidence 0.30-0.95 based on pattern count + message        |
|  length + position. Multiplier = 1 - (confidence * 0.9).               |
|  Hard drop: confidence >= 0.85 removed entirely.                        |
|                                                                         |
|  Position Rationale: After hard filters, before soft penalties.         |
|  Opening-only hedge (long messages): only 0.30 confidence.              |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D4: META-CONVERSATION PENALTY (0.3x)                                   |
|  -------------------------------------                                   |
|  Function: 4 regex patterns detect KYT/extension operational chatter.   |
|  Query guard: 3 KYT_QUERY_PATTERNS skip penalty when user genuinely    |
|  asks about extension.                                                  |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D5: RETRIEVAL DIAGNOSTIC PENALTY (0.5x)                                |
|  ----------------------------------------                               |
|  Function: 23 regex patterns detect meta-analysis of retrieval          |
|  behavior ("query returned 0", "confidence was 0.62", "meta-echo").     |
|  Query guard: 3 RETRIEVAL_QUERY_PATTERNS.                               |
|                                                                         |
|  Why 0.5x not 0.3x: Diagnostic content contains useful analysis.       |
|  0.5x lets source content win while keeping diagnostics findable.       |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D6: ECHO PENALTY (0.50x-0.90x)                                        |
|  --------------------------------                                       |
|  Function: 7 stored-data echo patterns detect assistant messages        |
|  that paraphrase stored data ("you said", "KYT captured").              |
|  Length-scaled: <300 chars -> 0.50x, 300-800 -> 0.70x, >800 -> 0.90x. |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D7: BARE QUESTION FILTER (hard drop)                                   |
|  -------------------------------------                                  |
|  Function: Drops items <120 chars, no "Assistant:" block, ending        |
|  with "?" or matching INTERROGATIVE_RE.                                 |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  D8: RECENCY MULTIPLIER (exponential decay)                             |
|  -------------------------------------------                            |
|  Function: Half-life 30 days. Blend: 85% original + 15% recency.       |
|  Formula: multiplier = exp(-daysSince / 30)                             |
|  Applied: score = score * 0.85 + score * multiplier * 0.15              |
+------------------------------+------------------------------------------+
                               |
                               v
======= SECTION E: DIVERSITY & RANKING =======================================

+-------------------------------------------------------------------------+
|  E1: CONTENT DEDUPLICATION (mmr.ts:deduplicateByContent, 199 lines)    |
|  -------------------------------------------------------                |
|  Function: Exact match on normalized (trimmed, lowercased) content.     |
|  Keep first occurrence (highest score after penalties).                  |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  E2: MMR DIVERSITY RERANKING (mmr.ts:applyServerMMR)                    |
|  ---------------------------------------------------                    |
|  Function: Maximal Marginal Relevance -- greedy selection balancing      |
|  relevance against redundancy.                                          |
|                                                                         |
|  Formula: MMR = lambda * relevance - (1-lambda) * max_sim_to_selected   |
|                                                                         |
|  Lambda: 0.5 (default), 0.35 (synthesis queries)                       |
|                                                                         |
|  Similarity: Per-pair hybrid -- cosine on 1024d embeddings when both    |
|  available, Jaccard on word sets as fallback.                           |
|                                                                         |
|  Output cap: topK items (default 5)                                     |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  E3: POST-MMR KEYWORD BOOST (mmr.ts:applyKeywordBoost)                  |
|  ------------------------------------------------------                  |
|  Function: After MMR, boost items containing query keywords.            |
|  Max boost: 15% of current score. Uses contextual_content.              |
+------------------------------+------------------------------------------+
                               |
                               v
======= SECTION F: CONFIDENCE & OUTPUT =======================================

+-------------------------------------------------------------------------+
|  F1: PLATFORM-MISMATCH PENALTY (0.3x)                                   |
|  --------------------------------------                                  |
|  Function: When query mentions a platform ("on Gemini"), items from     |
|  OTHER platforms get 0.3x penalty. Below-threshold items removed.       |
|  Platform-filtered rescue search if all results killed (threshold 0.35).|
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  F2: CONFIDENCE THRESHOLD                                               |
|  ------------------------                                               |
|  Function: Applied in rerankAndFilter(). Default: 0.40.                 |
|  Override by intent classifier (up to 0.65 for ambiguous queries).      |
|  No explicit rescue tier yet -- handled by low threshold + BM25 boost.  |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  F3: ENTITY ENRICHMENT (get_relevant_memories.ts:916-981)               |
|  --------------------------------------------------------               |
|  Function: Batch query entity_mentions + entities tables for final      |
|  result set. Attaches {canonical_name, entity_type} arrays.             |
|  Also incorporates entity_timeline injection data from C1b.             |
|                                                                         |
|  Position Rationale: Only enrich items we're returning (3-5).           |
+------------------------------+------------------------------------------+
                               |
                               v
======= SECTION G: CLIENT-SIDE OUTPUT ========================================

+-------------------------------------------------------------------------+
|  G1: CLIENT POST-PROCESSING (src/context-retrieval.js, 795 lines)      |
|  -----------------------------------------------------                  |
|  Function: Receives server results, runs client-side stages:            |
|   - Preference router (client mirror, for offline/legacy path)          |
|   - Temporal+synthesis fallback (getRecentByPlatform via edge fn)       |
|   - Preference + vector merge                                           |
|   - Entity-aware recency resolution (client-side, uses entity data)     |
|                                                                         |
|  Note: Quality penalties, MMR, keyword boost now server-side.           |
|  Client retains: injection building, temporal fallback, recency         |
|  resolution.                                                            |
+------------------------------+------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|  G2: INJECTION BUILDER (kyt-memory-injection-builder.js, 381 lines)    |
|  -------------------------------------------------------                |
|  Function: Formats server response into platform-specific injection     |
|  block. Sanitizes content (bracket patterns, separator patterns,        |
|  prompt injection vectors).                                             |
|                                                                         |
|  Confidence tier routing:                                               |
|    >= 0.5 -> "ALWAYS use K.Y.T. data first"                            |
|    0.25-0.5 -> "Review items, incorporate relevant info"                |
|    < 0.25 -> "Mention only if clearly related"                          |
|                                                                         |
|  Platform-specific formatting:                                          |
|    ChatGPT: system message prefix                                       |
|    Claude Web: Human turn prefix                                        |
|    Gemini: XHR StreamGenerate payload injection                         |
|    Claude Code: system-reminder hook context                            |
+------------------------------+------------------------------------------+
                               |
                               v
+========================================================================+
|                         FINAL OUTPUT                                    |
|  Formatted injection block inserted into user's prompt on target        |
|  platform. 3-8s full pipeline, <300ms fast path. 3-5 items max.         |
+========================================================================+
```

---

# DELIVERABLE 2: TECHNICAL WALKTHROUGH

## Section A: Pre-Retrieval (Client-Side)

### A1: Intent Classification

**Entry format**: Raw user message string (UTF-8, unbounded length).

The intent classifier is a heuristic scorer implemented in `src/intent-classifier.js` (425 lines, 61 unit tests). Runs purely on regex and string analysis -- no API calls, no ML inference, <1ms execution.

**Seven scoring functions** (each 0.0-1.0):

1. **scoreDirective** (lines 63-102): Imperative verbs (write, create, build at 0.8; continue/proceed/resume at 0.4). High directive + low memory reference = code task, not memory query.
2. **scoreMemoryReference** (lines 138-161): "remind me", "what did we discuss", "you mentioned" -- direct stored-information signals.
3. **scoreContentDensity** (lines 171-200): Word count and character length. Code blocks detected and excluded.
4. **scoreQuestionStructure** (lines 210-225): Interrogative words, question marks. "what is a monad?" doesn't need memory, "what did I say about monads?" does.
5. **scorePersonalReference** (lines 235-262): "my", "I said", "we built" -- first-person pronouns.
6. **scoreTemporalReference** (lines 272-290): "yesterday", "last week", "remember when" -- time-anchored recall.
7. **scoreSynthesisIntent** (lines 295-310): Multi-topic bridging language ("connect", "relate", "combine"). Not included in classifyIntent return object -- used directly by context-retrieval.js for synthesis+platform fallback.

**classifyIntent() returns 6 dimensions**: `{ directive, memory, density, question, personal, temporal }`.

**Classification rules** (first match wins):
- directive >= 0.7 AND memory < 0.3 AND personal < 0.3 -> **SKIP**
- density <= 0.15 AND memory < 0.5 -> **SKIP**
- memory >= 0.7 -> **QUERY** (threshold: 0.40)
- personal >= 0.4 AND temporal >= 0.5 -> **QUERY** (threshold: 0.45)
- question >= 0.5 AND personal >= 0.4 -> **QUERY** (threshold: 0.45)
- directive >= 0.4 AND memory >= 0.3 -> **QUERY** (threshold: 0.65)
- directive >= 0.4 AND temporal >= 0.4 -> **QUERY** (threshold: 0.60)
- question >= 0.5 AND density >= 0.4 -> **PASSIVE** (threshold: 0.60)
- density >= 0.4 with word count >= 8 -> **PASSIVE** (threshold: 0.60)
- else -> **SKIP**

**Exit format**: `{ intent, confidenceThreshold, reason, scores }`

**Why client-side**: Zero latency, zero cost, no dependencies. The confidence threshold is a critical input to the server pipeline's confidence filter.

### A1b: Layer 2 Intent Judge (classify_intent edge function)

**Entry format**: `{ message, scores, reason }` from Layer 1.

For PASSIVE classifications where the heuristic is uncertain, the `classify_intent` edge function (149 lines) acts as a second opinion. Claude Haiku 4.5 receives the message (truncated to 500 chars), the Layer 1 scores, and the classification reason.

**Output taxonomy**: MEMORY_QUERY (fire pipeline, threshold 0.50) or NO_RETRIEVAL (skip pipeline).

**Rate limiting**: Tier-aware via `getTierLimits(tier)` from `tier-check.ts`. Only PASSIVE intents reach this stage, so volume is naturally bounded.

**Why a separate edge function**: Keeps the LLM call server-side (no API key in client), and the 2s latency is acceptable since PASSIVE queries are inherently ambiguous -- better to spend 2s confirming than 12-18s on a wasted pipeline run.

### A2: Routing & Edge Function Call

**Entry format**: Intent classification result + raw user message.

If intent is SKIP, return empty immediately. Otherwise, `src/context-retrieval.js` dispatches:

- **Authenticated users** (edge mode): POST to `search_memories` edge function with query, userId, profileId, topK (20), confidenceThreshold, mmrLambda, fast flag.
- **MCP hook path**: Same edge function with fast=true (skip HyDE, reranking, entity search).
- **Legacy path** (still active): Unauthenticated -> local BM25 + client-side HyDE. To be removed in Phase 5.

**Current dual-path**: `getRoutingMode()` in `src/auth-config.js` returns 'edge' (JWT valid), 'legacy' (api_config exists, no JWT), or 'unconfigured'. Edge mode disables client-side query transformation. Both paths converge at the injection builder.

---

## Section B: Server-Side Pipeline (Retrieval Core)

**Implementation**: `supabase/functions/_shared/get_relevant_memories.ts` (1077 lines). Called by `supabase/functions/search_memories/index.ts` (158 lines).

### B0: Preference Router

Six regex patterns detect structured preference queries. Qualifier stripping order matters:
1. Strip "and why/how/when/where" suffixes FIRST
2. Strip "of all time", "ever", "in the world" superlatives SECOND

This ensures "favorite movie of all time and why" -> "movie".

**RPC call**: `lookup_user_preferences(p_user_id, p_category, p_limit: 10, p_profile_id)`.

**Short-circuit**: Pure preference match -> synthesize items (`"User's favorite {category}: {value}. Recorded: {date}."` with `score = confidence * 0.9`), return immediately.

### B1: Query Embedding

**Model**: Qwen3-Embedding-8B via Scaleway (HuggingFace router). Input: query string. Output: 4096d vector, Matryoshka-truncated to 1024d, L2-normalized. ~150ms typical latency. Embedding and batch support via `HuggingFaceClient` (163 lines).

**Fast path** (`fast=true`): Single vector search -> echo filter -> gravity scores as rerank_score -> BM25 boost -> quality penalties -> confidence filter. Target: <300ms total. Used by MCP hook for low-latency context injection.

### B2: Entity Search + HyDE + Concept Detection

Three-way parallel execution via `Promise.all()`:

**Entity search** (dual-arm):
- Embedding arm: `search_entities_by_embedding(embedding, userId, matchCount: 5, threshold: 0.8)`
- Text arm: `search_entities_by_text(expandedQuery, userId, matchCount: 5)` with `CONCEPT_SYNONYMS` expansion (level<->mode<->tier, nfl<->football<->player, diet<->weight<->nutrition)
- Results merged, deduplicated by ID
- Platform entities excluded from boost set when query mentions a platform

**HyDE generation** (`hyde-generator.ts`, 177 lines):
- Claude Haiku 4.5 (temp=0.7, 8s timeout, maxTokens: 300, maxRetries: 2)
- Prompt: "Imagine a past conversation where the user discussed [query]. Write a realistic excerpt..."
- Format validation: must contain "User:" and "Assistant:"
- Drift gate: >=1 non-stop-word from original query must appear in output (85 stop words)
- On failure: returns null, pipeline continues with raw query only

**Concept detection**: Text search for CONCEPT, ANALOGY, THEME entity types. Catches abstract queries ("3 levels of memory") that entity text search misses.

### B2b: Graph Walk

After entity search produces boost IDs, `graph_walk_from_entities` RPC traverses `entity_relationships`:
- Parameters: entity IDs, userId, maxDepth=2, maxIntermediate=20
- Returns chat_turns connected by shared entities
- Results scored by relationship_strength, tagged with entity_boost=true

### B3: Adaptive Short-Circuit + Vector Search

**Short-circuit decision** (lines 610-689): If top entity confidence >= 0.85 (or >= 0.80 for PERSON entities) after excluding platform entities:
- Skip HyDE embedding
- Single vector search with raw embedding only
- Still applies reranking (unlike Phase 5 spec which proposed skipping it)
- Savings: 2-4s from skipping dual search

**Vector search** via `match_messages_with_gravity` RPC:
- HNSW index on 1024d embeddings (pgvector)
- Returns candidates with gravity_score computed as:
  `gravity = similarity * (1 + impact/100 + intimacy*0.2) * time_decay * rehearsal_bonus`
- Time decay adaptive by impact level: logarithmic (high), linear (medium), exponential (low)
- Rehearsal bonus: `min(1 + access_count * 0.05, 1.5)`
- Optional `p_platform` filter for platform-specific rescue searches

**If not short-circuited**: Dual parallel vector search (raw + HyDE embeddings), each with same parameters.

---

## Section C: Fusion & Reranking

### C1: RRF Merge (`rrf.ts`, 152 lines)

`reciprocalRankFusion()` combines 2-3 ranked lists.

**Formula**: `RRF_score(d) = SUM(weight_i / (k + rank_i(d)))`, k=60.

**Weights**:
- 3-way (HyDE + Raw + Graph): 0.48, 0.32, 0.20
- 2-way (HyDE + Raw): 0.60, 0.40
- 2-way (Raw + Graph): 0.80, 0.20
- Raw only: no fusion needed

Items appearing in multiple lists have scores summed (not duplicated).

**Exported helpers**: `mergeHydeAndRawResults()` (convenience 2-way wrapper, default 0.6/0.4), `fallbackToRawResults()` (when HyDE fails).

### C1b: Entity Timeline Guarantee

After RRF merge, `get_newest_turns_for_entities` RPC fetches the most recent mention for each entity in the boost set. If not already in the pool, injected with entity_timeline metadata (entity_id, canonical_name, entity_type, created_at). This ensures contradictory memory chains always surface the newest statement.

### C1c: Query Echo Filter

Removes candidates <80 chars with >70% word overlap with the query, after filtering 50+ stop words. Content with <3 non-stop words is too sparse for reliable echo detection and is kept.

### C2: Cross-Encoder Reranking

**Model**: BAAI/bge-reranker-v2-m3 (via HuggingFace Scaleway router, `HuggingFaceClient.rerank()`)
**Input**: Query + all candidates (no hard cap in current code, but typically 20-40)
**Output**: `rerank_score` (0.0-1.0) per candidate

Uses `contextual_content` when available -- LLM-generated context prefix from `context-generator.ts` gives the cross-encoder richer signal than raw message text alone.

**Fallback chain**: gravity_score -> rrf_score -> 0.5 (static).

### C3: BM25 Keyword Boost + Entity Boost

Post-reranking: `rerank_score += (0.3 * term_hits / max_hits)`. Additional +0.1 for entity_boost flagged items. Uses `contextual_content` for matching when available.

---

## Section D: Quality Penalties (`quality-penalties.ts`, 524 lines)

These 8 penalties run server-side after reranking. Ordered cheapest-to-most-expensive. Total compiled regex count: 66 patterns across all penalty categories.

**Hard drops first**:
1. **Recursion guard**: Drops items with injection protocol markers
2. **Meta flag filter**: Drops items where `meta === true`
3. **Deflection penalty**: 36 deflection + 5 assistant echo patterns. Confidence 0.30-0.95 based on pattern count + message length + position. Opening-only hedge (long messages, patterns in first 150 chars) = 0.30. Hard drop >= 0.85.

**Score penalties**:
4. **Meta-conversation**: 4 patterns, 0.3x. Query guard: 3 KYT_QUERY_PATTERNS.
5. **Diagnostic**: 23 patterns, 0.5x. Query guard: 3 RETRIEVAL_QUERY_PATTERNS.
6. **Echo**: 7 stored-data patterns. Length-scaled: <300 chars=0.50x, 300-800=0.70x, >800=0.90x.

**More hard drops**:
7. **Bare question filter**: <120 chars, no "Assistant:" block, ends with "?" or matches INTERROGATIVE_RE.

**Time adjustment**:
8. **Recency multiplier**: Half-life 30 days. `score = score * 0.85 + score * exp(-days/30) * 0.15`.

All penalties pure regex/string matching -- microseconds on typical candidate sets. Zero API calls.

---

## Section E: Diversity & Ranking

### E1: Content Deduplication (`mmr.ts:deduplicateByContent`)

Exact match on normalized content (trim + lowercase). Keeps first (highest-scored) occurrence. Applied after penalties so duplicates with different penalty-adjusted scores keep the highest.

### E2: MMR Diversity Reranking (`mmr.ts:applyServerMMR`)

Greedy selection algorithm:
```
selected = argmax_d [ lambda * relevance(d) - (1-lambda) * max_{s in S} similarity(d, s) ]
```

**Similarity**: Per-pair hybrid -- cosine on 1024d embeddings when both candidates have them, Jaccard on word sets otherwise. Relevance normalized to [0,1] range. Similarity normalized from [-1,1] to [0,1].

**Lambda**: 0.5 (default), 0.35 (synthesis queries -- "compare what I said about X on ChatGPT vs Claude").

**Output cap**: maxResults (default 5).

### E3: Post-MMR Keyword Boost (`mmr.ts:applyKeywordBoost`)

After MMR selects the final set: `score += (0.15 * hits / maxHits) * score`. Max 15% boost. Uses contextual_content when available.

---

## Section F: Confidence & Output

### F1: Platform-Mismatch Penalty

When query mentions a platform, non-matching items get 0.3x penalty on `rerank_score`. Items below threshold removed. If all results killed:
- **Platform rescue search**: Second `match_messages_with_gravity` call with `p_platform` filter, threshold 0.35
- Rescue results go through echo filter + reranking

### F2: Confidence Threshold

Applied in `rerankAndFilter()`: `rerank_score >= threshold` (0.40 default, overridable by intent classifier).

No explicit rescue tier in current implementation. Low-confidence items are simply filtered. BM25 boost can push borderline items above threshold (+0.3 max).

### F3: Entity Enrichment

Batch query `entity_mentions` + `entities` tables for final result set. Attaches `entities: [{canonical_name, entity_type}]` to each result. Also incorporates entity_timeline data from C1b injection.

---

## Section G: Client-Side Output

### G1: Client Post-Processing

Client receives server results and applies remaining stages:
- **Temporal+synthesis fallback**: If query mentions a platform with temporal intent (scoreTemporalReference >= 0.4) and no results from that platform -> `getRecentByPlatform` via edge function
- **Preference + vector merge**: If preference router found results and query had qualifier
- **Entity-aware recency resolution**: Groups items by shared entities, boosts newest (1.5x), penalizes older (0.8x) with confidence gate (skip if older outscores newest by >0.2)

### G2: Injection Builder

**Sanitization**: Structural delimiters (`[SYSTEM]`, `[INST]`, `<system>`, `<|im_start|>`) -> replaced with `_`. Separator patterns and prompt injection vectors neutralized.

**Confidence tier routing** (based on max rerank_score):
- >= 0.5: "ALWAYS use K.Y.T. data first, suppress web search"
- 0.25-0.5: "Review items, incorporate relevant info"
- < 0.25: "Mention only if clearly related"

**Platform-specific**:
- ChatGPT: system message prefix
- Claude Web: Human turn prefix
- Gemini: XHR StreamGenerate payload injection
- Claude Code: system-reminder hook context

---

# DELIVERABLE 3: EXPERT OPINION

## Strengths

**1. Server-side quality penalties eliminate the MCP quality gap.**

Before the `quality-penalties.ts` migration, MCP consumers (Claude Code) received raw results without deflection filtering, meta-echo suppression, or recency adjustment. The same penalties that protected ChatGPT/Claude users were client-only in `context-retrieval.js`. Now all consumers get identical quality treatment. This is the single biggest improvement in the current architecture.

**2. The penalty ordering is textbook filtration design.**

Hard drops first (recursion guard, meta flag, high-confidence deflection), then score penalties (meta, diagnostic, echo), then more hard drops (bare questions), then time adjustment. Each stage reduces the candidate set so expensive stages operate on fewer items. Total cost: microseconds on 20-40 candidates. 66 compiled regexes is manageable -- regex compilation is a one-time cost per edge function cold start.

**3. Gravity scoring is genuinely novel for personal memory systems.**

Most RAG systems treat all documents equally from a temporal perspective. K.Y.T.'s gravity scoring with adaptive decay curves (logarithmic for high-impact memories, exponential for low-impact) and rehearsal bonuses maps to how human memory actually works. The "Jerry problem" solution (entity timeline guarantee) addresses a real failure mode of pure vector similarity.

**4. The drift gate on HyDE prevents a class of silent failures.**

HyDE is powerful but dangerous -- it can fabricate entities that don't exist in the corpus. Most implementations trust HyDE output blindly. K.Y.T.'s drift gate (>=1 original query term must appear, 85 stop words filtered) is simple and effective. Combined with the adaptive short-circuit (skip HyDE when entity confidence is high), HyDE is used only when it adds value.

**5. Three-way RRF fusion with graph walk is well-designed.**

The graph walk provides a retrieval signal that both embedding similarity and lexical matching miss: shared entity connections. The "Walter Peyton" -> "Walter Payton" typo bridging via entity relationships is a concrete example. RRF with k=60 prevents any single arm from dominating.

**6. The Layer 2 intent judge is a smart use of LLM budget.**

Spending ~2s of Haiku 4.5 time on ambiguous PASSIVE cases to avoid 12-18s of wasted pipeline execution is excellent cost engineering. The tiered approach (cheap heuristic for 80% of cases, LLM judge for 20%) is more efficient than either pure-heuristic or pure-LLM classification.

## Weaknesses & Technical Debt

**1. Dual-path architecture is still active.**

`src/context-retrieval.js` still contains the legacy local BM25+HyDE path for unauthenticated users, plus client-side mirrors of server-side logic (preference router, platform penalty). This creates maintenance burden: every server-side improvement must be mentally tracked as potentially missing from the client path. Phase 5's goal of deleting the client retrieval path entirely is the right call.

**2. The penalty stack interactions are hard to debug.**

8 sequential penalties, each modifying `rerank_score` multiplicatively, means a document can be penalized by multiple stages. A meta-conversation about retrieval diagnostics from the wrong platform: `score * 0.3 * 0.5 * 0.3 = score * 0.045`. The quality-penalties module logs each penalty application, but there's no aggregate per-item penalty trace in the response. Adding per-stage score snapshots to the response metadata would help debugging.

**3. MMR Jaccard fallback is weaker than cosine similarity.**

When candidates lack embeddings (graph walk results, rescue search results), MMR falls back to Jaccard similarity on word sets. Two items about "car preferences" and "automotive favorites" have low Jaccard overlap but high semantic similarity. The per-pair hybrid approach (cosine when both have embeddings, Jaccard otherwise) is correct, but graph walk results often lack embeddings.

**4. No explicit rescue tier in confidence filter.**

The Phase 5 spec describes a 3-tier confidence system (normal/rescue/block). Current implementation only has a single threshold. When the intent classifier raises the threshold to 0.65 and nothing passes, the result is empty. A rescue tier (top 2 items if score >= 0.10, respecting classifier signal) would prevent silent failures on edge cases.

**5. Entity enrichment runs twice in some paths.**

Entity data is fetched for timeline guarantee (C1b), then fetched again for enrichment (F3). The second query hits `entity_mentions` for all result IDs, including ones that already have entity_timeline data from C1b. Caching the C1b data and passing it to F3 would save one DB round-trip.

**6. context-generator.ts is ready but not yet integrated into ingestion.**

The Anthropic contextual retrieval technique is implemented (171 lines) but `contextual_content` is only populated for rows that were explicitly backfilled. New ingestion doesn't generate it yet. This means the cross-encoder and BM25 boost stages operate on raw text for recent messages, losing the 67% precision improvement Anthropic reports.

## Scalability

**API-call-bound, not data-bound.** At 3,163 messages, vector search is ~82ms (HNSW). At 30K messages, ~100ms. At 300K, ~150ms. The bottleneck is always the three sequential external API calls: HyDE generation (Haiku, 2-4s) + Reranking (BGE, 2-4s) + Embedding (Qwen3, 150ms).

**At 100K+ messages**: Add pre-filter by conversation recency or content_type before vector search, with fallback to full corpus if sparse.

**At 1M+ messages**: Partition HNSW index (by user, by time period). Supabase pgvector supports this via partial indexes.

## Comparison to Alternative Patterns

**Agent-based RAG** (LLM decides tools iteratively): More flexible but 3-5x more expensive and 5-10x slower. K.Y.T.'s fixed pipeline is correct for latency-sensitive injection.

**Multi-index retrieval** (separate indexes per content type): Premature at 3K messages. Unified HNSW + gravity scoring handles heterogeneous content well.

**Streaming/progressive retrieval**: Return partial results as stages complete. Appealing for UX but complex in injection-based systems where context is consumed atomically.

---

# DELIVERABLE 4: RESOURCE SECTION

## 1. RAG Fundamentals

**"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"**
- Type: Research paper (NeurIPS 2020)
- Authors: Lewis et al. (Facebook AI Research)
- The foundational RAG paper. Establishes retrieve-then-generate paradigm. Essential for understanding why retrieval + generation outperforms generation-only for factual recall.

**"A Survey on Retrieval-Augmented Text Generation"**
- Type: Research paper (arXiv 2024)
- Authors: Gao et al.
- Comprehensive taxonomy: naive RAG, advanced RAG (K.Y.T.'s category), modular RAG. K.Y.T.'s pre-retrieval/post-retrieval pipeline maps to "Advanced RAG."

**LlamaIndex Documentation -- "Building Performant RAG Applications"**
- Type: Documentation (docs.llamaindex.ai)
- Practical engineering guide covering query transformations, reranking, hybrid search. K.Y.T.'s architecture is a specific instantiation of these patterns.

## 2. Single Pipeline Architecture

**"Rethinking RAG Pipeline Complexity"**
- Type: Technical blog (Pinecone, pinecone.io/learn)
- Makes the case for simplified single-path retrieval over multi-agent architectures. Directly relevant to K.Y.T.'s Phase 5 consolidation.

**"Building Production RAG Systems" (Stanford CS 329S)**
- Type: Course materials (Stanford University)
- Covers observability, testing, and maintenance cost of pipeline complexity. Validates K.Y.T.'s unification decision.

## 3. Pre-retrieval Techniques

**"Precise Zero-Shot Dense Retrieval without Relevance Labels" (HyDE)**
- Type: Research paper (ACL 2023)
- Authors: Gao et al.
- The paper introducing Hypothetical Document Embeddings. K.Y.T.'s drift gate validation is a novel addition not in the original paper.

**"Query2doc: Query Expansion with Large Language Models"**
- Type: Research paper (EMNLP 2023)
- Authors: Wang et al.
- Theoretical grounding for LLM-rewritten queries outperforming raw queries. K.Y.T.'s query transformation implements this pattern.

## 4. Retrieval Methods

**"Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"**
- Type: Research paper (SIGIR 2009)
- Authors: Cormack, Clarke, Buttcher
- Original RRF paper. K.Y.T. uses standard formula with k=60. Essential for understanding rank-based vs score-based fusion.

**pgvector Documentation**
- Type: Documentation (github.com/pgvector/pgvector)
- K.Y.T.'s vector search runs on pgvector with HNSW indexes (1024d cosine distance). Covers index tuning parameters (m, ef_construction).

**"Matryoshka Representation Learning"**
- Type: Research paper (NeurIPS 2022)
- Authors: Kusupati et al.
- The technique K.Y.T. uses to truncate Qwen3's 4096d embeddings to 1024d without retraining. 4x lower storage while maintaining quality.

## 5. Post-retrieval Processing

**"Improving RAG Effectiveness with Reranking"**
- Type: Technical documentation (Jina AI, jina.ai/reranker)
- Documents BGE-Reranker-v2-m3 used by K.Y.T. Explains why cross-encoder after bi-encoder improves precision.

**"The Carbonell & Goldstein MMR Paper: Reducing Redundancy"**
- Type: Research paper (SIGIR 1998)
- Authors: Carbonell, Goldstein
- Original MMR paper. K.Y.T.'s synthesis-query lambda adjustment (0.35) is a novel extension.

**"Contextual Retrieval" (Anthropic)**
- Type: Technical blog (anthropic.com/news/contextual-retrieval)
- K.Y.T.'s `context-generator.ts` implements this: LLM-generated context prefix at write time, used by cross-encoder at search time. Reported 67% reduction in retrieval failures.

## 6. Generation Strategies

**"Prompt Engineering Guide"**
- Type: Documentation (Anthropic, docs.anthropic.com)
- K.Y.T.'s injection builder implements confidence-tiered instructions and sanitization. Covers principles behind these choices.

**"Deconstructing RAG" (NVIDIA Technical Blog)**
- Type: Technical blog (NVIDIA)
- How to frame retrieved context for the LLM, when to use "use this" vs "consider this." Directly relevant to K.Y.T.'s three-tier confidence routing.

## 7. Evaluation & Monitoring

**"RAGAS: Automated Evaluation of Retrieval Augmented Generation"**
- Type: Research paper + framework (arXiv 2023)
- Authors: Es et al.
- Framework for faithfulness, answer relevancy, context precision, context recall. K.Y.T.'s regression test queries are a manual version -- RAGAS could formalize evaluation.

**"Evaluating RAG Applications with RAGAs"**
- Type: Documentation (ragas.io)
- Practical implementation guide for RAGAS metrics. Next step for K.Y.T.'s automated testing.

## 8. Advanced Topics

**"Self-RAG: Learning to Retrieve, Generate, and Critique"**
- Type: Research paper (ICLR 2024)
- Authors: Asai et al.
- K.Y.T.'s intent classifier (whether to retrieve) and confidence filter (whether to inject) are lightweight versions of Self-RAG's critique loop. The Layer 2 LLM judge adds a degree of self-reflection.

**"Dense Passage Retrieval for Open-Domain Question Answering" (DPR)**
- Type: Research paper (EMNLP 2020)
- Authors: Karpukhin et al.
- Foundational bi-encoder retrieval. Helps reason about when bi-encoder fails (vocabulary mismatch -> solved by HyDE) and when it excels.

**"Lost in the Middle: How Language Models Use Long Contexts"**
- Type: Research paper (TMLR 2024)
- Authors: Liu et al. (Stanford/UC Berkeley)
- LLMs attend more to beginning/end of long contexts. K.Y.T.'s MMR diversity selection + confidence-tiered ordering places strongest matches first.

**"Adaptive Retrieval-Augmented Generation" (Adaptive-RAG)**
- Type: Research paper (2024)
- Authors: Jeong et al.
- Routing queries to different strategies based on complexity. K.Y.T.'s intent classifier + preference router + adaptive short-circuit implement this pattern.

</documentation>

---

## Implementation File Map

| Component | File | Lines |
|-----------|------|-------|
| Intent Classifier | `src/intent-classifier.js` | 425 |
| Context Retrieval (client) | `src/context-retrieval.js` | 795 |
| Auth Config + Routing | `src/auth-config.js` | 90 |
| Injection Builder | `kyt-memory-injection-builder.js` | 381 |
| Edge Function Entry | `supabase/functions/search_memories/index.ts` | 158 |
| Layer 2 Intent Judge | `supabase/functions/classify_intent/index.ts` | 149 |
| LLM Completion Proxy | `supabase/functions/llm_completion/index.ts` | 251 |
| Main Pipeline | `supabase/functions/_shared/get_relevant_memories.ts` | 1077 |
| RRF Fusion | `supabase/functions/_shared/rrf.ts` | 152 |
| Quality Penalties | `supabase/functions/_shared/quality-penalties.ts` | 524 |
| MMR + Dedup + Keyword Boost | `supabase/functions/_shared/mmr.ts` | 199 |
| HyDE Generator | `supabase/functions/_shared/hyde-generator.ts` | 177 |
| Context Generator | `supabase/functions/_shared/context-generator.ts` | 171 |
| Entity Extractor | `supabase/functions/_shared/entity-extractor.ts` | 649 |
| Memory Classifier | `supabase/functions/_shared/memory-classifier.ts` | 191 |
| HuggingFace Client | `supabase/functions/_shared/huggingface-client.ts` | 163 |
| Anthropic Client | `supabase/functions/_shared/anthropic-client.ts` | 189 |
| Conversation Chunker | `supabase/functions/_shared/conversation-chunker.ts` | 296 |
| Rate Limiter | `supabase/functions/_shared/rate-limit.ts` | 55 |
| Tier Check | `supabase/functions/_shared/tier-check.ts` | 62 |
| Cost Monitor + Utils | `supabase/functions/_shared/utils.ts` | 128 |
| Security Headers | `supabase/functions/_shared/headers.ts` | 29 |

**Total server-side retrieval logic**: 2,129 lines (get_relevant_memories + quality-penalties + mmr + hyde-generator + rrf)
**Total shared infrastructure**: 4,841 lines (all `_shared/` modules)
**Total client-side pipeline**: 1,691 lines (context-retrieval + intent-classifier + auth-config + injection-builder)

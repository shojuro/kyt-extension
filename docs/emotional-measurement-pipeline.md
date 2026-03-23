# K.Y.T. Emotional Measurement Pipeline — End-to-End Flowchart

How emotional data is created, stored, scored, searched, and surfaced across the full K.Y.T. pipeline.

---

## Pipeline Overview

```
 INGESTION                    STORAGE                   RETRIEVAL
 ─────────                    ───────                   ─────────
 Message     ──►  Classify    ──►  chat_turns     ◄──  Query
 captured         (Haiku 4.5)      (6 emotional        arrives
                  │                 columns)            │
                  ├─ impact                             ├─ Intent classify
                  ├─ intimacy                           ├─ Query transform
                  ├─ valence                            ├─ Emotion keyword search (GIN)
                  ├─ arousal                            ├─ Vector search + gravity
                  └─ emotion_keywords                   ├─ RRF merge (4-way)
                                                        ├─ BM25 boost (synonyms)
                                                        ├─ Gravity boost
                                                        ├─ Quality penalties
                                                        └─ Confidence filter → Inject
```

---

## PHASE 1: INGESTION — Scoring a Message's Emotional Weight

### Step 1: Message Capture

```
User types in ChatGPT / Claude / Gemini
        │
        ▼
Content script intercepts message
        │
        ▼
SAVE_MESSAGE dispatched to background.js
        │
        ▼
callEdgeFunction('save_chat_turn_batch', ...)
```

**What happens:** The platform-specific content script (ChatGPT content.js, Claude content.js, Gemini inject.js) intercepts the user's message via fetch/XHR override or DOM observation, and sends it to the service worker via port or `chrome.runtime.sendMessage`.

**Why here:** Capture must happen at the platform layer because each AI chat interface has a different message transport (ChatGPT uses fetch, Gemini uses XHR with length-prefixed byte streams, Claude uses SSE). The message is raw text at this point — no emotional analysis yet.

---

### Step 2: Parallel Classification (Server-Side)

```
save_chat_turn_batch/index.ts
        │
        ▼
Promise.allSettled([
    classifyMemory(...)      ◄── Haiku 4.5 LLM call
    extractEntities(...)     ◄── Haiku 4.5 LLM call
    generateChunkContext(...)◄── Haiku 4.5 LLM call
])
```

**File:** `supabase/functions/save_chat_turn_batch/index.ts` (line ~322)

**What happens:** Three LLM calls fire in parallel. The one we care about is `classifyMemory()`, which sends the message content to Claude Haiku 4.5 with a system prompt defining five psychological dimensions.

**Why parallel:** Classification, entity extraction, and context generation are independent operations on the same content. Running them concurrently cuts latency from ~15s (serial) to ~5s (parallel). They don't depend on each other's output.

**Why server-side:** API keys never touch the client. The extension calls a Supabase Edge Function, which holds the ANTHROPIC_API_KEY. This is a hard security boundary — the `CLAUDE.md` rules forbid any client-side API key exposure.

---

### Step 3: The Classifier — Five Dimensions from One LLM Call

```
classifyMemory() → memory-classifier.ts
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │  Claude Haiku 4.5 System Prompt                         │
  │                                                         │
  │  1. IMPACT (0-100)      ← Holmes-Rahe Life Change Scale │
  │     "How significant is this life event?"               │
  │     100=catastrophic ... 0=surface                      │
  │                                                         │
  │  2. INTIMACY (0-3)      ← Aron's 36 Questions           │
  │     "How deep is the self-disclosure?"                  │
  │     3=core identity ... 0=surface                       │
  │                                                         │
  │  3. VALENCE (-1.0 to +1.0) ← Russell's Circumplex      │
  │     "Is this pleasant or unpleasant?"                   │
  │     +1.0=ecstatic ... -1.0=devastated                   │
  │                                                         │
  │  4. AROUSAL (0.0 to 1.0)   ← Russell's Circumplex      │
  │     "How emotionally activated?"                        │
  │     1.0=panic/rage/ecstasy ... 0.0=disengaged           │
  │                                                         │
  │  5. EMOTION KEYWORDS (5-8)                              │
  │     "What terms would find this memory later?"          │
  │     e.g. ["grief", "loss", "mourning", "heartbroken"]  │
  └─────────────────────────────────────────────────────────┘
        │
        ▼
  JSON output: { impact, intimacy, valence, arousal, emotion_keywords, reasoning }
```

**File:** `supabase/functions/_shared/memory-classifier.ts`

**What each dimension does and why it exists:**

| Dimension | Scale | Framework | Purpose | What It Catches |
|-----------|-------|-----------|---------|-----------------|
| Impact | 0-100 | Holmes-Rahe | Measures life event magnitude | Wedding vs weather chat |
| Intimacy | 0-3 | Aron's 36Q | Measures self-disclosure depth | "I fear death" vs "I like pizza" |
| Valence | -1.0 to +1.0 | Russell's Circumplex | Measures pleasant↔unpleasant direction | Wedding (+0.8) vs funeral (-0.9) — both score ~80 on impact |
| Arousal | 0.0 to 1.0 | Russell's Circumplex | Measures emotional activation | Rage (0.9) vs sadness (0.2) — both negative valence |
| Keywords | 5-8 terms | LLM-generated | Provides BM25-searchable emotional anchors | "invisible" → stored as ["invisible", "ignored", "dismissed", "unseen"] |

**Why five dimensions, not fewer:**

- Impact alone can't distinguish a wedding from a funeral (both ~75-85).
- Impact + Intimacy still can't. A funeral discussed casually (intimacy=1) and deeply (intimacy=3) both score high impact.
- Valence solves the direction problem: wedding = +0.8, funeral = -0.9.
- Arousal solves the energy problem: "enraged" and "despairing" are both negative valence but one is high-arousal (0.9) and one is low-arousal (0.2). Retrieval for "I'm so angry" shouldn't surface melancholic memories.
- Keywords solve the vocabulary gap: vector embeddings handle synonymy well, but BM25 keyword search doesn't. "Invisible" won't keyword-match "dismissed" without explicit expansion.

**Why all in one call:** Adding valence + arousal + keywords to the existing classifier prompt costs ~100 extra tokens in the response (maxTokens increased from 300→400). No additional API call needed. The marginal cost per message is ~$0.00003.

---

### Step 4: Output Sanitization

```
Raw LLM output
        │
        ▼
  Bound scores:
    impact_score  = clamp(0, 100)
    intimacy_level = clamp(0, 3)
    valence       = clamp(-1.0, +1.0)
    arousal       = clamp(0.0, 1.0)
        │
        ▼
  Sanitize emotion_keywords:
    ├─ Must be string (reject non-strings)
    ├─ Lowercase
    ├─ Strip [^a-z0-9\s-] (blocks injection)
    ├─ Min 2 chars, max 30 chars per keyword
    ├─ Max 8 keywords total
    └─ Log if keyword not in VALID_EMOTION_TERMS set (~130 terms)
        │
        ▼
  ClassificationResult { impact_score, intimacy_level, valence, arousal, emotion_keywords, reasoning }
```

**File:** `supabase/functions/_shared/memory-classifier.ts` (line ~70-95)

**Why here (between LLM output and storage):** The LLM can return anything — hallucinated scores, prompt-injected text, Unicode exploits in keyword arrays. Sanitization is the last gate before data hits the database. It must be:
- **After the LLM call** (can't sanitize what doesn't exist yet)
- **Before storage** (corrupt data in the DB is permanent)
- **Non-rejecting for keywords** (log warnings, don't drop — builds monitoring dataset)

**Why `VALID_EMOTION_TERMS` is a monitor, not a filter:** If the LLM produces "wistfulness" and it's not in our ~130-term set, it's likely a valid emotion we didn't think of. Rejecting it loses information. Logging it lets us review and expand the set. The static synonym table (Step 12) is the gatekeeper at query time.

---

### Step 5: Database Storage

```
ClassificationResult
        │
        ▼
  INSERT INTO chat_turns (
    content,
    embedding,          ← 1024d Qwen3 vector
    impact_score,       ← SMALLINT (0-100)
    intimacy_level,     ← SMALLINT (0-3)
    valence,            ← REAL (-1.0 to +1.0)
    arousal,            ← REAL (0.0 to 1.0)
    emotion_keywords,   ← TEXT[] (up to 8 terms)
    emotion_classified, ← BOOLEAN (true)
    gravity_classified, ← BOOLEAN (true)
    ...
  )
```

**File:** `supabase/functions/save_chat_turn_batch/index.ts` (line ~357)
**Migration:** `supabase/migrations/20260324000000_emotional_dimensions.sql`

**Indexes on emotional data:**

| Index | Type | Purpose |
|-------|------|---------|
| `idx_chat_turns_valence_arousal` | B-tree composite | Quadrant filtering ("happy memories" → valence>0.3 AND arousal>0.3) |
| `idx_chat_turns_emotion_keywords` | GIN | Array overlap search (WHERE emotion_keywords && ARRAY['grief']) |
| `idx_chat_turns_emotion_unclassified` | Partial (created_at DESC) | Backfill targeting (WHERE emotion_classified=FALSE) |

**Why NULL-safe:** Existing rows (pre-migration) have `valence=NULL, arousal=NULL, emotion_keywords=NULL, emotion_classified=FALSE`. Every downstream consumer uses COALESCE or DEFAULT to handle this gracefully. The `emotion_classified` boolean is the sentinel — it distinguishes "never classified" from "classified as neutral" (where valence=0, arousal=0 are valid scores).

---

## PHASE 2: RETRIEVAL — Using Emotional Data to Find the Right Memory

### Step 6: Intent Classification (Client-Side Gate)

```
User types a message
        │
        ▼
  intent-classifier.js → classifyIntent()
        │
        ├─ EMOTIONAL_RESPONSE regex test:
        │   /^(haha|lmao|omg|yikes|ugh|sigh|wow|...)$/i
        │   → Score 1.0 → NO_RETRIEVAL intent
        │   "These are reactions, not queries. Don't search."
        │
        ├─ If scoreDirective() + scoreContentDensity() + ...
        │   → MEMORY_QUERY (needs retrieval)
        │   → NO_RETRIEVAL (skip)
        │
        ▼
  GET_CONTEXT dispatched (if MEMORY_QUERY)
```

**File:** `src/intent-classifier.js` (line 52-71)

**Why this is first:** Before spending ~16s on the retrieval pipeline, we need to know if the message even needs retrieval. "lol" and "omg" are emotional but they're reactions — the user isn't asking for memory recall. The EMOTIONAL_RESPONSE regex catches these and short-circuits to NO_RETRIEVAL. This saves API calls and latency.

**Relationship to the rest:** This is a gate, not a scorer. It decides binary yes/no on retrieval. The emotional *scoring* (valence/arousal) happens at write time (Step 3), not at query time. The intent classifier doesn't use valence/arousal — it uses simple regex patterns to detect reactive one-liners.

---

### Step 7: Query Transformation (Client-Side Expansion)

```
User query: "I'm feeling really anxious about my job change"
        │
        ▼
  query-transformer.js → transformQuery()
        │
        ▼
  isAlreadyOptimized(query)?
        │
        ├─ Count TECHNICAL terms: "function", "postgres", "api", etc.
        │   (emotional terms are NOT counted — intentional fix)
        │
        ├─ technicalCount >= 2? → Skip (already optimized)
        │
        ├─ technicalCount < 2? → LLM expands the query
        │   "anxious about job change" →
        │   "anxiety career transition job loss worry stress employment"
        │
        ▼
  Expanded query used for downstream search
```

**File:** `src/query-transformer.js` (line 188-239)

**Why here (before search, after intent):** Query transformation sits between "should we search?" (intent classifier) and "what do we search for?" (vector search). It's the only place in the pipeline where we can expand a vague emotional query into richer search terms before embeddings are generated.

**The critical fix:** Previously, `isAlreadyOptimized()` combined technical AND emotional patterns into one count. "Feeling sad and lonely" matched 3 emotional terms → `termCount >= 2` → marked "already optimized" → **zero expansion**. The fix separates the counts: only technical terms trigger the skip. Emotional queries always benefit from expansion because emotional language is inherently vague ("I feel invisible" could mean many things).

**Why NOT at the server level:** The query transformer runs client-side for the legacy/BM25 path. The server-side `get_relevant_memories.ts` pipeline has its own expansion via HyDE (hypothetical document embedding). Both paths benefit from expanded emotional queries, but they expand differently — client uses LLM reformulation, server uses HyDE hallucination.

**Current status:** This function is effectively disabled (still references OpenAI key removed in Haiku migration). The fix prepares it for re-enablement with Haiku. When re-enabled, emotional queries will get proper expansion.

---

### Step 8: Preference Router (Client-Side, STEP 0)

```
  "What's my favorite movie?"
        │
        ▼
  context-retrieval.js → detectPreferenceQuery()
        │
        ├─ Matches "favorite X" / "do I like X" patterns
        │
        ├─ Looks up user_preferences table
        │   → Returns: { category: "movie", value: "Inception",
        │                 sentiment: "positive" }
        │
        ├─ sentiment: "positive" → label: "favorite"
        │   sentiment: "negative" → label: "disliked"
        │
        ▼
  Short-circuit: returns preference directly, skips vector pipeline
```

**File:** `src/context-retrieval.js` (line 106-235)

**Why here (before vector search):** Preferences are stored in a dedicated `user_preferences` table with a simple sentiment tag (positive/negative/neutral). Looking them up is a direct DB query — no embeddings, no reranking, no pipeline latency. If the user asks "what's my favorite color?", the answer is in a row, not in semantic search. This short-circuit saves ~15s.

**Relationship to emotional scoring:** The preference system uses a binary sentiment tag, not the full Circumplex. This is intentional — preferences are facts ("I like X"), not emotional experiences. The valence/arousal system is for narrative emotional content ("I felt devastated when..."), not preference lookups.

---

### Step 9: Parallel Search — Four Lists

```
get_relevant_memories.ts (server-side)
        │
        ▼
  Promise.all([
    ┌─────────────────────────────────────────────┐
    │ 1. searchEntities()                          │
    │    Embedding similarity on entities table     │
    │    + text fallback with CONCEPT_SYNONYMS      │
    │    (includes emotional synonym clusters)      │
    │                                              │
    │ 2. generateHyDEWithFallback()                │
    │    Haiku 4.5 generates hypothetical answer   │
    │    → embedded → used for vector search       │
    │                                              │
    │ 3. detectConceptEntities()                   │
    │    Exact-match entity lookup for boosting    │
    │                                              │
    │ 4. searchByEmotionKeywords() ◄── NEW         │
    │    GIN index query on emotion_keywords       │
    │    + static synonym expansion                │
    └─────────────────────────────────────────────┘
  ])
```

**File:** `supabase/functions/_shared/get_relevant_memories.ts` (line ~881)

**Why four parallel lists:** Each search strategy has a different strength:

| List | Strength | Weakness |
|------|----------|----------|
| Entity search | Finds memories by named concepts | Misses unnamed emotional experiences |
| HyDE vector search | Semantic similarity, handles paraphrasing | Can hallucinate, misses exact keywords |
| Raw vector search | No hallucination risk, literal matching | Misses semantic connections |
| Emotion keyword search | Exact emotional vocabulary match via GIN index | Only works for classified rows with keywords |

The emotion keyword search is the newest addition. It queries the `emotion_keywords TEXT[]` column using PostgreSQL's GIN index with the `&&` (overlap) operator. Before querying, it expands terms via the static `CONCEPT_SYNONYMS` map:

```
User query: "I'm struggling with grief"
        │
        ▼
Extract emotional terms: ["grief"]
        │
        ▼
Expand via CONCEPT_SYNONYMS:
  grief → ["loss", "mourning", "bereavement", "death"]
        │
        ▼
Query: WHERE emotion_keywords && ARRAY['grief','loss','mourning','bereavement','death']
        │
        ▼
Returns: Up to 10 rows, sorted by created_at DESC
```

**Why here (parallel with other searches, not sequential):** The emotion keyword search is independent of embedding generation — it uses a GIN index, not vectors. Running it in parallel with the vector searches adds zero latency. If it returns nothing (no emotional terms in query, or no matching rows), it costs nothing — the pipeline continues with the other three lists.

---

### Step 10: Gravity Score Calculation (SQL Level)

```
  Vector search RPC: match_messages_with_gravity()
        │
        ▼
  FOR EACH candidate:
        │
        ▼
  calculate_gravity_score(
    vector_similarity,    ← cosine similarity (0.0-1.0)
    impact_score,         ← Holmes-Rahe (0-100)
    intimacy_level,       ← Aron's (0-3)
    created_at,           ← age of memory
    last_accessed,        ← recency of retrieval
    access_count,         ← rehearsal count
    valence,              ← Russell's (-1.0 to +1.0)  ◄── NEW
    arousal               ← Russell's (0.0 to 1.0)    ◄── NEW
  )
        │
        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ IMPORTANCE MULTIPLIER                                        │
  │                                                              │
  │   base      = 1.0                                            │
  │   + impact  = impact_score / 100.0       [+0.0 to +1.0]     │
  │   + intimacy = intimacy_level × 0.2      [+0.0 to +0.6]     │
  │   + emotion = |valence| × arousal × 0.4  [+0.0 to +0.4]     │
  │   ─────────────────────────────────────                      │
  │   Total range: [1.0, 3.0]                                   │
  │                                                              │
  │ ADAPTIVE TIME DECAY (based on importance)                    │
  │                                                              │
  │   importance > 1.5 → LOGARITHMIC   (1 year = ~20% strength) │
  │   importance 1.2-1.5 → LINEAR      (60 days = 50% strength) │
  │   importance < 1.2 → EXPONENTIAL   (60 days = ~13% strength)│
  │                                                              │
  │ REHEARSAL BONUS                                              │
  │                                                              │
  │   1.0 + (access_count × 0.05), capped at 1.5               │
  │                                                              │
  │ FINAL: vector_sim × importance × decay × rehearsal           │
  │ Range: [0.0, ~4.5]                                           │
  └──────────────────────────────────────────────────────────────┘
```

**File:** `supabase/functions/_sql/calculate_gravity_score.sql`

**How valence and arousal affect decay:**

The emotional intensity component is `|valence| × arousal × 0.4`. This means:

| Scenario | |valence| | arousal | Emotional Intensity | Effect |
|----------|----------|---------|---------------------|--------|
| "My mom passed away" | 0.9 | 0.8 | +0.29 | Shifts to logarithmic decay (persists years) |
| "I felt content today" | 0.3 | 0.2 | +0.02 | Near-zero boost (decays normally) |
| "The weather is nice" | 0.1 | 0.1 | +0.004 | No meaningful change |
| "I'M SO ANGRY" | 0.8 | 0.9 | +0.29 | Shifts to logarithmic decay |
| "I feel a bit sad" | 0.4 | 0.2 | +0.03 | Slight boost, stays in medium decay |

**Why absolute valence:** `|valence|` means both extreme joy (+0.9) and extreme despair (-0.9) persist longer. This is correct — emotionally intense memories of either polarity are more important to retain than neutral ones. The sign of valence matters at retrieval time (matching positive queries to positive memories), not at decay time.

**Why multiply by arousal:** Arousal acts as a confidence gate. "Calm contentment" (valence=+0.3, arousal=0.1) is mild and should decay normally. "Ecstatic celebration" (valence=+0.9, arousal=0.9) is intense and should persist. Without arousal, a calmly stated "I'm happy" would get the same persistence as a jubilant "I CAN'T BELIEVE IT WE WON!!"

**Why here (in SQL, not in application code):** The gravity score is computed during vector search via `match_messages_with_gravity()` RPC. Computing it in SQL means:
1. It runs on every retrieval automatically — no application code can forget to apply it.
2. It uses the database's current timestamp (`NOW()`) for decay — no clock skew from the client.
3. It's computed for ALL candidates in one query, not N+1 API calls.
4. The SQL function is `IMMUTABLE` — PostgreSQL can cache/optimize it.

---

### Step 11: RRF Merge (Reciprocal Rank Fusion)

```
  4 search result lists:
  ┌─────────────────────────────────────────────────────┐
  │ HyDE results      (weight: ~0.41)                   │
  │ Raw results       (weight: ~0.27)                   │
  │ Graph results     (weight: ~0.17)                   │
  │ Emotion keywords  (weight: ~0.15)  ◄── NEW          │
  └─────────────────────────────────────────────────────┘
        │
        ▼
  reciprocalRankFusion(lists, k=60, topK)
        │
        ▼
  For each candidate across all lists:
    rrf_score = Σ (weight_i / (k + rank_i))
        │
        ▼
  Merged candidates sorted by rrf_score DESC
```

**File:** `supabase/functions/_shared/get_relevant_memories.ts` (line ~1140)
**RRF implementation:** `supabase/functions/_shared/rrf.ts`

**Why RRF and not a simple union:** Different search strategies rank differently. A memory about "my dad's death" might rank #1 in emotion keyword search (exact match on "grief", "death") but #7 in raw vector search (the embedding captures the topic but ranks other semantically similar content higher). RRF combines rank positions across lists, giving each list a weighted vote. This means a memory that appears in multiple lists — even if not #1 in any — gets a boost from appearing across strategies.

**Why the emotion keyword list has weight 0.15:** It's the lowest-confidence signal — it's based on exact keyword matching, which can miss synonyms that weren't in the LLM's output at write time. The vector search paths (HyDE + Raw) handle semantic similarity better. The emotion keyword path catches what vector search misses: exact BM25-style keyword matches for emotional terms that the user typed literally. Weight 0.15 means it influences results but can't dominate.

**How weights adjust when emotion keywords are absent:** If the query has no emotional terms, `emotionKeywordResults` is empty and the merge proceeds as 3-way (HyDE + Raw + Graph) with the original weight distribution. No degradation for non-emotional queries.

---

### Step 12: BM25 Boost with Emotional Synonym Expansion

```
  Query: "I feel so lonely"
        │
        ▼
  applyBm25Boost(query, candidates)
        │
  For each candidate:
    Count keyword matches between query terms and content
    Boost = (0.3 × termScore) / maxScore
        │
        ▼
  Entity concept expansion kicks in upstream
  (searchGraphWalk text fallback):
        │
  ENTITY_CONCEPT_SYNONYMS map:
    'lonely' → ['alone', 'isolated', 'loneliness', 'disconnected']
    'grief'  → ['loss', 'mourning', 'bereavement', 'death']
    'angry'  → ['frustrated', 'mad', 'furious', 'resentful']
    ... (30 emotional clusters + 12 domain clusters)
```

**Files:**
- `supabase/functions/_shared/get_relevant_memories.ts` — server-side `CONCEPT_SYNONYMS` (line ~327)
- `src/browser-search.js` — client-side `ENTITY_CONCEPT_SYNONYMS` (line ~705)

**Why static synonyms at query time (not just LLM-generated at write time):**

This is the "belt and suspenders" architecture:

| Mechanism | When | Where | Strength | Weakness |
|-----------|------|-------|----------|----------|
| LLM emotion_keywords | Write time | Stored on chat_turns | Context-aware ("invisible" in a relationship vs workplace) | Non-deterministic, costs tokens |
| Static synonym clusters | Query time | In-memory map | Zero cost, deterministic, testable | Context-blind, limited vocabulary |

The two cover each other's gaps:
- If the LLM wrote `["overlooked", "dismissed"]` but the user searches "invisible" → static synonyms expand "invisible" is not in the static table, but "lonely" → "alone, isolated" catches many cases.
- If the static table doesn't have a term but the LLM wrote it at storage time → the GIN index emotion_keywords search (Step 9) finds it.

**Why both client and server have the same synonym map:** The client pipeline (browser-search.js) runs the legacy/offline path. The server pipeline (get_relevant_memories.ts) runs the edge path. Both need the same expansion to ensure consistent retrieval regardless of routing mode. The maps must stay in sync — both files have a comment noting this.

---

### Step 13: Gravity Boost (Post-Rerank)

```
  After BM25 boost, before confidence filter:
        │
        ▼
  applyGravityBoost(candidates)
        │
  For each candidate:
    gravity = candidate.gravity_score (computed in Step 10)
    normalized = min(gravity / 4.5, 1.0)    ← 4.5 = theoretical max
    boost = normalized × 0.15               ← max +0.15 additive
    rerank_score += boost
        │
        ▼
  Candidates re-sorted by boosted rerank_score
```

**File:** `supabase/functions/_shared/get_relevant_memories.ts`

**Why this was missing before (and why it matters):** Before this fix, gravity_score was computed at the SQL level (Step 10) and returned on every candidate, but the RRF merge used rank positions (not gravity_score), and the reranker produced its own `rerank_score` that replaced everything. Gravity was computed but thrown away. This meant high-impact, high-intimacy, emotionally charged memories got no persistence advantage in the final ranking — only vector similarity and reranker judgment mattered.

**Why additive (+0.15 max) not multiplicative:** A multiplicative boost (e.g., `rerank_score × gravity_factor`) would amplify the reranker's existing ranking — if the reranker scored an irrelevant result at 0.6, multiplying by a high gravity factor could push it above the confidence threshold. An additive cap of +0.15 ensures gravity can only break ties between semantically similar results. A memory with `rerank_score=0.3` can't get boosted above 0.45 — still below the default 0.40 threshold for most queries.

**Why here (after BM25, before confidence filter):**

```
Pipeline position:
  Reranker → BM25 boost → GRAVITY BOOST → Confidence filter → MMR

  Before BM25:  ✗ Would ignore keyword relevance
  Before rerank: ✗ Would bias the cross-encoder input
  After filter:  ✗ Too late — good memories already dropped
  HERE:          ✓ All relevance signals applied, gravity breaks remaining ties
```

---

### Step 14: Quality Penalties

```
  applyQualityPenalties(candidates, { query })
        │
        ▼
  For each candidate:
    ├─ Meta-conversation penalty (×0.3) ← uses impact_score
    │   "Did this talk about the pipeline itself?"
    │
    ├─ Diagnostic language penalty (×0.5) ← uses impact_score
    │   "Does this describe retrieval diagnostics?"
    │
    ├─ Deflection penalty (×0.3)
    │   "Is this an AI dodge ('I don't have that info')?"
    │
    └─ Fallback heuristic (if impact_score is NULL):
        Regex-based greeting/chatter detection
```

**File:** `supabase/functions/_shared/quality-penalties.ts`

**How emotional data is used here:** The quality penalties read `impact_score` and `intimacy_level` from the candidate to decide whether to apply penalties. A message with `impact_score=0` (surface chatter) that also matches meta-conversation patterns gets a harsh 0.3× penalty. A message with `impact_score=60` (significant life event) that happens to mention "retrieval" might get a lighter penalty because the impact score indicates it's genuinely important content, not just pipeline chatter.

**Why here (after gravity boost, before confidence filter):** Quality penalties are reductive — they can only decrease scores, never increase. They run after all positive signals (relevance, BM25, gravity) have been applied, so they act as a final quality gate. Running them earlier would risk penalizing content before its full relevance was assessed.

---

### Step 15: Confidence Filter and Injection

```
  confidenceThreshold = 0.40 (default)
                        0.60 (if intent classifier is uncertain)
                        0.65 (if query is very ambiguous)
        │
        ▼
  Filter: candidates where rerank_score >= confidenceThreshold
        │
        ▼
  Content deduplication (content hash)
        │
        ▼
  MMR (Maximal Marginal Relevance, λ=0.5)
    Balance relevance vs diversity
        │
        ▼
  Top-K results (typically 3-5)
        │
        ▼
  Format as injection block
        │
        ▼
  Injected into user's next prompt to the AI
```

**End state:** The user's AI sees a context block like:

```
[K.Y.T. Memory Context]
- "Last week you mentioned your mom was diagnosed with cancer.
   You said you felt helpless but wanted to be strong for your family."
   (Recorded: March 15, 2026)
```

This memory surfaced because:
1. It was classified with `impact_score=85, intimacy_level=3, valence=-0.8, arousal=0.7, emotion_keywords=["cancer", "helpless", "family", "grief", "fear"]`
2. The gravity score persisted it for months (logarithmic decay from high importance)
3. The user's current query "I don't know how to handle this" matched via vector similarity, emotion keyword GIN search ("helpless"), and synonym expansion
4. The gravity boost gave it a +0.12 tiebreaker over a less emotionally significant memory with the same vector similarity

---

## PHASE 3: BACKFILL — Classifying Historical Messages

```
background.js alarm: 'backfillEmotions'
(fires every 3 minutes)
        │
        ▼
callEdgeFunction('backfill_emotions', { fast_mode: true, max_rows: 50 })
        │
        ▼
  Query: chat_turns WHERE emotion_classified = FALSE
         ORDER BY created_at DESC
         LIMIT 50 (newest first)
        │
        ▼
  For each row (5 per batch, 2s delay):
    ├─ Skip if: is_question=true OR deflection >= 0.70 OR content empty
    │  (mark emotion_classified=true anyway)
    │
    ├─ classifyMemory(content, speakers)
    │  → Full classification: impact + intimacy + valence + arousal + keywords
    │
    └─ UPDATE chat_turns SET
         impact_score, intimacy_level,
         valence, arousal, emotion_keywords,
         emotion_classified = true,
         gravity_classified = true
```

**Files:**
- `supabase/functions/backfill_emotions/index.ts` — Edge function
- `background.js` — Alarm handler (case `backfillEmotions`)

**Why a separate backfill from backfill_gravity:** Existing rows already have `impact_score` and `intimacy_level` (from the original gravity classification). But they lack `valence`, `arousal`, and `emotion_keywords`. The `emotion_classified` boolean is separate from `gravity_classified` specifically to distinguish "has gravity scores but no emotional dimensions" from "has everything."

**Why newest first:** `ORDER BY created_at DESC` ensures recent messages (most likely to be queried soon) get classified first. A 2-year-old message about the weather can wait; yesterday's conversation about a job interview should have emotional dimensions ASAP.

**Cost:** ~1468 existing rows × ~$0.0002/call ≈ **$0.29 total**. ~10 minutes runtime at 50 rows per 3-minute alarm cycle.

---

## Summary: Where Each Emotional Signal Is Used

| Signal | Created At | Stored In | Used At | Purpose |
|--------|-----------|-----------|---------|---------|
| impact_score (0-100) | Write: classifier | chat_turns.impact_score | Gravity formula, quality penalties | Controls time decay rate |
| intimacy_level (0-3) | Write: classifier | chat_turns.intimacy_level | Gravity formula, quality penalties | Controls time decay rate |
| valence (-1.0 to +1.0) | Write: classifier | chat_turns.valence | Gravity formula (emotional intensity) | Distinguishes positive from negative |
| arousal (0.0 to 1.0) | Write: classifier | chat_turns.arousal | Gravity formula (emotional intensity) | Distinguishes high from low energy |
| emotion_keywords (TEXT[]) | Write: classifier | chat_turns.emotion_keywords | GIN search (Step 9), RRF list | BM25-style emotional matching |
| EMOTIONAL_RESPONSE regex | Query: intent classifier | In-memory | Gate: skip retrieval for reactions | Prevents "lol" from triggering search |
| Static synonym clusters | Query: concept expansion | In-memory (2 locations) | BM25 boost, entity text fallback | Expands "grief" → "loss mourning bereavement" |
| Preference sentiment | Write: entity extractor | user_preferences.sentiment | Preference router (Step 0) | Labels "favorite" vs "disliked" |
| Gravity boost (+0.15 max) | Query: post-rerank | Computed on the fly | Final ranking tiebreaker | Ensures high-gravity memories surface |

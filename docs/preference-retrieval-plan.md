# KYT Preference Retrieval Failure — Production Assessment & Fix Plan

**Date:** 2026-02-18 (revised after senior review)
**Test Case:** "What is my favorite car?" (user stated: "I think Lamborghini is the most amazing car")
**Result:** 0/4 incognito instances retrieved the correct answer
**Confidence in this assessment:** 97%

> **Revision note:** Updated after senior dev review to correct Priority 4 (entity naming),
> promote HyDE testing to Phase 2, and add retroactive data cleanup to Phase 1.

---

## Executive Summary

The "favorite car" test exposes **5 compounding failures** in the KYT pipeline. No single fix resolves the problem — the failures span ingestion, entity extraction, retrieval scoring, and content classification. Each failure independently reduces recall; together they create a near-zero probability of surfacing the correct answer.

The root cause is structural: **KYT was designed to retrieve explicit facts and named entities, not implicit user preferences expressed through indirect language.**

---

## 1. Failure Taxonomy

### Failure A: Self-Referential Pollution (Critical)

**What happens:** User asks "what is my favorite car?" → KYT stores this question as a message → On the next query, the stored question matches itself with high semantic similarity → The question occupies a retrieval slot that should contain the answer.

**Evidence from tests:** All 4 instances surfaced the question itself ("what is my favorite car?") as a top result, with confidence scores of 0.45-0.65.

**Root cause in code:**
- `background.js:698-800` — `saveMessage()` stores ALL messages indiscriminately. No distinction between questions and statements.
- No content-type filter at ingestion time. Questions, commands, greetings — everything goes to Supabase with identical treatment.

**Why it's critical:** A stored question about topic X will ALWAYS outscore the actual answer about topic X in semantic search (cosine similarity between "what is my favorite car?" and "what is my favorite car?" ≈ 1.0).

---

### Failure B: Assistant Deflection Stored as Knowledge (High)

**What happens:** When KYT has no answer, the assistant says "I don't have any information about your car preferences." This response gets stored. On subsequent queries, it surfaces as a retrieval result — actively telling the next instance there's nothing to find.

**Evidence from tests:** Instances 2-4 retrieved the assistant deflection from Instance 1 as a top-3 result.

**Root cause in code:**
- `background.js:743-754` — `saveMessage()` tags deflections with a `deflection` confidence score but **still stores them**.
- `background.js:1322-1332` — `detectDeflection()` penalty is applied at **retrieval-time**, not ingestion-time. The penalty (`1 - confidence * 0.9`) reduces score by up to 86%, but the message still occupies a retrieval slot and competes with real results.
- `src/assistant-quality-detector.js:39-50` — Deflection patterns correctly detect "I don't have information about" but the detection only triggers a score penalty, not a storage filter.

**Why it matters:** The deflection competes with the actual preference statement. After the 86% penalty, a 0.60 score becomes 0.08 — which is below threshold. But the presence of the deflection in Supabase search results means it consumes an RPC result slot (the query returns N rows, and this is one of them).

---

### Failure C: classifyContent() Misclassifies Questions as Preferences (High)

**What happens:** The heuristic classifier in the injection builder classifies "what is my favorite car?" as `user_preference` (type) with `technical_preference` (subtype) because the content contains the word "favorite". This triggers a +0.15 MMR boost for the question, pushing it above the actual answer.

**Root cause in code:**
`kyt-memory-injection-builder.js:69-71`:
```javascript
if (lower.includes('prefer') || lower.includes('favorite') ||
    lower.includes('i like') || lower.includes('don\'t use')) {
    return { type: 'user_preference', subtype: 'technical_preference', intent: 'user_annotated' };
}
```

This is a keyword-in-string check with no sentence structure awareness. The word "favorite" appears in both:
- ✅ "My favorite car is Lamborghini" (actual preference — correct classification)
- ❌ "What is my favorite car?" (question about preference — wrong classification)

**Downstream impact:** In `background.js:1417-1430`, the MMR `boostFunction` gives `user_preference` items a +0.15 boost. The misclassified question gets boosted; the actual statement (classified as `conversation_excerpt`) does not.

---

### Failure D: Semantic Vocabulary Gap (Medium-High)

**What happens:** User says "I think Lamborghini is the most amazing car" but later asks "what is my favorite car?" The embedding space treats "favorite" and "amazing" as weakly related. The cosine similarity between the query and the correct answer is ~0.35-0.45, which is near or below the confidence threshold.

**Root cause:** This is an inherent limitation of embedding models. "Favorite" implies persistent personal ranking; "amazing" implies admiration. They are semantically adjacent but not synonymous. The Qwen3-Embedding-8B model doesn't bridge this gap reliably.

**Why KYT doesn't compensate:**
- **Query transformation** (`src/query-transformer.js`) rewrites queries for better search, but it operates on the query side only. "What is my favorite car?" might become "user's preferred vehicle" — still distant from "amazing car."
- **BM25** searches for exact keyword matches. "favorite" ∉ {"Lamborghini", "amazing", "car"} — partial overlap only on "car."
- **HyDE** (`src/hyde-search-generator.js`) is **disabled by default** (`enableHyDE = false` at `browser-search.js:747`). Even if enabled, it generates a hypothetical answer document, not a vocabulary bridge.

---

### Failure E: Entity Graph Doesn't Capture Preferences (Medium)

**What happens:** "I think Lamborghini is the most amazing car" should create:
- Entity: `lamborghini` (type: ORG, relationship: "automotive")
- Mention edge with `sentiment: 'positive'` linking to the chat_turn

Instead, entity extraction creates:
- Entity: `lamborghini` (type: ORG, relationship: "unknown")
- No preference or sentiment signal is stored anywhere in the graph.

**Root cause in code:**
`supabase/functions/_shared/entity-extractor.ts:47-64` — The extraction prompt defines 9 entity types: PERSON, ORG, LOCATION, PROJECT, TECH, MISC, CONCEPT, ANALOGY, THEME. **There is no PREFERENCE type.**

The relationship vocabulary (`entity-extractor.ts:65-71`) includes family, work, and service relationships, but no preference vocabulary (e.g., "favorite", "admires", "prefers", "recommends").

When a user says "Lamborghini is the most amazing car," the extractor produces:
```json
{"entity_text": "Lamborghini", "normalized_name": "lamborghini", "entity_type": "ORG", "relationship": "unknown", "context_category": "general"}
```

The `relationship: "unknown"` means the canonical name becomes `lamborghini_unknown` — no preference signal survives.

**Graph walk failure:** Even if the entity were extracted correctly, `searchGraphWalk()` at `browser-search.js:560` uses `match_threshold: 0.8` for entity embedding search. The query "what is my favorite car?" has low embedding similarity to entity `lamborghini` (cosine ≈ 0.3). Both embedding and text entity search return 0 results → graph walk never executes → 0 graph results.

---

## 2. Compounding Effect Analysis

The 5 failures compound multiplicatively:

```
P(correct retrieval) = P(not self-polluted) × P(not deflection-polluted) × P(correctly classified) × P(semantic match) × P(entity bridge)

With current code:
= 0.0 × 0.3 × 0.0 × 0.4 × 0.1
= 0.0 (guaranteed failure)
```

Even fixing any single failure leaves the probability near zero. **At minimum, Failures A, C, and D must be addressed together** to achieve > 50% retrieval probability.

---

## 3. Prioritized Fix Recommendations

### Priority 1: Question Detection at Ingestion (Fixes A, partially C)

**What:** Add a question detector to `saveMessage()` that tags user messages as `is_question: true`. Questions still get stored (they have value for conversation context in chat_turns) but are excluded from direct message retrieval.

**Where:** `background.js:698`, inside `saveMessage()`

**Implementation:**
```javascript
// After line 724 (contentHash generation), before line 746 (newMessage creation):
const isQuestion = detectQuestionMessage(messageData.content, messageData.role);

const newMessage = {
  ...messageData,
  contentHash,
  capturedAt: Date.now(),
  messageId: messageData.messageId || generateMessageId(),
  timestamp: timestamp,
  is_question: isQuestion,
  ...(deflectionCheck.isDeflection ? { deflection: deflectionCheck.confidence } : {})
};
```

**Question detection heuristic:**
```javascript
function detectQuestionMessage(content, role) {
  if (role !== 'user') return false;
  const trimmed = content.trim();
  // Direct question marks
  if (trimmed.endsWith('?')) return true;
  // Interrogative openings
  const lower = trimmed.toLowerCase();
  const interrogatives = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember)\b/;
  return interrogatives.test(lower);
}
```

**Retrieval-side filter:** In `searchMessages()` and `searchSupabaseText()`, add `is_question=eq.false` (or `is_question=is.null`) filter to exclude stored questions from retrieval results. This requires a Supabase migration to add the `is_question` column.

**Risk:** Some questions contain embedded facts ("Is it true that Jennifer works at Google?"). These should NOT be filtered. Mitigation: only filter messages that are PURE questions (no embedded assertions). The interrogative-opening heuristic handles this — "Is it true that..." would match, but the content still gets stored in chat_turns where it's accessible via graph walk.

**Estimated impact:** Eliminates self-referential pollution entirely. The question still exists in storage for chat_turns context, but doesn't compete with answers in direct retrieval.

---

### Priority 2: Fix classifyContent() to Distinguish Questions from Statements (Fixes C)

**What:** Add question detection BEFORE the keyword checks in `classifyContent()`.

**Where:** `kyt-memory-injection-builder.js:60-90`

**Implementation:**
```javascript
function classifyContent(content) {
    const lower = content.toLowerCase();
    const trimmed = content.trim();

    // Questions are NOT preferences/instructions — classify as conversation_excerpt
    if (trimmed.endsWith('?') || /^(what|who|where|when|why|how|which|is|are|do|does|did|can|could|would|tell me|remind me)\b/i.test(trimmed)) {
        return { type: 'conversation_excerpt', subtype: 'question_answer', intent: 'auto_captured' };
    }

    // ... rest of existing classification logic unchanged ...
}
```

**Impact:** Questions no longer receive the +0.15 `user_preference` MMR boost. The actual statement "I think Lamborghini is amazing" (which does NOT start with an interrogative) retains its classification and boost.

---

### Priority 3: Deflection Storage Filtering (Fixes B)

**What:** High-confidence deflections (≥0.70) should be excluded from Supabase sync entirely. They have zero knowledge value and actively harm retrieval.

**Where:** `src/browser-sync.js`, in `syncMessages()` — filter before upsert.

**Implementation:** Before the Supabase upsert call, filter out messages where `msg.deflection >= 0.70`. These messages remain in `chrome.storage.local` for session context but never reach Supabase where they pollute cross-session retrieval.

**Why 0.70 threshold:** `assistant-quality-detector.js` assigns 0.90-0.95 confidence for explicit "I don't have access to" deflections, 0.50-0.70 for hedged-but-substantive responses. Filtering at 0.70 catches clear deflections while preserving hedged responses that may contain useful information.

**Risk:** Minimal. Deflections are already penalized 63-86% at retrieval time. Preventing them from reaching Supabase removes the retrieval-slot competition entirely.

---

### Priority 4: Preference Vocabulary in Entity Extraction (Fixes E)

**What:** Extend entity extraction to capture user sentiment/preference toward entities — but store the sentiment on the **edge** (entity_mentions), NOT in the entity's canonical name.

**Why not bake sentiment into canonical names:** The original plan proposed `lamborghini_favorite` as the canonical name. This is wrong. The dedup system at `entity-extractor.ts:259-267` does exact match on `canonical_name + entity_type`, and the fuzzy dedup guard at line 307-311 explicitly prevents cross-relationship merging (`matchRelationship === entity.relationship`). If a user later says "I actually hate Lamborghini," the extractor would produce `lamborghini_dislikes` — a **separate entity** that can't merge with `lamborghini_favorite`. Entity identity is fractured by sentiment. Recency resolution can't operate because it sees two independent entities instead of one entity with evolving opinion.

**Correct approach: stable entity names + sentiment on edges.**

**Where:**
1. `supabase/functions/_shared/entity-extractor.ts:47-74` — extraction prompt
2. `supabase/migrations/` — new migration for `entity_mentions.sentiment`
3. `supabase/functions/_shared/entity-extractor.ts:245-376` — `saveEntitiesWithMentions()`

**Implementation — Step 1: Schema migration:**
```sql
ALTER TABLE entity_mentions ADD COLUMN IF NOT EXISTS sentiment TEXT
  CHECK (sentiment IN ('positive', 'negative', 'neutral'));
```

**Implementation — Step 2: Extraction prompt update:**
Add to the entity extraction prompt's relationship vocabulary:
```
- Sentiment relationships: favorite, admires, prefers, recommends, loves (→ positive)
- Negative sentiment: dislikes, avoids, hates, criticizes (→ negative)
```

Add to the output schema a `sentiment` field per entity. The extractor should output:
```json
{
  "entity_text": "Lamborghini",
  "normalized_name": "lamborghini",
  "entity_type": "ORG",
  "relationship": "automotive",
  "context_category": "automotive",
  "sentiment": "positive"
}
```

The canonical name becomes `lamborghini_automotive` — **stable regardless of sentiment changes.** The relationship field captures the domain context (automotive, not favorite/dislikes).

**Implementation — Step 3: Save sentiment on the mention edge:**
In `saveEntitiesWithMentions()`, when creating entity_mentions, include the sentiment:
```javascript
await supabase.from('entity_mentions').insert({
  entity_id: entityId,
  chat_turn_id: chatTurnId,
  conversation_id: conversationId,
  mention_text: entity.entity_text,
  confidence: entity.confidence || 0.5,
  sentiment: entity.sentiment || null  // NEW: stored on the edge
});
```

**Impact:** One stable entity (`lamborghini_automotive`) accumulates all mentions. Each mention edge carries its own sentiment + timestamp. Graph walk retrieves chat_turns via entity_mentions. Recency resolution can operate on the newest mention's sentiment to determine which opinion is current. When the user says "I hate Lamborghini now," it creates a new mention on the SAME entity with `sentiment: 'negative'` — the entity timeline guarantee (`get_newest_turns_for_entities`) surfaces this latest turn.

---

### Priority 5: Lower Entity Embedding Threshold for Graph Walk (Fixes E partially)

**What:** Reduce `match_threshold` from 0.8 to 0.6 in the entity embedding search.

**Where:** `src/browser-search.js:560`

```javascript
body: JSON.stringify({
  query_embedding: queryEmbedding,
  match_threshold: 0.6,  // Was 0.8 — too strict for vocabulary-gap queries
  match_count: 5,
  p_user_id: userId
})
```

**Rationale:** 0.8 is appropriate for near-exact entity matches ("Jennifer" → `jennifer_sister`). But preference queries like "favorite car" need to match entities like "lamborghini" at lower thresholds. The text fallback (`search_entities_by_text`) already uses trigram similarity > 0.15, so the embedding search is unnecessarily restrictive in comparison.

**Risk:** More false-positive entity matches → more graph walks → slightly more latency. Mitigated by the existing `match_count: 5` limit and the fact that graph walk results still go through RRF fusion, Jina reranking, and confidence filtering.

---

### Priority 6: Enable HyDE for Preference Queries (Addresses D)

**What:** HyDE generates a hypothetical answer document that bridges vocabulary gaps. For "what is my favorite car?", HyDE would generate something like: "The user's favorite car is [a luxury sports car]. They have expressed admiration for..." This synthetic document has high embedding similarity to the actual statement about Lamborghini.

**Where:** `background.js`, in the `getContextForInjection()` call to `searchHybrid()`:

```javascript
const searchResults = await searchHybrid(searchQuery, {
  limit: 15,
  semanticThreshold: 0.50,
  enableHyDE: true,  // Was: false (default)
  enableGraph: true,
  openaiKey: apiConfig.openaiKey,
  maxTimestamp: maxTimestampCutoff
});
```

**Dependency:** HyDE requires an OpenAI key. The current code has the infrastructure but it's disabled by default. Enabling it adds ~1-2s latency (parallel with other searches) and costs ~$0.001 per query.

**Risk — hallucination:** HyDE can generate misleading hypothetical documents that match wrong results. For "what is my favorite car?", GPT-4o-mini might fabricate "The user's favorite car is a Toyota Camry" — a hallucinated preference that could pull completely wrong content from the vector store. The Jina reranker is the safety net, but if Jina's circuit breaker is open, the hallucinated HyDE document matches unchecked.

**Mitigation:** Enable HyDE but keep the confidence threshold at 0.40 for Jina-reranked results. If Jina is unavailable, HyDE results should be weighted lower in the RRF fusion (reduce the HyDE ranked list weight from 1.0 to 0.5 when `jinaReranked === false`).

**Phase note:** HyDE is the only proposed fix that directly bridges the vocabulary gap between "favorite" and "amazing." If entity extraction (Priority 4) doesn't capture preference relationships correctly, HyDE becomes the primary vocabulary bridge. **Test HyDE in parallel with Phase 2** (entity fixes) rather than waiting for Phase 3. Gate promotion on hallucination testing: run the validation test cases with HyDE enabled and verify that the Jina safety net catches fabricated hypothetical documents.

---

## 4. Edge Cases & Second-Order Concerns

### Edge Case 1: Questions Containing Embedded Facts
"Did I tell you that my favorite car is Lamborghini?" contains both a question AND a preference statement. The Priority 1 question detector would tag this as `is_question: true` and exclude it from retrieval.

**Mitigation:** The chat_turns chunker (`src/conversation-chunker.js`) pairs user-assistant messages into turns. The turn chunk containing this message would still be in Supabase and searchable via chat_turns. The entity extraction would still run on it (entity extraction operates on chat_turns, not individual messages). So the preference is captured via entity graph even if the individual message is excluded from direct retrieval.

### Edge Case 2: Negated Preferences
"I used to like Lamborghini but now I prefer Ferrari." The question detector doesn't trigger (not a question). `classifyContent()` correctly identifies it as `user_preference`. Entity extraction produces two mentions: `lamborghini_automotive` with `sentiment: 'negative'` and `ferrari_automotive` with `sentiment: 'positive'`. Both link to the same chat_turn. Since entity names are now sentiment-neutral (per revised Priority 4), both mentions accumulate on stable entities. Recency resolution (`applyRecencyResolution()` at `background.js:1004-1061`) boosts the newest turn per entity. The entity timeline guarantee (`get_newest_turns_for_entities`) ensures the latest Ferrari turn surfaces.

**Remaining gap:** If the Ferrari statement was said in a different conversation and only one surfaces in the initial retrieval pool, recency resolution can't compare them. This is an existing limitation of the recency resolution system (the "Jerry problem" from the earlier analysis). Not a regression from these fixes — and the entity-timeline guarantee (fix #25) already partially addresses it by pulling the newest turn per entity into the candidate pool.

### Edge Case 3: Implicit Preferences Without Named Entities
"I love cars with V12 engines and rear-wheel drive." No specific car entity to extract. BM25 won't match "favorite car" → "V12 engines." Semantic similarity is moderate. HyDE is the best path here.

**Mitigation:** This is a genuine limitation. HyDE (Priority 6) partially addresses it. Full resolution would require a preference-aware query expansion system that maps "favorite car" → related automotive attributes. Out of scope for this fix set.

### Edge Case 4: Multi-Turn Preference Expression
Turn 1: "What do you think about sports cars?"
Turn 2 (assistant): "What kind of sports cars interest you?"
Turn 3: "Lamborghini, definitely. The Aventador is incredible."

The preference is in Turn 3, but without context from Turns 1-2, "Lamborghini, definitely" doesn't obviously answer "what is my favorite car?" The chat_turns chunker would capture this as a turn chunk with the full context, which has better semantic match to the query.

**Mitigation:** chat_turns search (via graph walk and semantic search) handles this. The individual message "Lamborghini, definitely" is weak in isolation but strong in its turn chunk context.

### Edge Case 5: Platform Cross-Pollination
User states preference on ChatGPT, asks about it on Claude. Both platforms feed into the same Supabase database, so this should work — but only if sync has completed. Sync debouncing (5s debounce + 30s max-wait) means there's a window where the preference isn't yet in Supabase.

**Mitigation:** This is an existing timing limitation, not affected by these fixes.

### Edge Case 6: Stopword Filtering Removes "favorite"
In `searchSupabaseText()` at `browser-search.js:425`, the stopWords set includes common words but does NOT include "favorite". So "favorite" survives as a keyword. However, "car" is also not a stopword — the ilike search for "car" will return many irrelevant results, diluting the signal.

**Mitigation:** The existing per-keyword ilike search with hit-count scoring handles this. Results matching both "favorite" and "car" score higher than those matching only "car."

---

## 5. Implementation Order & Dependencies

```
Phase 1 (Immediate — blocks all other fixes):
  ├── P1: Question detection in saveMessage()
  ├── P2: Fix classifyContent() question guard
  ├── P3: Deflection storage filter in syncMessages()
  ├── P7: Retroactive data cleanup (tag existing questions + deflections)
  │
  │   Supabase migration:
  │     ALTER TABLE messages ADD COLUMN is_question BOOLEAN DEFAULT FALSE;
  │
  └── P7 cleanup script (runs after migration):
        UPDATE messages SET is_question = true
          WHERE role = 'user'
          AND (content LIKE '%?'
               OR content ~* '^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|tell me|remind me|do you know|do you remember)\s');
        UPDATE messages SET meta = true
          WHERE role = 'assistant'
          AND deflection >= 0.70
          AND (meta IS NULL OR meta = false);

Phase 2 (After Phase 1 validated):
  ├── P4: Entity extraction preference vocabulary (sentiment on edges, stable entity names)
  │   Supabase migration:
  │     ALTER TABLE entity_mentions ADD COLUMN sentiment TEXT
  │       CHECK (sentiment IN ('positive', 'negative', 'neutral'));
  ├── P5: Lower entity embedding threshold (0.8 → 0.6)
  └── P6: Enable HyDE (test in parallel — gate on hallucination validation)

Phase 3 (If HyDE testing fails or needs tuning):
  └── HyDE prompt tuning + reduced RRF weight when Jina unavailable
```

Phase 1 fixes are independent of each other and can be implemented in parallel. The retroactive cleanup script (P7) must run AFTER the `is_question` column migration. Phase 2 requires an edge function deployment + OpenAI key validation for HyDE testing. Phase 3 only activates if HyDE shows hallucination problems during Phase 2 testing.

### Priority 7: Retroactive Data Cleanup (New — Addresses Existing Pollution)

**What:** After deploying Phase 1 code changes, existing polluted data in Supabase still harms retrieval. Hundreds of stored questions and deflections are already in the `messages` table. New queries will surface that old pollution until it's cleaned.

**Why not forward-only:** There is no automatic retention window or TTL on the messages table. The recency multiplier (`background.js:1276-1278`) is only a 15% blend (`0.85 * original + 0.15 * recency_adjusted`), too weak to push old pollution below threshold in a reasonable timeframe. Waiting for self-cleanup is not viable.

**Precedent:** The `cli/src/commands/purge-meta.js` command already implements this pattern — pattern-matching messages and setting `meta: true` to exclude them from retrieval. The meta flag filter at `background.js:1314-1320` already excludes `meta === true` items.

**Implementation — Option A (SQL migration, recommended):**
Run as a one-time Supabase migration after the `is_question` column is added:
```sql
-- Tag existing user questions
UPDATE messages SET is_question = true
WHERE role = 'user'
  AND (
    content LIKE '%?'
    OR content ~* '^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|tell me|remind me|do you know|do you remember)\s'
  );

-- Tag existing high-confidence deflections as meta (excluded from retrieval)
UPDATE messages SET meta = true
WHERE role = 'assistant'
  AND deflection >= 0.70
  AND (meta IS NULL OR meta = false);
```

**Implementation — Option B (CLI command):**
Add `mem purge-questions` CLI command following the `purge-meta.js` pattern. Useful for re-running cleanup after threshold tuning.

**Risk:** The regex-based question tagging may false-positive on statements that happen to end with `?` (e.g., rhetorical questions containing facts). These are edge cases — and the content still exists in chat_turns for graph walk access. The deflection cleanup is safe because it only operates on messages already tagged with `deflection >= 0.70` at ingestion time.

**Impact:** Immediate removal of existing pollution from the retrieval pool. Combined with Phase 1 code changes, both new and old data are clean.

---

## 6. Validation Plan

After implementing all fixes, re-run the original test:

1. Store: "I think Lamborghini is the most amazing car" (on ChatGPT)
2. Wait for sync (>30s)
3. Open new incognito Claude instance
4. Ask: "What is my favorite car?"
5. **Expected:** KYT injects context containing the Lamborghini statement
6. **Acceptance criteria:**
   - The Lamborghini statement appears in injected context
   - The question "what is my favorite car?" does NOT appear in injected context
   - No assistant deflections appear in injected context
   - Confidence score ≥ 0.30 (low-confidence tier is acceptable for vocabulary-gap queries)

Additional test cases:
- "What kind of car do I like?" (paraphrase — tests semantic breadth)
- "Tell me about my vehicle preferences" (synonym — tests vocabulary gap)
- "Do I like Ferraris?" (negative test — should NOT return Lamborghini as evidence of Ferrari preference)
- "What's my favorite food?" (negative test — should return empty, not Lamborghini)

---

## 7. Self-Assessment

**Confidence: 97%** on the diagnosis. The 3% uncertainty is:
- I haven't run the actual queries against the production Supabase instance to verify entity extraction output. The entity extraction behavior is inferred from the prompt and code, not observed.
- HyDE effectiveness is theoretical — it depends on GPT-4o-mini generating a useful hypothetical document for preference queries specifically. It may require prompt tuning. Hallucination risk is real and must be validated during Phase 2 testing.

**Revisions from senior review (2026-02-18):**
- **Priority 4 corrected:** Sentiment is now stored on entity_mentions edges, not baked into canonical names. This preserves entity identity stability and lets recency resolution operate on evolving sentiment through the entity timeline guarantee.
- **HyDE promoted:** Testing moved from Phase 3 to Phase 2 (parallel with entity fixes). It's the only direct vocabulary bridge. Gated on hallucination validation.
- **Retroactive cleanup added (Priority 7):** One-time migration to tag existing questions and deflections in Supabase. Without this, old polluted data undermines all forward-looking code fixes.

**What this plan does NOT address:**
- The broader "implicit preference" problem (preferences expressed through behavior patterns, not explicit statements)
- Multi-hop reasoning ("I love V12 engines" + "Lamborghini uses V12 engines" → "I probably like Lamborghini")
- Preference evolution over time beyond what recency resolution + entity-timeline guarantee handles
- Real-time preference extraction from conversation flow (vs. post-hoc entity extraction)

These are legitimate future improvements but are architecturally distinct from the immediate failures exposed by the test.

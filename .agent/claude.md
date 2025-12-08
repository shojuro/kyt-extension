# BM25 Server-Side Search Feature

**Branch:** `feature/bm25-server`
**Created:** 2025-12-08
**Status:** Phase 1 - Writing Test Specifications

## Feature Summary

Add PostgreSQL full-text search (BM25 approximation via `ts_rank_cd`) as a parallel retrieval path to existing vector search, preserving gravity-weighted ranking for emotional memory prioritization.

## Problem Statement

Current vector-only search misses exact keyword matches in historical memories. Example: Query "Kobe Bryant" fails to find a 6-month-old message mentioning "Kobe Bryant" because semantic similarity decays or embeddings don't capture proper nouns well.

## Architecture Decision

**Option A: BM25 for Recall, Gravity for Ranking**

```
Query → PARALLEL {
  Vector+Gravity (50 candidates) ─┐
  BM25 Keyword (50 candidates) ───┼─→ MERGE → gravity × (1 + bm25_boost) → Top 10
                                  └─→ Dedupe by message_id
}
```

## Key Constraints

1. **Gravity MUST dominate** - High-intimacy memories must rank above trivial keyword matches
2. **Server-side only** - No BM25/tsvector code in client-side JavaScript
3. **Graceful degradation** - BM25 failure must not break vector search
4. **Performance** - Search latency must remain <500ms

## Critical Files

| File | Action | Phase |
|------|--------|-------|
| `tests/specs/bm25-search.spec.js` | CREATE | 1 |
| `tests/integration/architectural-validation.test.js` | CREATE | 1 |
| `supabase/migrations/20251209000000_add_bm25_tsvector.sql` | CREATE | 2 |
| `supabase/migrations/20251209000001_bm25_search_function.sql` | CREATE | 2 |
| `supabase/functions/_shared/get_relevant_memories.ts` | MODIFY | 2 |

## TDD Workflow

1. **Phase 1:** Write ALL tests before implementation (current)
2. **Phase 2:** Implement to make tests pass
3. **Phase 3:** Validation and architectural compliance
4. **Phase 4:** Deployment

## Test Specifications

### Functional Tests (tests/specs/bm25-search.spec.js)
- Test 1: BM25 finds exact keyword match ("Kobe Bryant")
- Test 2: Gravity dominates BM25 for Lonelies (high-intimacy outranks trivial)
- Test 3: Graceful degradation (search works if BM25 fails)
- Test 4: Performance <500ms

### Architectural Tests (tests/integration/architectural-validation.test.js)
- Test 5: Server-side only (no tsvector/ts_rank in client code)
- Test 6: Gravity formula unchanged

## Dependencies

- `calculate_gravity_score` function (existing, unchanged)
- `match_messages_with_gravity` RPC (existing, unchanged)
- `get_relevant_memories.ts` Edge Function (modified for merge)
- PostgreSQL full-text search (GIN index + tsvector)

## Success Criteria

All 6 tests pass with no modifications to test specifications after Phase 1.

# BM25 Server-Side Search - Progress Log

## Session: 2025-12-08

### Phase 0: Spec Approval
- [x] Created feature spec with Option A architecture
- [x] Leadership approved TDD-compliant plan
- [x] Moved from plan mode to execution

### Phase 1: Test Specifications (Current)

#### Task 1.1: Create Test Harness
- [x] Created worktree at `/home/penguinzyue/feature-bm25-server`
- [x] Branch: `feature/bm25-server`
- [x] Created `tests/specs/` directory
- [x] Created `tests/integration/` directory
- [x] Created `.agent/claude.md` - feature context
- [x] Created `.agent/features.json` - acceptance criteria
- [x] Created `.agent/progress.md` - this file

#### Task 1.2: Write Test Files
- [x] `tests/specs/bm25-search.spec.js` (Tests 1-4)
- [x] `tests/integration/architectural-validation.test.js` (Tests 5-6)

#### Task 1.3: Verify Tests Fail
- [x] Run `npm test` - Results:
  - **Tests 1-4 FAIL** (expected - `match_messages_with_bm25` doesn't exist)
  - **Tests 5-6 PASS** (expected - architectural guards, no violations yet)

#### Task 1.4: Leadership Review
- [x] Tests reviewed and approved before Phase 2
- [x] Test 2 independently verified: intimacy dominance assertion correct
- [x] Leadership approval: CLEARED FOR PHASE 2 (2025-12-08)

---

## Phase 2: Implementation (IN PROGRESS)

**Status:** SQL migrations COMPLETE, Edge Function NEXT

**Phase 2 Tasks:**
1. [x] Create SQL migration: `20251209000000_add_bm25_tsvector.sql`
   - content_tsvector column added to chat_turns
   - GIN index created for fast FTS queries
   - Auto-update trigger installed
   - Backfill script for existing rows
2. [x] Create RPC function: `20251209000001_bm25_search_function.sql`
   - match_messages_with_bm25() implemented
   - Uses ts_rank_cd with flag 32 (BM25 approximation)
   - Returns gravity_score + bm25_score for merge
   - Input validation and error handling included
3. [ ] Modify Edge Function: `get_relevant_memories.ts`
4. [ ] Run tests until ALL 6 pass

**Rules:**
- NO test modifications allowed
- Tests 5-6 MUST remain GREEN (architectural guards)
- Gravity formula MUST remain unchanged
- All BM25 code server-side only

---

## Test Results Summary (2025-12-08)

```
Test Files  1 failed | 1 passed (2)
Tests       4 failed | 11 passed | 1 skipped (16)
```

### Feature Tests (Expected FAIL - no implementation)
| Test | Status | Failure Reason |
|------|--------|----------------|
| BM25 finds "Kobe Bryant" | FAIL | Function `match_messages_with_bm25` not found |
| High-intimacy outranks trivial | FAIL | Function `match_messages_with_bm25` not found |
| Search works if BM25 fails | FAIL | Function `match_messages_with_bm25` not found |
| Search latency <500ms | FAIL | Function `match_messages_with_bm25` not found |

### Architectural Guards (Expected PASS - regression protection)
| Test | Status | Purpose |
|------|--------|---------|
| No PostgreSQL FTS in client | PASS | Prevents tsvector/ts_rank leaking to browser |
| Gravity formula unchanged | PASS | Protects gravity from BM25 corruption |

---

## Notes

### Key Design Decisions
1. Using `ts_rank_cd` as BM25 approximation (75% accuracy, simpler)
2. Parallel search: vector+gravity AND BM25 run concurrently
3. Final score: `gravity × (1 + bm25_boost)` - gravity dominates
4. Graceful degradation: BM25 failure → vector-only still works

### Files to Create in Phase 2
- `supabase/migrations/20251209000000_add_bm25_tsvector.sql`
- `supabase/migrations/20251209000001_bm25_search_function.sql`

### Files to Modify in Phase 2
- `supabase/functions/_shared/get_relevant_memories.ts`

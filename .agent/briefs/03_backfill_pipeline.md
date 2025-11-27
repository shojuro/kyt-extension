# Brief: Conversation Backfill Pipeline (Worktree 3)

**Branch:** `feature/backfill-pipeline`
**Goal:** Backfill entity extraction for existing conversations using GPT-4o-mini.

## Objectives
1.  **Backfill Function**: Create `supabase/functions/backfill_conversations/index.ts`.
2.  **Batch Processing**: Process 50 conversations per batch.
3.  **Reliability**: Rate limiting (60 req/min), progress tracking, resumability.

## Constraints
*   **Model**: GPT-4o-mini for extraction.
*   **State**: Track progress in `backfill_progress` table.

## Tasks
- [ ] Create `backfill_progress` table (conversation_id, status, error, last_updated).
- [ ] Implement `backfill_conversations` Edge Function.
- [ ] Logic:
    1.  Fetch batch of unproccessed conversations.
    2.  Run entity extraction (parallelized with rate limit).
    3.  Update `entity_mentions` table.
    4.  Update `backfill_progress`.
- [ ] Add "Dry Run" mode.
- [ ] Prepare for re-embedding swap (placeholder for HF embedding).

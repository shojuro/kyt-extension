# Brief: Production Hardening (Worktree 4)

**Branch:** `feature/production-hardening`
**Goal:** Improve error handling, retry logic, and observability for the production stack.

## Objectives
1.  **Reliability**: Add exponential backoff retries to Edge Functions.
2.  **Observability**: Implement cost monitoring and structured logging.
3.  **Safety**: Graceful degradation.

## Tasks
- [ ] Review existing Edge Functions (`save_chat_turn`, `search`, etc.).
- [ ] Add `retryWrapper` utility:
    - Max 3 retries.
    - Backoff: 1s, 2s, 4s.
- [ ] Implement `CostMonitor` utility:
    - Track token usage/API calls.
    - Alert if daily cost > threshold ($10/$25/$50).
- [ ] Improve Logging:
    - Use structured JSON logs.
    - Add `request_id` tracing across function calls.
- [ ] Document common failure modes and recovery steps.

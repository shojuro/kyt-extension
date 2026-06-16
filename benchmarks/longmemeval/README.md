# LongMemEval × KYT harness

Benchmarks KYT's retrieval pipeline on **LongMemEval V1** (`longmemeval_s` / `_m`,
cleaned release). KYT is the *retriever*; LongMemEval's own GPT-4o judge scores the
answers, so the number is comparable to the published leaderboard.

## How it works

```
dataset.json ──adapter──▶ save_chat_turn_batch (fast bulk, null embeddings)
                          backfill_embeddings (until none null)
             ──query────▶ search_memories (FULL pipeline, fast=false)
             ──answer───▶ answer model reads retrieved memories → hypothesis
             ──judge────▶ LongMemEval evaluate_qa.py (GPT-4o) → accuracy by type
```

Design decisions (see `kyt_lme/adapter.py` for the grounding):
- **Per-instance isolation** — each instance → its own synthetic `user_id`
  (`uuid5(question_id)`); `chat_turns` has no FK on `user_id` and every RPC scopes
  by it, so instances can't leak into each other.
- **Upsert-safe timestamps** — the upsert key is
  `(user_id, conversation_id, platform, start_timestamp)`; each turn gets a distinct,
  ordered timestamp so none collapse.
- **Temporal normalization** — each instance is shifted so its latest turn ≈ *now*,
  keeping every timestamp past KYT's 2022-11-30 floor and making the recency boost
  meaningful. Relative order/intervals are preserved.
- **Embeddings-only first baseline** — entities (graph walk) are a later pass; they
  need real `auth.users` rows + a Haiku 4.5 entity backfill.

## Prerequisites

1. **Dedicated benchmark Supabase project** (keeps ~247k `_s` rows + HNSW out of prod).
2. `pip install -r requirements.txt`
3. `cp .env.example .env` and fill in the **dedicated project** URL + keys, an
   `OPENAI_API_KEY` (answer + judge), and `LONGMEMEVAL_REPO` (a clone of
   https://github.com/xiaowu0162/longmemeval for the scorer).

## Stand up the dedicated project (structure now; run Saturday)

The current `feature/projects-vault` branch already contains the two safe fixes
(additive recency in `quality-penalties.ts`; `20260616000000_supersession_filter_entity_rpcs.sql`),
so deploying the branch to the new project gives the fixed pipeline by construction.

1. Create the project (Supabase dashboard or MCP `create_project`).
2. Push schema:  `supabase link --project-ref <new-ref>` then `supabase db push`
   (applies every migration, including the supersession filter).
3. Deploy functions: `supabase functions deploy save_chat_turn_batch backfill_embeddings search_memories`
   (and `backfill_entities` only if/when running the entity pass).
4. Set function secrets on the new project: `ANTHROPIC_API_KEY`, `HUGGINGFACE_API_KEY`
   (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically).

## Run sequence

```bash
# 0. no-API sanity (works now, no secrets)
python3 runner.py dry --dataset "/path/longmemeval_s_cleaned.json" --limit 5

# 1. smoke: 5 instances end-to-end, confirm a sensible accuracy before scaling
python3 runner.py all     --dataset "/path/longmemeval_s_cleaned.json" --limit 5
python3 "$LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py" gpt-4o out/hypotheses.jsonl "/path/longmemeval_s_cleaned.json"

# 2. full run (resumable — re-run any phase to continue)
python3 runner.py ingest   --dataset "/path/longmemeval_s_cleaned.json"
python3 runner.py backfill  --dataset "/path/longmemeval_s_cleaned.json"   # the long pole (hours)
python3 runner.py query     --dataset "/path/longmemeval_s_cleaned.json"

# 3. score (official judge) + per-type breakdown
python3 "$LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py" gpt-4o out/hypotheses.jsonl "/path/longmemeval_s_cleaned.json"
python3 "$LONGMEMEVAL_REPO/src/evaluation/print_qa_metrics.py" gpt-4o out/hypotheses.jsonl "/path/longmemeval_s_cleaned.json"

# 4. cleanup (if you ever run against a shared project)
python3 runner.py cleanup  --dataset "/path/longmemeval_s_cleaned.json"
```

State lives in `state/` (resumable; `now_ms` is pinned there so resumed ingest stays
idempotent). Hypotheses accumulate in `out/hypotheses.jsonl`.

## Notes / deferred
- **`_m` (2.7 GB, ~10× turns)** needs the Phase-3 embedding fallback provider first
  (single-provider throughput + outage risk over a multi-day run).
- **Entity pass** (multi-session graph walk): create `auth.users` per instance, run
  `backfill_entities` (Haiku 4.5), then re-query — a second baseline to measure the lift.

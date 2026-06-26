# LongMemEval run — operational runbook (first session)

Goal of session 1: stand up the dedicated benchmark project, deploy the (fixed)
pipeline, get a **green 5-instance smoke + score**, then kick off the full `_s`
ingest/backfill to run unattended. Full scoring happens after backfill finishes.

## Have ready before we start (otherwise the window is lost to setup)
- [ ] **Dedicated Supabase project** — who creates it (me via MCP w/ cost confirm, or you in the dashboard → give me ref + keys).
- [ ] **Keys**: `ANTHROPIC_API_KEY`, `HUGGINGFACE_API_KEY` (the edge functions — same providers as prod), `OPENAI_API_KEY` (answer-gen + judge).
- [ ] **Supabase CLI logged in**: `! supabase login` (interactive).
- [ ] **Answer-gen model** confirmed (default `gpt-4o`).
- [ ] Data paths (already have): `…/longmemeval_s_cleaned.json`.

---

## Phase 0 — Dedicated project  ✅ DONE
Created via Supabase MCP:
- name `kyt-benchmark` · ref **`lphelmfyssilofjknnqf`** · region `us-east-1` · org KYT Memory ($10/mo)
- URL `https://lphelmfyssilofjknnqf.supabase.co`
- First live step: confirm status is ACTIVE_HEALTHY (`get_project lphelmfyssilofjknnqf`).

## Phase 1 — Deploy the (fixed) pipeline  (~15–25 min)
Branch `feature/projects-vault` already carries both fixes, so deploying it = fixed pipeline.
```
supabase login                                          # interactive: run as  ! supabase login
supabase link --project-ref lphelmfyssilofjknnqf        # needs the new project's DB password
                                                        #   (set/reset in dashboard → Settings → Database)
supabase db push                       # applies ALL migrations incl. 20260616000000 supersession
#   ^ WATCH the output: a fresh DB is the clean case, but if any migration assumes
#     seeded data, stop and fix before continuing.
supabase secrets set ANTHROPIC_API_KEY=*** HUGGINGFACE_API_KEY=*** --project-ref lphelmfyssilofjknnqf
supabase functions deploy save_chat_turn_batch backfill_embeddings search_memories --project-ref lphelmfyssilofjknnqf
```
Verify (gate): a curl to search_memories returns 200 (service key) / 401 (no auth).
(Alt: I can apply migrations + deploy functions via the Supabase MCP if CLI login is a
hassle — then only the two function secrets need the dashboard.)

## Phase 2 — Configure harness  (~10 min)
```
cd benchmarks/longmemeval
pip install -r requirements.txt
cp .env.example .env       # fill BENCH_SUPABASE_URL/SERVICE/ANON (new project → Settings→API),
                           # OPENAI_API_KEY, LONGMEMEVAL_REPO
git clone https://github.com/xiaowu0162/longmemeval "$HOME/longmemeval"
pip install -r "$HOME/longmemeval/requirements.txt"   # judge deps
```

## Phase 3 — Smoke + GATE  (~10–15 min)   ← the decision point
```
python3 runner.py dry  --dataset "<_s path>" --limit 5      # no API, instant
python3 runner.py all  --dataset "<_s path>" --limit 5      # ingest→backfill→query 5
python3 runner.py status --dataset "<_s path>"              # expect 0 null embeddings
python3 "$LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py" gpt-4o out/hypotheses.jsonl "<_s path>"
```
**GATE — do NOT scale until:** all 5 ingested (200s), 0 null embeddings, search returns
non-empty results, judge runs, and the 5 answers look sane. If retrieval is empty or
the judge errors, stop and debug here (cheap) — not at 500.

## Phase 4–6 — Full `_s` run  (ingest min; backfill = HOURS; query ~1–2h)
```
python3 runner.py ingest   --dataset "<_s path>"     # ~247k turns, fast bulk (~15–30 min)
python3 runner.py backfill --dataset "<_s path>"     # LONG POLE — run unattended; resumable
python3 runner.py query    --dataset "<_s path>"     # 500 × full pipeline + answer-gen
```
All phases are resumable (state/); re-run any phase to continue after an interruption.

## Phase 7 — Score + read results
```
python3 "$LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py"   gpt-4o out/hypotheses.jsonl "<_s path>"
python3 "$LONGMEMEVAL_REPO/src/evaluation/print_qa_metrics.py" gpt-4o out/hypotheses.jsonl "<_s path>"
```
Read the per-`question_type` breakdown — that's the multi-session / temporal /
knowledge-update / abstention scorecard we've been targeting.

## Realistic outcome for a 2-hour window
Phases 0–3 (stand up + smoke + green gate) + **start** the full ingest/backfill.
Backfill embeddings is the multi-hour long pole, so the full `_s` number lands later
(after it finishes, unattended) — not inside the 2 hours.

## Watch-outs
- **Embedding throughput** (single Scaleway provider) governs wall-clock, not my code.
- Don't pass `fast:true` anywhere — the runner doesn't; that keeps the full pipeline on.
- `_m` and the entity (graph-walk) pass are explicitly later — not this session.

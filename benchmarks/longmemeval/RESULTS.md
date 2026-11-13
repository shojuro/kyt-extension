# LongMemEval-S results ledger

Tracked record of scored runs. The raw files live in `out/` (gitignored); every number below was
recomputed from those files on 2026-11-13 by counting `autoeval_label.label == true`.
All runs use the full retrieval path (`fast:false`) against the dedicated benchmark project.
The extension's default fast path has **not** been benchmarked yet.

## Full runs (500 questions)

| Date | Run | Reader | Judge | Correct | Score | Source file |
|---|---|---|---|---|---|---|
| 2026-07-02 | Baseline | gpt-4o | gpt-4o-2024-08-06 | 205 | 0.410 | `eval_baseline_0.41.jsonl` |
| 2026-07-02 | Keyword pool, ungated (reverted) | gpt-4o | gpt-4o-2024-08-06 | 209 | 0.418 | `eval_keywordpool.jsonl` |
| 2026-07-02 | Track 1: precision-gated keyword pool | gpt-4o | gpt-4o-2024-08-06 | 265 | 0.530 | `eval_precision_full_clean.jsonl` |
| 2026-07-03 | Track 1 + Track 2 (date-aware reader) | gpt-4o | gpt-4o-2024-08-06 | 287 | 0.574 | `eval_t1t2_full.jsonl` |
| 2026-07-03 | R0: same pipeline, stronger reader | gpt-4.1 | gpt-4o-2024-08-06 | 314 | 0.628 | `eval_r0_gpt41.jsonl` |
| 2026-07-03 | R0 re-judged | gpt-4.1 | gpt-4.1 | 313 | 0.626 | `hyp_r0_for41judge.jsonl.eval-results-gpt-4.1` |
| 2026-07-03 | R1a: keyword fusion | gpt-4.1 | gpt-4o-2024-08-06 | 312 | 0.624 | `eval_r1a_gpt41.jsonl` |
| 2026-07-03 | Reader swap | gpt-5-mini | gpt-4o-2024-08-06 | 313 | 0.626 | `eval_gpt5mini.jsonl` |

## Partial runs

| Date | Run | Questions | Correct | Score | Source file |
|---|---|---|---|---|---|
| 2026-07-02 | Track 1 A/B subset | 277 | 149 | 0.538 | `eval_track1.jsonl` |
| 2026-07-02 | Track 2 temporal subset | 133 | 68 | 0.511 | `eval_track2.jsonl` |
| 2026-07-03 | R1b entity signal, 60 hardest | 60 | 10 | 0.167 | `eval_r1b.jsonl` |

## Reading the numbers

- 0.410 to 0.574 is KYT's own gain (retrieval plus date-aware reading), with reader and judge held fixed.
- 0.574 to about 0.626 comes from swapping the reader model, not from KYT. Do not quote it as a retrieval gain.
- R1a (keyword fusion) and R1b (entity signal) did not move the score; see commit `1c3a4a1`.

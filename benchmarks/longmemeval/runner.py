"""LongMemEval x KYT runner.

Phases (each resumable via state/):
  ingest    fast bulk-upsert every instance's haystack (skip_ai_processing=True)
  backfill  drive backfill_embeddings until no null embeddings remain
  query     retrieve (full pipeline) -> answer-gen -> out/hypotheses.jsonl
  all       ingest -> backfill -> query
  status    print null-embedding + row counts (dedicated project)
  cleanup   delete every synthetic benchmark user_id from the dataset

Then score with LongMemEval's official judge (see README):
  python $LONGMEMEVAL_REPO/src/evaluation/evaluate_qa.py gpt-4o \
         out/hypotheses.jsonl <dataset.json>

--dry builds payloads for --limit instances and prints the plan WITHOUT any API
call or secret (runnable now). All model-API phases require benchmarks/longmemeval/.env.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from kyt_lme.loader import iter_instances
from kyt_lme.adapter import instance_to_payloads, make_user_id

HERE = Path(__file__).resolve().parent
STATE = HERE / "state"
OUT = HERE / "out"


# ---- small JSON state helpers --------------------------------------------
def _read_json(p, default):
    return json.loads(p.read_text()) if p.exists() else default


def _write_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj))


def pinned_now_ms():
    """Pin the reference 'now' for the whole run so resumed ingest stays idempotent
    (the upsert key includes start_timestamp; a drifting now would create dupes)."""
    p = STATE / "run_meta.json"
    meta = _read_json(p, {})
    if "now_ms" not in meta:
        meta["now_ms"] = int(time.time() * 1000)
        _write_json(p, meta)
    return meta["now_ms"]


def _done_set(phase):
    return set(_read_json(STATE / f"{phase}_done.json", []))


def _mark_done(phase, qid, done):
    done.add(qid)
    _write_json(STATE / f"{phase}_done.json", sorted(done))


# ---- phases ---------------------------------------------------------------
def phase_ingest(client, dataset, now_ms, limit):
    done = _done_set("ingest")
    n = 0
    for inst in iter_instances(dataset):
        if limit and n >= limit:
            break
        n += 1
        qid = inst["question_id"]
        if qid in done:
            continue
        p = instance_to_payloads(inst, now_ms)
        ok = True
        for b in p["ingest_batches"]:
            status, body = client.save_batch(b)
            if status != 200:
                print(f"  ingest FAIL {qid}: {status} {str(body)[:160]}")
                ok = False
                break
        if ok:
            _mark_done("ingest", qid, done)
            print(f"  ingested {qid}  ({p['meta']['n_turns']} turns)")
    print(f"ingest: {len(done)} instances complete")


def phase_backfill(client, max_loops=2000):
    loops = 0
    while loops < max_loops:
        remaining = client.count_null_embeddings()
        if remaining == 0:
            print("backfill: 0 null embeddings remaining — done")
            return
        status, body = client.backfill_embeddings_once()
        processed = (body or {}).get("processed") or (body or {}).get("backfilled") or 0
        print(f"  backfill loop {loops}: ~{remaining} null remaining, processed {processed} (status {status})")
        if status != 200 and processed == 0:
            print("  backfill stalled (provider error?) — retrying after pause")
            time.sleep(15)
        loops += 1
    print("backfill: hit max_loops cap")


def phase_query(client, dataset, now_ms, answer_model, openai_key, limit, topk):
    from kyt_lme import answergen
    done = _done_set("query")
    OUT.mkdir(parents=True, exist_ok=True)
    hyp_path = OUT / "hypotheses.jsonl"
    n = 0
    with hyp_path.open("a", encoding="utf-8") as fout:
        for inst in iter_instances(dataset):
            if limit and n >= limit:
                break
            n += 1
            qid = inst["question_id"]
            if qid in done:
                continue
            p = instance_to_payloads(inst, now_ms)
            body = dict(p["query"]); body["topK"] = topk
            status, res = client.search(body)
            items = (res or {}).get("results", []) if status == 200 else []
            if status != 200:
                print(f"  query FAIL {qid}: {status} {str(res)[:160]}")
                continue
            hyp = answergen.generate(inst["question"], items, answer_model, openai_key)
            fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n")
            fout.flush()
            _mark_done("query", qid, done)
            print(f"  answered {qid}  ({len(items)} memories -> {hyp[:60]!r})")
    print(f"query: {len(done)} hypotheses in {hyp_path}")


def phase_status(client):
    print("null embeddings remaining:", client.count_null_embeddings())


def phase_cleanup(dataset, client, limit):
    n = 0
    deleted = 0
    for inst in iter_instances(dataset):
        if limit and n >= limit:
            break
        n += 1
        code = client.delete_user(make_user_id(inst["question_id"]))
        if code in (200, 204):
            deleted += 1
    print(f"cleanup: deleted rows for {deleted} synthetic users")


def phase_dry(dataset, now_ms, limit):
    """No API, no secrets. Proves the plan for --limit instances."""
    import itertools
    total_turns = total_batches = 0
    for inst in itertools.islice(iter_instances(dataset), limit or 3):
        p = instance_to_payloads(inst, now_ms)
        m = p["meta"]
        total_turns += m["n_turns"]; total_batches += len(p["ingest_batches"])
        print(f"  {m['question_id']:>10} [{m['question_type']}"
              f"{'/ABS' if m['is_abstention'] else ''}]  user={p['user_id'][:8]}…  "
              f"{m['n_sessions']}s/{m['n_turns']}t -> {len(p['ingest_batches'])} batches")
    print(f"DRY: {total_turns} turns / {total_batches} ingest calls for "
          f"{limit or 3} instances. No API calls made.")


# ---- CLI ------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="LongMemEval x KYT runner")
    ap.add_argument("phase", choices=["ingest", "backfill", "query", "all", "status", "cleanup", "dry"])
    ap.add_argument("--dataset", required=True, help="path to longmemeval_*_cleaned.json")
    ap.add_argument("--limit", type=int, default=0, help="cap instances (0 = all)")
    ap.add_argument("--topk", type=int, default=20)
    args = ap.parse_args()

    if not Path(args.dataset).exists():
        sys.exit(f"dataset not found: {args.dataset}")

    now_ms = pinned_now_ms()

    if args.phase == "dry":
        return phase_dry(args.dataset, now_ms, args.limit)

    # API phases: build client now (validates dedicated-project secrets).
    from kyt_lme import config
    url, service_key, anon_key = config.supabase()
    from kyt_lme.kyt_client import KytClient
    client = KytClient(url, service_key, anon_key)

    if args.phase == "status":
        return phase_status(client)
    if args.phase == "cleanup":
        return phase_cleanup(args.dataset, client, args.limit)
    if args.phase in ("ingest", "all"):
        phase_ingest(client, args.dataset, now_ms, args.limit)
    if args.phase in ("backfill", "all"):
        phase_backfill(client)
    if args.phase in ("query", "all"):
        phase_query(client, args.dataset, now_ms, config.answer_model(),
                    config.openai_key(), args.limit, args.topk)


if __name__ == "__main__":
    main()

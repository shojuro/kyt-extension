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
def phase_ingest(client, dataset, now_ms, limit, workers=8):
    """Ingest instances in parallel (distinct user_ids → no upsert conflicts).
    Each instance: bulk-upsert its batches, then clear is_question/deflection so
    fact-bearing turns that also contain a question aren't excluded by the gravity
    RPC (see README)."""
    from concurrent.futures import ThreadPoolExecutor
    import threading, itertools
    done = _done_set("ingest")
    src = itertools.islice(iter_instances(dataset), limit) if limit else iter_instances(dataset)
    pending = [inst for inst in src if inst["question_id"] not in done]
    lock = threading.Lock()

    def ingest_one(inst):
        qid = inst["question_id"]
        p = instance_to_payloads(inst, now_ms)
        for b in p["ingest_batches"]:
            status, body = client.save_batch(b)
            if status != 200:
                return qid, False, f"{status} {str(body)[:120]}"
        client.clear_retrieval_filters(p["user_id"])
        return qid, True, p["meta"]["n_turns"]

    ok = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, (qid, success, info) in enumerate(ex.map(ingest_one, pending), 1):
            if success:
                with lock:
                    _mark_done("ingest", qid, done)
                ok += 1
            else:
                print(f"  ingest FAIL {qid}: {info}")
            if i % 25 == 0 or i == len(pending):
                print(f"  ingest: {i}/{len(pending)} done ({ok} ok)")
    print(f"ingest: {len(done)} instances complete")


def phase_backfill(client, dataset, now_ms, limit, workers=8):
    """Embed each instance's user in parallel. The per-user filter means concurrent
    calls don't overlap on the global null-queue, turning a multi-hour serial
    backfill into minutes. Each user (~500 turns) is one quick, sub-timeout call."""
    from concurrent.futures import ThreadPoolExecutor
    from kyt_lme.adapter import make_user_id
    import itertools
    src = itertools.islice(iter_instances(dataset), limit) if limit else iter_instances(dataset)
    uids = [make_user_id(inst["question_id"]) for inst in src]

    def backfill_user(uid):
        for _ in range(30):
            if client.count_null_embeddings(uid) == 0:
                return True
            client.backfill_embeddings_once(uid)
        return client.count_null_embeddings(uid) == 0

    ok = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, done_ok in enumerate(ex.map(backfill_user, uids), 1):
            ok += 1 if done_ok else 0
            if i % 25 == 0 or i == len(uids):
                print(f"  backfill: {i}/{len(uids)} users ({ok} fully embedded)")
    print(f"backfill: {ok}/{len(uids)} users fully embedded")


def phase_query(client, dataset, now_ms, answer_model, openai_key, limit, topk, workers=3):
    """Retrieve + answer-gen in parallel; append hypotheses + checkpoint per result.
    Lower default concurrency (3) + patient answergen backoff so the OpenAI answer-gen
    doesn't get rate-limited into false 'I don't know'. An answergen failure leaves the
    instance UNMARKED (retried on the next run), never writes a corrupt abstention."""
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from kyt_lme import answergen
    done = _done_set("query")
    OUT.mkdir(parents=True, exist_ok=True)
    hyp_path = OUT / "hypotheses.jsonl"

    pending, n = [], 0
    for inst in iter_instances(dataset):
        if limit and n >= limit:
            break
        n += 1
        if inst["question_id"] not in done:
            pending.append(inst)

    lock = threading.Lock()
    # Reference 'today' for the date-aware temporal reader: the adapter anchors each
    # instance's latest turn to now-7d, so 'ago' must be measured from there.
    import datetime
    _ref_iso = datetime.datetime.utcfromtimestamp((now_ms - 7 * 86400_000) / 1000).strftime("%Y-%m-%d (%a)")

    def do_query(inst):
        qid = inst["question_id"]
        q = inst["question"]
        body = dict(instance_to_payloads(inst, now_ms)["query"]); body["topK"] = topk
        status, res = client.search(body)
        if status != 200:
            return qid, None, "search"
        items = (res or {}).get("results", [])
        try:
            if answergen.is_temporal(q):   # date-aware reader for temporal questions
                return qid, answergen.generate_temporal(q, items, answer_model, openai_key, _ref_iso), None
            return qid, answergen.generate(q, items, answer_model, openai_key), None
        except Exception as e:   # answergen exhausted retries — skip, retry next run
            return qid, None, f"answergen:{str(e)[:60]}"

    cnt, fails = 0, 0
    with hyp_path.open("a", encoding="utf-8") as fout, ThreadPoolExecutor(max_workers=workers) as ex:
        for qid, hyp, err in ex.map(do_query, pending):
            cnt += 1
            if hyp is None:
                fails += 1
                if cnt % 25 == 0:
                    print(f"  query: {cnt}/{len(pending)} ({fails} skipped, last err: {err})")
                continue
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n")
                fout.flush()
                _mark_done("query", qid, done)
            if cnt % 25 == 0 or cnt == len(pending):
                print(f"  query: {cnt}/{len(pending)} processed ({fails} skipped)")
    print(f"query: {len(done)} hypotheses total in {hyp_path}  ({fails} skipped this run — rerun to fill)")


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
        phase_backfill(client, args.dataset, now_ms, args.limit)
    if args.phase in ("query", "all"):
        phase_query(client, args.dataset, now_ms, config.answer_model(),
                    config.openai_key(), args.limit, args.topk)


if __name__ == "__main__":
    main()

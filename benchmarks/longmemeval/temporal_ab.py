"""A1 validation: temporal query-rewrite A/B.

For each failed temporal-reasoning instance, retrieve with the ORIGINAL question and
with the NORMALIZED (framing-stripped) question, and compare recall of the has_answer
evidence turns. Also emit a normalized-retrieval hypothesis for the official judge.

Recall proxy: an evidence turn counts as retrieved if a retrieved item's content shares
>45% of the evidence turn's words. Reports both "any evidence" and "all evidence"
(the latter matters for DURATION, which needs both events).

Usage: python3 -u temporal_ab.py [limit]
Outputs: out/hypotheses_temporal_ab.jsonl, out/ref_temporal_ab.json, prints recall table.
"""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config, answergen
from kyt_lme.adapter import make_user_id
from kyt_lme.temporal import normalize_temporal_query
from kyt_lme.kyt_client import KytClient

URL, SVC, ANON = config.supabase()
client = KytClient(URL, SVC, ANON)
AM, OK = config.answer_model(), config.openai_key()
TOPK = 20
WORKERS = 6


def load_failures():
    labels = {}
    with open("out/hypotheses.jsonl.eval-results-gpt-4o") as f:
        for line in f:
            d = json.loads(line)
            al = d.get("autoeval_label")
            labels[d["question_id"]] = (al.get("label") if isinstance(al, dict) else al) in (True, "true")
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    return [qid for qid, r in ref.items()
            if r["question_type"] == "temporal-reasoning"
            and not qid.endswith("_abs") and not labels.get(qid, False)], ref


def evidence_turns(inst):
    return [t.get("content", "") for ses in inst["haystack_sessions"]
            for t in ses if isinstance(t, dict) and t.get("has_answer")]


def recall(evid, items):
    texts = [(it.get("contextual_content") or it.get("content") or "") for it in items]
    hits = 0
    for e in evid:
        ew = set(e.lower().split())
        if ew and any(len(ew & set(t.lower().split())) / len(ew) > 0.45 for t in texts):
            hits += 1
    return hits, len(evid)


def search(q, uid):
    status, res = client.search({"query": q, "userId": uid, "topK": TOPK})
    return (res or {}).get("results", []) if status == 200 else []


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    # We need the full instances (haystack) — read from the dataset file.
    from kyt_lme.loader import iter_instances
    ds = sys.argv[2] if len(sys.argv) > 2 else \
        "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"
    fail_ids, ref = load_failures()
    fail_set = set(fail_ids[:limit] if limit else fail_ids)
    insts = [x for x in iter_instances(ds) if x["question_id"] in fail_set]
    print(f"failed temporal instances: {len(insts)}", flush=True)

    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_temporal_ab.json", "w"))

    lock = threading.Lock()
    stats = {"any_before": 0, "any_after": 0, "all_before": 0, "all_after": 0, "n": 0}

    def work(inst):
        qid = inst["question_id"]
        uid = make_user_id(qid)
        evid = evidence_turns(inst)
        orig = inst["question"]
        norm = normalize_temporal_query(orig)
        items_b = search(orig, uid)
        items_a = search(norm, uid)
        hb, ne = recall(evid, items_b)
        ha, _ = recall(evid, items_a)
        # hypothesis from the normalized retrieval (answer prompt keeps ORIGINAL question)
        hyp = answergen.generate(orig, items_a, AM, OK)
        return qid, ne, hb, ha, hyp

    with open("out/hypotheses_temporal_ab.jsonl", "w") as fout, \
            ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for qid, ne, hb, ha, hyp in ex.map(work, insts):
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n")
                fout.flush()
                stats["n"] += 1
                if ne:
                    stats["any_before"] += 1 if hb > 0 else 0
                    stats["any_after"] += 1 if ha > 0 else 0
                    stats["all_before"] += 1 if hb == ne else 0
                    stats["all_after"] += 1 if ha == ne else 0
            if stats["n"] % 20 == 0:
                print(f"  {stats['n']}/{len(insts)}", flush=True)

    n = stats["n"]
    print(f"\n=== A1 recall proxy on {n} failed temporal instances ===")
    print(f"  >=1 evidence retrieved:  before {stats['any_before']}/{n}  ->  after {stats['any_after']}/{n}")
    print(f"  ALL evidence retrieved:  before {stats['all_before']}/{n}  ->  after {stats['all_after']}/{n}")
    print("Next: judge out/hypotheses_temporal_ab.jsonl vs out/ref_temporal_ab.json", flush=True)


if __name__ == "__main__":
    main()

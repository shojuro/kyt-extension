"""A1b validation: query decomposition A/B.

The A1 finding: temporal failures need MULTIPLE specific turns, but a single
similarity search returns a blended top-k that captures ~1. This tests whether
decomposing the question into its component events, retrieving each separately,
and unioning recovers the missing evidence.

BEFORE = single retrieval on the original question (baseline full pipeline).
AFTER  = decompose (gpt-4o-mini) -> retrieve each sub-query -> union/dedup -> top-K.

Recall proxy: has_answer evidence turn counts as retrieved if a retrieved item's
content shares >45% of the evidence turn's words. Reports >=1 and ALL evidence.

Usage: python3 -u decompose_ab.py [limit] [dataset]
Outputs: out/hypotheses_decompose_ab.jsonl, out/ref_decompose_ab.json, recall table.
"""
import json
import sys
import threading
import requests
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config, answergen
from kyt_lme.adapter import make_user_id
from kyt_lme.kyt_client import KytClient
from kyt_lme.loader import iter_instances

URL, SVC, ANON = config.supabase()
client = KytClient(URL, SVC, ANON)
AM, OK = config.answer_model(), config.openai_key()
TOPK = 20
SUB_TOPK = 12          # per sub-query before union
WORKERS = 6

_DECOMP_SYS = (
    "You split a user's question about their own history into the distinct events, "
    "activities, or facts it references. Output each as a short standalone search "
    "phrase (the event itself, no dates/ordinal words). One per line, no numbering. "
    "If the question references only one event, output exactly one line."
)


def decompose(question):
    """gpt-4o-mini -> list of sub-query event phrases (>=1)."""
    try:
        r = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OK}", "Content-Type": "application/json"},
            json={"model": "gpt-4o-mini", "temperature": 0,
                  "messages": [{"role": "system", "content": _DECOMP_SYS},
                               {"role": "user", "content": question}]},
            timeout=30)
        if r.status_code == 200:
            txt = r.json()["choices"][0]["message"]["content"]
            subs = [ln.strip("-* \t") for ln in txt.splitlines() if ln.strip()]
            subs = [s for s in subs if len(s.split()) >= 2]
            return subs or [question]
    except requests.RequestException:
        pass
    return [question]


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


def search(q, uid, topk):
    status, res = client.search({"query": q, "userId": uid, "topK": topk})
    return (res or {}).get("results", []) if status == 200 else []


def union_items(item_lists, cap):
    """Merge retrieved lists, dedup by id/content, keep best score order."""
    seen, merged = set(), []
    # interleave by rank so each sub-query contributes its top hits first
    maxlen = max((len(l) for l in item_lists), default=0)
    for rank in range(maxlen):
        for lst in item_lists:
            if rank < len(lst):
                it = lst[rank]
                key = it.get("id") or (it.get("content") or "")[:80]
                if key not in seen:
                    seen.add(key)
                    merged.append(it)
    return merged[:cap]


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    ds = sys.argv[2] if len(sys.argv) > 2 else \
        "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"

    labels = {}
    with open("out/hypotheses.jsonl.eval-results-gpt-4o") as f:
        for line in f:
            d = json.loads(line); al = d.get("autoeval_label")
            labels[d["question_id"]] = (al.get("label") if isinstance(al, dict) else al) in (True, "true")
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    fail_ids = [q for q, r in ref.items() if r["question_type"] == "temporal-reasoning"
                and not q.endswith("_abs") and not labels.get(q, False)]
    fail_set = set(fail_ids[:limit] if limit else fail_ids)
    insts = [x for x in iter_instances(ds) if x["question_id"] in fail_set]
    print(f"failed temporal instances: {len(insts)}", flush=True)

    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_decompose_ab.json", "w"))

    lock = threading.Lock()
    st = {"n": 0, "any_b": 0, "any_a": 0, "all_b": 0, "all_a": 0, "nsub": 0}

    def work(inst):
        qid = inst["question_id"]; uid = make_user_id(qid)
        evid = evidence_turns(inst); orig = inst["question"]
        subs = decompose(orig)
        items_b = search(orig, uid, TOPK)
        if len(subs) <= 1:
            items_a = items_b
        else:
            per = [search(s, uid, SUB_TOPK) for s in subs]
            items_a = union_items(per, TOPK)
        hb, ne = recall(evid, items_b); ha, _ = recall(evid, items_a)
        hyp = answergen.generate(orig, items_a, AM, OK)
        return qid, ne, hb, ha, hyp, len(subs)

    with open("out/hypotheses_decompose_ab.jsonl", "w") as fout, \
            ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for qid, ne, hb, ha, hyp, nsub in ex.map(work, insts):
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                st["n"] += 1; st["nsub"] += nsub
                if ne:
                    st["any_b"] += 1 if hb > 0 else 0
                    st["any_a"] += 1 if ha > 0 else 0
                    st["all_b"] += 1 if hb == ne else 0
                    st["all_a"] += 1 if ha == ne else 0
            if st["n"] % 20 == 0:
                print(f"  {st['n']}/{len(insts)}", flush=True)

    n = st["n"]
    print(f"\n=== A1b decomposition recall proxy on {n} failed temporal instances ===")
    print(f"  avg sub-queries/question: {st['nsub']/max(n,1):.1f}")
    print(f"  >=1 evidence retrieved:  before {st['any_b']}/{n}  ->  after {st['any_a']}/{n}")
    print(f"  ALL evidence retrieved:  before {st['all_b']}/{n}  ->  after {st['all_a']}/{n}")
    print("Next: judge out/hypotheses_decompose_ab.jsonl vs out/ref_decompose_ab.json", flush=True)


if __name__ == "__main__":
    main()

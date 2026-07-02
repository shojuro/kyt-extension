"""Quick confirmation that the DEPLOYED keyword-pool build reproduces the lift.

Re-queries failed temporal instances through the standard pipeline (plain search --
the keyword pool now runs server-side) + answergen. These were all baseline failures,
so any correct answer is a rescue. Usage: python3 -u rebase_check.py [limit]
"""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config, answergen
from kyt_lme.adapter import make_user_id
from kyt_lme.kyt_client import KytClient
from kyt_lme.loader import iter_instances

URL, SVC, ANON = config.supabase()
client = KytClient(URL, SVC, ANON)
AM, OK = config.answer_model(), config.openai_key()


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    ds = "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"
    labels = {}
    with open("out/hypotheses.jsonl.eval-results-gpt-4o") as f:
        for line in f:
            d = json.loads(line); al = d.get("autoeval_label")
            labels[d["question_id"]] = (al.get("label") if isinstance(al, dict) else al) in (True, "true")
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    fail_ids = [q for q, r in ref.items() if r["question_type"] == "temporal-reasoning"
                and not q.endswith("_abs") and not labels.get(q, False)]
    fail_set = set(fail_ids[:limit])
    insts = [x for x in iter_instances(ds) if x["question_id"] in fail_set]
    print(f"re-querying {len(insts)} failed temporal instances (deployed build)", flush=True)
    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_rebase_check.json", "w"))

    lock = threading.Lock(); n = [0]

    def work(inst):
        qid = inst["question_id"]
        st, res = client.search({"query": inst["question"], "userId": make_user_id(qid), "topK": 20})
        items = (res or {}).get("results", []) if st == 200 else []
        return qid, answergen.generate(inst["question"], items, AM, OK)

    with open("out/hypotheses_rebase_check.jsonl", "w") as fout, ThreadPoolExecutor(max_workers=4) as ex:
        for qid, hyp in ex.map(work, insts):
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                n[0] += 1
            if n[0] % 10 == 0:
                print(f"  {n[0]}/{len(insts)}", flush=True)
    print(f"done: {n[0]} hypotheses. Judge out/hypotheses_rebase_check.jsonl vs out/ref_rebase_check.json", flush=True)


if __name__ == "__main__":
    main()

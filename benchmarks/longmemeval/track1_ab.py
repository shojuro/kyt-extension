"""Track 1 A/B: precision-gated keyword pool on the 4 decisive categories.

Re-queries single-session-user + single-session-assistant + single-session-preference
+ temporal-reasoning (~289 instances) through the deployed precision pipeline, so we can
compare per-category to baseline: does precision gating keep the single-session-user win
without the assistant/preference regressions the universal keyword pool caused?

Usage: python3 -u track1_ab.py
Outputs: out/hypotheses_track1.jsonl, out/ref_track1.json
"""
import json
import threading
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config, answergen
from kyt_lme.adapter import make_user_id
from kyt_lme.kyt_client import KytClient
from kyt_lme.loader import iter_instances

URL, SVC, ANON = config.supabase()
client = KytClient(URL, SVC, ANON)
AM, OK = config.answer_model(), config.openai_key()
CATS = {"single-session-user", "single-session-assistant",
        "single-session-preference", "temporal-reasoning"}
DS = "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"


def main():
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    want = {q for q, r in ref.items() if r["question_type"] in CATS and not q.endswith("_abs")}
    insts = [x for x in iter_instances(DS) if x["question_id"] in want]
    print(f"re-querying {len(insts)} instances across {len(CATS)} categories", flush=True)
    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_track1.json", "w"))

    lock = threading.Lock(); n = [0]

    def work(inst):
        qid = inst["question_id"]
        st, res = client.search({"query": inst["question"], "userId": make_user_id(qid), "topK": 20})
        items = (res or {}).get("results", []) if st == 200 else []
        return qid, answergen.generate(inst["question"], items, AM, OK)

    with open("out/hypotheses_track1.jsonl", "w") as fout, ThreadPoolExecutor(max_workers=4) as ex:
        for qid, hyp in ex.map(work, insts):
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                n[0] += 1
            if n[0] % 30 == 0:
                print(f"  {n[0]}/{len(insts)}", flush=True)
    print(f"done: {n[0]} hypotheses -> out/hypotheses_track1.jsonl", flush=True)


if __name__ == "__main__":
    main()

"""R1b payoff test: does the now-LIVE entity signal lift retrieval?

Entities are populated for the subset (entity search + timeline + graph walk now fire
automatically in the pipeline). Re-query the 60 subset instances (30 temporal + 30
multi-session failures) with the deployed T1+T2 pipeline + gpt-4.1 reader (R0-normalized,
routed), judge, compare per-category to R0 (no entities, same reader).

Usage: ANSWER_MODEL=gpt-4.1 python3 -u r1b_ab.py
Outputs: out/hypotheses_r1b.jsonl, out/ref_r1b.json
"""
import json
import datetime
import threading
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config, answergen
from kyt_lme.adapter import make_user_id
from kyt_lme.kyt_client import KytClient
from kyt_lme.loader import iter_instances

URL, SVC, ANON = config.supabase()
client = KytClient(URL, SVC, ANON)
AM, OK = config.answer_model(), config.openai_key()
DS = "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"


def main():
    now_ms = json.load(open("state/run_meta.json"))["now_ms"]
    ref_iso = datetime.datetime.utcfromtimestamp((now_ms - 7 * 86400_000) / 1000).strftime("%Y-%m-%d (%a)")
    sub = json.load(open("state/entity_ab_subset.json"))
    want = set(sub["qids"])
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    insts = [x for x in iter_instances(DS) if x["question_id"] in want]
    print(f"R1b test: {len(insts)} subset instances, reader={AM}", flush=True)
    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_r1b.json", "w"))

    done = {}
    try:
        for l in open("out/hypotheses_r1b.jsonl"):
            d = json.loads(l); done[d["question_id"]] = d["hypothesis"]
    except FileNotFoundError:
        pass
    lock = threading.Lock()

    def work(inst):
        q = inst["question"]; uid = make_user_id(inst["question_id"])
        st, res = client.search({"query": q, "userId": uid, "topK": 20})
        items = (res or {}).get("results", []) if st == 200 else []
        if answergen.is_temporal(q):
            return inst["question_id"], answergen.generate_temporal(q, items, AM, OK, ref_iso)
        return inst["question_id"], answergen.generate(q, items, AM, OK)

    for loop in range(6):
        todo = [i for i in insts if i["question_id"] not in done]
        if not todo:
            break
        print(f"loop {loop}: {len(todo)} remaining", flush=True)
        with open("out/hypotheses_r1b.jsonl", "a") as fout, ThreadPoolExecutor(max_workers=4) as ex:
            futs = {ex.submit(work, i): i for i in todo}
            for fut in futs:
                try:
                    qid, hyp = fut.result()
                except Exception as e:
                    print(f"  skip {futs[fut]['question_id']} ({str(e)[:45]})", flush=True); continue
                with lock:
                    fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                    done[qid] = hyp
    print(f"done: {len(done)}/{len(insts)} answered", flush=True)


if __name__ == "__main__":
    main()

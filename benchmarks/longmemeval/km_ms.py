"""Re-query knowledge-update + multi-session (the 2 categories NOT in the track1 A/B)
through the deployed precision pipeline, resiliently. Combined with the clean track1
A/B hypotheses (user/assistant/preference/temporal), this yields a full-500 result
without re-querying the 277 already done.

Resumable + retry-until-complete: an answergen rate-limit exhaustion is caught and the
instance retried on the next loop pass, so no false 'I don't know' is ever written.
Low concurrency to stay under the OpenAI answer-gen rate limit.

Usage: python3 -u km_ms.py
Outputs: out/hypotheses_kms.jsonl
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
CATS = {"knowledge-update", "multi-session"}
DS = "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"
OUT = "out/hypotheses_kms.jsonl"


def main():
    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    want = {q for q, r in ref.items() if r["question_type"] in CATS}
    insts = [x for x in iter_instances(DS) if x["question_id"] in want]
    print(f"target: {len(insts)} instances (knowledge-update + multi-session)", flush=True)

    done = {}
    try:
        for l in open(OUT):
            d = json.loads(l); done[d["question_id"]] = d["hypothesis"]
    except FileNotFoundError:
        pass

    lock = threading.Lock()

    def work(inst):
        qid = inst["question_id"]
        st, res = client.search({"query": inst["question"], "userId": make_user_id(qid), "topK": 20})
        items = (res or {}).get("results", []) if st == 200 else []
        return qid, answergen.generate(inst["question"], items, AM, OK)  # raises on exhaustion

    for loop in range(6):
        todo = [i for i in insts if i["question_id"] not in done]
        if not todo:
            break
        print(f"loop {loop}: {len(todo)} remaining", flush=True)
        with open(OUT, "a") as fout, ThreadPoolExecutor(max_workers=2) as ex:
            futs = {ex.submit(work, i): i for i in todo}
            n = 0
            for fut in futs:
                i = futs[fut]
                try:
                    qid, hyp = fut.result()
                except Exception as e:
                    print(f"  skip {i['question_id']} ({str(e)[:50]}) — retry next loop", flush=True)
                    continue
                with lock:
                    fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                    done[qid] = hyp
                n += 1
                if n % 30 == 0:
                    print(f"    {n}/{len(todo)} this pass", flush=True)
    left = [i for i in insts if i["question_id"] not in done]
    print(f"done: {len(done)}/{len(insts)} answered ({len(left)} still failing)", flush=True)


if __name__ == "__main__":
    main()

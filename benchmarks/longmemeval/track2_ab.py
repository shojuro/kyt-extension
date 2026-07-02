"""Track 2 A/B: date-aware answer-side reasoning for temporal.

Retrieval already surfaces dated evidence (precision keyword pool). This tests whether
a date-aware reader lifts temporal: re-query all 133 temporal instances via the deployed
pipeline, answer with generate_temporal (dated memories + current-date reference + date
arithmetic), judge, compare to current temporal 0.361.

Reference 'today' = pinned_now - 7d (the adapter anchors each instance's latest turn to
now-7d, so 'ago' must be measured from there, not real-now).

Usage: python3 -u track2_ab.py   Outputs: out/hypotheses_track2.jsonl, out/ref_track2.json
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
DS = "/mnt/c/Users/JM505 Computers/Downloads/longmemeval_s_cleaned.json"
DAY_MS = 86400_000
MARGIN_DAYS = 7
OUT = "out/hypotheses_track2.jsonl"


def main():
    import datetime
    now_ms = json.load(open("state/run_meta.json"))["now_ms"]
    ref_ms = now_ms - MARGIN_DAYS * DAY_MS
    now_iso = datetime.datetime.utcfromtimestamp(ref_ms / 1000).strftime("%Y-%m-%d (%a)")
    print(f"reference 'today' = {now_iso} (pinned_now - {MARGIN_DAYS}d)", flush=True)

    ref = {r["question_id"]: r for r in json.load(open("out/ref_full.json"))}
    want = {q for q, r in ref.items() if r["question_type"] == "temporal-reasoning"}
    insts = [x for x in iter_instances(DS) if x["question_id"] in want]
    print(f"temporal instances: {len(insts)}", flush=True)
    json.dump([{k: ref[i["question_id"]][k] for k in ("question_id", "question", "answer", "question_type")}
               for i in insts], open("out/ref_track2.json", "w"))

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
        return qid, answergen.generate_temporal(inst["question"], items, AM, OK, now_iso)

    for loop in range(6):
        todo = [i for i in insts if i["question_id"] not in done]
        if not todo:
            break
        print(f"loop {loop}: {len(todo)} remaining", flush=True)
        with open(OUT, "a") as fout, ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(work, i): i for i in todo}
            n = 0
            for fut in futs:
                try:
                    qid, hyp = fut.result()
                except Exception as e:
                    print(f"  skip {futs[fut]['question_id']} ({str(e)[:45]})", flush=True)
                    continue
                with lock:
                    fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                    done[qid] = hyp
                n += 1
                if n % 30 == 0:
                    print(f"    {n}/{len(todo)}", flush=True)
    print(f"done: {len(done)}/{len(insts)} answered", flush=True)


if __name__ == "__main__":
    main()

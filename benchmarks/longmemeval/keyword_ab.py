"""A1c validation: keyword-augmented candidate pool.

Root cause (established): temporal evidence is a buried incidental clause that embeds
~0.57 to the question and gets outranked by decoys, so it never enters the vector
candidate pool. But it IS the only turn containing BOTH question entities. This tests
whether adding keyword-matched turns (ranked by keyword co-occurrence count) to the
retrieval set recovers that evidence.

BEFORE = vector retrieval (current full pipeline via search_memories).
AFTER  = vector UNION keyword-FTS turns (ranked by #query-keywords they contain).

Mirrors the eventual server fix: inject keyword-matched turns into the candidate pool
before rerank. Recall proxy = has_answer evidence retrieved (>45% word overlap).

Usage: python3 -u keyword_ab.py [limit] [dataset]
Outputs: out/hypotheses_keyword_ab.jsonl, out/ref_keyword_ab.json, recall table.
"""
import json
import re
import sys
import time
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
KW_POOL = 12           # keyword turns to merge in
WORKERS = 4            # lower concurrency to stay under OpenAI rate limits
_REST = {"Authorization": f"Bearer {SVC}", "apikey": SVC, "Content-Type": "application/json"}

_KW_SYS = (
    "Extract 2-5 distinctive content keywords from the user's question that identify the "
    "specific events, objects, people, or places it asks about. Prefer concrete nouns and "
    "proper names; use singular base form; drop generic words (day, time, event, ago, order). "
    "Output comma-separated, lowercase, no explanation."
)


def _openai_chat(model, messages, retries=6):
    """POST chat/completions with exponential backoff on 429/5xx."""
    for attempt in range(retries):
        try:
            r = requests.post("https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OK}", "Content-Type": "application/json"},
                json={"model": model, "temperature": 0, "messages": messages}, timeout=40)
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"]
            if r.status_code in (429, 500, 502, 503):
                time.sleep(min(2 ** attempt, 30))
                continue
            r.raise_for_status()
        except requests.RequestException:
            time.sleep(min(2 ** attempt, 30))
    return None


def extract_keywords(question):
    txt = _openai_chat("gpt-4o-mini",
                       [{"role": "system", "content": _KW_SYS},
                        {"role": "user", "content": question}])
    if not txt:
        return []
    kws = [k.strip().lower() for k in txt.split(",") if k.strip()]
    return [k for k in kws if len(k) >= 3][:5]


def gen_answer(question, items):
    """Answer-gen with backoff (SYSTEM prompt mirrors answergen.SYSTEM)."""
    up = answergen.build_user_prompt(question, items)
    txt = _openai_chat(AM, [{"role": "system", "content": answergen.SYSTEM},
                            {"role": "user", "content": up}])
    return txt.strip() if txt else "I don't know."


def keyword_search(uid, keywords):
    """Postgres FTS per keyword (stemmed), union, rank by #keywords each turn contains."""
    if not keywords:
        return []
    # OR of full-text matches; use the first significant word of each keyword phrase.
    terms = [re.sub(r"[^a-z0-9 ]", "", k).split()[0] for k in keywords if k.split()]
    ors = ",".join(f"content.fts(english).{t}" for t in terms if t)
    if not ors:
        return []
    url = (f"{URL}/rest/v1/chat_turns?user_id=eq.{uid}"
           f"&select=id,content,contextual_content,created_at&or=({ors})&limit=60")
    try:
        r = requests.get(url, headers=_REST, timeout=30)
        rows = r.json() if r.status_code == 200 else []
    except requests.RequestException:
        return []
    # rank by how many distinct keywords appear in the turn (co-occurrence = signal)
    for row in rows:
        c = (row.get("content") or "").lower()
        row["_kwhits"] = sum(1 for k in keywords if k in c) or 1
    rows.sort(key=lambda x: x["_kwhits"], reverse=True)
    return rows[:KW_POOL]


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


def vsearch(q, uid):
    status, res = client.search({"query": q, "userId": uid, "topK": TOPK})
    return (res or {}).get("results", []) if status == 200 else []


def union_items(vec, kw, cap):
    seen, merged = set(), []
    # keyword co-occurrence hits first (they're the buried-evidence rescue), then vector
    for it in kw + vec:
        key = it.get("id") or (it.get("content") or "")[:80]
        if key not in seen:
            seen.add(key); merged.append(it)
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
               for i in insts], open("out/ref_keyword_ab.json", "w"))

    lock = threading.Lock()
    st = {"n": 0, "any_b": 0, "any_a": 0, "all_b": 0, "all_a": 0, "kw_rescue": 0}

    def work(inst):
        qid = inst["question_id"]; uid = make_user_id(qid)
        evid = evidence_turns(inst); q = inst["question"]
        vec = vsearch(q, uid)
        kws = extract_keywords(q)
        kw = keyword_search(uid, kws)
        merged = union_items(vec, kw, TOPK)
        hb, ne = recall(evid, vec); ha, _ = recall(evid, merged)
        hyp = gen_answer(q, merged)
        return qid, ne, hb, ha, hyp

    with open("out/hypotheses_keyword_ab.jsonl", "w") as fout, \
            ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for qid, ne, hb, ha, hyp in ex.map(work, insts):
            with lock:
                fout.write(json.dumps({"question_id": qid, "hypothesis": hyp}) + "\n"); fout.flush()
                st["n"] += 1
                if ne:
                    st["any_b"] += 1 if hb > 0 else 0
                    st["any_a"] += 1 if ha > 0 else 0
                    st["all_b"] += 1 if hb == ne else 0
                    st["all_a"] += 1 if ha == ne else 0
                    if ha > hb:
                        st["kw_rescue"] += 1
            if st["n"] % 20 == 0:
                print(f"  {st['n']}/{len(insts)}", flush=True)

    n = st["n"]
    print(f"\n=== A1c keyword-augmented recall proxy on {n} failed temporal instances ===")
    print(f"  >=1 evidence retrieved:  before {st['any_b']}/{n}  ->  after {st['any_a']}/{n}")
    print(f"  ALL evidence retrieved:  before {st['all_b']}/{n}  ->  after {st['all_a']}/{n}")
    print(f"  instances where keyword pool improved recall: {st['kw_rescue']}/{n}")
    print("Next: judge out/hypotheses_keyword_ab.jsonl vs out/ref_keyword_ab.json", flush=True)


if __name__ == "__main__":
    main()

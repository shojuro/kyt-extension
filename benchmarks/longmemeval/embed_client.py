"""Client-side embedding backfill — bypasses the edge function entirely.

The edge-function backfill stalled at scale (DB lock contention + per-call gateway
overhead) even though the Scaleway provider is fast. This embeds null-embedding
chat_turns directly: fetch (via the partial index) -> Scaleway batch embed ->
truncate(1024)+L2-normalize (identical to HuggingFaceClient.truncateAndNormalize)
-> PATCH the row. Controlled concurrency, resumable (just re-run).

Env: HF (HuggingFace/Scaleway key). Reads Supabase creds from .env via config.
Usage: python3 -u embed_client.py [max_rows]
"""
import os
import sys
import time
import requests
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config

URL, SVC, _ANON = config.supabase()
HF = os.environ["HF"]
SCALEWAY = "https://router.huggingface.co/scaleway/v1/embeddings"
MODEL = "qwen3-embedding-8b"
DIMS = 1024
PAGE = 500          # rows fetched per index scan
BATCH = 50          # texts per embedding call
WORKERS = 8         # concurrent embed+write pipelines (sustainable on one provider)

_REST = {"Authorization": f"Bearer {SVC}", "apikey": SVC, "Content-Type": "application/json"}
_HF = {"Authorization": f"Bearer {HF}", "Content-Type": "application/json"}


def truncate_normalize(emb):
    t = emb[:DIMS]
    n = sum(v * v for v in t) ** 0.5
    return t if n == 0 else [v / n for v in t]


def to_vec_literal(emb):
    return "[" + ",".join(repr(round(v, 7)) for v in emb) + "]"


def embed_batch(texts):
    for attempt in range(5):
        try:
            r = requests.post(SCALEWAY, headers=_HF,
                              json={"input": texts, "model": MODEL}, timeout=60)
            if r.status_code == 200:
                data = sorted(r.json()["data"], key=lambda x: x["index"])
                return [truncate_normalize(d["embedding"]) for d in data]
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
        except requests.RequestException:
            time.sleep(2 ** attempt)
    raise RuntimeError("embed_batch failed after retries")


def patch_row(row_id, vec_literal):
    for attempt in range(4):
        try:
            r = requests.patch(f"{URL}/rest/v1/chat_turns?id=eq.{row_id}",
                              headers={**_REST, "Prefer": "return=minimal"},
                              json={"embedding": vec_literal}, timeout=30)
            if r.status_code in (200, 204):
                return True
            time.sleep(1 + attempt)
        except requests.RequestException:
            time.sleep(1 + attempt)
    return False


def process_batch(rows):
    texts = [(r.get("contextual_content") or r["content"] or "") for r in rows]
    embs = embed_batch(texts)
    payload = [{"id": r["id"], "embedding": to_vec_literal(e)} for r, e in zip(rows, embs)]
    for attempt in range(4):
        try:
            rr = requests.post(f"{URL}/rest/v1/rpc/bulk_set_embeddings",
                              headers=_REST, json={"p": payload}, timeout=90)
            if rr.status_code in (200, 204):
                return len(rows)
            time.sleep(1 + attempt)
        except requests.RequestException:
            time.sleep(1 + attempt)
    return 0


def fetch_null_page(limit):
    r = requests.get(
        f"{URL}/rest/v1/chat_turns?embedding=is.null&select=id,content,contextual_content&limit={limit}",
        headers=_REST, timeout=60)
    r.raise_for_status()
    return r.json()


def main():
    cap = int(sys.argv[1]) if len(sys.argv) > 1 else 0  # 0 = all
    total = 0
    t0 = time.time()
    while True:
        page = fetch_null_page(PAGE if not cap else min(PAGE, cap - total))
        if not page:
            break
        batches = [page[i:i + BATCH] for i in range(0, len(page), BATCH)]
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for n in ex.map(process_batch, batches):
                total += n
        rate = total / max(time.time() - t0, 1)
        print(f"  embedded {total} rows ({rate:.0f}/s)", flush=True)
        if cap and total >= cap:
            break
    print(f"done: {total} rows embedded in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

"""R1b Option A: client-side entity extractor — makes KYT's entity signal LIVE.

The edge-function backfill_entities is throughput-capped (Haiku per row + 8s client
timeout + 150s edge limit + concurrency-induced timeouts) — ~11 turns/150s even
batched. This bypasses all of that: extract entities in Python with real concurrency
+ backoff, then write entities + mentions + relationships + embeddings directly.

Extraction model = gpt-4o-mini (the raw Anthropic key isn't available client-side, and
the retrieval pipeline only READS the entities table — it's model-agnostic which LLM
populated it). Same extraction prompt as entity-extractor.ts (entity_prompt.txt).

Save logic mirrors saveEntitiesWithMentions: canonical_name = normalized_name+"_"+
relationship; dedup on (user_id, canonical_name, entity_type); embed new entities
("entity_text (entity_type, relationship)", 1024d); insert entity_mentions; upsert
entity_relationships for co-occurring entity pairs.

Usage: python3 -u entity_extract_client.py <user_id | 'subset'> [max_turns]
Env: OPENAI_API_KEY, HF (Scaleway).
"""
import json
import os
import re
import sys
import time
import threading
import requests
from concurrent.futures import ThreadPoolExecutor

from kyt_lme import config

URL, SVC, _ANON = config.supabase()
OK = config.openai_key()
HF = os.environ["HF"]
SYSTEM = open(os.path.join(os.path.dirname(__file__), "entity_prompt.txt")).read()
SCALEWAY = "https://router.huggingface.co/scaleway/v1/embeddings"
DIMS = 1024
EXTRACT_WORKERS = 8
SAVE_WORKERS = 8
VALID_TYPES = {"PERSON", "ORG", "LOCATION", "PROJECT", "TECH", "MISC", "CONCEPT", "ANALOGY", "THEME", "TOPIC"}

_REST = {"Authorization": f"Bearer {SVC}", "apikey": SVC, "Content-Type": "application/json"}
_HF = {"Authorization": f"Bearer {HF}", "Content-Type": "application/json"}


def _norm(name):
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


def _to_vec(e):
    e = e[:DIMS]
    n = sum(v * v for v in e) ** 0.5
    e = e if n == 0 else [v / n for v in e]
    return "[" + ",".join(repr(round(v, 7)) for v in e) + "]"


def embed_batch(texts):
    """One Scaleway call for a whole turn's entity embed-texts."""
    if not texts:
        return []
    for attempt in range(5):
        try:
            r = requests.post(SCALEWAY, headers=_HF, json={"input": texts, "model": "qwen3-embedding-8b"}, timeout=60)
            if r.status_code == 200:
                data = sorted(r.json()["data"], key=lambda x: x["index"])
                return [_to_vec(d["embedding"]) for d in data]
            time.sleep(2 ** attempt)
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return [None] * len(texts)


def extract(content, speakers):
    """gpt-4o-mini JSON extraction with the entity-extractor.ts system prompt."""
    user = (f"Extract entities and user preferences from this conversation:\n\n"
            f"SPEAKERS: {', '.join(speakers or ['User','Assistant'])}\n\n"
            f"CONTENT:\n{content}\n\n"
            f"Return entities with their relationship to the user, and any user preferences detected.")
    for attempt in range(8):
        try:
            r = requests.post("https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OK}", "Content-Type": "application/json"},
                json={"model": "gpt-4o-mini", "temperature": 0.2,
                      "response_format": {"type": "json_object"},
                      "messages": [{"role": "system", "content": SYSTEM},
                                   {"role": "user", "content": user}]}, timeout=60)
            if r.status_code == 200:
                return json.loads(r.json()["choices"][0]["message"]["content"])
            if r.status_code in (429, 500, 502, 503):
                time.sleep(min(2 ** attempt, 60)); continue
            return None
        except (requests.RequestException, json.JSONDecodeError):
            time.sleep(min(2 ** attempt, 30))
    return None


def _mark(turn_id):
    requests.patch(f"{URL}/rest/v1/chat_turns?id=eq.{turn_id}",
                   headers={**_REST, "Prefer": "return=minimal"},
                   json={"entities_extracted": True, "preferences_extracted": True}, timeout=30)


def save_turn(user_id, turn, parsed):
    """Batched save: 1 Scaleway embed + bulk entity upsert + bulk mentions +
    bulk relationships + 1 mark. Race-safe via ON CONFLICT so turns can save in
    parallel. Atomic per turn; ~5 round-trips instead of dozens."""
    # 1. Build deduped entity rows for this turn.
    rows, seen = [], set()
    for ent in (parsed.get("entities") or [])[:15]:
        et = ent.get("entity_text")
        if not et:
            continue
        etype = ent.get("entity_type") if ent.get("entity_type") in VALID_TYPES else "MISC"
        rel = ent.get("relationship") or "unknown"
        norm = ent.get("normalized_name") or _norm(et)
        if not norm:
            continue
        canon = f"{norm}_{rel}"
        key = (canon, etype)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"user_id": user_id, "entity_text": et, "normalized_name": norm,
                     "entity_type": etype, "relationship": rel,
                     "context_category": ent.get("context_category") or "general",
                     "canonical_name": canon, "mention_count": 1,
                     "_embed_text": f"{et} ({etype}, {rel})"})
    if not rows:
        _mark(turn["id"])
        return
    # 2. One embed call for the whole turn.
    vecs = embed_batch([r.pop("_embed_text") for r in rows])
    for r, v in zip(rows, vecs):
        if v:
            r["embedding"] = v
    # 3. Bulk entity upsert (atomic, race-safe), return rows to map canonical->id.
    try:
        resp = requests.post(
            f"{URL}/rest/v1/entities?on_conflict=user_id,canonical_name,entity_type",
            headers={**_REST, "Prefer": "resolution=merge-duplicates,return=representation"},
            json=rows, timeout=60)
        got = resp.json() if resp.status_code in (200, 201) else []
    except requests.RequestException:
        got = []
    id_by = {(g["canonical_name"], g["entity_type"]): g["id"] for g in got if "id" in g}
    ids = [id_by.get((r["canonical_name"], r["entity_type"])) for r in rows]
    ids = [i for i in ids if i]
    if not ids:
        _mark(turn["id"])
        return
    # 4. Bulk mentions.
    mentions = [{"entity_id": eid, "chat_turn_id": turn["id"],
                 "conversation_id": turn.get("conversation_id") or turn["id"],
                 "mention_text": r["entity_text"]}
                for eid, r in zip(ids, rows) if eid]
    if mentions:
        requests.post(f"{URL}/rest/v1/entity_mentions",
                      headers={**_REST, "Prefer": "return=minimal"}, json=mentions, timeout=60)
    # 5. Bulk co-occurrence relationships (ordered pairs a<b; ignore dup pairs).
    uniq = list(dict.fromkeys(ids))
    pairs = []
    for i in range(len(uniq)):
        for j in range(i + 1, len(uniq)):
            a, b = sorted([uniq[i], uniq[j]])
            pairs.append({"user_id": user_id, "entity_a_id": a, "entity_b_id": b,
                          "co_occurrence_count": 1, "relationship_strength": 0.29,
                          "relationship_type": "co_occurrence"})
    if pairs:
        requests.post(
            f"{URL}/rest/v1/entity_relationships?on_conflict=user_id,entity_a_id,entity_b_id",
            headers={**_REST, "Prefer": "resolution=ignore-duplicates,return=minimal"},
            json=pairs, timeout=60)
    _mark(turn["id"])


def fetch_unextracted(user_id, limit):
    r = requests.get(f"{URL}/rest/v1/chat_turns?user_id=eq.{user_id}&entities_extracted=eq.false"
                     f"&is_question=eq.false&select=id,content,speakers,conversation_id&limit={limit}",
                     headers=_REST, timeout=60)
    return r.json() if r.status_code == 200 else []


def process_user(user_id, max_turns):
    total = 0
    lock = threading.Lock()
    while True:
        turns = fetch_unextracted(user_id, min(200, max_turns - total) if max_turns else 200)
        turns = [t for t in turns if t.get("content")]
        if not turns:
            break
        # Phase 1: parallel extraction
        results = {}
        def do(t):
            p = extract(t["content"], t.get("speakers"))
            if p is not None:
                with lock:
                    results[t["id"]] = (t, p)
        with ThreadPoolExecutor(max_workers=EXTRACT_WORKERS) as ex:
            list(ex.map(do, turns))
        # Phase 2: parallel save (race-safe via ON CONFLICT upserts).
        # A transient error on one turn must not crash the run — skip it (stays
        # unmarked -> refetched next iteration).
        def _safe_save(kv):
            try:
                save_turn(user_id, kv[1][0], kv[1][1])
                return True
            except Exception as e:
                print(f"    save skip {kv[0][:8]} ({str(e)[:50]})", flush=True)
                return False
        with ThreadPoolExecutor(max_workers=SAVE_WORKERS) as ex:
            saved = sum(1 for ok in ex.map(_safe_save, list(results.items())) if ok)
        total += saved
        print(f"  {user_id[:8]}: +{saved}/{len(results)} saved ({total} total)", flush=True)
        # No-progress guard: extraction or save produced nothing this pass -> stop
        # (avoids an infinite refetch loop on persistently-failing turns).
        if saved == 0:
            print(f"    {user_id[:8]}: no progress this pass — stopping user", flush=True)
            break
        if max_turns and total >= max_turns:
            break
    return total


def main():
    target = sys.argv[1]
    max_turns = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if target == "subset":
        sub = json.load(open("state/entity_ab_subset.json"))
        users = list(sub["users"].values())
    else:
        users = [target]
    t0 = time.time()
    grand = 0
    for i, uid in enumerate(users, 1):
        try:
            n = process_user(uid, max_turns)
        except Exception as e:   # isolate per-user failures — don't kill the whole run
            print(f"[{i}/{len(users)}] {uid[:8]} FAILED: {str(e)[:60]} — continuing", flush=True)
            continue
        grand += n
        print(f"[{i}/{len(users)}] {uid[:8]} done: {n} turns ({time.time()-t0:.0f}s, {grand} total)", flush=True)
    print(f"DONE: {grand} turns extracted across {len(users)} users in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

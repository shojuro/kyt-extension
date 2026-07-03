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
VALID_TYPES = {"PERSON", "ORG", "LOCATION", "PROJECT", "TECH", "MISC", "CONCEPT", "ANALOGY", "THEME", "TOPIC"}

_REST = {"Authorization": f"Bearer {SVC}", "apikey": SVC, "Content-Type": "application/json"}
_HF = {"Authorization": f"Bearer {HF}", "Content-Type": "application/json"}


def _norm(name):
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


def embed(text):
    for attempt in range(5):
        try:
            r = requests.post(SCALEWAY, headers=_HF, json={"input": [text], "model": "qwen3-embedding-8b"}, timeout=40)
            if r.status_code == 200:
                e = r.json()["data"][0]["embedding"][:DIMS]
                n = sum(v * v for v in e) ** 0.5
                e = e if n == 0 else [v / n for v in e]
                return "[" + ",".join(repr(round(v, 7)) for v in e) + "]"
            time.sleep(2 ** attempt)
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None


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


def get_entity_id(user_id, canonical, etype):
    r = requests.get(f"{URL}/rest/v1/entities?user_id=eq.{user_id}&canonical_name=eq.{canonical}"
                     f"&entity_type=eq.{etype}&select=id&limit=1", headers=_REST, timeout=30)
    rows = r.json() if r.status_code == 200 else []
    return rows[0]["id"] if rows else None


def upsert_entity(user_id, ent):
    """Return entity id, creating (with embedding) or bumping mention_count."""
    etype = ent.get("entity_type", "MISC")
    if etype not in VALID_TYPES:
        etype = "MISC"
    rel = ent.get("relationship") or "unknown"
    norm = ent.get("normalized_name") or _norm(ent.get("entity_text"))
    if not norm:
        return None
    canonical = f"{norm}_{rel}"
    eid = get_entity_id(user_id, canonical, etype)
    if eid:
        return eid   # already exists (mention_count bump skipped — not needed for retrieval)
    emb = embed(f"{ent.get('entity_text')} ({etype}, {rel})")
    body = {"user_id": user_id, "entity_text": ent.get("entity_text"), "normalized_name": norm,
            "entity_type": etype, "relationship": rel,
            "context_category": ent.get("context_category") or "general",
            "canonical_name": canonical, "mention_count": 1}
    if emb:
        body["embedding"] = emb
    r = requests.post(f"{URL}/rest/v1/entities", headers={**_REST, "Prefer": "return=representation"},
                      json=body, timeout=30)
    if r.status_code in (200, 201):
        return r.json()[0]["id"]
    # race/conflict -> fetch existing
    return get_entity_id(user_id, canonical, etype)


def save_turn(user_id, turn, parsed):
    """Serial save: entities + mentions + co-occurrence relationships."""
    ents = parsed.get("entities") or []
    ids = []
    for ent in ents[:15]:
        if not ent.get("entity_text"):
            continue
        eid = upsert_entity(user_id, ent)
        if eid:
            ids.append(eid)
            requests.post(f"{URL}/rest/v1/entity_mentions", headers={**_REST, "Prefer": "return=minimal"},
                          json={"entity_id": eid, "chat_turn_id": turn["id"],
                                "conversation_id": turn.get("conversation_id") or turn["id"],
                                "mention_text": ent.get("entity_text")}, timeout=30)
    # co-occurrence relationships (ordered pairs, CHECK a<b)
    uniq = list(dict.fromkeys(ids))
    for i in range(len(uniq)):
        for j in range(i + 1, len(uniq)):
            a, b = sorted([uniq[i], uniq[j]])
            requests.post(f"{URL}/rest/v1/rpc/upsert_entity_relationship", headers=_REST,
                          json={"p_user_id": user_id, "p_entity_a": a, "p_entity_b": b,
                                "p_relationship_type": "co_occurrence"}, timeout=30)
    # mark extracted
    requests.patch(f"{URL}/rest/v1/chat_turns?id=eq.{turn['id']}",
                   headers={**_REST, "Prefer": "return=minimal"},
                   json={"entities_extracted": True, "preferences_extracted": True}, timeout=30)


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
        # Phase 2: serial save
        for tid, (t, p) in results.items():
            save_turn(user_id, t, p)
            total += 1
        print(f"  {user_id[:8]}: +{len(results)} saved ({total} total)", flush=True)
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
        n = process_user(uid, max_turns)
        grand += n
        print(f"[{i}/{len(users)}] {uid[:8]} done: {n} turns ({time.time()-t0:.0f}s, {grand} total)", flush=True)
    print(f"DONE: {grand} turns extracted across {len(users)} users in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()

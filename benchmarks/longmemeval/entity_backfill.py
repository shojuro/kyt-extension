"""Parallel per-user entity backfill for the A2 validation subset.

Drives backfill_entities (Haiku extraction) per user, fanned out across workers.
Each user requires a real auth.users row (entities FK) — seeded separately.
Resumable: re-run and it skips users already fully extracted.

Reads the subset from state/entity_ab_subset.json. Usage:
  python3 -u entity_backfill.py            # all subset users
  python3 -u entity_backfill.py 5          # first 5 users (rate probe)
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from kyt_lme import config
from kyt_lme.kyt_client import KytClient

URL, SVC, ANON = config.supabase()
MAX_ROWS = 80          # per call; keeps each edge invocation under the wall-clock limit
WORKERS = 10           # concurrent users (each = one sequential Haiku stream server-side)


def backfill_user(client, uid):
    """Loop backfill_entities for one user until no unextracted turns remain."""
    for _ in range(40):
        remaining = client.count_unextracted_turns(uid)
        if remaining == 0:
            return client.count_entities(uid)
        client.backfill_entities_once(uid, max_rows=MAX_ROWS, fast_mode=True)
    return client.count_entities(uid)


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    sub = json.load(open("state/entity_ab_subset.json"))
    uids = list(sub["users"].values())
    if limit:
        uids = uids[:limit]
    client = KytClient(URL, SVC, ANON)

    total_turns = sum(client.count_turns_for_user(u) for u in uids)
    print(f"users={len(uids)}  total_turns~{total_turns}", flush=True)

    t0 = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(backfill_user, client, u): u for u in uids}
        for fut in as_completed(futs):
            ents = fut.result()
            done += 1
            elapsed = time.time() - t0
            print(f"  [{done}/{len(uids)}] {futs[fut][:8]} -> {ents} entities "
                  f"({elapsed:.0f}s elapsed)", flush=True)
    # Report residual coverage
    left = sum(client.count_unextracted_turns(u) for u in uids)
    print(f"done: {len(uids)} users in {time.time()-t0:.0f}s; unextracted turns left={left}", flush=True)


if __name__ == "__main__":
    main()

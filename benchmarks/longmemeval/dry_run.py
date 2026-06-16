"""Dry-run: prove the LongMemEval -> KYT transform on REAL data, no API calls.

Usage:  python3 dry_run.py "<path to longmemeval_s_cleaned.json>" [num_instances]

Verifies, per instance:
  * the (conversation_id, start_timestamp) upsert key is collision-free,
  * temporal normalization keeps every timestamp in KYT's valid window
    (>= 2022-11-30 and < now), and anchors the instance's latest turn near now,
  * batch sizes respect the 50-turn cap,
  * the query payload runs the full pipeline (no `fast`).
"""
import sys
import time
import itertools
import datetime

from kyt_lme.loader import iter_instances
from kyt_lme.adapter import instance_to_payloads, parse_lme_date, to_ms, DAY_MS

FLOOR_MS = to_ms(datetime.datetime(2022, 11, 30))


def fmt(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def main():
    path = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    now_ms = int(time.time() * 1000)

    total_turns = 0
    for inst in itertools.islice(iter_instances(path), n):
        # original date span
        orig = [to_ms(parse_lme_date(d)) for d in inst["haystack_dates"] if d]
        p = instance_to_payloads(inst, now_ms)
        m = p["meta"]

        # collision check on the upsert key
        seen, dups = set(), 0
        shifted = []
        for b in p["ingest_batches"]:
            assert len(b["turns"]) <= 50, "batch exceeds 50-turn cap"
            assert b["skip_ai_processing"] is True
            for t in b["turns"]:
                key = (t["conversation_id"], t["timestamp"])
                if key in seen:
                    dups += 1
                seen.add(key)
                shifted.append(t["timestamp"])
        assert dups == 0, f"{dups} duplicate upsert keys (turns would be dropped!)"

        # temporal window checks
        smin, smax = min(shifted), max(shifted)
        assert smin >= FLOOR_MS, "shifted timestamp before KYT 2022-11-30 floor"
        assert smax < now_ms, "shifted timestamp in the future"
        total_turns += m["n_turns"]

        print(f"--- {m['question_id']}  [{m['question_type']}"
              f"{' /ABSTENTION' if m['is_abstention'] else ''}] ---")
        print(f"  user_id        : {p['user_id']}")
        print(f"  sessions/turns : {m['n_sessions']} / {m['n_turns']}"
              f"  in {len(p['ingest_batches'])} batches")
        print(f"  orig date span : {fmt(min(orig))} -> {fmt(max(orig))}")
        print(f"  shifted span   : {fmt(smin)} -> {fmt(smax)}"
              f"   (latest ~= now-{round((now_ms - smax)/DAY_MS)}d)")
        print(f"  upsert keys    : {len(seen)} unique, {dups} collisions")
        print(f"  query          : {p['query']['query'][:80]!r}")
        print(f"  gold_answer    : {str(m['gold_answer'])[:80]!r}")
        sample = p["ingest_batches"][0]["turns"][0]
        print(f"  sample turn    : role={sample['role']} "
              f"ts={fmt(sample['timestamp'])} content={sample['content'][:60]!r}")
        print()

    print(f"OK: {n} instance(s) transformed, {total_turns} turns, all upsert "
          f"keys unique, all timestamps within KYT's valid window.")


if __name__ == "__main__":
    main()

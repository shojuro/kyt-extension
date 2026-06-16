"""Map a LongMemEval instance to KYT edge-function payloads.

Design decisions (grounded in the live KYT schema, 2026-06-16):

* Isolation: each instance becomes its own synthetic user_id (uuid5 of the
  question_id). chat_turns has NO FK on user_id, so synthetic ids are fine, and
  every retrieval RPC scopes by user_id -> airtight cross-instance isolation.

* Upsert key is (user_id, conversation_id, platform, start_timestamp) with
  ignoreDuplicates. So every turn in a session MUST get a distinct, ordered
  start_timestamp or turns silently collapse. We give each turn
  session_base_ms + i*1000 (preserves intra-session order, no collisions).

* Temporal normalization: KYT's ingest rejects timestamps before 2022-11-30 and
  its recency boost is computed vs wall-clock now. LongMemEval dates span
  2021-05..2024-02, and ~747 dates predate the floor. We shift each instance so
  its latest date maps to (now - margin_days): this keeps every timestamp inside
  the valid window AND makes "the present" for the instance ~= now, so KYT's
  recency mechanism behaves as if the conversation were current. Relative order
  and intervals within an instance are preserved (a single uniform offset).
"""
import re
import uuid
import datetime

# Stable namespace so user_ids are deterministic across runs (resumable/cleanup).
LME_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "kyt:longmemeval")
PLATFORM = "chatgpt"
DAY_MS = 86_400_000
_DOW_RE = re.compile(r"\s*\(\w{3}\)\s*")  # strips the " (Tue) " day-of-week token


def parse_lme_date(s):
    """'2023/05/30 (Tue) 23:40' -> naive datetime (UTC-interpreted)."""
    cleaned = _DOW_RE.sub(" ", s).strip()
    return datetime.datetime.strptime(cleaned, "%Y/%m/%d %H:%M")


def to_ms(dt):
    return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def make_user_id(question_id):
    return str(uuid.uuid5(LME_NAMESPACE, str(question_id)))


def is_abstention(instance):
    """LongMemEval marks abstention instances with a _abs question_id suffix."""
    return str(instance.get("question_id", "")).endswith("_abs")


def _instance_dates_ms(instance):
    ms = []
    for d in instance.get("haystack_dates", []):
        if d:
            ms.append(to_ms(parse_lme_date(d)))
    if instance.get("question_date"):
        ms.append(to_ms(parse_lme_date(instance["question_date"])))
    return ms


def compute_offset_ms(instance, now_ms, margin_days):
    """Offset that maps the instance's latest date to (now - margin_days)."""
    max_ms = max(_instance_dates_ms(instance))
    target_ms = now_ms - margin_days * DAY_MS
    return target_ms - max_ms


def instance_to_payloads(instance, now_ms, margin_days=7, max_batch=50):
    """Return {user_id, ingest_batches, query, meta} for one instance.

    ingest_batches: list of save_chat_turn_batch bodies (<=max_batch turns each,
                    skip_ai_processing=True -> fast bulk upsert, null embeddings).
    query:          search_memories body (no `fast` -> full pipeline).
    """
    uid = make_user_id(instance["question_id"])
    offset = compute_offset_ms(instance, now_ms, margin_days)

    session_ids = instance["haystack_session_ids"]
    session_dates = instance["haystack_dates"]
    sessions = instance["haystack_sessions"]

    turns = []
    for sid, sdate, sess in zip(session_ids, session_dates, sessions):
        base = to_ms(parse_lme_date(sdate)) + offset
        for i, t in enumerate(sess):
            turns.append({
                "user_id": uid,
                "conversation_id": str(sid),
                "platform": PLATFORM,
                "content": t.get("content", ""),
                "role": t.get("role", "user"),
                # distinct + ordered within the session (collision-free upsert key)
                "timestamp": base + i * 1000,
            })

    batches = [
        {"skip_ai_processing": True, "turns": turns[i:i + max_batch]}
        for i in range(0, len(turns), max_batch)
    ]

    query = {"query": instance["question"], "userId": uid}

    meta = {
        "question_id": instance["question_id"],
        "question_type": instance.get("question_type"),
        "is_abstention": is_abstention(instance),
        "gold_answer": instance.get("answer"),
        "answer_session_ids": instance.get("answer_session_ids", []),
        "offset_ms": offset,
        "n_sessions": len(sessions),
        "n_turns": len(turns),
    }
    return {"user_id": uid, "ingest_batches": batches, "query": query, "meta": meta}

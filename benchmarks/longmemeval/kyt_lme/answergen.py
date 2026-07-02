"""Answer generation: turn KYT's retrieved memories into a hypothesis answer.

KYT is the RETRIEVER. The benchmark still needs a "chat assistant" that reads the
retrieved memories and answers the question; LongMemEval's judge then grades that
answer vs gold. We keep this model swappable (default gpt-4o) for parity with the
LongMemEval reference setup. (Model API — runs Saturday.)
"""
import datetime
import time

import requests

SYSTEM = (
    "You are a helpful assistant answering a question about the user, using ONLY "
    "the retrieved memories from your long-term memory of past conversations. "
    "If the memories do not contain enough information to answer, say you don't "
    "know rather than guessing. Answer concisely and directly."
)

# Temporal-aware reader: retrieval now surfaces the dated evidence, so the remaining
# temporal gap is the reader doing the date arithmetic. Each memory carries the date
# it was said; give an explicit current-date reference (the benchmark shifts all
# timestamps, anchoring each instance's latest turn to now-7d, so "ago" must be
# measured from that reference, not real-now) and instruct step-by-step computation.
SYSTEM_TEMPORAL = (
    "You answer a question about the user using ONLY the retrieved memories below. "
    "Each memory is tagged [date] with the date the user said it. Today's date is {now}.\n"
    "This is often a temporal question. Reason with the dates step by step:\n"
    "- 'how many days/weeks/months ago ...' → compute the interval from TODAY to the "
    "event's date, then convert to the unit asked.\n"
    "- 'how many days/weeks between X and Y' or 'how long' → compute the difference "
    "between the two events' dates.\n"
    "- 'which happened first / in what order' → compare the dates.\n"
    "Identify the relevant memory/memories, state the date(s), show the calculation, "
    "and give the final number rounded as the question implies. If the needed date is "
    "not in the memories, say you don't know rather than guessing. End with a concise "
    "direct answer."
)


def _fmt_date(ts):
    """ISO timestamp -> 'YYYY-MM-DD (Weekday)'; passthrough on parse failure."""
    if not ts:
        return ""
    try:
        d = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return d.strftime("%Y-%m-%d (%a)")
    except (ValueError, TypeError):
        return str(ts)[:10]


def build_temporal_prompt(question, retrieved_items):
    if retrieved_items:
        lines = []
        for i, it in enumerate(retrieved_items, 1):
            content = it.get("contextual_content") or it.get("content") or ""
            d = _fmt_date(it.get("created_at") or it.get("timestamp") or "")
            lines.append(f"[{d or 'undated'}] {content}".strip())
        memories = "\n".join(lines)
    else:
        memories = "(no memories retrieved)"
    return f"Retrieved memories:\n{memories}\n\nQuestion: {question}\nAnswer:"


def build_user_prompt(question, retrieved_items):
    """retrieved_items: list of dicts from search_memories results[]."""
    if retrieved_items:
        lines = []
        for i, it in enumerate(retrieved_items, 1):
            content = it.get("contextual_content") or it.get("content") or ""
            ts = it.get("created_at") or it.get("timestamp") or ""
            lines.append(f"[memory {i}{f' — {ts}' if ts else ''}] {content}".strip())
        memories = "\n".join(lines)
    else:
        memories = "(no memories retrieved)"
    return f"Retrieved memories:\n{memories}\n\nQuestion: {question}\nAnswer:"


def _chat(system, user, model, openai_key, timeout=60, retries=10):
    """OpenAI chat completion with patient backoff on 429/5xx. Raises after exhausting
    retries (never silently returns 'I don't know' — that would corrupt the eval as a
    false abstention; a real failure should surface loudly)."""
    body = {"model": model, "temperature": 0,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}]}
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
                json=body, timeout=timeout,
            )
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"].strip()
            last = f"{r.status_code} {r.text[:120]}"
            if r.status_code in (429, 500, 502, 503):
                time.sleep(min(2 ** attempt, 60))
                continue
            r.raise_for_status()
        except requests.RequestException as e:
            last = str(e)
            time.sleep(min(2 ** attempt, 60))
    raise RuntimeError(f"answergen exhausted retries (last: {last})")


def generate(question, retrieved_items, model, openai_key, timeout=60, retries=10):
    """Return a hypothesis string (baseline reader)."""
    return _chat(SYSTEM, build_user_prompt(question, retrieved_items), model, openai_key, timeout, retries)


def generate_temporal(question, retrieved_items, model, openai_key, now_iso, timeout=60, retries=10):
    """Date-aware reader for temporal questions: dated memories + current-date reference
    + step-by-step date-arithmetic instruction. now_iso = the reference 'today' (for the
    shifted benchmark timeline, = pinned_now - 7d)."""
    system = SYSTEM_TEMPORAL.format(now=now_iso)
    return _chat(system, build_temporal_prompt(question, retrieved_items), model, openai_key, timeout, retries)


import re as _re
_TEMPORAL_RE = _re.compile(
    r"\b(how (many|much) (days?|weeks?|months?|years?|time)|how long|"
    r"\bago\b|when did|when was|what (date|day)|most recent(ly)?|"
    r"which .*(happen|occur|come|took place|first|before|after|earlier|later)|"
    r"(the )?order of|in (the )?order|first to last|earliest to latest|"
    r"first,? (and )?second|between .* and |"
    r"last (mon|tues|wednes|thurs|fri|satur|sun)day|last (week|month|year))\b", _re.I)


def is_temporal(question: str) -> bool:
    """Route to the date-aware reader: duration / ago / ordering / when questions."""
    return bool(_TEMPORAL_RE.search(question or ""))

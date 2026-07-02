"""Answer generation: turn KYT's retrieved memories into a hypothesis answer.

KYT is the RETRIEVER. The benchmark still needs a "chat assistant" that reads the
retrieved memories and answers the question; LongMemEval's judge then grades that
answer vs gold. We keep this model swappable (default gpt-4o) for parity with the
LongMemEval reference setup. (Model API — runs Saturday.)
"""
import time

import requests

SYSTEM = (
    "You are a helpful assistant answering a question about the user, using ONLY "
    "the retrieved memories from your long-term memory of past conversations. "
    "If the memories do not contain enough information to answer, say you don't "
    "know rather than guessing. Answer concisely and directly."
)


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


def generate(question, retrieved_items, model, openai_key, timeout=60, retries=10):
    """Return a hypothesis string. Uses OpenAI chat completions with patient backoff
    on 429/5xx (parallel query runs saturate the OpenAI rate limit; giving up here
    would corrupt results as false 'I don't know'). Raises after exhausting retries
    so callers can distinguish a real failure from a genuine abstention."""
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": build_user_prompt(question, retrieved_items)},
        ],
        "temperature": 0,
    }
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
    # Do NOT silently return "I don't know" — that would corrupt the eval as a false
    # abstention. Surface the failure so the run fails loudly instead of scoring 0.
    raise RuntimeError(f"answergen exhausted retries (last: {last})")

"""Temporal query normalization (A1 validation).

Strips temporal framing from a question so the CORE EVENT(S) drive retrieval.
The pipeline re-embeds the raw query string, so rewriting it changes what gets
matched — the goal is to recover the ~60% DURATION recall misses where the event
("meet my aunt and receive the crystal chandelier") is buried under framing
("how many weeks ago did I ...").

Rule-based for the validation A/B (fast, deterministic, free). The production
build would use Haiku for robustness, but the rules are enough to prove/disprove
the recall lift.

  normalize_temporal_query("How many weeks ago did I meet up with my aunt and "
                           "receive the crystal chandelier?")
    -> "meet up with my aunt and receive the crystal chandelier"
"""
import re

# Ordered strip patterns applied to the lowercased question. Each removes a
# temporal-framing fragment while preserving the event description.
_STRIP = [
    # duration framing: "how many days/weeks/... (passed) (ago) (did i / between)"
    r"^how many (?:days?|weeks?|months?|years?)\s+(?:have\s+)?(?:passed|elapsed)?\s*",
    r"^how much time\s+(?:has|had)?\s*(?:passed|elapsed)?\s*",
    r"^how long\s+(?:ago|since)?\s*(?:has it been|had it been)?\s*(?:since)?\s*",
    # ordering framing handled separately (keep the options); here strip leads:
    r"^when (?:did|was|were)\s+",
    r"^on (?:which|what)\s+(?:date|day)\s+(?:did|was|were)?\s*",
    r"^(?:what|which)\s+(?:date|day|time)\s+(?:did|was|were)\s+",
    # residual connective leads after the above
    r"^(?:did|do|have|has)\s+i\s+",
    r"^(?:between|from)\s+",
    r"^i\s+",
]

# Fragments removed anywhere in the string.
_INLINE = [
    r"\bhow many (?:days?|weeks?|months?|years?)\b",
    r"\bhow long ago\b",
    r"\b(?:weeks?|days?|months?|years?) ago\b",
    r"\bago\b",
    r"\bdid i\b",
]


def normalize_temporal_query(q: str) -> str:
    s = q.strip().rstrip("?").strip().lower()
    changed = True
    # Apply leading strips repeatedly (some stack: "how many weeks ago did i").
    while changed:
        changed = False
        for pat in _STRIP:
            new = re.sub(pat, "", s)
            if new != s:
                s, changed = new.strip(), True
    for pat in _INLINE:
        s = re.sub(pat, "", s)
    s = re.sub(r"\s{2,}", " ", s).strip(" ,.")
    # Guard: never return empty or near-empty — fall back to the original.
    if len(s.split()) < 2:
        return q.strip().rstrip("?").strip()
    return s

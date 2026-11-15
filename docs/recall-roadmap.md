# Recall roadmap

Working guide for getting K.Y.T.'s recall to the level of the best published
memory systems. Agreed with the founder on 2026-11-15. Update the checkboxes
and the results table as work lands; do not start a later phase to dodge a
failing earlier one.

## The rule

Every change to search, capture or storage is judged by the recall test set,
run before and after. A change ships when it fixes questions and breaks none,
or when what it breaks is understood and accepted in writing here. Numbers
set from one or two searches are placeholders until the set confirms them.

## Where the design stands

| Part | Strong systems | K.Y.T. on 2026-11-15 |
|---|---|---|
| Finding candidates | Meaning and exact words, fused | Meaning only |
| Deciding relevance | One learned stage over all candidates | A model judge on sections only; the reranker was failing silently |
| Stored unit | An exchange (question with answer), plus facts | Single messages |
| Facts that change | Added, updated, retired, dated | Memory cards only; nothing ever marked replaced |
| Scoring | Relevance first, recency as tiebreak | Relevance multiplied by time decay; year-old turns score near zero |
| Rules | Few | Many hand-set penalties and thresholds |
| Tuning | A fixed question set on every change | A benchmark exists; recent thresholds set by hand |

## Phase 0 — Measure (in progress)

- [x] Scoring library and runner: `validation/recall-eval/` (tests in `tests/unit/recall-eval.test.js`)
- [x] First question set, 52 questions, private (`validation/user_data/`, not in git)
- [ ] Founder reviews the questions; expected answers widened where a sibling turn also answers
- [ ] Baseline run recorded in the results table below
- [ ] Add questions whenever a real failure is found (each bug becomes a question)

Done when: a baseline exists and the founder accepts the set as representative.

## Phase 1 — Find the right candidates

- [ ] Log what the section judge is shown and what it replies
- [ ] Keyword lane for sections: sections containing the question's distinctive words join the candidates
- [ ] Keyword lane for whole turns
- [ ] Strip question scaffolding ("what did you tell me about") from the text that is embedded for search, if the set shows it helps

Done when: no question fails because the right turn was never a candidate.

## Phase 2 — One judge decides

- [ ] Extend the model judge from sections to all candidates (turns, sections, cards)
- [ ] Remove the reranker call from the main path, or give it a working host
- [ ] Retire penalties the judge makes redundant, one at a time, each checked against the set

Done when: relevance is decided in one place and the "returned nothing wrong" questions still pass.

## Phase 3 — Store exchanges

- [ ] Link each reply to the message it answers
- [ ] Embed a reply together with its question; sections carry the question too
- [ ] Show the pair when injecting
- [ ] Backfill existing turns (about 5,000 replies; embeddings only)

Done when: "what did you tell me about X" finds the reply through the question that prompted it.

## Phase 4 — Facts that stay current

- [ ] Merge duplicate entities (same name, different type)
- [ ] Grow memory cards into dated facts with "replaced by"
- [ ] Refresh cards when new evidence arrives, not monthly

Done when: questions about current state ("what is my X now") return the latest value.

## Phase 5 — Graph, only if it earns it

- [ ] Weight relationships by repeat count; ignore single co-occurrences
- [ ] Measure the graph walk on the set with it on and off
- [ ] "Related names" query expansion stays off unless the set shows a gain

## Remove or simplify

- [ ] Time decay out of factual ranking (keep for emotional content if the set supports it)
- [ ] Hand-set thresholds replaced by values the set supports: fast-path scale, section floor and gap, outline rule
- [ ] Page capture retired per platform once re-import is proven there (done for ChatGPT, with a 24-hour fallback)
- [x] Per-chunk question generation during sync (off 2026-11-14; nothing read it)
- [ ] Unused or broken readers: `loadDynamicSynonyms` (wrong column names), the 3-argument `upsert_entity_relationship`

## Capture work that recall depends on

- [ ] Claude Code sessions are not being stored (newest turn 2026-06-10)
- [ ] Gemini re-import fails (`GEMINI_RPC_EMPTY_RESPONSE`)
- [ ] Voice chats: confirm whether memory can be injected
- [ ] Mixed-speaker and mislabelled turns from older page capture

## Results

Run with `node --env-file=.env validation/recall-eval/run.mjs <set.json> --label "<what changed>"`.
Live, read-only; needs the founder's go.

| Date | Commit | What changed | Answer found | In top 3 | Correctly empty | Notes |
|---|---|---|---|---|---|---|
| | | baseline | | | | |

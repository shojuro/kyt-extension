// Whole messages found by the words of the question, to sit beside the ones
// found by meaning. Pure module: tests/unit/keyword-lane.test.js. The search
// itself is the SQL function keyword_turn_candidates.
//
// Why: recall test set, 2026-11-15, run four. The meaning search handed the
// judge 2 to 10 whole messages for most questions, and for "what did I say
// about running around the Beverly Center and Venice Beach?" the message
// that says exactly that was not among them. Ranked by plain word overlap it
// was 310th; with rare words weighted above common ones it was 2nd.

import type { SectionHit } from "./turn-sections.ts";
import { JUDGE_KEYWORD_PASSAGES, TURN_KIND, type TurnCandidate } from "./section-judge.ts";

/** Terms sent to the keyword search at most. */
export const MAX_KEYWORD_TERMS = 8;
/** Rows asked of the keyword search. */
export const KEYWORD_TURN_CANDIDATES = 10;
/** Marks a passage the keyword search found (logs only). */
export const KEYWORD_LANE = "keyword";

// Words that say "this is a question about the past" or carry no topic.
const STOPWORDS = new Set([
    "the", "and", "but", "for", "with", "from", "into", "over", "about", "that", "this", "these", "those",
    "you", "your", "our", "its", "was", "were", "are", "did", "does", "have", "has", "had", "been", "being",
    "what", "which", "who", "whom", "when", "where", "why", "how", "whose", "any", "some", "there", "here",
    "then", "than", "not", "can", "could", "would", "should", "will", "just", "also", "very", "really",
    "tell", "told", "say", "said", "says", "talk", "talked", "talking", "discuss", "discussed", "mention",
    "mentioned", "explain", "explained", "describe", "described", "give", "gave", "share", "shared",
    "remember", "recall", "earlier", "before", "previously", "once", "again", "ago", "last", "first",
    "conversation", "conversations", "chat", "chats", "thing", "things", "something", "anything",
    "between", "one", "two", "three", "like", "get", "got", "let", "lay", "laid", "out", "know",
]);

/** The topic words of a question, in order, without repeats. */
export function keywordTerms(query: unknown, max = MAX_KEYWORD_TERMS): string[] {
    if (typeof query !== "string") return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
        seen.add(word);
        out.push(word);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * Keyword-found messages as passages for the judge, leaving out any the
 * meaning search already supplied. Order is the keyword search's own.
 */
export function keywordPassages(
    candidates: TurnCandidate[],
    alreadyShown: Iterable<string>,
    max = JUDGE_KEYWORD_PASSAGES,
): SectionHit[] {
    const shown = new Set(alreadyShown);
    const out: SectionHit[] = [];
    for (const c of candidates ?? []) {
        if (!c || typeof c.id !== "string" || typeof c.content !== "string" || !c.content.trim()) continue;
        if (shown.has(c.id)) continue;
        shown.add(c.id);
        out.push({
            id: c.id,
            turn_id: c.id,
            kind: TURN_KIND,
            section_index: 0,
            heading: "",
            content: c.content,
            similarity: 0,
            platform: c.platform ?? "unknown",
            speakers: c.speakers ?? [],
            created_at: c.created_at ?? "",
            lane: KEYWORD_LANE,
        } as unknown as SectionHit);
        if (out.length >= max) break;
    }
    return out;
}

// Stored turns that are the user asking an assistant what was said before, or
// an assistant saying it could not find it. They are attempts to recall, not
// memories, and they match a new recall question better than the real answer
// does. Recall test set, 2026-11-15: "what did you tell me about Cyrus?"
// returned that day's failed attempts to ask the same thing.
//
// Deliberately narrow. A reply that answers a recall question with real
// content (a ranked list, a summary) stays: only replies that open by saying
// nothing was found are removed.
// Pure module: tests/unit/recall-attempts.test.js.

const PLACEHOLDER_RE = /(?:`{3}\s*)?This block is not supported on your current device yet\.?(?:\s*`{3})?/gi;

const RECALL_QUESTION_RES: RegExp[] = [
    /\bwhat (?:did|have|had) (?:you|we) (?:tell|told|say|said|talk|talked|discuss|discussed|decide|decided|conclude|determine)\b/i,
    /\bwhat did i (?:say|tell you|mention|share)\b/i,
    /\b(?:do|did|can) you (?:still )?(?:remember|recall)\b/i,
    /\b(?:did|didn['’]?t) (?:you|we) (?:tell|say|talk|discuss|mention)\b/i,
    /\b(?:we|you and i) (?:were|was) (?:just )?(?:talking|discussing|chatting)\b[\s\S]{0,300}\?/i,
    /\bwe(?:['’]ve| have)? (?:been )?(?:talking|talked|discussed|spoken|spoke) (?:about|of)\b[\s\S]{0,300}\?/i,
    /\bwe had (?:a|that) (?:conversation|discussion|chat)\b[\s\S]{0,300}\?/i,
    /\b(?:that|the|those) [\s\S]{0,60}\byou (?:told|gave|said|mentioned|described|explained|listed)\b[\s\S]{0,200}\?/i,
    /\byou (?:told|gave) me\b[\s\S]{0,200}\?/i,
];

const DEFLECTION_OPENING_RES: RegExp[] = [
    /\b(?:couldn['’]?t|could not|can['’]?t|cannot|wasn['’]?t able to|was unable to|am unable to|unable to) (?:find|locate|see|recall|access|confirm|retrieve)\b/i,
    /\bi (?:don['’]?t|do not|didn['’]?t) (?:have|see|recall|remember|find)\b[\s\S]{0,60}\b(?:record|context|memory|memories|conversation|chat|information|access|history)\b/i,
    /\bi (?:still )?(?:searched|looked through|checked|went through) (?:your|our|my|the) (?:past |previous |saved |stored |recent )?(?:chats|conversations|memory|memories|history)\b/i,
    /\bno (?:record|mention|trace) of\b/i,
    /\bnothing (?:about|on|regarding)\b[\s\S]{0,60}\b(?:saved|stored)\b/i,
    /\bgoing by the (?:snippets|excerpts|lines|context) you (?:pasted|shared|provided)\b/i,
    /\bK\.Y\.T\.(?: memory)? (?:brought|injected|pulled in|retrieved|returned)\b/i,
];

/** Characters of a reply read as its opening. */
export const OPENING_CHARS = 350;
/** A user turn longer than this is treated as a statement, whatever it asks. */
export const MAX_RECALL_QUESTION_CHARS = 700;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** True when the text asks an assistant about an earlier conversation. */
export function isRecallQuestion(value: unknown): boolean {
    const t = text(value).trim();
    if (!t) return false;
    return RECALL_QUESTION_RES.some((re) => re.test(t));
}

/** True when a reply opens by saying the earlier conversation was not found. */
export function opensWithDeflection(value: unknown): boolean {
    const opening = text(value).replace(PLACEHOLDER_RE, " ").replace(/\s+/g, " ").trim().slice(0, OPENING_CHARS);
    if (!opening) return false;
    return DEFLECTION_OPENING_RES.some((re) => re.test(opening));
}

interface Stored {
    content?: unknown;
    speakers?: unknown;
}

/**
 * True when a stored turn is an attempt to recall, not a memory:
 *  - an assistant reply that opens with "I couldn't find…";
 *  - a short user turn that asks what was said before;
 *  - a "User: … Assistant: …" chunk whose first user message asks that.
 */
export function isRecallAttempt(turn: Stored): boolean {
    const content = text(turn?.content).trim();
    if (!content) return false;
    const speakers = Array.isArray(turn?.speakers) ? (turn.speakers as unknown[]).map(String) : [];
    const chunk = /^User:\s*/i.exec(content);
    if (chunk) {
        const rest = content.slice(chunk[0].length);
        const end = rest.search(/\s(?:Assistant|User):\s/i);
        return isRecallQuestion(end >= 0 ? rest.slice(0, end) : rest.slice(0, MAX_RECALL_QUESTION_CHARS));
    }
    const assistantOnly = speakers.includes("assistant") && !speakers.includes("user");
    const userOnly = speakers.includes("user") && !speakers.includes("assistant");
    if (assistantOnly) return opensWithDeflection(content);
    if (userOnly) return content.length <= MAX_RECALL_QUESTION_CHARS && isRecallQuestion(content);
    return false;
}

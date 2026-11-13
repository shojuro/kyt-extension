/**
 * Question detector for user turns. Pure module (no Deno or network imports)
 * so the unit tests can load it.
 *
 * A turn tagged as a question is stored without an embedding and is never
 * retrieved, so a false positive silently throws a memory away.
 *
 * Keep in sync with detectIsQuestion in src/context-retrieval.js
 * (the extension cannot import edge-function code).
 */

/** Openers that mark a question or a request ("what...", "list...", "tell me..."). */
export const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;

/**
 * First-person openers. A short prompt that starts this way states a fact
 * about the user ("my codeword is falcon-88", "I live in Bangkok") and must
 * stay searchable.
 */
export const FIRST_PERSON_STATEMENT_RE = /^(my|i|i['’]m|im|i['’]ve|i['’]d|i['’]ll|we|we['’]re|we['’]ve|our|me)\b/i;

const SHORT_PROMPT_CHARS = 60;

export function detectIsQuestionText(content: unknown): boolean {
    const text = (typeof content === "string" ? content : "").trim();
    if (text.endsWith("?")) return true;
    if (INTERROGATIVE_RE.test(text)) return true;
    // Short prompts with no assertion are usually bare requests ("continue",
    // "next one please"), unless they open in the first person.
    if (text.length < SHORT_PROMPT_CHARS && !text.includes(".") && !text.includes("!")) {
        return !FIRST_PERSON_STATEMENT_RE.test(text);
    }
    return false;
}

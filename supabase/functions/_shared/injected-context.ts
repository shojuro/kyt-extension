// The context block K.Y.T. adds to a prompt must never be stored or returned
// as a memory. The extension strips it on capture, but the conversation
// re-import reads the platform's own copy of the message, block included, and
// saves it through save_chat_turn_batch. This module is the server-side strip.
// Pure module: tests/unit/injected-context.test.js.
//
// Keep the patterns in step with stripInjectionPrefix in src/context-retrieval.js.

const BLOCK_START = "\\(For context: I've (?:talked about things like this before|mentioned some of these topics before)";
const BLOCK_END = "(?:I'm sharing these so you have the full picture[^)]*|Do not add specific dates[^)]*)\\)\\s*(?:---\\s*)?";

const BLOCK_RE = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`, "g");
const OPEN_BLOCK_RE = new RegExp(`${BLOCK_START}[\\s\\S]*$`);
const NOTE_RE = /\(K\.Y\.T\. memory check:[^)]*\)\s*(?:---\s*)?/g;

/** Query length under which "the same text as the query" is not judged. */
export const MIN_ECHO_QUERY_CHARS = 30;

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** Text without complete injected blocks. Used when a turn is saved. */
export function stripInjectedContext(content: unknown): string {
    return asText(content)
        .replace(BLOCK_RE, "")
        .replace(NOTE_RE, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * As stripInjectedContext, and also cuts a block whose end is missing. For
 * excerpts and sections, where the block may have been cut in two.
 */
export function stripInjectedContextLoose(content: unknown): string {
    return stripInjectedContext(content).replace(OPEN_BLOCK_RE, "").trim();
}

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * True when a stored text is an earlier asking of the same question: the
 * query, with little or nothing added. It tells the assistant nothing, and
 * it outscores every real answer because it matches the query word for word.
 */
export function isEchoOfQuery(content: unknown, query: unknown): boolean {
    const q = squash(asText(query));
    if (q.length < MIN_ECHO_QUERY_CHARS) return false;
    const c = squash(stripInjectedContextLoose(content));
    if (!c) return false;
    if (c.includes(q)) return c.length <= q.length * 1.5;
    return q.includes(c) && c.length >= q.length * 0.8;
}

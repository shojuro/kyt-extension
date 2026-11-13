// Pull the first complete JSON value out of a model reply. Pure module (no remote
// imports) so it can be unit-tested outside Deno: tests/unit/json-extract.test.js.
//
// Models asked for "JSON only" still add prose after the object, wrap it in a
// ``` fence, or emit a second object. JSON.parse on the whole reply then fails
// with "Unexpected non-whitespace character after JSON" although the first
// object is fine.

export type JsonExtractionReason = "empty" | "no_json" | "truncated";

export class JsonExtractionError extends Error {
    reason: JsonExtractionReason;
    constructor(reason: JsonExtractionReason, message: string) {
        super(message);
        this.name = "JsonExtractionError";
        this.reason = reason;
    }
}

export interface JsonExtractionOptions {
    /** Only accept a top-level object; skip arrays such as "[1]" in the prose. */
    objectOnly?: boolean;
}

/**
 * Index of the character that closes the bracket opened at `start`, or -1 when
 * the text ends first. Brackets inside strings are ignored, and so are escaped
 * quotes inside strings.
 */
function findBalancedEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Return the first complete top-level JSON object or array in `text`.
 *
 * Leading prose, trailing prose, code fences and later JSON values are ignored.
 * A balanced group that is not JSON (for example "{placeholder}") is skipped.
 * A JSON value that is cut off throws with reason "truncated": the scan never
 * falls back to a complete fragment nested inside a cut-off value.
 */
export function extractFirstJson<T = unknown>(text: unknown, options: JsonExtractionOptions = {}): T {
    if (typeof text !== "string" || text.trim().length === 0) {
        throw new JsonExtractionError("empty", "No text to extract JSON from");
    }
    const opener = options.objectOnly ? /\{/g : /[{[]/g;
    let from = 0;
    while (from < text.length) {
        opener.lastIndex = from;
        const match = opener.exec(text);
        if (!match) break;
        const start = match.index;
        const end = findBalancedEnd(text, start);
        if (end === -1) {
            throw new JsonExtractionError("truncated", "JSON value is cut off before its closing bracket");
        }
        try {
            return JSON.parse(text.slice(start, end + 1)) as T;
        } catch {
            // Balanced but not JSON: prose. Look for the next candidate after it.
            from = end + 1;
        }
    }
    throw new JsonExtractionError("no_json", "No JSON value found in text");
}

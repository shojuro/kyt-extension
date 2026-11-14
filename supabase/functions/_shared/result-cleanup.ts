// Last clean-up of search results before they leave search_memories.
// Pure module: tests/unit/result-cleanup.test.js.

import { isEchoOfQuery, stripInjectedContextLoose } from "./injected-context.ts";

// Placeholder text that claude.ai puts where a tool call or widget was shown.
// It was captured as part of assistant replies and came back as "memory".
const UNSUPPORTED_BLOCK_RE = /(?:`{3}\s*)?This block is not supported on your current device yet\.?(?:\s*`{3})?/gi;

/** Minimum characters of real text a result must keep to be worth injecting. */
export const MIN_RESULT_CHARS = 20;

/** Result text without capture placeholders. */
export function cleanResultContent(content: unknown): string {
    return stripInjectedContextLoose(content)
        .replace(UNSUPPORTED_BLOCK_RE, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*\n\s*/g, "\n\n")
        .trim();
}

/**
 * Clean every result's content, drop results with nothing left, and (when the
 * query is given) drop earlier askings of the same question.
 */
export function cleanResults<T extends { content?: unknown }>(results: T[], query?: string): T[] {
    const out: T[] = [];
    for (const item of results ?? []) {
        const content = cleanResultContent(item?.content);
        if (content.length < MIN_RESULT_CHARS) continue;
        if (query && isEchoOfQuery(content, query)) continue;
        out.push(content === item.content ? item : { ...item, content });
    }
    return out;
}

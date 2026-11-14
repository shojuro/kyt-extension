// Model id, request shape, reply reading and prices for the Anthropic calls made
// by the edge functions. Pure module (no remote imports) so it can be
// unit-tested outside Deno: tests/unit/anthropic-model.test.js.

import { extractFirstJson, JsonExtractionError } from "./json-extract.ts";

/** The one model every edge function uses. Change it here only. */
export const ANTHROPIC_MODEL = "claude-haiku-5-5";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

interface ModelProfile {
    /** Adaptive thinking is on by default and effort is set in output_config. */
    adaptiveThinking: boolean;
    /** temperature / top_p / top_k are accepted. */
    sampling: boolean;
    /** USD per token. */
    price: { input: number; output: number };
    /** Rate card for prompts longer than `overTokens` input tokens. */
    longPrompt?: { overTokens: number; input: number; output: number };
    /** Multipliers on the input price. */
    cacheWriteMultiplier: number;
    cacheReadMultiplier: number;
}

const PER_MTOK = 1 / 1_000_000;

const HAIKU_4_5: ModelProfile = {
    adaptiveThinking: false,
    sampling: true,
    price: { input: 1.0 * PER_MTOK, output: 5.0 * PER_MTOK },
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
};

const MODEL_PROFILES: Record<string, ModelProfile> = {
    // $0.10 / $0.50 per MTok for prompts up to 100K tokens, $0.50 / $2.50 beyond.
    // Thinking tokens are billed as output tokens and arrive in usage.output_tokens.
    "claude-haiku-5-5": {
        adaptiveThinking: true,
        sampling: false,
        price: { input: 0.10 * PER_MTOK, output: 0.50 * PER_MTOK },
        longPrompt: { overTokens: 100_000, input: 0.50 * PER_MTOK, output: 2.50 * PER_MTOK },
        cacheWriteMultiplier: 1.25,
        cacheReadMultiplier: 0.1,
    },
    "claude-haiku-4-5": HAIKU_4_5,
    "claude-haiku-4-5-20251001": HAIKU_4_5,
};

function profileFor(model: string): ModelProfile {
    const profile = MODEL_PROFILES[model];
    if (!profile) throw new Error(`No price or capability profile for model "${model}"`);
    return profile;
}

/** Effort for these classification and extraction calls. The model default is "medium". */
export const ANTHROPIC_EFFORT = "low";

// Thinking shares max_tokens with the answer, and the Haiku 5.5 tokenizer counts
// about 30% more tokens for the same text than Haiku 4.5. Callers keep passing
// the size of the answer they want; the request adds room on top.
export const THINKING_HEADROOM_TOKENS = 1024;
export const TOKENIZER_SCALE = 1.3;

/** max_tokens to send for an answer budget of `answerTokens`. */
export function effectiveMaxTokens(model: string, answerTokens: number): number {
    if (!profileFor(model).adaptiveThinking) return answerTokens;
    return Math.ceil(answerTokens * TOKENIZER_SCALE) + THINKING_HEADROOM_TOKENS;
}

/** Replaces the assistant "{" prefill, which Haiku 5.5 rejects with a 400. */
export const JSON_ONLY_INSTRUCTION =
    "\n\nOutput format: respond with a single JSON object and nothing else. " +
    "No text before or after it, no code fences, no second object.";

export interface MessagesBodyInput {
    systemPrompt: string;
    userPrompt: string;
    /** Size of the answer wanted, in tokens. */
    maxTokens: number;
    /** Sent only to models that accept sampling parameters. */
    temperature?: number;
    enableCache?: boolean;
    /** Ask for a single JSON object. */
    json?: boolean;
    model?: string;
}

/** Body for POST /v1/messages. Always ends with the user turn: no prefill. */
export function buildMessagesBody(input: MessagesBodyInput): Record<string, unknown> {
    const model = input.model ?? ANTHROPIC_MODEL;
    const profile = profileFor(model);
    const systemText = input.json ? input.systemPrompt + JSON_ONLY_INSTRUCTION : input.systemPrompt;

    const body: Record<string, unknown> = {
        model,
        system: input.enableCache
            ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
            : systemText,
        messages: [{ role: "user", content: input.userPrompt }],
        max_tokens: effectiveMaxTokens(model, input.maxTokens),
    };
    if (profile.adaptiveThinking) {
        // Thinking off: left adaptive, these short extraction and classification
        // calls spent about two thirds of their output tokens on it (2026-11-13:
        // ~1,090 output tokens per entity extraction against ~380 of answer).
        body.thinking = { type: "disabled" };
        body.output_config = { effort: ANTHROPIC_EFFORT };
    }
    if (profile.sampling && typeof input.temperature === "number") {
        body.temperature = input.temperature;
    }
    return body;
}

/** Text of the first `text` block. A reply can start with `thinking` blocks. */
export function firstText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    for (const block of content) {
        if (block && block.type === "text" && typeof block.text === "string") return block.text;
    }
    return "";
}

export type ReplyFailureKind = "refusal" | "truncated" | "empty" | "parse";

/** The API answered (and billed), but the reply cannot be used. */
export class AnthropicReplyError extends Error {
    kind: ReplyFailureKind;
    constructor(kind: ReplyFailureKind, message: string) {
        super(message);
        this.name = "AnthropicReplyError";
        this.kind = kind;
    }
}

/** Throws AnthropicReplyError when the model declined the request. */
export function assertNotRefused(data: { stop_reason?: string } | null | undefined): void {
    if (data?.stop_reason === "refusal") {
        throw new AnthropicReplyError("refusal", "Anthropic declined the request (stop_reason: refusal)");
    }
}

/** Read the JSON object out of a Messages API response. */
export function readJsonReply<T = Record<string, unknown>>(
    data: { stop_reason?: string; content?: unknown } | null | undefined,
): T {
    assertNotRefused(data);
    const text = firstText(data?.content);
    const cutOff = data?.stop_reason === "max_tokens";
    try {
        return extractFirstJson<T>(text, { objectOnly: true });
    } catch (e) {
        const reason = e instanceof JsonExtractionError ? e.reason : "no_json";
        if (cutOff || reason === "truncated") {
            throw new AnthropicReplyError("truncated", `Anthropic reply was cut off before the JSON ended (stop_reason: ${data?.stop_reason})`);
        }
        if (reason === "empty") {
            throw new AnthropicReplyError("empty", "Anthropic reply has no text block");
        }
        throw new AnthropicReplyError("parse", `Failed to parse JSON from Anthropic response: ${(e as Error).message}`);
    }
}

export interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/** Estimated cost in USD of one response, from its `usage` block. */
export function estimateCostUsd(model: string, usage: AnthropicUsage | null | undefined): number {
    const profile = profileFor(model);
    const input = usage?.input_tokens || 0;
    const output = usage?.output_tokens || 0;
    const cacheWrite = usage?.cache_creation_input_tokens || 0;
    const cacheRead = usage?.cache_read_input_tokens || 0;

    const promptTokens = input + cacheWrite + cacheRead;
    const rate = profile.longPrompt && promptTokens > profile.longPrompt.overTokens
        ? profile.longPrompt
        : profile.price;

    return input * rate.input +
        output * rate.output +
        cacheWrite * rate.input * profile.cacheWriteMultiplier +
        cacheRead * rate.input * profile.cacheReadMultiplier;
}

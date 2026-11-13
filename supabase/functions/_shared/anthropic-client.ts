/**
 * Anthropic Client for K.Y.T. LLM Operations
 *
 * Unified client for Claude Haiku chat completions (model id: ANTHROPIC_MODEL in
 * anthropic-model.ts). Used across all server-side LLM call sites: intent
 * classification, HyDE generation, context generation, memory classification,
 * entity extraction.
 *
 * The request body, reply reading and prices live in anthropic-model.ts, which
 * is pure and unit-tested (tests/unit/anthropic-model.test.js).
 */

import { retryWrapper, CostMonitor, Logger } from "./utils.ts";
import {
    ANTHROPIC_MODEL,
    ANTHROPIC_MESSAGES_URL,
    ANTHROPIC_VERSION,
    AnthropicReplyError,
    type AnthropicUsage,
    assertNotRefused,
    buildMessagesBody,
    estimateCostUsd,
    firstText,
    readJsonReply,
} from "./anthropic-model.ts";

export interface CompletionOptions {
    /** Ignored by models that reject sampling parameters (Haiku 5.5). */
    temperature?: number;
    /** Size of the answer wanted. The request adds room for thinking on top. */
    maxTokens?: number;
    maxRetries?: number;
    timeoutMs?: number;
    operation?: string;
    enableCache?: boolean;
}

export interface ClientContext {
    userId?: string;
    edgeFunction?: string;
}

interface MessagesResponse {
    content?: unknown;
    stop_reason?: string;
    usage?: AnthropicUsage;
}

export class AnthropicClient {
    private apiKey: string;
    private context: ClientContext;
    private static readonly MODEL = ANTHROPIC_MODEL;
    private static readonly API_URL = ANTHROPIC_MESSAGES_URL;

    constructor(apiKey: string, context: ClientContext = {}) {
        this.apiKey = apiKey;
        this.context = context;
    }

    /**
     * One Messages API call, retried on API and network errors only. What the
     * caller does with the reply (parsing) happens outside the retry, so an
     * unusable reply is not paid for again.
     */
    private callMessages(
        body: Record<string, unknown>,
        retry: { maxRetries: number; timeoutMs: number },
        operation: string,
        requestId?: string
    ): Promise<MessagesResponse> {
        return retryWrapper(async () => {
            const response = await fetch(AnthropicClient.API_URL, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": ANTHROPIC_VERSION,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                // Cancel the request when the retry wrapper gives up on it, so an
                // abandoned attempt does not keep generating.
                signal: AbortSignal.timeout(retry.timeoutMs)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Anthropic API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as MessagesResponse;

            // Fire-and-forget: cost logging must never block the completion
            this.logCost(data, operation, requestId).catch(err =>
                Logger.warn(`Cost logging failed (non-fatal): ${err.message}`, { requestId })
            );

            return data;
        }, { maxRetries: retry.maxRetries, baseDelayMs: 300, timeoutMs: retry.timeoutMs });
    }

    /**
     * Generate a text completion via the Anthropic Messages API.
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message
     * @param options - Generation options (maxTokens, retries, timeout, operation)
     * @param requestId - Request ID for tracing
     * @returns Generated text content
     * @throws AnthropicReplyError (kind "refusal") when the model declines
     */
    async generateCompletion(
        systemPrompt: string,
        userPrompt: string,
        options: CompletionOptions = {},
        requestId?: string
    ): Promise<string> {
        const {
            temperature = 0.0,
            maxTokens = 50,
            maxRetries = 1,
            timeoutMs = 3000,
            operation = "completion",
        } = options;

        const data = await this.callMessages(
            buildMessagesBody({ systemPrompt, userPrompt, maxTokens, temperature, enableCache: options.enableCache }),
            { maxRetries, timeoutMs },
            operation,
            requestId
        );

        assertNotRefused(data);
        const content = firstText(data.content).trim();
        if (!content && data.stop_reason === "max_tokens") {
            Logger.warn("Anthropic reply hit max_tokens before any text", { requestId, operation });
        }
        return content;
    }

    /**
     * Generate a JSON completion.
     *
     * The system prompt asks for a single JSON object (no assistant prefill:
     * Haiku 5.5 rejects it), and the first complete object in the reply is
     * parsed, so prose or a code fence around it does not fail the call.
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message
     * @param options - Generation options
     * @param requestId - Request ID for tracing
     * @returns Parsed JSON object
     * @throws AnthropicReplyError when the reply is a refusal, cut off, empty or not JSON
     */
    async generateJsonCompletion<T = Record<string, unknown>>(
        systemPrompt: string,
        userPrompt: string,
        options: CompletionOptions = {},
        requestId?: string
    ): Promise<T> {
        const {
            temperature = 0.0,
            maxTokens = 300,
            maxRetries = 1,
            timeoutMs = 5000,
            operation = "json_completion",
        } = options;

        const data = await this.callMessages(
            buildMessagesBody({ systemPrompt, userPrompt, maxTokens, temperature, enableCache: options.enableCache, json: true }),
            { maxRetries, timeoutMs },
            operation,
            requestId
        );

        try {
            return readJsonReply<T>(data);
        } catch (e) {
            Logger.warn("JSON parse failed from Anthropic response", {
                requestId,
                operation,
                kind: e instanceof AnthropicReplyError ? e.kind : "unknown",
                stopReason: data.stop_reason,
                outputTokens: data.usage?.output_tokens,
                preview: firstText(data.content).substring(0, 200),
                error: (e as Error).message,
            });
            throw e;
        }
    }

    /**
     * Count tokens in a text string using the Anthropic token counting API.
     * This endpoint is FREE with separate rate limits (100-8000 RPM by tier).
     */
    async countTokens(text: string): Promise<number> {
        const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
            method: "POST",
            headers: {
                "x-api-key": this.apiKey,
                "anthropic-version": ANTHROPIC_VERSION,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: AnthropicClient.MODEL,
                messages: [{ role: "user", content: text }]
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Token count API error: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        return data.input_tokens;
    }

    /**
     * Log API usage cost to the cost_tracking table.
     * Thinking tokens are part of usage.output_tokens and are priced as output.
     */
    private async logCost(
        data: { usage?: AnthropicUsage },
        operation: string,
        requestId?: string
    ): Promise<void> {
        const inputTokens = data.usage?.input_tokens || 0;
        const outputTokens = data.usage?.output_tokens || 0;
        const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
        const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;

        const estimatedCost = estimateCostUsd(AnthropicClient.MODEL, data.usage);

        await CostMonitor.logUsage({
            service: "anthropic",
            model: AnthropicClient.MODEL,
            operation,
            cost: estimatedCost,
            requestId,
            userId: this.context.userId,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            edgeFunction: this.context.edgeFunction,
        });

        Logger.info("Anthropic completion generated", {
            requestId,
            model: AnthropicClient.MODEL,
            operation,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            estimatedCost
        });
    }
}

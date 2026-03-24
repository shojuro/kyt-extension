/**
 * Anthropic Client for K.Y.T. LLM Operations
 *
 * Unified client for Claude Haiku 4.5 chat completions.
 * Used across all server-side LLM call sites: intent classification,
 * HyDE generation, context generation, memory classification, entity extraction.
 *
 * Supports both text and JSON completions (via prefill trick).
 */

import { retryWrapper, CostMonitor, Logger } from "./utils.ts";

export interface CompletionOptions {
    temperature?: number;
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

export class AnthropicClient {
    private apiKey: string;
    private context: ClientContext;
    private static readonly MODEL = "claude-haiku-4-5-20251001";
    private static readonly API_URL = "https://api.anthropic.com/v1/messages";

    constructor(apiKey: string, context: ClientContext = {}) {
        this.apiKey = apiKey;
        this.context = context;
    }

    /**
     * Generate a text completion via the Anthropic Messages API.
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message
     * @param options - Generation options (temperature, maxTokens, retries, timeout, operation)
     * @param requestId - Request ID for tracing
     * @returns Generated text content
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

        return retryWrapper(async () => {
            const response = await fetch(AnthropicClient.API_URL, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: AnthropicClient.MODEL,
                    system: options.enableCache
                        ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
                        : systemPrompt,
                    messages: [
                        { role: "user", content: userPrompt }
                    ],
                    temperature,
                    max_tokens: maxTokens
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Anthropic API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const content = data.content?.[0]?.text?.trim() || "";

            // Fire-and-forget: cost logging must never block the completion
            this.logCost(data, operation, requestId).catch(err =>
                Logger.warn(`Cost logging failed (non-fatal): ${err.message}`, { requestId })
            );

            return content;
        }, { maxRetries, baseDelayMs: 300, timeoutMs });
    }

    /**
     * Generate a JSON completion using the Anthropic prefill trick.
     *
     * Sends an assistant prefill message starting with '{', then prepends '{'
     * to the response and parses as JSON. This forces structured JSON output
     * without needing a response_format parameter.
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message
     * @param options - Generation options
     * @param requestId - Request ID for tracing
     * @returns Parsed JSON object
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

        return retryWrapper(async () => {
            const response = await fetch(AnthropicClient.API_URL, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: AnthropicClient.MODEL,
                    system: options.enableCache
                        ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
                        : systemPrompt,
                    messages: [
                        { role: "user", content: userPrompt },
                        { role: "assistant", content: "{" }
                    ],
                    temperature,
                    max_tokens: maxTokens
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Anthropic API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const rawContent = data.content?.[0]?.text || "";

            // Prepend the '{' we used as prefill
            const jsonString = "{" + rawContent;

            // Diagnostic: log raw response for classifier debugging
            if (operation === 'memory_classification') {
                console.log(`[anthropic] ${operation}: status=${response.status}, stop=${data.stop_reason}, rawLen=${rawContent.length}, preview=${jsonString.substring(0, 150)}`);
            }

            // Fire-and-forget: cost logging must never block the completion
            this.logCost(data, operation, requestId).catch(err =>
                Logger.warn(`Cost logging failed (non-fatal): ${err.message}`, { requestId })
            );

            try {
                return JSON.parse(jsonString) as T;
            } catch (e) {
                Logger.warn("JSON parse failed from Anthropic response", {
                    requestId,
                    preview: jsonString.substring(0, 200),
                    error: (e as Error).message,
                });
                throw new Error(`Failed to parse JSON from Anthropic response: ${(e as Error).message}`);
            }
        }, { maxRetries, baseDelayMs: 300, timeoutMs });
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
                "anthropic-version": "2023-06-01",
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
     */
    private async logCost(
        data: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } },
        operation: string,
        requestId?: string
    ): Promise<void> {
        const inputTokens = data.usage?.input_tokens || 0;
        const outputTokens = data.usage?.output_tokens || 0;
        const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
        const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;

        // Haiku 4.5 pricing: $1.00/MTok input, $5.00/MTok output, $1.25/MTok cache write, $0.10/MTok cache read
        const estimatedCost =
            (inputTokens * 0.000001) +
            (outputTokens * 0.000005) +
            (cacheCreationTokens * 0.00000125) +
            (cacheReadTokens * 0.0000001);

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

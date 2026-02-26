/**
 * Anthropic Client for Intent Classification (Layer 2)
 *
 * Lightweight client for Claude Haiku 4.5 chat completions.
 * Used as the LLM judge for ambiguous PASSIVE intent classifications.
 */

import { retryWrapper, CostMonitor, Logger } from "./utils.ts";

export class AnthropicClient {
    private apiKey: string;
    private static readonly MODEL = "claude-haiku-4-5-20251001";
    private static readonly API_URL = "https://api.anthropic.com/v1/messages";

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Generate a message completion via the Anthropic Messages API.
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message
     * @param options - Generation options
     * @param requestId - Request ID for tracing
     * @returns Generated text content
     */
    async generateCompletion(
        systemPrompt: string,
        userPrompt: string,
        options: {
            temperature?: number;
            maxTokens?: number;
        } = {},
        requestId?: string
    ): Promise<string> {
        const { temperature = 0.0, maxTokens = 50 } = options;

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
                    system: systemPrompt,
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

            // Haiku 4.5 pricing: $0.80/1M input, $4.00/1M output
            const inputTokens = data.usage?.input_tokens || 150;
            const outputTokens = data.usage?.output_tokens || 10;
            const estimatedCost = (inputTokens * 0.0000008) + (outputTokens * 0.000004);

            await CostMonitor.logUsage(
                "anthropic",
                AnthropicClient.MODEL,
                "intent_classification",
                estimatedCost,
                requestId
            );

            Logger.info("Anthropic completion generated", {
                requestId,
                model: AnthropicClient.MODEL,
                inputTokens,
                outputTokens,
                estimatedCost
            });

            return content;
        }, { maxRetries: 1, baseDelayMs: 300, timeoutMs: 4000 });
    }
}

/**
 * OpenAI Client for HyDE Generation
 *
 * Lightweight client for GPT-4o-mini chat completions.
 * Used for generating hypothetical documents in the HyDE pipeline.
 */

import { retryWrapper, CostMonitor, Logger } from "./utils.ts";

export class OpenAIClient {
    private apiKey: string;
    private static readonly MODEL = "gpt-4o-mini";
    private static readonly API_URL = "https://api.openai.com/v1/chat/completions";

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Generate a chat completion
     *
     * @param systemPrompt - System message for the model
     * @param userPrompt - User message (the query)
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
        const { temperature = 0.7, maxTokens = 300 } = options;

        return retryWrapper(async () => {
            const response = await fetch(OpenAIClient.API_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: OpenAIClient.MODEL,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature,
                    max_tokens: maxTokens
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content?.trim() || "";

            // Log cost
            // GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
            // Estimate: ~200 input tokens, ~150 output tokens = ~$0.0001
            const inputTokens = data.usage?.prompt_tokens || 200;
            const outputTokens = data.usage?.completion_tokens || 150;
            const estimatedCost = (inputTokens * 0.00000015) + (outputTokens * 0.0000006);

            await CostMonitor.logUsage(
                "openai",
                OpenAIClient.MODEL,
                "hyde_generation",
                estimatedCost,
                requestId
            );

            Logger.info("OpenAI completion generated", {
                requestId,
                model: OpenAIClient.MODEL,
                inputTokens,
                outputTokens,
                estimatedCost
            });

            return content;
        }, { maxRetries: 2, baseDelayMs: 500, timeoutMs: 8000 });
    }
}

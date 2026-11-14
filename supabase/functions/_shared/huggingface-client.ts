
import { retryWrapper, CostMonitor } from "./utils.ts";
import type { ClientContext } from "./anthropic-client.ts";
import { embedWithFallback, PROVIDER_TIMEOUT_MS } from "./embedding-provider.ts";
import type { EmbeddingProvider } from "./embedding-provider.ts";
import { RERANK_MODEL, RERANK_TIMEOUT_MS, rerankProviders, rerankWithFallback } from "./rerank-provider.ts";

// Each attempt tries every provider once, so few attempts are needed. The
// attempt timeout leaves room for both providers to time out in turn.
const EMBEDDING_RETRY = { maxRetries: 2, baseDelayMs: 1000, timeoutMs: PROVIDER_TIMEOUT_MS * 2 + 1000 };

export class HuggingFaceClient {
    private apiKey: string;
    private context: ClientContext;
    // Label used in cost logs; kept stable so cost rows group across provider changes.
    private static readonly EMBEDDING_COST_LABEL = "qwen3-embedding-8b";

    constructor(apiKey: string, context: ClientContext = {}) {
        this.apiKey = apiKey;
        this.context = context;
    }

    /** POST one embeddings request to one provider; throws "<label> API Error: NNN - ..." on failure. */
    private async postEmbedding(
        provider: EmbeddingProvider,
        body: { input: string | string[]; model: string },
        label: string,
    ): Promise<unknown> {
        const response = await fetch(provider.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${label} API Error: ${response.status} - ${errorText}`);
        }
        return response.json();
    }

    async generateEmbeddings(text: string, requestId?: string): Promise<number[][]> {
        // Providers and their order live in embedding-provider.ts.
        // Graceful degradation: if all attempts fail, the circuit breaker catches it
        // and messages sync with null embeddings (backfill alarm fills them later).
        return retryWrapper(async () => {
            const vectors = await embedWithFallback(
                text,
                (provider, body) => this.postEmbedding(provider, body, "HF Embedding"),
            );

            // Log cost (approx $0.0001 per request)
            await CostMonitor.logUsage({
                service: "huggingface",
                model: HuggingFaceClient.EMBEDDING_COST_LABEL,
                operation: "embedding",
                cost: 0.0001,
                requestId,
                userId: this.context.userId,
                inputTokens: Math.ceil(text.length / 4),
                edgeFunction: this.context.edgeFunction,
            });

            return vectors;
        }, EMBEDDING_RETRY);
    }

    /**
     * Generate embeddings for multiple texts in a single API call
     *
     * @param texts - Array of texts to embed (max 50 recommended)
     * @param requestId - Request ID for tracing
     * @returns Array of embedding arrays (1024 dimensions each, Matryoshka-truncated from 4096)
     */
    async generateEmbeddingsBatch(texts: string[], requestId?: string): Promise<number[][]> {
        if (texts.length === 0) return [];

        return retryWrapper(async () => {
            const vectors = await embedWithFallback(
                texts,
                (provider, body) => this.postEmbedding(provider, body, "HF Batch Embedding"),
            );

            // Log cost (approx $0.0001 per text in batch)
            const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
            await CostMonitor.logUsage({
                service: "huggingface",
                model: HuggingFaceClient.EMBEDDING_COST_LABEL,
                operation: "embedding_batch",
                cost: 0.0001 * texts.length,
                requestId,
                userId: this.context.userId,
                inputTokens: Math.ceil(totalChars / 4),
                edgeFunction: this.context.edgeFunction,
            });

            return vectors;
        }, EMBEDDING_RETRY);
    }

    async rerank(query: string, documents: string[], requestId?: string): Promise<HFRerankResponse[]> {
        if (!Array.isArray(documents) || documents.length === 0) return [];
        const result = await rerankWithFallback(query, documents, async (provider, body) => {
            const response = await fetch(provider.url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`${response.status} - ${(await response.text()).slice(0, 160)}`);
            }
            return await response.json();
        }, rerankProviders(Deno.env.get("RERANK_ENDPOINT_URL")));
        if (result.failures.length > 0) {
            console.warn(`Rerank served by ${result.provider} after: ${result.failures.join(" | ")}`, { requestId });
        }

        // Log cost (approx $0.00005 per request)
        await CostMonitor.logUsage({
            service: "huggingface",
            model: RERANK_MODEL,
            operation: "rerank",
            cost: 0.00005,
            requestId,
            userId: this.context.userId,
            inputTokens: Math.ceil((query.length + documents.join('').length) / 4),
            edgeFunction: this.context.edgeFunction,
        });
        return result.scores;
    }
}

export interface HFRerankResponse {
    index: number;
    score: number;
}

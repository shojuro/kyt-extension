
import { retryWrapper, CostMonitor } from "./utils.ts";
import type { ClientContext } from "./anthropic-client.ts";
import { embedWithFallback, PROVIDER_TIMEOUT_MS } from "./embedding-provider.ts";
import type { EmbeddingProvider } from "./embedding-provider.ts";

// Each attempt tries every provider once, so few attempts are needed. The
// attempt timeout leaves room for both providers to time out in turn.
const EMBEDDING_RETRY = { maxRetries: 2, baseDelayMs: 1000, timeoutMs: PROVIDER_TIMEOUT_MS * 2 + 1000 };

export class HuggingFaceClient {
    private apiKey: string;
    private context: ClientContext;
    // Label used in cost logs; kept stable so cost rows group across provider changes.
    private static readonly EMBEDDING_COST_LABEL = "qwen3-embedding-8b";
    private static readonly RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
    // Reranking still goes through the Scaleway route; callers fall back when it fails.
    private static readonly HF_ROUTER_URL = "https://router.huggingface.co/scaleway";

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
        const url = `${HuggingFaceClient.HF_ROUTER_URL}/v1/rerank`;

        return retryWrapper(async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    query,
                    documents,
                    model: HuggingFaceClient.RERANK_MODEL,
                    return_documents: false
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Rerank API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Log cost (approx $0.00005 per request)
            await CostMonitor.logUsage({
                service: "huggingface",
                model: HuggingFaceClient.RERANK_MODEL,
                operation: "rerank",
                cost: 0.00005,
                requestId,
                userId: this.context.userId,
                inputTokens: Math.ceil((query.length + documents.join('').length) / 4),
                edgeFunction: this.context.edgeFunction,
            });

            const results = data.results ?? data;
            if (!Array.isArray(results)) {
                console.warn(`Rerank returned non-array: ${typeof results}`, { requestId });
                return [];
            }
            return results;
        });
    }
}

export interface HFRerankResponse {
    index: number;
    score: number;
}

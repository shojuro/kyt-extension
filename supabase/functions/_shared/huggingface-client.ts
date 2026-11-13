
import { retryWrapper, CostMonitor } from "./utils.ts";
import type { ClientContext } from "./anthropic-client.ts";
import { buildEmbeddingRequest, parseEmbeddingResponse } from "./embedding-provider.ts";

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

    async generateEmbeddings(text: string, requestId?: string): Promise<number[][]> {
        const { url, body } = buildEmbeddingRequest(text);

        // Enhanced resilience: 5 retries with longer backoff for provider outages.
        // Route and model live in embedding-provider.ts.
        // Graceful degradation: if all retries fail, circuit breaker catches it
        // and messages sync with null embeddings (backfill alarm fills them later).
        return retryWrapper(async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Embedding API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

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

            return parseEmbeddingResponse(data);
        }, { maxRetries: 5, baseDelayMs: 1000, timeoutMs: 15000 });
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

        const { url, body } = buildEmbeddingRequest(texts);

        // Enhanced resilience: 5 retries, 15s timeout, 403-aware backoff.
        return retryWrapper(async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Batch Embedding API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

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

            return parseEmbeddingResponse(data);
        }, { maxRetries: 5, baseDelayMs: 1000, timeoutMs: 15000 });
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

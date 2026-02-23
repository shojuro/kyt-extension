
import { retryWrapper, CostMonitor } from "./utils.ts";

export class HuggingFaceClient {
    private apiKey: string;
    private static readonly EMBEDDING_MODEL = "qwen3-embedding-8b";
    private static readonly RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
    // HuggingFace Router for Scaleway embeddings (works with HF API key)
    private static readonly SCALEWAY_API_URL = "https://router.huggingface.co/scaleway";
    // HuggingFace Inference API for reranking (Scaleway router)
    private static readonly HF_ROUTER_URL = "https://router.huggingface.co/scaleway";

    // Matryoshka truncation target: 1024d enables HNSW indexing (pgvector 0.8.0 caps at 2000d)
    private static readonly TARGET_DIMS = 1024;

    /**
     * Matryoshka truncation + L2 normalization.
     * Qwen3-Embedding-8B natively supports MRL — the first N dimensions of
     * the full 4096-dim vector form a valid lower-dimensional embedding.
     * Re-normalizing after truncation is required for cosine similarity.
     */
    private static truncateAndNormalize(embedding: number[], dims: number): number[] {
        const truncated = embedding.slice(0, dims);
        const norm = Math.sqrt(truncated.reduce((sum, val) => sum + val * val, 0));
        if (norm === 0) return truncated;
        return truncated.map(val => val / norm);
    }

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async generateEmbeddings(text: string, requestId?: string): Promise<number[][]> {
        // Use direct Scaleway API for embeddings (more reliable)
        const url = `${HuggingFaceClient.SCALEWAY_API_URL}/v1/embeddings`;

        return retryWrapper(async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    input: text,
                    model: HuggingFaceClient.EMBEDDING_MODEL
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Embedding API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Log cost (approx $0.0001 per request)
            await CostMonitor.logUsage(
                "huggingface",
                HuggingFaceClient.EMBEDDING_MODEL,
                "embedding",
                0.0001,
                requestId
            );

            return data.data.map((item: any) =>
                HuggingFaceClient.truncateAndNormalize(item.embedding, HuggingFaceClient.TARGET_DIMS)
            );
        });
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

        const url = `${HuggingFaceClient.SCALEWAY_API_URL}/v1/embeddings`;

        return retryWrapper(async () => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    input: texts, // Array of strings for batch
                    model: HuggingFaceClient.EMBEDDING_MODEL
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Batch Embedding API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Log cost (approx $0.0001 per text in batch)
            await CostMonitor.logUsage(
                "huggingface",
                HuggingFaceClient.EMBEDDING_MODEL,
                "embedding_batch",
                0.0001 * texts.length,
                requestId
            );

            // Scaleway returns embeddings sorted by index, but ensure order
            const sortedData = data.data.sort((a: any, b: any) => a.index - b.index);
            return sortedData.map((item: any) =>
                HuggingFaceClient.truncateAndNormalize(item.embedding, HuggingFaceClient.TARGET_DIMS)
            );
        });
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
            await CostMonitor.logUsage(
                "huggingface",
                HuggingFaceClient.RERANK_MODEL,
                "rerank",
                0.00005,
                requestId
            );

            return data.results || data;
        });
    }
}

export interface HFRerankResponse {
    index: number;
    score: number;
}

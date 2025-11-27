// OpenAI-compatible endpoint for Nebius via HF Router
export const HF_ROUTER_URL = "https://router.huggingface.co/nebius/v1";
export const HF_INFERENCE_URL = "https://api-inference.huggingface.co/models";

// Models
export const EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";
export const RERANKING_MODEL = "BAAI/bge-reranker-v2-m3";

export interface HFEmbeddingResponse {
    object: string;
    data: {
        object: string;
        embedding: number[];
        index: number;
    }[];
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

export interface HFRerankResponse {
    index: number;
    score: number;
}

export class HuggingFaceClient {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Generate embeddings using OpenAI-compatible endpoint (Nebius/HF Router)
     * @param inputs Single string or array of strings
     * @returns Array of embedding vectors
     */
    async generateEmbeddings(inputs: string | string[]): Promise<number[][]> {
        const url = `${HF_ROUTER_URL}/embeddings`;

        // Ensure inputs is an array
        const inputList = Array.isArray(inputs) ? inputs : [inputs];

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: EMBEDDING_MODEL,
                    input: inputList,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Router Error (${response.status}): ${errorText}`);
            }

            const result = await response.json() as HFEmbeddingResponse;

            // Extract embeddings in order
            return result.data.sort((a, b) => a.index - b.index).map(item => item.embedding);

        } catch (error) {
            console.error("HF Embedding Error:", error);
            throw error;
        }
    }

    /**
     * Rerank a list of documents against a query (Standard Inference API)
     * @param query The search query
     * @param documents List of document texts to rerank
     * @returns Array of { index, score } sorted by score descending
     */
    async rerank(query: string, documents: string[]): Promise<HFRerankResponse[]> {
        const url = `${HF_ROUTER_URL}/rerank`;

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: {
                        source_sentence: query,
                        sentences: documents
                    },
                    options: { wait_for_model: true }
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HF Rerank Error (${response.status}): ${errorText}`);
            }

            const result = await response.json() as HFRerankResponse[];

            return result.sort((a, b) => b.score - a.score);

        } catch (error) {
            console.error("HF Reranking Error:", error);
            throw error;
        }
    }
}

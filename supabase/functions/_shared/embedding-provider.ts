/**
 * Embedding provider route: where embedding requests go and how the reply is
 * turned into stored vectors. Pure module (no Deno or network imports) so the
 * unit tests can load it.
 *
 * Provider history:
 * - Until 2026-11-13: Scaleway through the Hugging Face router. Hugging Face
 *   then refused it with HTTP 402 "Pay-as-you go is not enabled for provider
 *   scaleway yet".
 * - Since 2026-11-13: DeepInfra through the same router, same model. Vectors
 *   were checked against stored ones (cosine 0.998+), so old and new rows
 *   stay comparable.
 */

/** OpenAI-compatible embeddings endpoint (billed to the Hugging Face account). */
export const EMBEDDING_URL = "https://router.huggingface.co/deepinfra/v1/openai/embeddings";

/** Model id as DeepInfra expects it (the Hugging Face Hub id). */
export const EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";

/** Matryoshka truncation target: 1024d enables HNSW indexing (pgvector caps at 2000d). */
export const TARGET_DIMS = 1024;

export function buildEmbeddingRequest(input: string | string[]): {
    url: string;
    body: { input: string | string[]; model: string };
} {
    return { url: EMBEDDING_URL, body: { input, model: EMBEDDING_MODEL } };
}

/**
 * Matryoshka truncation + L2 normalization.
 * Qwen3-Embedding-8B natively supports MRL: the first N dimensions of the
 * full 4096-dim vector form a valid lower-dimensional embedding.
 * Re-normalizing after truncation is required for cosine similarity.
 */
export function truncateAndNormalize(embedding: number[], dims: number): number[] {
    const truncated = embedding.slice(0, dims);
    const norm = Math.sqrt(truncated.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return truncated;
    return truncated.map((val) => val / norm);
}

/**
 * Turn an OpenAI-style embeddings reply into stored vectors, in input order.
 * Throws when the reply has no data or a vector is shorter than TARGET_DIMS,
 * so a provider change can never write vectors of the wrong size.
 */
export function parseEmbeddingResponse(data: any): number[][] {
    if (!data || !Array.isArray(data.data)) {
        throw new Error("HF Embedding API returned an unexpected response (no data array)");
    }
    const sorted = [...data.data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item: any) => {
        const embedding = item?.embedding;
        if (!Array.isArray(embedding) || embedding.length < TARGET_DIMS) {
            const got = Array.isArray(embedding) ? embedding.length : typeof embedding;
            throw new Error(
                `HF Embedding API returned an unexpected response (vector of ${got}, need at least ${TARGET_DIMS} dims)`
            );
        }
        return truncateAndNormalize(embedding, TARGET_DIMS);
    });
}

// Where the cross-encoder (reranker) runs, and how each provider is asked.
// Pure module: tests/unit/rerank-provider.test.js.
//
// 2026-11-14: the Scaleway route answered every call with
// "Model not supported by provider scaleway", so search fell back to
// un-reranked order without anyone noticing. Hugging Face's own inference
// provider lists the model as live (task: text-classification), so it is
// tried first; Scaleway stays as the second choice.

export const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
/** Characters of each document sent to the reranker. */
export const RERANK_DOC_CHARS = 4000;
export const RERANK_TIMEOUT_MS = 10000;

export interface RerankScore {
    index: number;
    score: number;
}

export interface RerankProvider {
    name: string;
    url: string;
    body: (query: string, documents: string[]) => unknown;
    /** Scores from the provider's reply; throws when the reply is not usable. */
    parse: (data: unknown, count: number) => RerankScore[];
}

/**
 * Reply to a batch of {text, text_pair} inputs: one entry per pair, each a
 * {label, score} or a list of them (one label for this model).
 */
export function parsePairScores(data: unknown, count: number): RerankScore[] {
    let rows: unknown = data;
    // A single pair may come back as [[{label, score}]] or [{label, score}].
    if (Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && count > 1 && rows[0].length === count) {
        rows = rows[0];
    }
    if (!Array.isArray(rows) || rows.length !== count) {
        throw new Error(`unexpected rerank reply shape (${Array.isArray(rows) ? `${rows.length} rows for ${count} pairs` : typeof rows})`);
    }
    return rows.map((row, index) => {
        const entry = Array.isArray(row) ? row[0] : row;
        const score = typeof entry === "number" ? entry : (entry as { score?: unknown })?.score;
        if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new Error(`rerank reply row ${index} has no score`);
        }
        return { index, score };
    });
}

/** Reply of a "/v1/rerank" endpoint: {results: [{index, relevance_score | score}]}. */
export function parseRerankResults(data: unknown, count: number): RerankScore[] {
    const results = (data as { results?: unknown })?.results ?? data;
    if (!Array.isArray(results)) throw new Error("unexpected rerank reply shape (not a list)");
    const out: RerankScore[] = [];
    for (const r of results as Array<Record<string, unknown>>) {
        const index = r?.index;
        const score = typeof r?.relevance_score === "number" ? r.relevance_score : r?.score;
        if (typeof index === "number" && index >= 0 && index < count && typeof score === "number" && Number.isFinite(score)) {
            out.push({ index, score });
        }
    }
    if (out.length === 0 && count > 0) throw new Error("rerank reply held no usable scores");
    return out;
}

export const RERANK_PROVIDERS: RerankProvider[] = [
    {
        name: "hf-inference",
        url: `https://router.huggingface.co/hf-inference/models/${RERANK_MODEL}`,
        body: (query, documents) => ({ inputs: documents.map((d) => ({ text: query, text_pair: d })) }),
        parse: parsePairScores,
    },
    {
        name: "scaleway",
        url: "https://router.huggingface.co/scaleway/v1/rerank",
        body: (query, documents) => ({ query, documents, model: RERANK_MODEL, return_documents: false }),
        parse: parseRerankResults,
    },
];

/**
 * Ask each provider in turn; the first usable reply wins. `send` posts one
 * request and returns the parsed JSON, or throws.
 */
export async function rerankWithFallback(
    query: string,
    documents: string[],
    send: (provider: RerankProvider, body: unknown) => Promise<unknown>,
    providers: RerankProvider[] = RERANK_PROVIDERS,
): Promise<{ scores: RerankScore[]; provider: string; failures: string[] }> {
    const docs = documents.map((d) => (typeof d === "string" ? d : "").slice(0, RERANK_DOC_CHARS));
    const failures: string[] = [];
    for (const provider of providers) {
        try {
            const data = await send(provider, provider.body(query, docs));
            const scores = provider.parse(data, docs.length).sort((a, b) => b.score - a.score);
            return { scores, provider: provider.name, failures };
        } catch (e) {
            failures.push(`${provider.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
    }
    throw new Error(`HF Rerank API Error: ${failures.join(" | ")}`);
}

/**
 * HyDE (Hypothetical Document Embeddings) Generator
 *
 * Generates hypothetical conversation documents that would answer a query.
 * Uses conversation format to match the stored chat_turns data.
 *
 * Key insight: The hypothetical document is semantically closer to actual
 * stored conversations than the raw query, improving retrieval quality.
 */

import { OpenAIClient } from "./openai-client.ts";
import { Logger } from "./utils.ts";

const HYDE_SYSTEM_PROMPT = `You are generating a hypothetical conversation that might exist in a user's ChatGPT or Claude chat history, captured by K.Y.T. (Know Your Thoughts), a personal conversation memory extension.

Given the user's search query, generate a realistic conversation snippet (2-3 turns) that would contain the answer they're looking for.

Format EXACTLY as:
User: [user message]
Assistant: [assistant response]
User: [optional follow-up]
Assistant: [optional response]

Rules:
1. Keep it natural and conversational, not formal or encyclopedic
2. Include specific details that would help retrieval
3. Match how real people talk about topics in chat
4. 100-200 words total
5. Do NOT include any preamble - start directly with "User:"
6. Stay grounded in what a real conversation would contain — do not invent product names, model numbers, or technical specs that weren't in the query`;

/**
 * Generate a hypothetical document for a query
 *
 * @param query - The search query
 * @param apiKey - OpenAI API key
 * @param requestId - Request ID for tracing
 * @returns Hypothetical conversation document or null on failure
 */
export async function generateHypotheticalDocument(
    query: string,
    apiKey: string,
    requestId?: string
): Promise<string | null> {
    if (!apiKey) {
        Logger.warn("OpenAI API key not configured, skipping HyDE", { requestId });
        return null;
    }

    if (!query || query.trim().length < 3) {
        Logger.warn("Query too short for HyDE generation", { requestId, query });
        return null;
    }

    try {
        const client = new OpenAIClient(apiKey);

        const userPrompt = `Search query: "${query}"

Generate a hypothetical conversation that would answer this query:`;

        const hydeDoc = await client.generateCompletion(
            HYDE_SYSTEM_PROMPT,
            userPrompt,
            { temperature: 0.7, maxTokens: 300 },
            requestId
        );

        // Validate output format
        if (!hydeDoc || !hydeDoc.includes("User:") || !hydeDoc.includes("Assistant:")) {
            Logger.warn("HyDE output invalid format, discarding", {
                requestId,
                preview: hydeDoc?.substring(0, 100)
            });
            return null;
        }

        // Drift gate: discard if HyDE lost all original query terms
        const DRIFT_STOP = new Set(['the','a','an','is','are','was','were','in','on','at','to','for',
            'of','and','or','but','with','about','what','how','why','when','where','which','who',
            'my','your','this','that','do','does','did','can','could','should','would','will',
            'not','just','also','some','any','all','top','best','most','need','needs','want','tell']);
        const queryTerms = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
            .filter((w: string) => w.length > 2 && !DRIFT_STOP.has(w));
        if (queryTerms.length > 0) {
            const hydeLower = hydeDoc.toLowerCase();
            const hasAnyTerm = queryTerms.some((t: string) => hydeLower.includes(t));
            if (!hasAnyTerm) {
                Logger.warn("HyDE drift gate: no query terms found in output, discarding", {
                    requestId,
                    queryTerms,
                    preview: hydeDoc.substring(0, 100)
                });
                return null;
            }
        }

        Logger.info("HyDE document generated", {
            requestId,
            queryLength: query.length,
            hydeLength: hydeDoc.length
        });

        return hydeDoc;

    } catch (error) {
        // Silent fallback - log error but don't propagate
        Logger.error("HyDE generation failed, using fallback", {
            requestId,
            error: error.message
        });
        return null;
    }
}

/**
 * Generate HyDE with explicit fallback handling
 *
 * This is the main entry point - always returns a result:
 * - On success: { hydeDoc, usedHyde: true }
 * - On failure: { hydeDoc: null, usedHyde: false }
 *
 * @param query - The search query
 * @param apiKey - OpenAI API key
 * @param requestId - Request ID for tracing
 */
export async function generateHyDEWithFallback(
    query: string,
    apiKey: string,
    requestId?: string
): Promise<{ hydeDoc: string | null; usedHyde: boolean }> {
    const hydeDoc = await generateHypotheticalDocument(query, apiKey, requestId);
    return {
        hydeDoc,
        usedHyde: hydeDoc !== null
    };
}

/**
 * Check if a query should skip HyDE (adaptive short-circuit)
 *
 * For high-confidence entity matches, HyDE adds latency without value.
 * Short-circuit when entity extraction is sufficient.
 *
 * @param entities - Extracted entities with confidence scores
 * @param threshold - Confidence threshold for short-circuit (default: 0.85)
 * @returns true if should skip HyDE
 */
export function shouldSkipHyDE(
    entities: Array<{ confidence: number; entity_type?: string }>,
    threshold = 0.85
): boolean {
    if (!entities || entities.length === 0) {
        return false;
    }

    // Short-circuit if any entity has high confidence
    // Especially for PERSON entities which are often exact lookups
    return entities.some(e => {
        const isHighConfidence = e.confidence >= threshold;
        const isPersonEntity = e.entity_type === "PERSON";

        // Lower threshold for PERSON entities (0.80 vs 0.85)
        if (isPersonEntity && e.confidence >= 0.80) {
            return true;
        }

        return isHighConfidence;
    });
}

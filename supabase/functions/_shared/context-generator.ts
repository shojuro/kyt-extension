/**
 * Context Generator Module - Contextual Retrieval for KYT Memory
 * Purpose: Generate LLM context summaries for conversation chunks before embedding.
 * Framework: Uses Claude Haiku 4.5 for context generation.
 * Date: 2026-02-22
 *
 * Implements Anthropic's Contextual Retrieval technique adapted for conversations:
 * - Conversation-aware prompting (who's talking, topic, intent, decisions)
 * - Surrounding chunk context for better topic framing
 * - Anti-circular retrieval (Rule 7: summarize question topics, don't echo them)
 *
 * The generated context prefix is prepended to chunk content before vector embedding.
 * This creates asymmetric embeddings: stored chunks are context-enriched while
 * query embeddings stay raw. DO NOT "fix" this — it's intentional per Anthropic's design.
 */

import { AnthropicClient } from "./anthropic-client.ts";

export interface ContextGeneratorInput {
  chunkContent: string;
  platform?: string;
  conversationId?: string;
  timestamp?: string;
  surroundingChunks?: string[];
}

interface ContextResult {
  contextPrefix: string;
  contextualContent: string;
}

/**
 * System prompt for conversation-aware context generation.
 *
 * Key design decisions:
 * - Rule 7 prevents circular retrieval: question chunks get topic summaries,
 *   not echoed questions. Without this, "what are the top 3 models?" in context
 *   would near-perfectly match the same question asked later.
 * - Third person ("The user discusses...") avoids first-person confusion with
 *   the actual chunk content.
 * - 50-100 word target balances information density vs embedding noise.
 */
const CONTEXT_GENERATION_SYSTEM_PROMPT = `You generate brief context summaries for conversation chunks from a user's AI chat history.
Your summary will be PREPENDED to the chunk before vector embedding, so it must capture what the chunk is ABOUT — not repeat its contents.

Rules:
1. Write 1-3 sentences maximum (50-100 words)
2. State the TOPIC and the user's INTENT or STANCE
3. Include key entities, decisions, or opinions by name
4. Use third-person: "The user discusses..." or "This conversation covers..."
5. If the user expresses a preference or opinion, state it explicitly
6. If a decision or conclusion is reached, state it
7. If the user asks a question, state the TOPIC of the question, not the question itself (e.g. "The user asks about LLM platform priorities" NOT "The user asks what are the top three models")
8. Do NOT summarize turn-by-turn — capture the conceptual theme
9. Do NOT include information not present in the chunk or surrounding context
10. Output ONLY the context summary text, no labels or formatting`;

/**
 * Build the user prompt for context generation.
 * Includes surrounding chunks (truncated) for topic framing.
 */
function buildContextPrompt(input: ContextGeneratorInput): string {
  const {
    chunkContent,
    platform = 'unknown',
    timestamp,
    surroundingChunks = [],
  } = input;

  const dateLine = timestamp
    ? `Date: ${new Date(timestamp).toISOString().split('T')[0]}`
    : '';

  let surroundingSection = '';
  if (surroundingChunks.length > 0) {
    const truncated = surroundingChunks.map((chunk, i) => {
      // Truncate each surrounding chunk to ~200 words
      const words = chunk.split(/\s+/);
      const limited = words.slice(0, 200).join(' ');
      return `[Adjacent chunk ${i + 1}]: ${limited}${words.length > 200 ? '...' : ''}`;
    });
    surroundingSection = `\nSURROUNDING CONTEXT (for understanding, do NOT summarize):\n${truncated.join('\n')}\n`;
  }

  return `Platform: ${platform}
${dateLine}
${surroundingSection}
CHUNK TO CONTEXTUALIZE:
${chunkContent}

Write a 1-3 sentence context summary for the chunk above:`;
}

/**
 * Generate a context summary for a single conversation chunk.
 *
 * @param input - Chunk content + optional surrounding context
 * @param anthropicApiKey - Anthropic API key
 * @returns Context result with prefix and full contextual content, or null on failure
 */
export async function generateChunkContext(
  input: ContextGeneratorInput,
  anthropicApiKey: string
): Promise<ContextResult | null> {
  if (!input.chunkContent || input.chunkContent.trim().length === 0) {
    return null;
  }

  if (!anthropicApiKey || anthropicApiKey.trim().length === 0) {
    console.warn('Context generator: missing Anthropic API key');
    return null;
  }

  const prompt = buildContextPrompt(input);

  try {
    const client = new AnthropicClient(anthropicApiKey);
    const contextPrefix = await client.generateCompletion(
      CONTEXT_GENERATION_SYSTEM_PROMPT,
      prompt,
      {
        temperature: 0.3,
        maxTokens: 200,
        maxRetries: 2,
        timeoutMs: 5000,
        operation: 'context_generation',
        cacheControl: true,
      }
    );

    if (!contextPrefix || contextPrefix.length === 0) {
      return null;
    }

    // Prepend context to chunk content with clear separator
    const contextualContent = `${contextPrefix}\n\n---\n\n${input.chunkContent}`;

    return { contextPrefix, contextualContent };
  } catch (error) {
    console.warn(`Context generator error: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Generate context summaries for a batch of chunks.
 * Processes sequentially with configurable delay to respect rate limits.
 *
 * @param inputs - Array of chunk inputs
 * @param anthropicApiKey - Anthropic API key
 * @param delayMs - Delay between API calls (default: 200ms)
 * @returns Array of results (null entries for failures)
 */
export async function generateContextBatch(
  inputs: ContextGeneratorInput[],
  anthropicApiKey: string,
  delayMs: number = 200
): Promise<(ContextResult | null)[]> {
  const results: (ContextResult | null)[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const result = await generateChunkContext(inputs[i], anthropicApiKey);
    results.push(result);

    // Rate limit delay between calls (skip after last)
    if (i < inputs.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}

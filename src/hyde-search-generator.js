/**
 * Client-side HyDE (Hypothetical Document Embeddings) generator for search.
 *
 * When a user queries "the walking analogy", this generates a hypothetical
 * conversation about a child learning to walk, bridges the vocabulary gap,
 * and enables semantic search to find the actual stored content.
 *
 * Mirrors the server-side hyde-generator.ts in supabase/functions/_shared/.
 */

import { createCircuitBreaker } from './embedding-circuit-breaker.js';
import { fetchWithTimeout } from './utils/fetch.js';

// ── Circuit breaker for HyDE API calls ────────────────────────────────────
const HYDE_CB_STORAGE_KEY = 'kyt_hyde_circuit_breaker';
const HYDE_COOLDOWN_STEPS = [60000, 120000, 300000]; // 1m, 2m, 5m

export const hydeCB = createCircuitBreaker(HYDE_CB_STORAGE_KEY, HYDE_COOLDOWN_STEPS);

// ── Constants ─────────────────────────────────────────────────────────────
const HYDE_TIMEOUT_MS = 6000; // 6s budget — HyDE runs in parallel so longer timeout is safe

const HYDE_SYSTEM_PROMPT = `You are a memory recall assistant for K.Y.T. (Know Your Thoughts), a Chrome extension that captures the user's ChatGPT and Claude conversations and stores them for later retrieval.

Given a user's search query about a past conversation, generate a short hypothetical conversation snippet (2-3 turns, 100-200 words) that would be semantically similar to what the user is looking for.

The conversation should:
- Use natural, conversational language
- Include specific details that someone might remember
- Cover the topic from the perspective of a real ChatGPT or Claude conversation
- Include both user and assistant turns
- Stay grounded in what a real conversation about this topic would contain

Do NOT explain what you're doing. Just output the hypothetical conversation directly.`;

/**
 * Generate a hypothetical document (conversation snippet) for a search query.
 * Used to bridge vocabulary gaps between how users search and how content is stored.
 *
 * @param {string} query - User's search query (e.g., "the walking analogy")
 * @param {string} openaiKey - OpenAI API key
 * @returns {Promise<string|null>} Hypothetical conversation text, or null on failure
 */
export async function generateHyDEDocument(query, openaiKey) {
  if (!query || !openaiKey) return null;

  try {
    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: HYDE_SYSTEM_PROMPT },
            { role: 'user', content: `Search query: "${query}"\n\nIMPORTANT: The user's stored conversations are about software development, AI products, startups, and personal knowledge management. Interpret ambiguous terms in this context (e.g., "shipping" means releasing software, not mailing packages; "models" means AI/LLM models, not fashion models).\n\nGenerate a hypothetical conversation that this query might be trying to find:` }
          ],
          temperature: 0.7,
          max_tokens: 300
        })
      },
      HYDE_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      // Billing/quota 429: open circuit for 1 hour (no point retrying until user tops up)
      if (response.status === 429 && (errorText.includes('quota') || errorText.includes('billing'))) {
        const BILLING_COOLDOWN_MS = 3600000; // 1 hour
        console.error(`🔌 HyDE billing/quota exceeded — circuit open for ${BILLING_COOLDOWN_MS / 60000}m`);
        const currentState = await hydeCB.getState();
        await hydeCB.updateState({
          isOpen: true,
          openedAt: Date.now(),
          lastFailureCode: 429,
          lastFailureMessage: errorText,
          cooldownMs: BILLING_COOLDOWN_MS,
          consecutiveFailures: currentState.consecutiveFailures + 1,
          totalTrips: currentState.totalTrips + 1
        });
      } else {
        await hydeCB.recordFailure(response.status, errorText);
      }
      console.warn(`⚠️ HyDE generation failed: ${response.status} - ${errorText}`);
      return null;
    }

    await hydeCB.recordSuccess();

    const data = await response.json();
    const hydeDoc = data.choices?.[0]?.message?.content?.trim();

    if (!hydeDoc || hydeDoc.length < 20) {
      console.warn('⚠️ HyDE generated empty or too-short document');
      return null;
    }

    // Drift gate: discard if HyDE lost all original query terms
    const DRIFT_STOP = new Set(['the','a','an','is','are','was','were','in','on','at','to','for',
      'of','and','or','but','with','about','what','how','why','when','where','which','who',
      'my','your','this','that','do','does','did','can','could','should','would','will',
      'not','just','also','some','any','all','top','best','most','need','needs','want','tell']);
    const queryTerms = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !DRIFT_STOP.has(w));
    if (queryTerms.length > 0) {
      const hydeLower = hydeDoc.toLowerCase();
      const hasAnyTerm = queryTerms.some(t => hydeLower.includes(t));
      if (!hasAnyTerm) {
        console.warn(`⚠️ HyDE drift gate: none of [${queryTerms.join(', ')}] found in output, discarding`);
        return null;
      }
    }

    console.log(`✅ HyDE document generated (${hydeDoc.length} chars) for query: "${query}"`);
    return hydeDoc;

  } catch (error) {
    // Record timeout as status 0
    if (error.message?.includes('timed out')) {
      await hydeCB.recordFailure(0, error.message);
    }
    console.warn(`⚠️ HyDE generation error: ${error.message}`);
    return null;
  }
}

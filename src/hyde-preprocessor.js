/**
 * KYT HyDE (Hypothetical Document Embeddings) Preprocessor
 *
 * Generates hypothetical questions for conversation-turn chunks.
 * Improves retrieval quality by indexing what users MIGHT ask about the content.
 *
 * LLM: GPT-4.1-mini via llm_completion edge function (cost optimization for dev).
 * Production target: Claude Haiku 4.5. Swap provider param to 'anthropic' when ready.
 *
 * Strategy:
 * - Run batch process on existing turn chunks (30-day history)
 * - Generate 3-5 hypothetical questions per chunk
 * - Store in `chat_turns.hypothetical_questions` array
 * - Provide "WOW moment" - instant searchable history on download
 */

import { callEdgeFunction } from './api-client.js';

// ── In-memory rate limit tracker ────────────────────────────────────────
// Prevents wasting service worker time on doomed API calls when rate-limited.
// Resets on service worker restart (intentional — transient by design).
let _hydeRateLimitedUntil = 0;
let _hydeConsecutiveFailures = 0;
const HYDE_COOLDOWN_MS = 60000;       // 1 min after first failure
const HYDE_MAX_COOLDOWN_MS = 300000;  // 5 min max backoff

/**
 * Generate hypothetical questions for a conversation turn chunk
 *
 * Uses Claude Haiku 4.5 to generate questions a user might ask about this content.
 * These questions improve retrieval when users search for similar topics.
 *
 * @param {Object} turnChunk - Conversation turn chunk
 * @param {string} turnChunk.content - Turn content (formatted: "User: ...\nAssistant: ...")
 * @param {string[]} turnChunk.topics - Extracted topics
 * @param {string[]} turnChunk.speakers - Speakers in conversation
 * @param {number} questionCount - Number of questions to generate (default: 3)
 * @returns {Promise<Object>} Generation result
 */
export async function generateHypotheticalQuestions(turnChunk, _unused, questionCount = 3) {
  try {
    // Check in-memory rate limit cooldown FIRST
    if (Date.now() < _hydeRateLimitedUntil) {
      const waitSec = Math.ceil((_hydeRateLimitedUntil - Date.now()) / 1000);
      return {
        success: false,
        questions: [],
        error: `HyDE rate-limited, skipping (${waitSec}s remaining)`
      };
    }

    // Validate inputs
    if (!turnChunk || !turnChunk.content) {
      throw new Error('Invalid turn chunk: missing content');
    }

    // Build HyDE prompt
    const prompt = buildHyDEPrompt(turnChunk, questionCount);

    console.log(`🔮 Generating ${questionCount} hypothetical questions for chunk...`);

    // Call via edge function (no API key needed client-side)
    const result = await callEdgeFunction('llm_completion', {
      system: 'You are a memory recall assistant. Generate search queries, conceptual labels, and recall phrases for a conversation. Think about how someone would search for this content months later — they\'ll remember the concept or analogy, not the exact words.',
      user: prompt,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      temperature: 0.7,
      max_tokens: 250,
      operation: 'hyde_index',
    }, { timeoutMs: 10000 });

    if (result.error) {
      // Rate limit detection: engage cooldown
      _hydeConsecutiveFailures++;
      const cooldown = Math.min(
        HYDE_COOLDOWN_MS * Math.pow(2, _hydeConsecutiveFailures - 1),
        HYDE_MAX_COOLDOWN_MS
      );
      _hydeRateLimitedUntil = Date.now() + cooldown;
      throw new Error(`LLM completion error: ${result.error}`);
    }

    // Success — reset failure counter
    _hydeConsecutiveFailures = 0;

    const questionsText = result.content?.trim() || '';

    // Parse questions (assumes LLM returns numbered list)
    const questions = parseQuestions(questionsText, questionCount);

    console.log(`✅ Generated ${questions.length} hypothetical questions`);

    return {
      success: true,
      questions: questions,
      tokensUsed: 0 // Token count not returned from edge function
    };

  } catch (error) {
    console.error('❌ HyDE question generation failed:', error.message);

    // Graceful fallback: return empty array
    return {
      success: false,
      questions: [],
      error: error.message
    };
  }
}

/**
 * Build HyDE prompt for question generation
 *
 * @param {Object} turnChunk - Conversation turn chunk
 * @param {number} questionCount - Number of questions to generate
 * @returns {string} Prompt for LLM
 */
function buildHyDEPrompt(turnChunk, questionCount) {
  let prompt = `Generate recall aids for this conversation so it can be found months later.\n\n`;

  // Add conversation content (truncated if too long)
  const maxContentLength = 800;
  const content = turnChunk.content.length > maxContentLength
    ? turnChunk.content.substring(0, maxContentLength) + '...'
    : turnChunk.content;

  prompt += `Conversation:\n${content}\n\n`;

  // Add topics as context
  if (turnChunk.topics && turnChunk.topics.length > 0) {
    prompt += `Topics: ${turnChunk.topics.join(', ')}\n\n`;
  }

  prompt += `Generate exactly ${questionCount} items in 3 categories:

Category 1 — Hypothetical search queries (${Math.max(questionCount - 2, 1)} items):
Natural questions a user might type to find this conversation.

Category 2 — Conceptual labels (1 line, comma-separated):
Abstract concepts, principles, or themes discussed. Prefix with [CONCEPT].

Category 3 — Recall phrases (1 line, comma-separated):
Analogies, metaphors, nicknames, or shorthand someone might use to refer to this content later. Prefix with [RECALL].

Example for a conversation about not erasing a child's progress when they stumble while learning to walk:
1. How should I handle setbacks in learning?
2. Should you restart when someone makes a mistake?
3. Encouraging progress despite stumbles
[CONCEPT] incremental learning, progressive mastery, preserving progress
[RECALL] walking analogy, child taking steps, don't erase the steps

Now generate for the conversation above:`;

  return prompt;
}

/**
 * Parse questions from LLM response
 *
 * Handles various formats:
 * - Numbered list (1., 2., 3.)
 * - Bulleted list (-, *, •)
 * - Plain lines
 *
 * @param {string} questionsText - Raw LLM output
 * @param {number} expectedCount - Expected number of questions
 * @returns {string[]} Array of parsed questions
 */
function parseQuestions(questionsText, expectedCount) {
  const lines = questionsText.split('\n').filter(line => line.trim().length > 0);
  const questions = [];

  for (const line of lines) {
    // Remove numbering/bullets: "1. ", "- ", "* ", "• "
    let question = line
      .replace(/^\d+\.\s*/, '')   // Remove "1. "
      .replace(/^[-*•]\s*/, '')   // Remove "- " or "* " or "• "
      .replace(/^\[CONCEPT\]\s*/i, '')  // Remove "[CONCEPT] " prefix
      .replace(/^\[RECALL\]\s*/i, '')   // Remove "[RECALL] " prefix
      .trim();

    // Remove quotes if present
    question = question.replace(/^["']|["']$/g, '');

    if (question.length > 0 && question.length < 300) { // Sanity check (recall phrases can be longer)
      questions.push(question);
    }

    // Stop if we have enough questions
    if (questions.length >= expectedCount) {
      break;
    }
  }

  return questions.slice(0, expectedCount);
}

/**
 * Batch process turn chunks with HyDE preprocessing
 *
 * Generates hypothetical questions for multiple chunks with rate limiting.
 * Use this for processing 30-day history on extension download.
 *
 * @param {Object[]} turnChunks - Array of turn chunks from chat_turns table
 * @param {string} _unused - Formerly apiKey, now unused (edge function handles auth)
 * @param {Object} options - Processing options
 * @param {number} options.questionCount - Questions per chunk (default: 3)
 * @param {number} options.batchSize - Chunks per batch (default: 10)
 * @param {number} options.delayMs - Delay between batches (default: 1000ms)
 * @returns {Promise<Object>} Processing result
 */
export async function batchProcessHyDE(turnChunks, _unused, options = {}) {
  const {
    questionCount = 3,
    batchSize = 10,
    delayMs = 1000
  } = options;

  console.log(`🔮 Starting HyDE batch processing: ${turnChunks.length} chunks`);

  const processedChunks = [];
  let totalQuestions = 0;
  let failedChunks = 0;

  // Process in batches
  for (let i = 0; i < turnChunks.length; i += batchSize) {
    const batch = turnChunks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(turnChunks.length / batchSize);

    console.log(`📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} chunks)`);

    // Process batch (sequential to avoid rate limits)
    for (const chunk of batch) {
      const result = await generateHypotheticalQuestions(chunk, null, questionCount);

      if (result.success && result.questions.length > 0) {
        processedChunks.push({
          ...chunk,
          hypothetical_questions: result.questions
        });
        totalQuestions += result.questions.length;
      } else {
        failedChunks++;
        // Keep chunk without questions (graceful degradation)
        processedChunks.push({
          ...chunk,
          hypothetical_questions: []
        });
      }

      // Small delay between chunks within batch
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Delay between batches (rate limit protection)
    if (i + batchSize < turnChunks.length) {
      console.log(`⏳ Waiting ${delayMs}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`✅ HyDE preprocessing complete:`);
  console.log(`   Processed: ${processedChunks.length} chunks`);
  console.log(`   Total questions: ${totalQuestions}`);
  console.log(`   Failed: ${failedChunks} chunks`);

  return {
    success: true,
    processed: processedChunks.length,
    totalQuestions: totalQuestions,
    failed: failedChunks,
    chunks: processedChunks
  };
}

/**
 * Update chat_turns table with hypothetical questions
 *
 * Updates Supabase chat_turns table with generated questions.
 * Use after batch processing to persist HyDE results.
 *
 * @param {Object[]} processedChunks - Chunks with hypothetical_questions
 * @param {Object} config - Supabase configuration
 * @param {string} config.supabaseUrl - Supabase project URL
 * @param {string} config.supabaseKey - Supabase API key
 * @returns {Promise<Object>} Update result
 */
export async function updateChatTurnsWithHyDE(processedChunks, config) {
  console.log(`📝 Updating ${processedChunks.length} chunks in Supabase...`);

  let updated = 0;
  let failed = 0;

  // Update chunks individually (could be batched, but safer for MVP)
  for (const chunk of processedChunks) {
    if (!chunk.id) {
      console.warn(`⚠️ Chunk missing ID, skipping`);
      failed++;
      continue;
    }

    try {
      const response = await fetch(
        `${config.supabaseUrl}/rest/v1/chat_turns?id=eq.${chunk.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.supabaseKey,
            'Authorization': `Bearer ${config.accessToken || config.supabaseKey}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            hypothetical_questions: chunk.hypothetical_questions
          })
        }
      );

      if (response.ok) {
        updated++;
      } else {
        const error = await response.json();
        console.error(`❌ Update failed for chunk ${chunk.id}:`, error.message);
        failed++;
      }

    } catch (error) {
      console.error(`❌ Update error for chunk ${chunk.id}:`, error.message);
      failed++;
    }

    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log(`✅ Update complete: ${updated} updated, ${failed} failed`);

  return {
    success: failed === 0,
    updated: updated,
    failed: failed
  };
}

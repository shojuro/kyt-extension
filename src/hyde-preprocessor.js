/**
 * KYT HyDE (Hypothetical Document Embeddings) Preprocessor
 *
 * Generates hypothetical questions for conversation-turn chunks.
 * Improves retrieval quality by indexing what users MIGHT ask about the content.
 *
 * Phase 8: HyDE Preprocessing (Final phase)
 *
 * Strategy:
 * - Run batch process on existing turn chunks (30-day history)
 * - Generate 3-5 hypothetical questions per chunk
 * - Store in `chat_turns.hypothetical_questions` array
 * - Provide "WOW moment" - instant searchable history on download
 */

/**
 * Generate hypothetical questions for a conversation turn chunk
 *
 * Uses GPT-3.5-turbo to generate questions a user might ask about this content.
 * These questions improve retrieval when users search for similar topics.
 *
 * @param {Object} turnChunk - Conversation turn chunk
 * @param {string} turnChunk.content - Turn content (formatted: "User: ...\nAssistant: ...")
 * @param {string[]} turnChunk.topics - Extracted topics
 * @param {string[]} turnChunk.speakers - Speakers in conversation
 * @param {string} apiKey - OpenAI API key
 * @param {number} questionCount - Number of questions to generate (default: 3)
 * @returns {Promise<Object>} Generation result
 *
 * @example
 * const result = await generateHypotheticalQuestions(
 *   {
 *     content: "User: How do I fix RLS?\nAssistant: Check your policy...",
 *     topics: ['rls', 'supabase', 'auth'],
 *     speakers: ['user', 'assistant']
 *   },
 *   apiKey,
 *   3
 * );
 * // result.questions: ["How to fix RLS?", "Supabase auth policy error", "RLS debugging"]
 */
export async function generateHypotheticalQuestions(turnChunk, apiKey, questionCount = 3) {
  try {
    // Validate inputs
    if (!turnChunk || !turnChunk.content) {
      throw new Error('Invalid turn chunk: missing content');
    }

    if (!apiKey) {
      throw new Error('OpenAI API key required for HyDE preprocessing');
    }

    // Build HyDE prompt
    const prompt = buildHyDEPrompt(turnChunk, questionCount);

    console.log(`🔮 Generating ${questionCount} hypothetical questions for chunk...`);

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a question generation assistant. Generate hypothetical questions a user might ask to find this conversation. Questions should be natural, diverse, and capture different aspects of the content.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7, // Higher temperature for diverse questions
        max_tokens: 150,  // Space for multiple questions
        n: 1
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const questionsText = data.choices[0].message.content.trim();

    // Parse questions (assumes LLM returns numbered list)
    const questions = parseQuestions(questionsText, questionCount);

    console.log(`✅ Generated ${questions.length} hypothetical questions`);

    return {
      success: true,
      questions: questions,
      tokensUsed: data.usage?.total_tokens || 0
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
  let prompt = `Generate ${questionCount} hypothetical questions a user might ask to find this conversation.\n\n`;

  // Add conversation content (truncated if too long)
  const maxContentLength = 500;
  const content = turnChunk.content.length > maxContentLength
    ? turnChunk.content.substring(0, maxContentLength) + '...'
    : turnChunk.content;

  prompt += `Conversation:\n${content}\n\n`;

  // Add topics as context
  if (turnChunk.topics && turnChunk.topics.length > 0) {
    prompt += `Topics: ${turnChunk.topics.join(', ')}\n\n`;
  }

  prompt += `Instructions:
1. Generate ${questionCount} diverse questions
2. Questions should be natural (how users actually search)
3. Cover different aspects: problem statement, solution, error message, concept
4. Keep questions concise (5-15 words each)
5. Format as numbered list (1., 2., 3., etc.)

Example:
1. How to fix RLS policy error in Supabase?
2. Supabase auth user isolation not working
3. Row level security debugging tips

Now generate ${questionCount} questions for the conversation above:`;

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
      .trim();

    // Remove quotes if present
    question = question.replace(/^["']|["']$/g, '');

    if (question.length > 0 && question.length < 200) { // Sanity check
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
 * @param {string} apiKey - OpenAI API key
 * @param {Object} options - Processing options
 * @param {number} options.questionCount - Questions per chunk (default: 3)
 * @param {number} options.batchSize - Chunks per batch (default: 10)
 * @param {number} options.delayMs - Delay between batches (default: 1000ms)
 * @returns {Promise<Object>} Processing result
 *
 * @example
 * const result = await batchProcessHyDE(turnChunks, apiKey, {
 *   questionCount: 3,
 *   batchSize: 10,
 *   delayMs: 1000
 * });
 * // result.processed: 120 chunks
 * // result.totalQuestions: 360 questions
 */
export async function batchProcessHyDE(turnChunks, apiKey, options = {}) {
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
      const result = await generateHypotheticalQuestions(chunk, apiKey, questionCount);

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
            'Authorization': `Bearer ${config.supabaseKey}`,
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

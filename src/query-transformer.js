/**
 * KYT Query Transformation Module
 *
 * Transforms vague user queries into optimized search terms using LLM.
 * Improves semantic search precision by extracting key concepts and technical terms.
 *
 * Phase 7: Query Transformation (Must-have for search quality)
 */

/**
 * Transform user query into optimized search terms
 *
 * Uses GPT-3.5-turbo to rewrite vague queries into embedding-optimized terms.
 * Extracts technical concepts, removes filler words, preserves user intent.
 *
 * @param {string} userQuery - Raw user query (e.g., "that python thing from last week")
 * @param {Object} context - Optional context for transformation
 * @param {string[]} context.recentTopics - Recent conversation topics
 * @param {string} context.searchContext - Context type ('chat_history', 'code', etc.)
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Object>} Transformation result
 *
 * @example
 * const result = await transformQuery(
 *   "that python thing from last week",
 *   { recentTopics: ['python', 'rls', 'supabase'] },
 *   apiKey
 * );
 * // result.optimizedQuery: "python RLS policy Supabase database configuration"
 * // result.success: true
 */
export async function transformQuery(userQuery, context = {}, apiKey) {
  try {
    // Validate inputs
    if (!userQuery || typeof userQuery !== 'string') {
      throw new Error('Invalid user query: must be non-empty string');
    }

    if (!apiKey) {
      throw new Error('OpenAI API key required for query transformation');
    }

    // Already specific technical query - return as-is
    if (isAlreadyOptimized(userQuery)) {
      console.log('📊 Query already optimized, skipping transformation');
      return {
        success: true,
        originalQuery: userQuery,
        optimizedQuery: userQuery,
        transformed: false,
        reason: 'Query already contains specific technical terms'
      };
    }

    // Build transformation prompt
    const prompt = buildTransformationPrompt(userQuery, context);

    console.log('🔄 Transforming query:', userQuery);

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
            content: 'You are a query optimization assistant. Transform vague user queries into concise, technical search terms optimized for semantic search. Extract key concepts, remove filler words, preserve intent.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3, // Low temperature for consistent, focused output
        max_tokens: 50,   // Short, focused output
        n: 1
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const optimizedQuery = data.choices[0].message.content.trim();

    console.log('✅ Query transformed:', optimizedQuery);

    return {
      success: true,
      originalQuery: userQuery,
      optimizedQuery: optimizedQuery,
      transformed: true,
      tokensUsed: data.usage?.total_tokens || 0
    };

  } catch (error) {
    console.error('❌ Query transformation failed:', error.message);

    // Graceful fallback: return original query
    return {
      success: false,
      originalQuery: userQuery,
      optimizedQuery: userQuery, // Use original as fallback
      transformed: false,
      error: error.message
    };
  }
}

/**
 * Check if query is already optimized (contains technical terms)
 * If true, skip LLM transformation to save cost/latency
 *
 * @param {string} query - User query
 * @returns {boolean} True if already optimized
 */
function isAlreadyOptimized(query) {
  // Technical term patterns (same as extractTopics in conversation-chunker.js)
  const technicalPatterns = [
    // Programming languages
    /\b(python|javascript|java|rust|go|sql|typescript|bash|c\+\+|csharp|ruby|php|swift|kotlin)\b/i,

    // Database/backend terms
    /\b(database|postgres|supabase|rls|policy|schema|table|column|index|query|migration)\b/i,

    // API/web terms
    /\b(api|endpoint|rest|graphql|http|fetch|request|response|auth|jwt|oauth)\b/i,

    // Common tech terms
    /\b(function|class|method|variable|error|bug|debug|test|deploy|config|sync|embed)\b/i,

    // Vector search terms
    /\b(embedding|vector|similarity|search|cosine|distance|semantic)\b/i
  ];

  // If query contains 2+ technical terms, likely already optimized
  let technicalTermCount = 0;
  for (const pattern of technicalPatterns) {
    if (pattern.test(query)) {
      technicalTermCount++;
    }
  }

  return technicalTermCount >= 2;
}

/**
 * Build transformation prompt with context
 *
 * @param {string} userQuery - Raw user query
 * @param {Object} context - Context for transformation
 * @returns {string} Prompt for LLM
 */
function buildTransformationPrompt(userQuery, context) {
  let prompt = `Transform this vague query into specific search terms:\n"${userQuery}"\n\n`;

  // Add recent topics as context
  if (context.recentTopics && context.recentTopics.length > 0) {
    prompt += `Recent conversation topics: ${context.recentTopics.join(', ')}\n\n`;
  }

  // Add search context
  if (context.searchContext) {
    prompt += `Search context: ${context.searchContext}\n\n`;
  }

  prompt += `Instructions:
1. Extract key technical concepts and terms
2. Remove filler words ("that", "thing", "um", "like")
3. Add relevant technical context from topics
4. Keep output concise (5-10 words max)
5. Preserve user's intent

Output only the optimized search terms, nothing else.`;

  return prompt;
}

/**
 * Extract recent topics from conversation history
 * Helper for providing context to query transformer
 *
 * @param {Object[]} recentMessages - Recent messages from storage
 * @param {number} limit - Max topics to extract (default: 10)
 * @returns {string[]} Array of topic keywords
 */
export function extractRecentTopics(recentMessages = [], limit = 10) {
  const topics = new Set();

  // Extract topics from recent messages (similar to conversation-chunker.js)
  for (const msg of recentMessages.slice(-20)) { // Last 20 messages
    const content = msg.content || '';

    // Extract programming languages
    const langMatches = content.match(/\b(python|javascript|java|rust|go|sql|typescript|bash|c\+\+|csharp|ruby|php|swift|kotlin)\b/gi) || [];
    langMatches.forEach(lang => topics.add(lang.toLowerCase()));

    // Extract tech terms
    const techMatches = content.match(/\b(api|database|auth|rls|supabase|postgres|openai|embedding|vector|search|query|schema|function|bug|error|debug|test|sync)\b/gi) || [];
    techMatches.forEach(term => topics.add(term.toLowerCase()));

    if (topics.size >= limit) break;
  }

  return Array.from(topics).slice(0, limit);
}

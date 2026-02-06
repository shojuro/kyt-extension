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

    // Check if already optimized (avoid double-transformation)
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
            content: 'You are a query optimization assistant for a dual-purpose memory system (Developer Tool + AI Companion). Your goal is to transform vague user queries into specific search terms optimized for semantic search.\n\nAnalyze the user\'s intent:\n1. **Technical/Developer**: Extract libraries, error codes, specific concepts (e.g., "fix that bug" -> "fix postgres RLS policy error").\n2. **Emotional/Companion**: Extract emotional themes, shared memories, relationship milestones, temporal references (e.g., "remember when we talked about my ex?" -> "breakup relationship advice ex-partner emotional support").\n\nOutput ONLY the optimized search terms. Keep it concise (5-10 words).'
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
    let optimizedQuery = data.choices[0].message.content.trim();

    // SANITY CHECK: Detect query pollution
    // If transformed query is much longer than original AND contains unrelated tech terms, it's polluted
    const pollutionDetected = detectQueryPollution(userQuery, optimizedQuery, context.recentTopics || []);

    if (pollutionDetected) {
      console.warn('⚠️ Query pollution detected, using original query instead');
      console.warn(`  Original: "${userQuery}"`);
      console.warn(`  Polluted: "${optimizedQuery}"`);

      return {
        success: true,
        originalQuery: userQuery,
        optimizedQuery: userQuery, // Fall back to original
        transformed: false,
        reason: 'Pollution detected - transformed query contained irrelevant terms'
      };
    }

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
 * Detect if transformed query has been polluted with irrelevant context
 * 
 * @param {string} originalQuery - Original user query
 * @param {string} transformedQuery - LLM-transformed query
 * @param {string[]} recentTopics - Recent conversation topics provided as context
 * @returns {boolean} True if pollution detected
 */
function detectQueryPollution(originalQuery, transformedQuery, recentTopics) {
  // Extract words (3+ chars) from original query
  const originalWords = new Set(
    originalQuery.toLowerCase().match(/\b\w{3,}\b/g) || []
  );

  // Extract words (3+ chars) from transformed query
  const transformedWords = transformedQuery.toLowerCase().match(/\b\w{3,}\b/g) || [];

  if (transformedWords.length === 0) {
    return false; // Empty transform, not polluted per se
  }

  // Count words in transformed that are completely new (not in original)
  const newWords = transformedWords.filter(w => !originalWords.has(w));

  // Semantic drift: if >50% of transformed words are new, it has drifted
  if (newWords.length / transformedWords.length > 0.5) {
    return true;
  }

  // Also check for technical term pollution (original check, no length gate)
  const recentTopicsSet = new Set(recentTopics.map(t => t.toLowerCase()));
  let irrelevantCount = 0;

  for (const word of transformedWords) {
    if (!originalWords.has(word) && !recentTopicsSet.has(word)) {
      const isTechnical = /^(javascript|supabase|api|function|debug|postgres|database|code|error|bug|sync|embed|vector)$/i.test(word);
      if (isTechnical) {
        irrelevantCount++;
      }
    }
  }

  // 2+ irrelevant technical terms = polluted
  return irrelevantCount >= 2;
}

/**
 * Check if query is already optimized (contains technical or specific emotional terms)
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

  // Emotional/Companion patterns (for "Lonely" ICP)
  const emotionalPatterns = [
    // Feelings/Emotions
    /\b(happy|sad|angry|anxious|depressed|excited|love|hate|fear|joy|grief|lonely)\b/i,

    // Relationship terms
    /\b(friend|partner|ex|breakup|date|anniversary|birthday|wedding|family|mom|dad)\b/i,

    // Memory triggers
    /\b(remember|recall|memory|past|future|dream|goal|wish|hope)\b/i,

    // Specific context
    /\b(advice|support|help|listen|talk|chat|vent)\b/i
  ];

  const allPatterns = [...technicalPatterns, ...emotionalPatterns];

  // If query contains 2+ specific terms, likely already optimized
  let termCount = 0;

  // Combine all patterns into a single regex for counting
  // Extract the inner groups (remove / and flags)
  const allSources = allPatterns.map(p => p.source);
  // We need to be careful about flags, but here they are all 'i'.

  // Simpler approach: iterate and match
  for (const pattern of allPatterns) {
    const matches = query.match(new RegExp(pattern.source, 'gi')) || [];
    termCount += matches.length;
  }

  return termCount >= 2;
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

  // Add recent topics as context ONLY if they seem relevant
  if (context.recentTopics && context.recentTopics.length > 0) {
    prompt += `Recent conversation topics: ${context.recentTopics.join(', ')}\n\n`;
    prompt += `**IMPORTANT**: Only use these topics if they are relevant to the user's current query. If the query is about a completely different subject (e.g., user asks about "Christmas plans" but topics are about "JavaScript debugging"), IGNORE the recent topics entirely.\n\n`;
  }

  // Add search context
  if (context.searchContext) {
    prompt += `Search context: ${context.searchContext}\n\n`;
  }

  prompt += `Instructions:
1. Identify intent: Technical (Dev) or Emotional (Companion)
2. Extract key concepts from THE USER'S QUERY ONLY (Tech: libs, errors; Emotional: feelings, people, events)
3. Remove filler words ("that", "thing", "um", "like")
4. ONLY add context from recent topics if they are DIRECTLY RELEVANT to the query
5. DO NOT add random technical terms if the query is non-technical
6. Keep output concise (5-10 words max)
7. Preserve user's intent

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

    // Extract emotional/relationship terms (Dual ICP)
    const emotionalMatches = content.match(/\b(happy|sad|love|hate|friend|partner|ex|breakup|family|dream|goal|anxious|lonely|support)\b/gi) || [];
    emotionalMatches.forEach(term => topics.add(term.toLowerCase()));

    if (topics.size >= limit) break;
  }

  return Array.from(topics).slice(0, limit);
}

/**
 * Fetch recent messages from Supabase and extract topics
 * Replaces local storage topic extraction for cross-device consistency
 *
 * @param {Object} apiConfig - API configuration
 * @param {number} limit - Max topics to extract
 * @returns {Promise<string[]>} Array of topic keywords
 */
export async function fetchRecentTopicsFromSupabase(apiConfig, limit = 10) {
  try {
    if (!apiConfig || !apiConfig.supabaseUrl || !apiConfig.supabaseKey) {
      console.warn('⚠️ Supabase config missing, skipping topic fetch');
      return [];
    }

    const userId = apiConfig.userId || '00000000-0000-0000-0000-000000000000';

    console.log(`🔄 Fetching recent topics for user: ${userId}`);

    // Fetch last 20 messages for this user
    const response = await fetch(
      `${apiConfig.supabaseUrl}/rest/v1/messages?user_id=eq.${userId}&order=timestamp.desc&limit=20&select=content`,
      {
        method: 'GET',
        headers: {
          'apikey': apiConfig.supabaseKey,
          'Authorization': `Bearer ${apiConfig.supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.statusText}`);
    }

    const messages = await response.json();

    // Reuse existing extraction logic
    return extractRecentTopics(messages, limit);

  } catch (error) {
    console.error('❌ Failed to fetch recent topics from Supabase:', error);
    return [];
  }
}

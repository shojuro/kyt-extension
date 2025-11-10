/**
 * KYT Day 2: Search Service
 *
 * Performs vector similarity search on stored messages
 * - Generates query embedding via OpenAI
 * - Queries Supabase with vector similarity
 * - Returns ranked results by relevance
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Generate embedding for search query
 * @param {string} query - Search query text
 * @returns {Promise<number[]>} - 1536-dimensional embedding vector
 */
async function generateQueryEmbedding(query) {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
      encoding_format: 'float'
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating query embedding:', error.message);
    throw error;
  }
}

/**
 * Search messages by semantic similarity
 * @param {string} query - Natural language search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results to return (default: 5)
 * @param {number} options.threshold - Min similarity score 0-1 (default: 0.5)
 * @param {string} options.role - Filter by role: 'user' or 'assistant'
 * @param {string} options.conversationId - Filter by specific conversation
 * @returns {Promise<Object[]>} - Array of matching messages with similarity scores
 */
export async function searchMessages(query, options = {}) {
  const {
    limit = 5,
    threshold = 0.5,
    role = null,
    conversationId = null
  } = options;

  console.log(`Searching for: "${query}" (limit: ${limit}, threshold: ${threshold})`);

  try {
    // Step 1: Generate embedding for query
    const queryEmbedding = await generateQueryEmbedding(query);

    // Step 2: Build query with filters
    let queryBuilder = supabase.rpc('match_messages', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit
    });

    // Apply additional filters if provided
    if (role) {
      queryBuilder = queryBuilder.eq('role', role);
    }

    if (conversationId) {
      queryBuilder = queryBuilder.eq('conversation_id', conversationId);
    }

    // Step 3: Execute search
    const { data, error } = await queryBuilder;

    if (error) {
      console.error('Search error:', error);
      throw error;
    }

    console.log(`Found ${data.length} results`);

    return data;

  } catch (error) {
    console.error('Search failed:', error);
    return [];
  }
}

/**
 * Search for messages semantically similar to a given message
 * Useful for finding related conversations
 * @param {string} messageId - ID of the reference message
 * @param {number} limit - Max results to return
 * @returns {Promise<Object[]>} - Similar messages with similarity scores
 */
export async function findSimilarMessages(messageId, limit = 5) {
  try {
    // Get the reference message with its embedding
    const { data: refMessage, error: fetchError } = await supabase
      .from('messages')
      .select('embedding, content')
      .eq('message_id', messageId)
      .single();

    if (fetchError) throw fetchError;
    if (!refMessage || !refMessage.embedding) {
      throw new Error('Message not found or has no embedding');
    }

    // Search using the reference message's embedding
    const { data, error } = await supabase.rpc('match_messages', {
      query_embedding: refMessage.embedding,
      match_threshold: 0.5,
      match_count: limit + 1 // +1 because reference message will match itself
    });

    if (error) throw error;

    // Filter out the reference message itself
    const similarMessages = data.filter(m => m.message_id !== messageId);

    console.log(`Found ${similarMessages.length} similar messages to "${refMessage.content.substring(0, 50)}..."`);

    return similarMessages.slice(0, limit);

  } catch (error) {
    console.error('Error finding similar messages:', error);
    return [];
  }
}

/**
 * Get conversation context for a message
 * Returns messages from the same conversation in chronological order
 * @param {string} conversationId - Conversation ID
 * @param {number} limit - Max messages to return
 * @returns {Promise<Object[]>} - Messages in conversation order
 */
export async function getConversationContext(conversationId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) throw error;

    return data || [];

  } catch (error) {
    console.error('Error getting conversation context:', error);
    return [];
  }
}

/**
 * Advanced search with multiple filters and options
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.query - Search query
 * @param {Date} searchParams.startDate - Filter messages after this date
 * @param {Date} searchParams.endDate - Filter messages before this date
 * @param {string[]} searchParams.roles - Filter by roles
 * @param {number} searchParams.limit - Max results
 * @returns {Promise<Object[]>} - Filtered and ranked results
 */
export async function advancedSearch(searchParams) {
  const {
    query,
    startDate = null,
    endDate = null,
    roles = null,
    limit = 10
  } = searchParams;

  try {
    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(query);

    // Build base query
    let queryBuilder = supabase.rpc('match_messages', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3, // Lower threshold for advanced search
      match_count: limit * 2 // Get more results for filtering
    });

    // Apply date filters
    if (startDate) {
      const startTimestamp = new Date(startDate).getTime();
      queryBuilder = queryBuilder.gte('timestamp', startTimestamp);
    }

    if (endDate) {
      const endTimestamp = new Date(endDate).getTime();
      queryBuilder = queryBuilder.lte('timestamp', endTimestamp);
    }

    // Apply role filter
    if (roles && roles.length > 0) {
      queryBuilder = queryBuilder.in('role', roles);
    }

    const { data, error } = await queryBuilder.limit(limit);

    if (error) throw error;

    return data || [];

  } catch (error) {
    console.error('Advanced search failed:', error);
    return [];
  }
}

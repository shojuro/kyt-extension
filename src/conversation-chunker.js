/**
 * KYT Phase 3: Conversation Chunker
 *
 * Converts raw messages into conversation-turn chunks for context-aware search
 *
 * Strategy:
 * - Group messages by conversation_id
 * - Pair user-assistant messages into "turns"
 * - Chunk turns with sliding window (5-7 turns, 2-3 overlap)
 * - Format as: "User: ...\nAssistant: ...\n..."
 * - Extract topics for filtering
 *
 * Output: Turn chunks ready for Supabase chat_turns table
 */

import { normalizePlatform } from './utils/normalize-platform.js';

/**
 * Group messages by conversation ID
 * @param {Object[]} messages - Raw messages from storage
 * @returns {Map<string, Object[]>} Messages grouped by conversation_id
 */
function groupByConversation(messages) {
  const conversations = new Map();

  for (const msg of messages) {
    const convId = msg.conversationId || msg.conversation_id || 'unknown';
    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }
    conversations.get(convId).push(msg);
  }

  // Sort each conversation by timestamp
  for (const [convId, msgs] of conversations) {
    msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return conversations;
}

/**
 * Pair user-assistant messages into turns
 *
 * A "turn" is a user message followed by an assistant response.
 * Handles incomplete turns (user-only or assistant-only).
 *
 * @param {Object[]} messages - Messages from one conversation (sorted by timestamp)
 * @returns {Object[]} Turn pairs [{user: msg, assistant: msg}, ...]
 */
function pairIntoTurns(messages) {
  const turns = [];
  let currentTurn = { user: null, assistant: null };

  for (const msg of messages) {
    const role = (msg.role || '').toLowerCase();

    if (role === 'user') {
      // If we already have a user message, save previous turn
      if (currentTurn.user) {
        turns.push({ ...currentTurn });
        currentTurn = { user: null, assistant: null };
      }
      currentTurn.user = msg;

    } else if (role === 'assistant') {
      currentTurn.assistant = msg;
      // Complete turn - save it
      turns.push({ ...currentTurn });
      currentTurn = { user: null, assistant: null };
    }
    // Ignore 'system' role messages
  }

  // Handle incomplete turn at end
  if (currentTurn.user || currentTurn.assistant) {
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * Extract topics from turn content (simple keyword extraction)
 *
 * Uses pattern matching to find:
 * - Programming languages (python, javascript, etc.)
 * - Tech terms (api, database, auth, etc.)
 *
 * @param {string} content - Turn content
 * @returns {string[]} Extracted topics (max 10)
 */
function extractTopics(content) {
  const keywords = new Set();

  // Programming languages
  const langPattern = /\b(python|javascript|java|rust|go|sql|typescript|bash|c\+\+|csharp|ruby|php|swift|kotlin)\b/gi;
  const langMatches = content.match(langPattern) || [];
  langMatches.forEach(lang => keywords.add(lang.toLowerCase()));

  // Common tech terms
  const techPattern = /\b(api|database|auth|bug|error|rls|postgres|supabase|openai|embedding|vector|search|query|token|sync|schema|index|function|table|column|constraint|policy|view|trigger|migration|optimization|performance|security|testing|debugging|deployment|docker|kubernetes|aws|gcp|azure|github|git|ci\/cd|rest|graphql|websocket|http|https|json|xml|yaml|csv|regex|cache|queue|stream|batch|async|promise|callback|event|listener|observer|mutation|injection|xss|csrf|ssl|tls|jwt|oauth|saml|cors|cdn|dns|ip|tcp|udp|firewall|load balancer|nginx|apache|redis|mongodb|elasticsearch|kafka|rabbitmq|celery|django|flask|fastapi|express|react|vue|angular|nextjs|svelte|tailwind|bootstrap|webpack|vite|npm|yarn|pip|conda|virtualenv|poetry|pytest|jest|mocha|cypress|selenium|playwright)\b/gi;
  const techMatches = content.match(techPattern) || [];
  techMatches.forEach(term => keywords.add(term.toLowerCase()));

  // Limit to 10 topics (most relevant)
  return Array.from(keywords).slice(0, 10);
}

/**
 * Chunk conversation turns with sliding window
 *
 * Example with windowSize=5, overlap=2:
 * - Chunk 1: turns 1-5
 * - Chunk 2: turns 4-8 (overlaps with turns 4-5 from chunk 1)
 * - Chunk 3: turns 7-11 (overlaps with turns 7-8 from chunk 2)
 *
 * @param {Object[]} turns - Turn pairs from conversation
 * @param {number} windowSize - Number of turns per chunk (default 5)
 * @param {number} overlap - Number of turns to overlap (default 2)
 * @returns {Object[]} Turn chunks
 */
function chunkTurns(turns, windowSize = 5, overlap = 2) {
  const chunks = [];
  const step = windowSize - overlap;

  for (let i = 0; i < turns.length; i += step) {
    const window = turns.slice(i, i + windowSize);

    if (window.length === 0) continue;

    // Format as: "User: ...\nAssistant: ...\n..."
    const contentParts = [];
    const speakers = new Set();
    const timestamps = [];

    for (const turn of window) {
      if (turn.user) {
        contentParts.push(`User: ${turn.user.content}`);
        speakers.add('user');
        timestamps.push(turn.user.timestamp);
      }
      if (turn.assistant) {
        contentParts.push(`Assistant: ${turn.assistant.content}`);
        speakers.add('assistant');
        timestamps.push(turn.assistant.timestamp);
      }
    }

    const content = contentParts.join('\n\n');
    const topics = extractTopics(content);

    // Mark chunk as question if ALL user messages are questions AND
    // no assistant has a substantive response (all deflections or missing)
    const allQuestionsNoAnswers = window.every(turn => {
      const userIsQ = turn.user?.is_question;
      const asstIsDeflection = !turn.assistant || (turn.assistant.deflection >= 0.70);
      return userIsQ && asstIsDeflection;
    });

    // Propagate max assistant deflection score for SQL-level filtering
    const maxDeflection = Math.max(0, ...window
      .map(t => t.assistant?.deflection || 0));

    chunks.push({
      turn_range: `${i + 1}-${i + window.length}`,
      content: content,
      speakers: Array.from(speakers),
      turn_count: window.length,
      start_timestamp: Math.min(...timestamps),
      end_timestamp: Math.max(...timestamps),
      topics: topics,
      is_question: allQuestionsNoAnswers,
      deflection: maxDeflection > 0 ? maxDeflection : null,
      // conversation_id, platform, user_id will be added by caller
    });
  }

  return chunks;
}

/**
 * Main function: Convert raw messages to turn chunks
 *
 * Pipeline:
 * 1. Group messages by conversation_id
 * 2. Pair messages into user-assistant turns
 * 3. Chunk turns with sliding window
 * 4. Add metadata (conversation_id, platform, user_id)
 *
 * @param {Object[]} messages - Raw messages from extension
 * @param {string} userId - User ID for RLS (from Supabase Auth)
 * @returns {Object[]} Turn chunks ready for Supabase chat_turns table
 */
export function messagesToTurnChunks(messages, userId) {
  const allChunks = [];

  // Group by conversation
  const conversations = groupByConversation(messages);

  console.log(`📊 Chunking ${messages.length} messages from ${conversations.size} conversations`);

  for (const [convId, msgs] of conversations) {
    if (msgs.length === 0) continue;

    // Get platform from first message
    const platform = normalizePlatform(msgs[0].platform);

    // Pair into turns
    const turns = pairIntoTurns(msgs);

    if (turns.length === 0) continue;

    console.log(`  📝 Conversation ${convId.substring(0, 20)}: ${msgs.length} messages → ${turns.length} turns`);

    // Chunk with sliding window (5 turns, 2 overlap)
    const chunks = chunkTurns(turns, 5, 2);

    // Add metadata
    for (const chunk of chunks) {
      chunk.conversation_id = convId;
      chunk.platform = platform;
      chunk.user_id = userId;
      chunk.hypothetical_questions = []; // Will be filled by HyDE preprocessing (Phase 4)
    }

    // Propagate content_type from source messages if all agree
    const allContentTypes = msgs.map(m => m.content_type).filter(Boolean);
    if (allContentTypes.length > 0 && new Set(allContentTypes).size === 1) {
      for (const chunk of chunks) {
        chunk.content_type = allContentTypes[0];
      }
    }

    allChunks.push(...chunks);
  }

  console.log(`✅ Created ${allChunks.length} turn chunks from ${messages.length} messages`);

  return allChunks;
}

/**
 * Helper: Get summary statistics for chunking results
 * @param {Object[]} chunks - Turn chunks
 * @returns {Object} Statistics
 */
export function getChunkingStats(chunks) {
  const stats = {
    totalChunks: chunks.length,
    avgTurnsPerChunk: 0,
    avgContentLength: 0,
    platformCounts: {},
    topicCounts: {},
  };

  if (chunks.length === 0) return stats;

  let totalTurns = 0;
  let totalContentLength = 0;

  for (const chunk of chunks) {
    totalTurns += chunk.turn_count;
    totalContentLength += chunk.content.length;

    // Platform counts
    stats.platformCounts[chunk.platform] = (stats.platformCounts[chunk.platform] || 0) + 1;

    // Topic counts
    for (const topic of chunk.topics || []) {
      stats.topicCounts[topic] = (stats.topicCounts[topic] || 0) + 1;
    }
  }

  stats.avgTurnsPerChunk = (totalTurns / chunks.length).toFixed(2);
  stats.avgContentLength = Math.round(totalContentLength / chunks.length);

  return stats;
}

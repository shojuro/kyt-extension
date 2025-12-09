/**
 * Conversation Chunker - TypeScript Version
 *
 * Converts raw messages into conversation-turn chunks for context-aware search.
 *
 * Strategy:
 * - Group messages by conversation_id
 * - Pair user-assistant messages into "turns"
 * - Chunk turns with sliding window (5 turns, 2 overlap)
 * - Format as: "User: ...\nAssistant: ...\n..."
 * - Extract topics for filtering
 *
 * Output: Turn chunks ready for Supabase chat_turns table
 */

// =============================================================================
// Types
// =============================================================================

export interface RawMessage {
  id?: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: number;
  conversationId?: string;
  conversation_id?: string;
  platform?: string;
}

export interface TurnPair {
  user: RawMessage | null;
  assistant: RawMessage | null;
}

export interface TurnChunk {
  turn_range: string;
  content: string;
  speakers: string[];
  turn_count: number;
  start_timestamp: number;
  end_timestamp: number;
  topics: string[];
  conversation_id?: string;
  platform?: string;
  user_id?: string;
  hypothetical_questions?: string[];
}

export interface ChunkingStats {
  totalChunks: number;
  avgTurnsPerChunk: number;
  avgContentLength: number;
  platformCounts: Record<string, number>;
  topicCounts: Record<string, number>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Group messages by conversation ID
 */
function groupByConversation(messages: RawMessage[]): Map<string, RawMessage[]> {
  const conversations = new Map<string, RawMessage[]>();

  for (const msg of messages) {
    const convId = msg.conversationId || msg.conversation_id || 'unknown';
    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }
    conversations.get(convId)!.push(msg);
  }

  // Sort each conversation by timestamp
  for (const [_convId, msgs] of conversations) {
    msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return conversations;
}

/**
 * Pair user-assistant messages into turns
 *
 * A "turn" is a user message followed by an assistant response.
 * Handles incomplete turns (user-only or assistant-only).
 */
function pairIntoTurns(messages: RawMessage[]): TurnPair[] {
  const turns: TurnPair[] = [];
  let currentTurn: TurnPair = { user: null, assistant: null };

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
 */
function extractTopics(content: string): string[] {
  const keywords = new Set<string>();

  // Programming languages
  const langPattern = /\b(python|javascript|java|rust|go|sql|typescript|bash|c\+\+|csharp|ruby|php|swift|kotlin)\b/gi;
  const langMatches = content.match(langPattern) || [];
  langMatches.forEach(lang => keywords.add(lang.toLowerCase()));

  // Common tech terms
  const techPattern = /\b(api|database|auth|bug|error|rls|postgres|supabase|openai|embedding|vector|search|query|token|sync|schema|index|function|table|column|constraint|policy|view|trigger|migration|optimization|performance|security|testing|debugging|deployment|docker|kubernetes|aws|gcp|azure|github|git|rest|graphql|websocket|http|https|json|xml|yaml|csv|regex|cache|queue|stream|batch|async|promise|callback|event|listener|observer|mutation|injection|xss|csrf|ssl|tls|jwt|oauth|saml|cors|cdn|dns|redis|mongodb|elasticsearch|kafka|rabbitmq|django|flask|fastapi|express|react|vue|angular|nextjs|svelte|tailwind|bootstrap|webpack|vite|npm|yarn|pip|conda|pytest|jest|mocha|cypress|selenium|playwright)\b/gi;
  const techMatches = content.match(techPattern) || [];
  techMatches.forEach(term => keywords.add(term.toLowerCase()));

  // Limit to 10 topics
  return Array.from(keywords).slice(0, 10);
}

/**
 * Chunk conversation turns with sliding window
 *
 * Example with windowSize=5, overlap=2:
 * - Chunk 1: turns 1-5
 * - Chunk 2: turns 4-8 (overlaps with turns 4-5 from chunk 1)
 * - Chunk 3: turns 7-11 (overlaps with turns 7-8 from chunk 2)
 */
function chunkTurns(
  turns: TurnPair[],
  windowSize: number = 5,
  overlap: number = 2
): TurnChunk[] {
  const chunks: TurnChunk[] = [];
  const step = windowSize - overlap;

  for (let i = 0; i < turns.length; i += step) {
    const window = turns.slice(i, i + windowSize);

    if (window.length === 0) continue;

    // Format as: "User: ...\nAssistant: ...\n..."
    const contentParts: string[] = [];
    const speakers = new Set<string>();
    const timestamps: number[] = [];

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

    chunks.push({
      turn_range: `${i + 1}-${i + window.length}`,
      content: content,
      speakers: Array.from(speakers),
      turn_count: window.length,
      start_timestamp: Math.min(...timestamps),
      end_timestamp: Math.max(...timestamps),
      topics: topics,
    });
  }

  return chunks;
}

// =============================================================================
// Main Export Functions
// =============================================================================

/**
 * Convert raw messages to turn chunks
 *
 * Pipeline:
 * 1. Group messages by conversation_id
 * 2. Pair messages into user-assistant turns
 * 3. Chunk turns with sliding window
 * 4. Add metadata (conversation_id, platform, user_id)
 *
 * @param messages - Raw messages from import
 * @param userId - User ID for RLS
 * @returns Turn chunks ready for database insertion
 */
export function messagesToTurnChunks(
  messages: RawMessage[],
  userId: string
): TurnChunk[] {
  const allChunks: TurnChunk[] = [];

  // Group by conversation
  const conversations = groupByConversation(messages);

  console.log(`[chunker] Processing ${messages.length} messages from ${conversations.size} conversations`);

  for (const [convId, msgs] of conversations) {
    if (msgs.length === 0) continue;

    // Get platform from first message
    const platform = msgs[0].platform || 'chatgpt';

    // Pair into turns
    const turns = pairIntoTurns(msgs);

    if (turns.length === 0) continue;

    console.log(`[chunker] Conversation ${convId.substring(0, 20)}: ${msgs.length} msgs → ${turns.length} turns`);

    // Chunk with sliding window (5 turns, 2 overlap)
    const chunks = chunkTurns(turns, 5, 2);

    // Add metadata
    for (const chunk of chunks) {
      chunk.conversation_id = convId;
      chunk.platform = platform;
      chunk.user_id = userId;
      chunk.hypothetical_questions = []; // Filled by HyDE in Day 3
    }

    allChunks.push(...chunks);
  }

  console.log(`[chunker] Created ${allChunks.length} chunks from ${messages.length} messages`);

  return allChunks;
}

/**
 * Get summary statistics for chunking results
 */
export function getChunkingStats(chunks: TurnChunk[]): ChunkingStats {
  const stats: ChunkingStats = {
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
    const platform = chunk.platform || 'unknown';
    stats.platformCounts[platform] = (stats.platformCounts[platform] || 0) + 1;

    // Topic counts
    for (const topic of chunk.topics || []) {
      stats.topicCounts[topic] = (stats.topicCounts[topic] || 0) + 1;
    }
  }

  stats.avgTurnsPerChunk = Number((totalTurns / chunks.length).toFixed(2));
  stats.avgContentLength = Math.round(totalContentLength / chunks.length);

  return stats;
}

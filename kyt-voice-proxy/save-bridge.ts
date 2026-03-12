/**
 * Save Bridge — Calls save_chat_turn_batch on response.done to persist voice conversation turns.
 *
 * Fire-and-forget: failures are logged for retry but don't block the conversation.
 */

import { callEdgeFunction } from './memory-bridge.ts';

export interface VoiceTurn {
  content: string;
  speakers: string[];
  conversationId: string;
  timestamp?: number;
}

/**
 * Save a pair of turns (user + assistant) to Supabase.
 * Called on each response.done event from the Realtime API.
 */
export async function saveVoiceTurns(
  userId: string,
  sessionId: string,
  userTranscript: string,
  assistantTranscript: string,
): Promise<void> {
  if (!userTranscript && !assistantTranscript) return;

  const conversationId = `voice-${sessionId}`;
  const now = Date.now();
  const turns: VoiceTurn[] = [];

  if (userTranscript) {
    turns.push({
      content: userTranscript,
      speakers: ['user'],
      conversationId,
      timestamp: now - 1000, // User spoke ~1s before assistant
    });
  }

  if (assistantTranscript) {
    turns.push({
      content: assistantTranscript,
      speakers: ['assistant'],
      conversationId,
      timestamp: now,
    });
  }

  try {
    await callEdgeFunction('save_chat_turn_batch', {
      turns: turns.map((t) => ({
        content: t.content,
        speakers: t.speakers,
        conversation_id: t.conversationId,
        platform: 'mobile',
        content_type: 'conversation',
        user_id: userId,
        start_timestamp: t.timestamp,
        end_timestamp: t.timestamp,
      })),
      user_id: userId,
    });
    console.log(`[save-bridge] Saved ${turns.length} turns for session ${sessionId}`);
  } catch (err) {
    // Fire-and-forget — log but don't throw
    console.error(`[save-bridge] Failed to save turns for session ${sessionId}:`, err);
  }
}

/**
 * Sync messages via save_chat_turn_batch edge function.
 *
 * For authenticated users, this replaces the client-side HuggingFace embedding
 * generation + direct REST inserts in browser-sync.js.  The edge function
 * handles embeddings, classification, and entity extraction server-side.
 */

import { callEdgeFunction } from './api-client.js';

const BATCH_SIZE = 50; // save_chat_turn_batch limit

/**
 * Sync messages to Supabase via the save_chat_turn_batch edge function.
 *
 * @param {Array<Object>} messages - Messages from chrome.storage captured_messages
 * @param {Object} [options]
 * @param {boolean} [options.skipAiProcessing=false] - Skip embeddings/classification (fast path)
 * @returns {Promise<{success: boolean, synced: number, duplicates: number, errors: number}>}
 */
export async function syncViaEdgeFunction(messages, options = {}) {
  const { skipAiProcessing = false } = options;

  if (!messages || messages.length === 0) {
    return { success: true, synced: 0, duplicates: 0, errors: 0 };
  }

  // Get userId from auth session
  const result = await chrome.storage.local.get(['auth_session']);
  const session = result.auth_session;
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error('No authenticated user for edge sync');
  }

  let totalSynced = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;

  // Batch messages into groups of BATCH_SIZE
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    // Convert to edge function format
    const turns = batch.map((msg) => ({
      user_id: userId,
      content: msg.content,
      role: msg.role || 'assistant',
      platform: msg.platform || msg.source || 'chatgpt',
      conversation_id: msg.conversationId || msg.conversation_id || null,
      timestamp: msg.timestamp || msg.capturedAt || Date.now(),
      is_injection: msg.is_injection || false,
      profile_id: userId,  // MVP: profile_id = user_id
    }));

    try {
      const response = await callEdgeFunction('save_chat_turn_batch', {
        turns,
        skip_ai_processing: skipAiProcessing,
      });

      if (response.success) {
        totalSynced += response.inserted || 0;
        totalDuplicates += response.duplicates_skipped || 0;
        totalErrors += response.errors || 0;
      } else {
        console.warn('Edge sync batch failed:', response.error);
        totalErrors += batch.length;
      }
    } catch (err) {
      console.error('Edge sync batch error:', err.message);
      totalErrors += batch.length;

      // Detect rate limiting and signal backoff
      if (err.message?.includes('429') || err.message?.includes('rate limit')) {
        const retryAfter = Date.now() + 60_000; // 60s default backoff
        await chrome.storage.local.set({
          kyt_sync_rate_limited: { retryAfter, setAt: Date.now() },
        });
        console.warn(`⚠️ Rate limited — backing off until ${new Date(retryAfter).toISOString()}`);
        break; // Don't send remaining batches
      }
    }
  }

  console.log(`Edge sync complete: ${totalSynced} synced, ${totalDuplicates} duplicates, ${totalErrors} errors`);

  return {
    success: totalErrors === 0,
    synced: totalSynced,
    duplicates: totalDuplicates,
    errors: totalErrors,
  };
}

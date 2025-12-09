/**
 * Import Conversation Batch - Edge Function
 *
 * Processes historical conversation imports with:
 * - 90-day window filtering
 * - Conversation chunking (5-turn windows, 2-turn overlap)
 * - Batched AI processing (HyDE + embeddings) - Day 3
 * - Auto-resume capability - Day 4
 *
 * @see CLAUDE.md - Anti-Theater Rules (this is REAL implementation)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { messagesToTurnChunks, type RawMessage, type TurnChunk } from '../_shared/conversation-chunker.ts';
// Day 3: Uncomment for AI processing
import { generateHyDE } from '../_shared/hyde-generator.ts';
import { HuggingFaceClient } from '../_shared/huggingface-client.ts';

// =============================================================================
// Constants
// =============================================================================

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100; // Messages per batch for DB insert
const MAX_MESSAGES = 10000; // Safety limit

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Filter messages to 90-day window
 */
function filterTo90Days(messages: RawMessage[]): RawMessage[] {
  const cutoff = Date.now() - NINETY_DAYS_MS;
  return messages.filter(m => {
    const timestamp = m.timestamp || 0;
    return timestamp > cutoff;
  });
}

/**
 * Generate content hash for deduplication
 * MD5 of: content + timestamp + role
 */
async function generateContentHash(content: string, timestamp: number, role: string): Promise<string> {
  const input = `${content}|${timestamp}|${role}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('MD5', data).catch(() => null);

  if (!hashBuffer) {
    // Fallback: simple hash if MD5 not available
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { messages, user_id, platform = 'chatgpt', resume_token } = await req.json();

    // ==========================================================================
    // Input Validation
    // ==========================================================================

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({
        error: 'messages array required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!user_id) {
      return new Response(JSON.stringify({
        error: 'user_id required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (messages.length > MAX_MESSAGES) {
      return new Response(JSON.stringify({
        error: `Max ${MAX_MESSAGES} messages per request`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[import] Starting import: ${messages.length} messages for user ${user_id.substring(0, 8)}...`);

    // ==========================================================================
    // Initialize Supabase Client
    // ==========================================================================

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ==========================================================================
    // Step 1: Filter to 90-day window
    // ==========================================================================

    const rawMessages: RawMessage[] = messages.map((m: any) => ({
      id: m.id,
      content: m.content || '',
      role: m.role || 'user',
      timestamp: m.timestamp || m.create_time * 1000 || Date.now(),
      conversationId: m.conversation_id || m.conversationId,
      conversation_id: m.conversation_id || m.conversationId,
      platform: m.platform || platform,
    }));

    const recentMessages = filterTo90Days(rawMessages);
    const filteredCount = rawMessages.length - recentMessages.length;

    console.log(`[import] 90-day filter: ${recentMessages.length} kept, ${filteredCount} filtered`);

    if (recentMessages.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        status: 'complete',
        processed: 0,
        filtered_old: filteredCount,
        chunks_created: 0,
        message: 'No messages within 90-day window'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ==========================================================================
    // Step 2: Create conversation chunks
    // ==========================================================================

    const chunks = messagesToTurnChunks(recentMessages, user_id);

    console.log(`[import] Created ${chunks.length} chunks from ${recentMessages.length} messages`);

    // ==========================================================================
    // Step 3: Insert chunks to database (Day 2: No AI processing yet)
    // ==========================================================================

    let insertedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    // Process in batches
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      const records = batch.map((chunk: TurnChunk) => ({
        user_id: chunk.user_id,
        conversation_id: chunk.conversation_id,
        platform: chunk.platform || platform,
        content: chunk.content,
        turn_range: chunk.turn_range,
        speakers: chunk.speakers,
        turn_count: chunk.turn_count,
        start_timestamp: chunk.start_timestamp,
        end_timestamp: chunk.end_timestamp,
        topics: chunk.topics,
        // Day 2: Skip AI processing - null embeddings
        embedding: null,
        impact_score: 0,
        intimacy_level: 0,
        // Day 3: Add HyDE questions
        hypothetical_questions: [],
        last_accessed: new Date().toISOString(),
        access_count: 0,
      }));

      try {
        const { data, error } = await supabase
          .from('chat_turns')
          .upsert(records, {
            onConflict: 'user_id,conversation_id,platform,start_timestamp',
            ignoreDuplicates: true,
          })
          .select('id');

        if (error) {
          console.error(`[import] Batch ${i}-${i + batch.length} error:`, error.message);
          errorCount += batch.length;
          errors.push(error.message);
        } else {
          const batchInserted = data?.length || 0;
          insertedCount += batchInserted;
          duplicateCount += batch.length - batchInserted;
        }
      } catch (e) {
        console.error(`[import] Batch ${i}-${i + batch.length} exception:`, e.message);
        errorCount += batch.length;
        errors.push(e.message);
      }
    }

    console.log(`[import] Complete: ${insertedCount} inserted, ${duplicateCount} duplicates, ${errorCount} errors`);

    // ==========================================================================
    // Response
    // ==========================================================================

    return new Response(JSON.stringify({
      success: errorCount === 0,
      status: 'complete', // Day 4: May return 'partial' with resume_token
      processed: chunks.length,
      inserted: insertedCount,
      duplicates_skipped: duplicateCount,
      filtered_old: filteredCount,
      chunks_created: chunks.length,
      errors: errorCount,
      error_messages: errors.slice(0, 5), // Limit error messages
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error(`[import] Fatal error:`, e.message);
    return new Response(JSON.stringify({
      error: e.message,
      status: 'failed'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

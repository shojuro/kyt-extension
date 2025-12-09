/**
 * Import Conversation Batch - Edge Function
 *
 * Processes historical conversation imports with:
 * - 90-day window filtering
 * - Conversation chunking (5-turn windows, 2-turn overlap)
 * - Batched AI processing (HyDE + embeddings)
 * - Auto-resume capability - Day 4
 *
 * @see CLAUDE.md - Anti-Theater Rules (this is REAL implementation)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { messagesToTurnChunks, type RawMessage, type TurnChunk } from '../_shared/conversation-chunker.ts';
import { generateHypotheticalDocument } from '../_shared/hyde-generator.ts';
import { HuggingFaceClient } from '../_shared/huggingface-client.ts';
import { classifyMemory } from '../_shared/memory-classifier.ts';

// =============================================================================
// Constants
// =============================================================================

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DB_BATCH_SIZE = 50; // Chunks per DB insert batch
const HYDE_BATCH_SIZE = 20; // Chunks per HyDE batch
const EMBEDDING_BATCH_SIZE = 50; // Texts per embedding batch
const RATE_LIMIT_MS = 200; // Delay between API batches
const MAX_MESSAGES = 10000; // Safety limit

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Sleep for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Split array into chunks
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

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

// =============================================================================
// Batched AI Processing
// =============================================================================

interface ProcessedChunk extends TurnChunk {
  embedding: number[] | null;
  hyde_questions: string[];
  impact_score: number;
  intimacy_level: number;
}

/**
 * Process chunks with batched HyDE generation
 *
 * @param chunks - Turn chunks to process
 * @param openaiKey - OpenAI API key for HyDE
 * @returns Chunks with HyDE questions attached
 */
async function batchProcessHyDE(
  chunks: TurnChunk[],
  openaiKey: string
): Promise<{ chunk: TurnChunk; hydeDoc: string | null }[]> {
  const results: { chunk: TurnChunk; hydeDoc: string | null }[] = [];
  const batches = chunkArray(chunks, HYDE_BATCH_SIZE);

  console.log(`[import] Processing ${chunks.length} chunks for HyDE in ${batches.length} batches`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    // Process batch in parallel
    const hydePromises = batch.map(async (chunk) => {
      try {
        // Generate HyDE for chunk content (first 500 chars as query)
        const query = chunk.content.substring(0, 500);
        const hydeDoc = await generateHypotheticalDocument(query, openaiKey);
        return { chunk, hydeDoc };
      } catch (e) {
        console.warn(`[import] HyDE failed for chunk, continuing:`, e.message);
        return { chunk, hydeDoc: null };
      }
    });

    const batchResults = await Promise.allSettled(hydePromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // Should not happen since we catch inside, but safety
        console.error('[import] HyDE promise rejected:', result.reason);
      }
    }

    // Rate limit between batches
    if (i < batches.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  return results;
}

/**
 * Process chunks with batched embedding generation
 *
 * @param textsToEmbed - Array of text content to embed
 * @param hfClient - HuggingFace client instance
 * @returns Array of embeddings (4096 dimensions each)
 */
async function batchProcessEmbeddings(
  textsToEmbed: string[],
  hfClient: HuggingFaceClient
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = [];
  const batches = chunkArray(textsToEmbed, EMBEDDING_BATCH_SIZE);

  console.log(`[import] Generating embeddings for ${textsToEmbed.length} texts in ${batches.length} batches`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    try {
      const embeddings = await hfClient.generateEmbeddingsBatch(batch);
      results.push(...embeddings);
    } catch (e) {
      console.error(`[import] Embedding batch ${i} failed:`, e.message);
      // Fill with nulls for failed batch
      results.push(...batch.map(() => null));
    }

    // Rate limit between batches
    if (i < batches.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  return results;
}

/**
 * Classify chunks for gravity scoring (impact + intimacy)
 */
async function batchClassifyChunks(
  chunks: TurnChunk[],
  openaiKey: string
): Promise<{ impact_score: number; intimacy_level: number }[]> {
  const results: { impact_score: number; intimacy_level: number }[] = [];

  // Process in smaller batches to avoid rate limits
  const batches = chunkArray(chunks, HYDE_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const classifyPromises = batch.map(async (chunk) => {
      try {
        const classification = await classifyMemory(
          { content: chunk.content },
          openaiKey
        );
        return {
          impact_score: classification?.impact_score || 0,
          intimacy_level: classification?.intimacy_level || 0
        };
      } catch (e) {
        return { impact_score: 0, intimacy_level: 0 };
      }
    });

    const batchResults = await Promise.allSettled(classifyPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({ impact_score: 0, intimacy_level: 0 });
      }
    }

    // Rate limit
    if (i < batches.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  return results;
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
    const { messages, user_id, platform = 'chatgpt', resume_token, skip_ai = false } = await req.json();

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
    // Initialize Clients
    // ==========================================================================

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';
    const hfKey = Deno.env.get('HUGGINGFACE_API_KEY') || '';
    const hfClient = new HuggingFaceClient(hfKey);

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
    // Step 3: AI Processing (HyDE + Embeddings + Classification)
    // ==========================================================================

    let processedChunks: ProcessedChunk[] = [];

    if (skip_ai || !hfKey) {
      // Skip AI processing - null embeddings
      console.log(`[import] Skipping AI processing (skip_ai=${skip_ai}, hfKey=${!!hfKey})`);
      processedChunks = chunks.map(chunk => ({
        ...chunk,
        embedding: null,
        hyde_questions: [],
        impact_score: 0,
        intimacy_level: 0,
      }));
    } else {
      console.log(`[import] Starting AI processing for ${chunks.length} chunks...`);

      // 3a. Generate HyDE documents (parallel batched)
      const hydeResults = await batchProcessHyDE(chunks, openaiKey);

      // 3b. Prepare texts for embedding (chunk content + HyDE docs)
      const textsToEmbed: string[] = hydeResults.map(({ chunk, hydeDoc }) => {
        // Combine chunk content with HyDE for richer embedding
        return hydeDoc ? `${chunk.content}\n\n${hydeDoc}` : chunk.content;
      });

      // 3c. Generate embeddings (batched)
      const embeddings = await batchProcessEmbeddings(textsToEmbed, hfClient);

      // 3d. Classify for gravity (impact + intimacy)
      const classifications = await batchClassifyChunks(chunks, openaiKey);

      // 3e. Combine results
      processedChunks = chunks.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx] || null,
        hyde_questions: hydeResults[idx]?.hydeDoc
          ? [hydeResults[idx].hydeDoc!.substring(0, 500)]
          : [],
        impact_score: classifications[idx]?.impact_score || 0,
        intimacy_level: classifications[idx]?.intimacy_level || 0,
      }));

      const embeddingsGenerated = embeddings.filter(e => e !== null).length;
      console.log(`[import] AI complete: ${embeddingsGenerated}/${chunks.length} embeddings generated`);
    }

    // ==========================================================================
    // Step 4: Insert to database
    // ==========================================================================

    let insertedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    // Process in batches
    const dbBatches = chunkArray(processedChunks, DB_BATCH_SIZE);

    for (let i = 0; i < dbBatches.length; i++) {
      const batch = dbBatches[i];

      const records = batch.map((chunk: ProcessedChunk) => ({
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
        embedding: chunk.embedding,
        impact_score: chunk.impact_score,
        intimacy_level: chunk.intimacy_level,
        hypothetical_questions: chunk.hyde_questions,
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
          console.error(`[import] DB batch ${i} error:`, error.message);
          errorCount += batch.length;
          errors.push(error.message);
        } else {
          const batchInserted = data?.length || 0;
          insertedCount += batchInserted;
          duplicateCount += batch.length - batchInserted;
        }
      } catch (e) {
        console.error(`[import] DB batch ${i} exception:`, e.message);
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
      processed: recentMessages.length, // Messages processed (not chunks)
      inserted: insertedCount,
      skipped: duplicateCount, // Test expects 'skipped'
      filtered: filteredCount, // Test expects 'filtered'
      chunks_created: processedChunks.length,
      embeddings_generated: processedChunks.filter(c => c.embedding !== null).length,
      errors: errorCount,
      error_messages: errors.slice(0, 5),
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

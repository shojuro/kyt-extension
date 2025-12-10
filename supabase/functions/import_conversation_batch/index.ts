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
const DB_BATCH_SIZE = 25; // Chunks per DB insert batch (checkpoint interval)
const HYDE_BATCH_SIZE = 20; // Chunks per HyDE batch
const EMBEDDING_BATCH_SIZE = 50; // Texts per embedding batch
const RATE_LIMIT_MS = 200; // Delay between API batches
const MAX_MESSAGES = 10000; // Safety limit
const TIMEOUT_BUFFER_MS = 120000; // 120s timeout buffer (30s safety for 150s limit)
const CHUNK_BATCH_SIZE = 100; // Chunks to process before checking timeout

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
// Progress Tracking (Auto-Resume Support)
// =============================================================================

interface ImportProgress {
  id: string;
  user_id: string;
  total_messages: number;
  processed_messages: number;
  last_processed_index: number;
  resume_data: {
    chunks_processed?: number;
    filtered_count?: number;
    platform?: string;
  };
  status: 'in_progress' | 'completed' | 'failed';
  error_message?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Load existing progress for resume
 */
async function loadProgress(supabase: any, progressId: string): Promise<ImportProgress | null> {
  try {
    const { data, error } = await supabase
      .from('import_progress')
      .select('*')
      .eq('id', progressId)
      .single();

    if (error || !data) return null;
    return data as ImportProgress;
  } catch {
    return null;
  }
}

/**
 * Create new progress record
 */
async function createProgress(
  supabase: any,
  userId: string,
  totalMessages: number,
  platform: string
): Promise<ImportProgress | null> {
  try {
    const { data, error } = await supabase
      .from('import_progress')
      .insert({
        user_id: userId,
        total_messages: totalMessages,
        processed_messages: 0,
        last_processed_index: 0,
        resume_data: { platform },
        status: 'in_progress'
      })
      .select()
      .single();

    if (error) {
      console.warn('[import] Could not create progress record:', error.message);
      return null;
    }
    return data as ImportProgress;
  } catch (e) {
    console.warn('[import] Progress creation failed:', e.message);
    return null;
  }
}

/**
 * Update progress record
 */
async function updateProgress(
  supabase: any,
  progressId: string,
  updates: Partial<ImportProgress>
): Promise<void> {
  try {
    await supabase
      .from('import_progress')
      .update(updates)
      .eq('id', progressId);
  } catch (e) {
    console.warn('[import] Progress update failed:', e.message);
  }
}

/**
 * Mark progress as complete
 */
async function markComplete(
  supabase: any,
  progressId: string,
  chunksProcessed?: number,
  chunksInserted?: number
): Promise<void> {
  await updateProgress(supabase, progressId, {
    status: 'completed',
    ...(chunksProcessed !== undefined && { last_processed_index: chunksProcessed }),
    ...(chunksInserted !== undefined && { resume_data: { chunks_inserted: chunksInserted } }),
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
// SSE Streaming Handler
// =============================================================================

/**
 * Handle SSE streaming response for progress updates
 * Returns events as: data: {...json...}\n\n
 */
async function handleSSEStream(req: Request, body: any): Promise<Response> {
  const { messages = [], user_id, platform = 'chatgpt', resume_token, skip_ai = false } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: Record<string, unknown>) => {
        const eventData = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(eventData));
      };

      try {
        // Stage 1: Validating
        sendEvent({ stage: 'validating', percent: 5, message: 'Validating input...' });

        if (!messages || !Array.isArray(messages) || !user_id) {
          sendEvent({ stage: 'error', percent: 100, message: 'Invalid input: messages array and user_id required' });
          controller.close();
          return;
        }

        // Stage 2: Filtering
        sendEvent({ stage: 'filtering', percent: 10, message: `Filtering ${messages.length} messages to 90-day window...` });

        const cutoff = Date.now() - NINETY_DAYS_MS;
        const rawMessages: RawMessage[] = messages.map((m: any) => ({
          id: m.id,
          content: m.content || '',
          role: m.role || 'user',
          timestamp: m.timestamp || m.create_time * 1000 || Date.now(),
          conversationId: m.conversation_id || m.conversationId,
          conversation_id: m.conversation_id || m.conversationId,
          platform: m.platform || platform,
        }));

        const recentMessages = rawMessages.filter(m => (m.timestamp || 0) > cutoff);
        const filteredCount = rawMessages.length - recentMessages.length;

        sendEvent({
          stage: 'filtering',
          percent: 15,
          message: `Kept ${recentMessages.length} messages, filtered ${filteredCount} older messages`
        });

        if (recentMessages.length === 0) {
          sendEvent({
            stage: 'complete',
            percent: 100,
            inserted: 0,
            skipped: 0,
            filtered: filteredCount,
            message: 'No messages within 90-day window'
          });
          controller.close();
          return;
        }

        // Stage 3: Chunking
        sendEvent({ stage: 'chunking', percent: 20, message: 'Creating conversation chunks...' });

        const chunks = messagesToTurnChunks(recentMessages, user_id);
        sendEvent({
          stage: 'chunking',
          percent: 25,
          message: `Created ${chunks.length} chunks from ${recentMessages.length} messages`
        });

        // Initialize clients
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );
        const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';
        const hfKey = Deno.env.get('HUGGINGFACE_API_KEY') || '';
        const hfClient = new HuggingFaceClient(hfKey);

        let processedChunks: ProcessedChunk[] = [];

        if (skip_ai || !hfKey) {
          // Skip AI
          sendEvent({ stage: 'processing', percent: 50, message: 'Skipping AI processing...' });
          processedChunks = chunks.map(chunk => ({
            ...chunk,
            embedding: null,
            hyde_questions: [],
            impact_score: 0,
            intimacy_level: 0,
          }));
        } else {
          // Stage 4: HyDE generation
          sendEvent({ stage: 'hyde', percent: 30, message: 'Generating HyDE documents...' });
          const hydeResults = await batchProcessHyDE(chunks, openaiKey);
          sendEvent({ stage: 'hyde', percent: 45, message: `Generated ${hydeResults.filter(h => h.hydeDoc).length} HyDE documents` });

          // Stage 5: Embeddings
          sendEvent({ stage: 'embeddings', percent: 50, message: 'Generating embeddings...' });
          const textsToEmbed = hydeResults.map(({ chunk, hydeDoc }) =>
            hydeDoc ? `${chunk.content}\n\n${hydeDoc}` : chunk.content
          );
          const embeddings = await batchProcessEmbeddings(textsToEmbed, hfClient);
          sendEvent({ stage: 'embeddings', percent: 65, message: `Generated ${embeddings.filter(e => e).length}/${chunks.length} embeddings` });

          // Stage 6: Classification
          sendEvent({ stage: 'classifying', percent: 70, message: 'Classifying memories...' });
          const classifications = await batchClassifyChunks(chunks, openaiKey);
          sendEvent({ stage: 'classifying', percent: 80, message: 'Classification complete' });

          // Combine results
          processedChunks = chunks.map((chunk, idx) => ({
            ...chunk,
            embedding: embeddings[idx] || null,
            hyde_questions: hydeResults[idx]?.hydeDoc ? [hydeResults[idx].hydeDoc!.substring(0, 500)] : [],
            impact_score: classifications[idx]?.impact_score || 0,
            intimacy_level: classifications[idx]?.intimacy_level || 0,
          }));
        }

        // Stage 7: Database insert
        sendEvent({ stage: 'inserting', percent: 85, message: 'Inserting to database...' });

        let insertedCount = 0;
        let duplicateCount = 0;
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

            if (!error && data) {
              insertedCount += data.length;
              duplicateCount += batch.length - data.length;
            }
          } catch (e) {
            console.error(`[import-sse] DB batch ${i} error:`, e.message);
          }

          // Progress update per batch
          const progress = 85 + ((i + 1) / dbBatches.length) * 10;
          sendEvent({
            stage: 'inserting',
            percent: Math.round(progress),
            message: `Inserted batch ${i + 1}/${dbBatches.length}`
          });
        }

        // Stage 8: Complete
        sendEvent({
          stage: 'complete',
          percent: 100,
          inserted: insertedCount,
          skipped: duplicateCount,
          filtered: filteredCount,
          chunks_created: processedChunks.length,
          message: `Import complete: ${insertedCount} inserted, ${duplicateCount} duplicates`
        });

      } catch (e) {
        sendEvent({ stage: 'error', percent: 100, message: `Import failed: ${e.message}` });
      }

      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
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
    const body = await req.json();
    const { messages, user_id, platform = 'chatgpt', resume_token, skip_ai = false, stream_progress = false } = body;

    // ==========================================================================
    // SSE Streaming Support
    // ==========================================================================

    const wantsStream = req.headers.get('Accept')?.includes('text/event-stream') || stream_progress === true;

    if (wantsStream) {
      // Return SSE streaming response
      return handleSSEStream(req, body);
    }

    // ==========================================================================
    // Non-streaming path (original logic)
    // ==========================================================================

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
    // Initialize Clients & Timeout Tracking
    // ==========================================================================

    const startTime = Date.now();
    const timeoutDeadline = startTime + TIMEOUT_BUFFER_MS;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const openaiKey = Deno.env.get('OPENAI_API_KEY') || '';
    const hfKey = Deno.env.get('HUGGINGFACE_API_KEY') || '';
    const hfClient = new HuggingFaceClient(hfKey);

    // ==========================================================================
    // Progress Tracking (Auto-Resume Support)
    // ==========================================================================

    let progress: ImportProgress | null = null;
    let startIndex = 0;

    // Load existing progress if resume_token provided
    if (resume_token) {
      progress = await loadProgress(supabase, resume_token);
      if (progress) {
        startIndex = progress.last_processed_index;
        console.log(`[import] Resuming from index ${startIndex} (progress ${progress.id.substring(0, 8)}...)`);
      } else {
        console.warn(`[import] Invalid resume_token, starting fresh`);
      }
    }

    // Create new progress if not resuming (and table exists)
    if (!progress) {
      progress = await createProgress(supabase, user_id, messages.length, platform);
      if (progress) {
        console.log(`[import] Created progress record ${progress.id.substring(0, 8)}...`);
      }
    }

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

    const allChunks = messagesToTurnChunks(recentMessages, user_id);

    console.log(`[import] Created ${allChunks.length} chunks from ${recentMessages.length} messages`);

    // ==========================================================================
    // Step 2b: Skip already processed chunks on resume
    // ==========================================================================

    const chunks = allChunks.slice(startIndex);
    const skippedChunks = startIndex;

    if (chunks.length === 0) {
      // All chunks already processed in previous run
      console.log(`[import] All ${allChunks.length} chunks already processed, marking complete`);
      if (progress) {
        await markComplete(supabase, progress.id, allChunks.length, 0);
      }
      return new Response(JSON.stringify({
        success: true,
        status: 'complete',
        processed: recentMessages.length,
        filtered_old: filteredCount,
        chunks_created: allChunks.length,
        inserted: 0,
        skipped: allChunks.length,
        message: 'All chunks already processed in previous run'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[import] Processing ${chunks.length} chunks (skipping ${skippedChunks} already processed)`);

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
    // Step 4: Insert to database (with timeout checking)
    // ==========================================================================

    let insertedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const errors: string[] = [];
    let chunksProcessed = 0;
    let timedOut = false;

    // Process in batches
    const dbBatches = chunkArray(processedChunks, DB_BATCH_SIZE);

    for (let i = 0; i < dbBatches.length; i++) {
      // Check for timeout before processing each batch
      if (Date.now() > timeoutDeadline) {
        console.log(`[import] Timeout approaching, stopping at batch ${i}/${dbBatches.length}`);
        timedOut = true;
        break;
      }

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
          chunksProcessed += batch.length;
        }
      } catch (e) {
        console.error(`[import] DB batch ${i} exception:`, e.message);
        errorCount += batch.length;
        errors.push(e.message);
      }

      // Update progress after each batch (use global index for resume)
      if (progress) {
        const globalIndex = startIndex + chunksProcessed;
        await updateProgress(supabase, progress.id, {
          processed_messages: recentMessages.length,
          last_processed_index: globalIndex,  // CRITICAL: Global index for correct resume
          resume_data: {
            chunks_processed: globalIndex,
            total_chunks: allChunks.length,
            filtered_count: filteredCount,
            platform
          }
        });
      }
    }

    console.log(`[import] ${timedOut ? 'Partial' : 'Complete'}: ${insertedCount} inserted, ${duplicateCount} duplicates, ${errorCount} errors (global progress: ${startIndex + chunksProcessed}/${allChunks.length})`);

    // ==========================================================================
    // Response (with auto-resume support)
    // ==========================================================================

    // Mark complete if finished
    const globalProcessed = startIndex + chunksProcessed;
    if (!timedOut && progress) {
      await markComplete(supabase, progress.id, globalProcessed, insertedCount);
    }

    // Calculate remaining chunks for partial response (from total, not current batch)
    const remainingChunks = allChunks.length - globalProcessed;

    return new Response(JSON.stringify({
      success: errorCount === 0 && !timedOut,
      status: timedOut ? 'partial' : 'complete',
      processed: recentMessages.length,
      inserted: insertedCount,
      skipped: duplicateCount + skippedChunks,  // Include previously processed
      filtered: filteredCount,
      chunks_created: globalProcessed,  // Global count
      chunks_total: allChunks.length,   // Total for progress tracking
      embeddings_generated: processedChunks.slice(0, chunksProcessed).filter(c => c.embedding !== null).length,
      errors: errorCount,
      error_messages: errors.slice(0, 5),
      // Auto-resume fields (only present when partial)
      ...(timedOut && progress ? {
        resumeToken: progress.id,
        remaining: remainingChunks,
      } : {}),
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

/**
 * Edge Function: backfill_contextual
 *
 * Generates LLM context summaries for existing chat_turns and re-embeds them.
 * Implements Anthropic's Contextual Retrieval technique for conversations.
 *
 * For each chunk:
 * 1. Fetches surrounding chunks from the same conversation (adjacent + opener)
 * 2. Generates a context summary via GPT-4o-mini
 * 3. Re-embeds the contextualized content via HuggingFace
 * 4. Updates the row with contextual_content + new embedding
 *
 * Configuration:
 * - BATCH_SIZE: 5 (GPT-4o-mini per row + re-embedding)
 * - MAX_ROWS: 100 per invocation
 * - BATCH_DELAY_MS: 2000ms between batches
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateChunkContext } from "../_shared/context-generator.ts";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiApiKey = Deno.env.get("OPENAI_API_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey);

const BATCH_SIZE = 5;
const MAX_ROWS = 15;  // ~10s per row (fetch + GPT-4o-mini + re-embed), 150s Supabase limit
const BATCH_DELAY_MS = 500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Fetch surrounding chunks for a given chat_turn from the same conversation.
 * Returns up to 3 chunks: 2 temporally adjacent + the opening chunk (if different).
 */
async function fetchSurroundingChunks(
  conversationId: string,
  userId: string,
  currentId: string,
  startTimestamp: number
): Promise<string[]> {
  const chunks: string[] = [];
  const seenIds = new Set<string>([currentId]);

  try {
    // Adjacent chunks (temporally nearest)
    const { data: adjacent } = await supabase
      .from("chat_turns")
      .select("id, content")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .neq("id", currentId)
      .order("start_timestamp", { ascending: true })
      .limit(50); // Fetch enough to find nearest

    if (adjacent && adjacent.length > 0) {
      // Sort by temporal distance from current chunk
      const sorted = adjacent
        .filter((r: any) => r.content && r.content.trim().length > 0)
        .map((r: any) => ({
          ...r,
          distance: Math.abs((r.start_timestamp || 0) - startTimestamp),
        }))
        .sort((a: any, b: any) => a.distance - b.distance);

      // Take 2 nearest
      for (const item of sorted.slice(0, 2)) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          chunks.push(item.content);
        }
      }
    }

    // Opening chunk (topic framing — often contains "I want to discuss X")
    const { data: opener } = await supabase
      .from("chat_turns")
      .select("id, content")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .order("start_timestamp", { ascending: true })
      .limit(1);

    if (opener && opener.length > 0 && !seenIds.has(opener[0].id)) {
      if (opener[0].content && opener[0].content.trim().length > 0) {
        chunks.push(opener[0].content);
      }
    }
  } catch (err) {
    console.warn(
      `Failed to fetch surrounding chunks for ${conversationId}: ${(err as Error).message}`
    );
  }

  return chunks;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("Starting backfill_contextual...");

    // Parse optional body params
    let requestedLimit = MAX_ROWS;
    try {
      const body = await req.json();
      if (body?.limit && typeof body.limit === "number" && body.limit > 0) {
        requestedLimit = Math.min(body.limit, MAX_ROWS);
      }
    } catch {
      // No body or invalid JSON — use defaults
    }

    const effectiveMaxRows = requestedLimit;
    let totalProcessed = 0;
    let totalContextGenerated = 0;
    let totalReembedded = 0;
    let errors = 0;

    const maxBatches = Math.ceil(effectiveMaxRows / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing context generation
      const { data: rows, error: fetchError } = await supabase
        .from("chat_turns")
        .select(
          "id, content, conversation_id, user_id, platform, start_timestamp"
        )
        .or("context_generated.is.null,context_generated.eq.false")
        .order("created_at", { ascending: false }) // Newest first
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error("Fetch error:", fetchError.message);
        throw fetchError;
      }

      if (!rows || rows.length === 0) {
        console.log("No more rows to process.");
        break;
      }

      console.log(
        `Batch ${batch + 1}: processing ${rows.length} chat_turns`
      );

      for (const row of rows) {
        try {
          if (!row.content || !row.user_id) {
            // Mark as processed to skip in future runs
            await supabase
              .from("chat_turns")
              .update({
                context_generated: true,
                context_generated_at: new Date().toISOString(),
              })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Fetch surrounding chunks for topic context
          const surroundingChunks = await fetchSurroundingChunks(
            row.conversation_id,
            row.user_id,
            row.id,
            row.start_timestamp || 0
          );

          // Generate context summary via GPT-4o-mini
          const contextResult = await generateChunkContext(
            {
              chunkContent: row.content,
              platform: row.platform,
              conversationId: row.conversation_id,
              timestamp: row.start_timestamp
                ? new Date(row.start_timestamp).toISOString()
                : undefined,
              surroundingChunks,
            },
            openaiApiKey
          );

          if (contextResult) {
            totalContextGenerated++;

            // Re-embed with contextualized content
            // ASYMMETRIC EMBEDDING: stored chunks get context prefix,
            // query embeddings stay raw. DO NOT "fix" this.
            try {
              const [newEmbedding] = await hfClient.generateEmbeddings(
                contextResult.contextualContent
              );

              // Update row with context + new embedding
              await supabase
                .from("chat_turns")
                .update({
                  contextual_content: contextResult.contextualContent,
                  embedding: newEmbedding,
                  context_generated: true,
                  context_generated_at: new Date().toISOString(),
                })
                .eq("id", row.id);

              totalReembedded++;
            } catch (embedErr) {
              // Context generated but embedding failed — save context anyway
              console.warn(
                `Re-embedding failed for ${row.id}: ${(embedErr as Error).message}`
              );
              await supabase
                .from("chat_turns")
                .update({
                  contextual_content: contextResult.contextualContent,
                  context_generated: true,
                  context_generated_at: new Date().toISOString(),
                })
                .eq("id", row.id);
            }
          } else {
            // Context generation failed — mark as processed to avoid infinite retry
            // The row keeps its existing raw embedding
            console.warn(`Context generation returned null for ${row.id}`);
            await supabase
              .from("chat_turns")
              .update({
                context_generated: true,
                context_generated_at: new Date().toISOString(),
              })
              .eq("id", row.id);
          }

          totalProcessed++;
          console.log(
            `  Row ${row.id}: context=${contextResult ? "yes" : "no"}, surrounding=${surroundingChunks.length} chunks`
          );
        } catch (rowErr) {
          errors++;
          console.error(
            `  Row ${row.id} failed: ${(rowErr as Error).message}`
          );
          // Don't mark as processed — will retry on next run
        }
      }

      // Rate limit delay between batches
      if (batch < maxBatches - 1 && rows.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      } else if (rows.length < BATCH_SIZE) {
        break;
      }
    }

    // Count remaining
    const { count: remaining } = await supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .or("context_generated.is.null,context_generated.eq.false");

    const result = {
      success: true,
      processed: totalProcessed,
      context_generated: totalContextGenerated,
      reembedded: totalReembedded,
      errors,
      remaining: remaining || 0,
    };

    console.log("Backfill contextual complete:", result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Backfill contextual failed:", (error as Error).message);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

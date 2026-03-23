/**
 * Edge Function: backfill_emotions
 *
 * Backfills valence, arousal, and emotion_keywords for chat_turns
 * that were saved before the emotional dimensions feature.
 * Also refreshes impact_score and intimacy_level with the updated classifier.
 *
 * Pattern follows backfill_gravity/index.ts.
 *
 * Configuration:
 * - BATCH_SIZE: 5 (Haiku 4.5 per row)
 * - MAX_ROWS: 50 per invocation (default)
 * - BATCH_DELAY_MS: 2000ms between batches (200ms in fast_mode)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyMemory } from "../_shared/memory-classifier.ts";
import type { ClientContext } from "../_shared/anthropic-client.ts";
import { securityHeaders } from "../_shared/headers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BATCH_SIZE = 5;
const MAX_ROWS = 50;
const MAX_ROWS_CAP = 50;
const BATCH_DELAY_MS = 2000;
const FAST_BATCH_DELAY_MS = 200;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  ...securityHeaders(),
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("Starting backfill_emotions...");

    // Parse optional body params
    let requestedLimit = MAX_ROWS;
    let fastMode = false;
    let filterUserId: string | null = null;
    try {
      const body = await req.json();
      fastMode = body?.fast_mode === true;
      if (body?.max_rows && typeof body.max_rows === "number" && body.max_rows > 0) {
        requestedLimit = Math.min(body.max_rows, MAX_ROWS_CAP);
      }
      if (body?.user_id && typeof body.user_id === "string") {
        filterUserId = body.user_id;
      }
    } catch {
      // No body or invalid JSON — use defaults
    }

    const effectiveMaxRows = requestedLimit;
    const effectiveDelay = fastMode ? FAST_BATCH_DELAY_MS : BATCH_DELAY_MS;
    console.log(`  Options: fast_mode=${fastMode}, user_id=${filterUserId?.substring(0, 8) || "all"}, max_rows=${effectiveMaxRows}`);

    let totalProcessed = 0;
    let totalClassified = 0;
    let errors = 0;

    const maxBatches = Math.ceil(effectiveMaxRows / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing emotional classification:
      // emotion_classified = false → never classified with valence/arousal
      // Skip questions and high-deflection rows
      let query = supabase
        .from("chat_turns")
        .select("id, content, speakers, is_question, deflection")
        .eq("emotion_classified", false)
        .order("created_at", { ascending: false })
        .limit(BATCH_SIZE);

      if (filterUserId) {
        query = query.eq("user_id", filterUserId);
      }

      const { data: rows, error: fetchError } = await query;

      if (fetchError) {
        console.error("Fetch error:", fetchError.message);
        throw fetchError;
      }

      if (!rows || rows.length === 0) {
        console.log("No more rows to process.");
        break;
      }

      console.log(`Batch ${batch + 1}: processing ${rows.length} chat_turns`);

      for (const row of rows) {
        try {
          // Skip rows with no content
          if (!row.content) {
            await supabase
              .from("chat_turns")
              .update({ emotion_classified: true })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Skip questions and deflections — they don't carry emotional gravity
          if (row.is_question === true || (row.deflection != null && row.deflection >= 0.70)) {
            await supabase
              .from("chat_turns")
              .update({ emotion_classified: true })
              .eq("id", row.id);
            totalProcessed++;
            console.log(`  Row ${row.id}: skipped (${row.is_question ? "question" : "deflection"})`);
            continue;
          }

          // Classify memory: full classification including valence/arousal/emotion_keywords
          const costContext: ClientContext = { userId: filterUserId || undefined, edgeFunction: 'backfill_emotions' };
          const classification = await classifyMemory(
            {
              content: row.content,
              speakers: row.speakers || ["user", "assistant"],
            },
            anthropicApiKey,
            costContext
          );

          // Update the row with all classification fields
          const updateData: Record<string, unknown> = {
            impact_score: classification.impact_score,
            intimacy_level: classification.intimacy_level,
            valence: classification.valence,
            arousal: classification.arousal,
            emotion_keywords: classification.emotion_keywords.length > 0 ? classification.emotion_keywords : null,
            emotion_classified: true,
            gravity_classified: true, // Also mark gravity as classified
          };

          const { error: updateError } = await supabase
            .from("chat_turns")
            .update(updateData)
            .eq("id", row.id);

          if (updateError) {
            throw updateError;
          }

          totalProcessed++;
          totalClassified++;
          console.log(`  Row ${row.id}: impact=${classification.impact_score}, intimacy=${classification.intimacy_level}, valence=${classification.valence}, arousal=${classification.arousal}, keywords=${classification.emotion_keywords.length}`);
        } catch (rowErr) {
          errors++;
          console.error(`  Row ${row.id} failed: ${(rowErr as Error).message}`);
          // Continue to next row — don't update so it retries
        }
      }

      // Rate limit delay between batches
      if (batch < maxBatches - 1 && rows.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, effectiveDelay));
      } else if (rows.length < BATCH_SIZE) {
        break;
      }
    }

    // Count remaining unprocessed rows
    let remainingQuery = supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .eq("emotion_classified", false);
    if (filterUserId) {
      remainingQuery = remainingQuery.eq("user_id", filterUserId);
    }
    const { count: remaining } = await remainingQuery;

    const result = {
      success: true,
      processed: totalProcessed,
      classified: totalClassified,
      errors,
      remaining: remaining || 0,
    };

    console.log("Backfill emotions complete:", result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Backfill emotions failed:", (error as Error).message);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

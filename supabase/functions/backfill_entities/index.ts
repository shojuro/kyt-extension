/**
 * Edge Function: backfill_entities
 *
 * Re-processes existing chat_turns with the updated entity extractor
 * (CONCEPT/ANALOGY/THEME support). Mirrors the backfill_embeddings pattern.
 *
 * Queries chat_turns where entities_extracted = false, runs entity extraction
 * + saveEntitiesWithMentions per row, then marks entities_extracted = true.
 *
 * Configuration:
 * - BATCH_SIZE: 5 (GPT-4o-mini per row)
 * - MAX_ROWS: 100 per invocation
 * - BATCH_DELAY_MS: 2000ms between batches
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractEntities, saveEntitiesWithMentions } from "../_shared/entity-extractor.ts";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiApiKey = Deno.env.get("OPENAI_API_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey);

const BATCH_SIZE = 5;
const MAX_ROWS = 100;
const BATCH_DELAY_MS = 2000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("Starting backfill_entities...");

    // Parse optional body params
    let forceReextract = false;
    try {
      const body = await req.json();
      forceReextract = body?.force_reextract === true;
    } catch {
      // No body or invalid JSON — use defaults
    }

    let totalProcessed = 0;
    let totalEntitiesCreated = 0;
    let errors = 0;

    // Process in batches
    const maxBatches = Math.ceil(MAX_ROWS / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing entity extraction
      let query = supabase
        .from("chat_turns")
        .select("id, content, speakers, conversation_id, user_id")
        .order("id")
        .limit(BATCH_SIZE);

      if (forceReextract) {
        // Re-extract all (for updating entity types after schema changes)
        query = query.or("entities_extracted.is.null,entities_extracted.eq.false");
      } else {
        // Only process rows that haven't been extracted yet
        query = query.or("entities_extracted.is.null,entities_extracted.eq.false");
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

      // Process each row
      for (const row of rows) {
        try {
          if (!row.content || !row.user_id) {
            // Mark as extracted to skip in future runs
            await supabase
              .from("chat_turns")
              .update({ entities_extracted: true })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Extract entities using GPT-4o-mini
          const entities = await extractEntities(
            {
              content: row.content,
              speakers: row.speakers || ["User", "Assistant"],
            },
            openaiApiKey
          );

          // Save entities + mentions + relationships
          if (entities.length > 0) {
            await saveEntitiesWithMentions(
              entities,
              row.id,
              row.conversation_id || row.id,
              row.user_id,
              supabase,
              hfClient
            );
            totalEntitiesCreated += entities.length;
          }

          // Mark as extracted
          await supabase
            .from("chat_turns")
            .update({ entities_extracted: true })
            .eq("id", row.id);

          totalProcessed++;
          console.log(`  Row ${row.id}: ${entities.length} entities extracted`);
        } catch (rowErr) {
          errors++;
          console.error(`  Row ${row.id} failed: ${(rowErr as Error).message}`);
          // Continue to next row — don't mark as extracted so it retries
        }
      }

      // Rate limit delay between batches
      if (batch < maxBatches - 1 && rows.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      } else if (rows.length < BATCH_SIZE) {
        // Last batch was partial — no more rows
        break;
      }
    }

    // Count remaining
    const { count: remaining } = await supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .or("entities_extracted.is.null,entities_extracted.eq.false");

    const result = {
      success: true,
      processed: totalProcessed,
      entities_created: totalEntitiesCreated,
      errors,
      remaining: remaining || 0,
    };

    console.log("Backfill complete:", result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Backfill failed:", (error as Error).message);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

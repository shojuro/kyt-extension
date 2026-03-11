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
import { extractEntities, saveEntitiesWithMentions, savePreferences } from "../_shared/entity-extractor.ts";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";
import type { ClientContext } from "../_shared/anthropic-client.ts";
import { securityHeaders } from "../_shared/headers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey, { edgeFunction: 'backfill_entities' });

const BATCH_SIZE = 5;
const MAX_ROWS = 100;
const MAX_ROWS_CAP = 200; // Absolute cap for max_rows param
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
    console.log("Starting backfill_entities...");

    // Parse optional body params
    let forceReextract = false;
    let requestedLimit = MAX_ROWS;
    let fastMode = false;
    let filterUserId: string | null = null;
    let contentTypeFilter: string | null = null;
    try {
      const body = await req.json();
      forceReextract = body?.force_reextract === true;
      fastMode = body?.fast_mode === true;
      if (body?.limit && typeof body.limit === 'number' && body.limit > 0) {
        requestedLimit = Math.min(body.limit, MAX_ROWS_CAP);
      }
      if (body?.max_rows && typeof body.max_rows === 'number' && body.max_rows > 0) {
        requestedLimit = Math.min(body.max_rows, MAX_ROWS_CAP);
      }
      if (body?.user_id && typeof body.user_id === 'string') {
        filterUserId = body.user_id;
      }
      if (body?.content_type_filter && typeof body.content_type_filter === 'string') {
        contentTypeFilter = body.content_type_filter;
      }
    } catch {
      // No body or invalid JSON — use defaults
    }

    const effectiveMaxRows = requestedLimit;
    const effectiveDelay = fastMode ? FAST_BATCH_DELAY_MS : BATCH_DELAY_MS;
    console.log(`  Options: fast_mode=${fastMode}, user_id=${filterUserId?.substring(0, 8) || 'all'}, content_type=${contentTypeFilter || 'all'}, max_rows=${effectiveMaxRows}`);
    let totalProcessed = 0;
    let totalEntitiesCreated = 0;
    let errors = 0;

    // Process in batches
    const maxBatches = Math.ceil(effectiveMaxRows / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing entity extraction
      let query = supabase
        .from("chat_turns")
        .select("id, content, speakers, conversation_id, user_id, is_question, deflection")
        .order("created_at", { ascending: false })
        .limit(BATCH_SIZE);

      if (!forceReextract) {
        // Only process rows that haven't been extracted yet (entities OR preferences)
        query = query.or(
          "entities_extracted.is.null,entities_extracted.eq.false," +
          "preferences_extracted.is.null,preferences_extracted.eq.false"
        );
      }
      // When forceReextract=true, no filter — re-processes all rows

      // Apply optional filters
      if (filterUserId) {
        query = query.eq("user_id", filterUserId);
      }
      if (contentTypeFilter) {
        query = query.eq("content_type", contentTypeFilter);
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
              .update({ entities_extracted: true, preferences_extracted: true })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Skip questions and deflections — no useful entities to extract
          if (row.is_question === true || (row.deflection != null && row.deflection >= 0.70)) {
            await supabase
              .from("chat_turns")
              .update({ entities_extracted: true, preferences_extracted: true })
              .eq("id", row.id);
            totalProcessed++;
            console.log(`  Row ${row.id}: skipped (${row.is_question ? 'question' : 'deflection'})`);
            continue;
          }

          // Extract entities + preferences using GPT-4o-mini
          const costContext: ClientContext = { userId: row.user_id, edgeFunction: 'backfill_entities' };
          const { entities, preferences } = await extractEntities(
            {
              content: row.content,
              speakers: row.speakers || ["User", "Assistant"],
            },
            anthropicApiKey,
            costContext
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

          // Save preferences
          if (preferences.length > 0) {
            await savePreferences(preferences, row.id, row.user_id, supabase);
          }

          // Mark as extracted (both entities and preferences)
          await supabase
            .from("chat_turns")
            .update({ entities_extracted: true, preferences_extracted: true })
            .eq("id", row.id);

          totalProcessed++;
          console.log(`  Row ${row.id}: ${entities.length} entities, ${preferences.length} preferences extracted`);
        } catch (rowErr) {
          errors++;
          console.error(`  Row ${row.id} failed: ${(rowErr as Error).message}`);
          // Continue to next row — don't mark as extracted so it retries
        }
      }

      // Rate limit delay between batches
      if (batch < maxBatches - 1 && rows.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, effectiveDelay));
      } else if (rows.length < BATCH_SIZE) {
        // Last batch was partial — no more rows
        break;
      }
    }

    // Count remaining (with matching filters)
    let remainingQuery = supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .or(
        "entities_extracted.is.null,entities_extracted.eq.false," +
        "preferences_extracted.is.null,preferences_extracted.eq.false"
      );
    if (filterUserId) {
      remainingQuery = remainingQuery.eq("user_id", filterUserId);
    }
    if (contentTypeFilter) {
      remainingQuery = remainingQuery.eq("content_type", contentTypeFilter);
    }
    const { count: remaining } = await remainingQuery;

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

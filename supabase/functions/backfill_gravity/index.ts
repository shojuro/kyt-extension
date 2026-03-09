/**
 * Edge Function: backfill_gravity
 *
 * Backfills impact_score, intimacy_level, and topics for chat_turns
 * that were imported with skip_ai_processing=true (gravity scoring inputs).
 *
 * Uses classifyMemory() (Haiku 4.5) for impact_score + intimacy_level,
 * and inline keyword extraction for topics.
 *
 * Configuration:
 * - BATCH_SIZE: 5 (Haiku 4.5 per row)
 * - MAX_ROWS: 50 per invocation (default)
 * - BATCH_DELAY_MS: 2000ms between batches (200ms in fast_mode)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyMemory } from "../_shared/memory-classifier.ts";
import { securityHeaders } from "../_shared/headers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BATCH_SIZE = 5;
const MAX_ROWS = 50;
const MAX_ROWS_CAP = 200;
const BATCH_DELAY_MS = 2000;
const FAST_BATCH_DELAY_MS = 200;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  ...securityHeaders(),
};

/**
 * Extract topics from content using keyword matching.
 * Copied from _shared/conversation-chunker.ts (not exported there).
 */
function extractTopics(content: string): string[] {
  const keywords = new Set<string>();

  const langPattern = /\b(python|javascript|java|rust|go|sql|typescript|bash|c\+\+|csharp|ruby|php|swift|kotlin)\b/gi;
  const langMatches = content.match(langPattern) || [];
  langMatches.forEach(lang => keywords.add(lang.toLowerCase()));

  const techPattern = /\b(api|database|auth|bug|error|rls|postgres|supabase|openai|embedding|vector|search|query|token|sync|schema|index|function|table|column|constraint|policy|view|trigger|migration|optimization|performance|security|testing|debugging|deployment|docker|kubernetes|aws|gcp|azure|github|git|rest|graphql|websocket|http|https|json|xml|yaml|csv|regex|cache|queue|stream|batch|async|promise|callback|event|listener|observer|mutation|injection|xss|csrf|ssl|tls|jwt|oauth|saml|cors|cdn|dns|redis|mongodb|elasticsearch|kafka|rabbitmq|django|flask|fastapi|express|react|vue|angular|nextjs|svelte|tailwind|bootstrap|webpack|vite|npm|yarn|pip|conda|pytest|jest|mocha|cypress|selenium|playwright)\b/gi;
  const techMatches = content.match(techPattern) || [];
  techMatches.forEach(term => keywords.add(term.toLowerCase()));

  return Array.from(keywords).slice(0, 10);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("Starting backfill_gravity...");

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
    let totalTopicsSet = 0;
    let errors = 0;

    const maxBatches = Math.ceil(effectiveMaxRows / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing gravity scoring:
      // gravity_classified = false → never classified
      // Skip questions and high-deflection rows (same as backfill_entities)
      let query = supabase
        .from("chat_turns")
        .select("id, content, speakers, is_question, deflection")
        .eq("gravity_classified", false)
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
              .update({ gravity_classified: true })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Skip questions and deflections — they don't carry personal gravity
          if (row.is_question === true || (row.deflection != null && row.deflection >= 0.70)) {
            await supabase
              .from("chat_turns")
              .update({ gravity_classified: true })
              .eq("id", row.id);
            totalProcessed++;
            console.log(`  Row ${row.id}: skipped (${row.is_question ? "question" : "deflection"})`);
            continue;
          }

          // Classify memory: impact_score + intimacy_level via Haiku 4.5
          const classification = await classifyMemory(
            {
              content: row.content,
              speakers: row.speakers || ["user", "assistant"],
            },
            anthropicApiKey
          );

          // Extract topics (keyword-based, no LLM cost)
          const topics = extractTopics(row.content);

          // Update the row
          const updateData: Record<string, unknown> = {
            impact_score: classification.impact_score,
            intimacy_level: classification.intimacy_level,
            gravity_classified: true,
          };
          if (topics.length > 0) {
            updateData.topics = topics;
            totalTopicsSet++;
          }

          const { error: updateError } = await supabase
            .from("chat_turns")
            .update(updateData)
            .eq("id", row.id);

          if (updateError) {
            throw updateError;
          }

          totalProcessed++;
          totalClassified++;
          console.log(`  Row ${row.id}: impact=${classification.impact_score}, intimacy=${classification.intimacy_level}, topics=${topics.length}`);
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
      .eq("gravity_classified", false);
    if (filterUserId) {
      remainingQuery = remainingQuery.eq("user_id", filterUserId);
    }
    const { count: remaining } = await remainingQuery;

    const result = {
      success: true,
      processed: totalProcessed,
      classified: totalClassified,
      topics_set: totalTopicsSet,
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

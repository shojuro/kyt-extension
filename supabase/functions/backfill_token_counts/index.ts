/**
 * Edge Function: backfill_token_counts
 *
 * Counts tokens for existing chat_turns using the Anthropic token counting API.
 * Follows the backfill_entities pattern: batch processing with delay between batches.
 *
 * The token counting API is FREE with separate rate limits (100-8000 RPM by tier).
 *
 * Configuration:
 * - BATCH_SIZE: 10 (token counting is fast, no LLM generation)
 * - MAX_ROWS: 50 per invocation (default), cap 200
 * - BATCH_DELAY_MS: 200ms between batches
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { securityHeaders } from "../_shared/headers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const anthropic = new AnthropicClient(anthropicApiKey, { edgeFunction: "backfill_token_counts" });

const BATCH_SIZE = 10;
const DEFAULT_MAX_ROWS = 50;
const MAX_ROWS_CAP = 200;
const BATCH_DELAY_MS = 200;

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
    console.log("Starting backfill_token_counts...");

    const body = await req.json().catch(() => ({}));
    const maxRows = Math.min(body.max_rows || DEFAULT_MAX_ROWS, MAX_ROWS_CAP);

    let totalProcessed = 0;
    let totalErrors = 0;
    let remaining = 0;

    // Process in batches
    while (totalProcessed + totalErrors < maxRows) {
      const batchLimit = Math.min(BATCH_SIZE, maxRows - totalProcessed - totalErrors);

      // Fetch uncounted rows (newest first — LIFBG pattern)
      const { data: rows, error: fetchErr } = await supabase
        .from("chat_turns")
        .select("id, content")
        .is("token_count", null)
        .order("created_at", { ascending: false })
        .limit(batchLimit);

      if (fetchErr) {
        throw new Error(`Failed to fetch rows: ${fetchErr.message}`);
      }

      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        try {
          let count = 0;
          if (row.content && row.content.trim().length > 0) {
            count = await anthropic.countTokens(row.content);
          }

          const { error: updateErr } = await supabase
            .from("chat_turns")
            .update({ token_count: count })
            .eq("id", row.id);

          if (updateErr) {
            console.error(`Failed to update row ${row.id}: ${updateErr.message}`);
            totalErrors++;
          } else {
            totalProcessed++;
          }
        } catch (err) {
          console.error(`Token count failed for row ${row.id}: ${(err as Error).message}`);
          totalErrors++;
        }
      }

      // Brief delay between batches
      if (totalProcessed + totalErrors < maxRows) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // Count remaining
    const { count: remainingCount } = await supabase
      .from("chat_turns")
      .select("*", { count: "exact", head: true })
      .is("token_count", null);

    remaining = remainingCount || 0;

    const result = {
      success: true,
      processed: totalProcessed,
      errors: totalErrors,
      remaining,
    };

    console.log("backfill_token_counts result:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("backfill_token_counts error:", (err as Error).message);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

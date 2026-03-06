/**
 * Edge Function: backfill_preferences
 *
 * Re-processes existing chat_turns to extract user preferences into the
 * user_preferences table. Follows the backfill_entities pattern exactly.
 *
 * Queries chat_turns where preferences_extracted IS NULL or FALSE,
 * runs extractEntities() (which now returns preferences too),
 * saves preferences, and marks preferences_extracted = true.
 *
 * Configuration:
 * - BATCH_SIZE: 5 (GPT-4o-mini per row)
 * - MAX_ROWS: 100 per invocation
 * - BATCH_DELAY_MS: 2000ms between batches
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractEntities, savePreferences } from "../_shared/entity-extractor.ts";
import { securityHeaders } from "../_shared/headers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BATCH_SIZE = 5;
const MAX_ROWS = 50;
const BATCH_DELAY_MS = 2000;

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
    console.log("Starting backfill_preferences...");

    // Resolve auth user_id consistently with live save_chat_turn path.
    // Priority: user_id already used by existing preferences > auth.admin.listUsers().
    // This prevents the listUsers() ordering bug where Supabase returns the
    // newest user first, which may differ from the extension's authenticated user.
    let authUserId: string | undefined;

    const { data: existingPref } = await supabase
      .from("user_preferences")
      .select("user_id")
      .limit(1)
      .single();

    if (existingPref?.user_id) {
      authUserId = existingPref.user_id;
      console.log(`Resolved auth user from existing preferences: ${authUserId}`);
    } else {
      const { data: authUsers } = await supabase.auth.admin.listUsers({ perPage: 1 });
      authUserId = authUsers?.users?.[0]?.id;
      console.log(`Resolved auth user from auth.admin: ${authUserId}`);
    }

    if (!authUserId) {
      throw new Error("No auth users found — cannot save preferences without valid user_id");
    }

    let totalProcessed = 0;
    let totalPreferencesCreated = 0;
    let errors = 0;

    const maxBatches = Math.ceil(MAX_ROWS / BATCH_SIZE);

    for (let batch = 0; batch < maxBatches; batch++) {
      // Query chat_turns needing preference extraction
      const { data: rows, error: fetchError } = await supabase
        .from("chat_turns")
        .select("id, content, speakers, user_id")
        .or("preferences_extracted.is.null,preferences_extracted.eq.false")
        .or("is_injection.is.null,is_injection.eq.false")
        .not("speakers", "eq", "{assistant}")
        .order("id")
        .limit(BATCH_SIZE);

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
          if (!row.content || !row.user_id) {
            // Mark as extracted to skip in future runs
            await supabase
              .from("chat_turns")
              .update({ preferences_extracted: true })
              .eq("id", row.id);
            totalProcessed++;
            continue;
          }

          // Extract entities + preferences using GPT-4o-mini
          const { preferences } = await extractEntities(
            {
              content: row.content,
              speakers: row.speakers || ["User", "Assistant"],
            },
            anthropicApiKey
          );

          // Save preferences (use auth user_id to satisfy FK constraint)
          if (preferences.length > 0) {
            const saved = await savePreferences(preferences, row.id, authUserId, supabase);
            totalPreferencesCreated += saved;
          }

          // Mark as extracted
          await supabase
            .from("chat_turns")
            .update({ preferences_extracted: true })
            .eq("id", row.id);

          totalProcessed++;
          console.log(`  Row ${row.id}: ${preferences.length} preferences extracted`);
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
        break;
      }
    }

    // Count remaining
    const { count: remaining } = await supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .or("preferences_extracted.is.null,preferences_extracted.eq.false");

    const result = {
      success: true,
      processed: totalProcessed,
      preferences_created: totalPreferencesCreated,
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

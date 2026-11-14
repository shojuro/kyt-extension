/**
 * Edge Function: backfill_sections
 *
 * Splits long turns into sections and embeds each one, so search can return
 * the part of a long message that answers a question. Handles both the
 * existing backlog and newly saved turns: the extension calls it on a timer.
 * Splitting rules and rationale: ../_shared/turn-sections.ts (unit-tested).
 *
 * No language model is called; the only paid work is embedding.
 *
 * Each turn's outcome is recorded in chat_turns.metadata.sections
 * ({ v, len, n }), so a turn is split once and again only when its content or
 * the splitting rules change. When the embedding provider is down the run
 * stops without marking anything, and the turns are picked up next time. A
 * turn whose sections cannot be stored three times is left alone.
 *
 * Body params: limit (turns per run, default 20, cap 60), user_id (service role only).
 */

import { stripInjectedContext } from "../_shared/injected-context.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";
import { securityHeaders } from "../_shared/headers.ts";
import { resolveUserId } from "../_shared/auth-helpers.ts";
import {
  MIN_TURN_CHARS,
  sectionEmbedText,
  SECTIONS_VERSION,
  splitIntoSections,
} from "../_shared/turn-sections.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const DEFAULT_LIMIT = 20;
const LIMIT_CAP = 60;
const PARALLEL = 3;
const EMBED_BATCH = 16;
// Stop starting turns after this long, to finish inside the edge wall clock (150 s).
const RUN_BUDGET_MS = 90_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  ...securityHeaders(),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** The embedding provider could not be reached: nothing about the turn is wrong. */
class EmbeddingUnavailable extends Error {}

interface PendingTurn {
  id: string;
  content: string;
  content_len: number;
}

async function mark(userId: string, turnId: string, info: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc("mark_turn_sections", { p_user_id: userId, p_turn_id: turnId, p_info: info });
  if (error) throw new Error(`mark failed: ${error.message}`);
}

/** Split, embed and store one turn. Returns the number of sections written. */
async function sectionOne(userId: string, turn: PendingTurn, hf: HuggingFaceClient): Promise<number> {
  // Injected context saved with a turn is not the user's text: never section it.
  const sections = splitIntoSections(stripInjectedContext(turn.content));
  if (sections.length === 0) {
    await supabase.from("turn_sections").delete().eq("turn_id", turn.id);
    await mark(userId, turn.id, { v: SECTIONS_VERSION, len: turn.content_len, n: 0 });
    return 0;
  }

  const embeddings: number[][] = [];
  try {
    for (let i = 0; i < sections.length; i += EMBED_BATCH) {
      const batch = sections.slice(i, i + EMBED_BATCH).map(sectionEmbedText);
      embeddings.push(...await hf.generateEmbeddingsBatch(batch));
    }
  } catch (e) {
    throw new EmbeddingUnavailable((e as Error).message);
  }
  if (embeddings.length !== sections.length) {
    throw new EmbeddingUnavailable(`got ${embeddings.length} embeddings for ${sections.length} sections`);
  }

  // Replace whatever was there: the turn may have been split before from older content.
  const { error: deleteError } = await supabase.from("turn_sections").delete().eq("turn_id", turn.id);
  if (deleteError) throw new Error(`section delete failed: ${deleteError.message}`);
  const { error: insertError } = await supabase.from("turn_sections").insert(
    sections.map((section, i) => ({
      user_id: userId,
      turn_id: turn.id,
      section_index: section.index,
      kind: section.kind,
      heading: section.heading || null,
      content: section.content,
      embedding: embeddings[i],
    })),
  );
  if (insertError) throw new Error(`section insert failed: ${insertError.message}`);

  await mark(userId, turn.id, { v: SECTIONS_VERSION, len: turn.content_len, n: sections.length });
  return sections.length;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) ?? {};
    } catch {
      // no body: defaults
    }

    const { userId } = await resolveUserId(
      req.headers.get("Authorization"),
      supabase,
      typeof body.user_id === "string" ? body.user_id : null,
    );
    // Signed-in users process their own turns; the service role must name a
    // user. Anon callers are refused: every turn costs embedding calls.
    if (!userId) return json({ error: "Authentication required" }, 401);

    const limit = Math.min(typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_LIMIT, LIMIT_CAP);
    const startedAt = Date.now();
    const hf = new HuggingFaceClient(hfApiKey, { userId, edgeFunction: "backfill_sections" });

    const { data, error } = await supabase.rpc("turns_needing_sections", {
      p_user_id: userId,
      p_limit: limit,
      p_min_chars: MIN_TURN_CHARS,
      p_version: SECTIONS_VERSION,
    });
    if (error) throw new Error(`pending query failed: ${error.message}`);
    const pending = (data ?? []) as PendingTurn[];

    let processed = 0;
    let sectioned = 0;
    let unsplit = 0;
    let sectionsWritten = 0;
    let failed = 0;
    let stopped: string | null = null;
    const errors: string[] = [];

    for (let i = 0; i < pending.length && !stopped; i += PARALLEL) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        stopped = "time_budget";
        break;
      }
      const chunk = pending.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(chunk.map((turn) => sectionOne(userId, turn, hf)));
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          processed++;
          if (result.value > 0) {
            sectioned++;
            sectionsWritten += result.value;
          } else {
            unsplit++;
          }
          continue;
        }
        const reason = result.reason as Error;
        if (reason instanceof EmbeddingUnavailable) {
          // Not the turn's fault: leave it unmarked and stop the run.
          stopped = "embedding_unavailable";
          errors.push(String(reason.message).slice(0, 160));
          continue;
        }
        failed++;
        errors.push(String(reason?.message ?? reason).slice(0, 160));
        // Count the failure on the turn so one bad turn cannot be retried forever.
        try {
          const { data: row } = await supabase.from("chat_turns").select("metadata").eq("id", chunk[j].id).single();
          const before = Number((row?.metadata as any)?.sections?.failed) || 0;
          await mark(userId, chunk[j].id, { v: 0, len: chunk[j].content_len, failed: before + 1 });
        } catch (markError) {
          stopped = "database_unavailable";
          errors.push(String((markError as Error).message).slice(0, 160));
        }
      }
    }

    const { data: remainingData, error: remainingError } = await supabase.rpc("count_turns_needing_sections", {
      p_user_id: userId,
      p_min_chars: MIN_TURN_CHARS,
      p_version: SECTIONS_VERSION,
    });
    const remaining = remainingError ? null : Number(remainingData) || 0;

    console.log(JSON.stringify({ fn: "backfill_sections", processed, sectioned, unsplit, sectionsWritten, failed, remaining, stopped }));
    return json({
      success: true,
      processed,
      sectioned,
      unsplit,
      sections_written: sectionsWritten,
      failed,
      remaining,
      stopped,
      errors: errors.slice(0, 5),
    });
  } catch (error) {
    console.error("backfill_sections failed:", (error as Error).message);
    return json({ success: false, error: (error as Error).message }, 500);
  }
});

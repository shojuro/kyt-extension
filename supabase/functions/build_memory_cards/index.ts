/**
 * Edge Function: build_memory_cards
 *
 * Writes "memory cards": one short record per important name (project,
 * person, tool) from the user's own past statements, with every spelling of
 * the name attached. search_memories puts a card first when a question names
 * the thing. Logic and rationale: ../_shared/memory-cards.ts (unit-tested).
 *
 * Each run handles a few cards and reports how many are left, so the caller
 * repeats until `remaining` is 0. A card is rewritten only when it is new,
 * has a new note or spelling, gained many mentions, or is a month old; and
 * when its evidence is unchanged the model is not called again.
 *
 * Body params:
 *   limit      cards per run (default 8, cap 20)
 *   max_auto   how many names to pick by mention count (default 150, cap 400)
 *   pins       [{ name, aliases?: string[], note?: string }] names the user
 *              wants a card for; stored, so they need sending only once
 *   rebuild_before  ISO time: rewrite every card last written before it
 *                   ("rewrite everything" without rewriting a card twice)
 *   dry_run    list what would be built, write nothing, call no model
 *   user_id    service role only
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { ANTHROPIC_MODEL, AnthropicReplyError } from "../_shared/anthropic-model.ts";
import { securityHeaders } from "../_shared/headers.ts";
import { resolveUserId } from "../_shared/auth-helpers.ts";
import {
  buildCardUserPrompt,
  CARD_SYSTEM_PROMPT,
  cardFromNoteOnly,
  type CardPin,
  type CardPlan,
  type CardText,
  cleanSnippet,
  type EntityGroup,
  evidenceFingerprint,
  evidencePattern,
  type EvidenceRow,
  isCardStale,
  parseCardReply,
  planCards,
  squash,
} from "../_shared/memory-cards.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const DEFAULT_LIMIT = 8;
const LIMIT_CAP = 20;
const DEFAULT_MAX_AUTO = 150;
const MAX_AUTO_CAP = 400;
const MAX_PINS = 50;
const EVIDENCE_ROWS = 40;
const PARALLEL = 4;
// Stop starting cards after this long, to finish inside the edge wall clock (150 s).
const RUN_BUDGET_MS = 90_000;
const MODEL_TIMEOUT_MS = 30_000;

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

/** Keep only well-formed pins, with bounded sizes. */
function readPins(raw: unknown): CardPin[] {
  if (!Array.isArray(raw)) return [];
  const pins: CardPin[] = [];
  for (const item of raw.slice(0, MAX_PINS)) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
    pins.push({
      name: item.name.trim().slice(0, 80),
      aliases: Array.isArray(item.aliases)
        ? item.aliases.filter((a: unknown) => typeof a === "string").slice(0, 12).map((a: string) => a.trim().slice(0, 80))
        : [],
      note: typeof item.note === "string" ? item.note.trim().slice(0, 600) : undefined,
    });
  }
  return pins;
}

interface StoredCard {
  card_key: string;
  name: string;
  aliases: string[] | null;
  alias_names: string[] | null;
  pinned: boolean;
  user_note: string | null;
  status: string | null;
  mention_count: number | null;
  built_at: string | null;
  evidence_fingerprint: string | null;
}

type Outcome = "built" | "insufficient" | "unchanged" | "failed";

async function buildOne(
  userId: string,
  plan: CardPlan,
  existing: StoredCard | undefined,
  anthropic: AnthropicClient,
  force: boolean,
): Promise<{ outcome: Outcome; modelCalled: boolean }> {
  const pattern = evidencePattern(plan);
  let evidence: EvidenceRow[] = [];
  if (pattern) {
    const { data, error } = await supabase.rpc("memory_card_evidence", {
      p_user_id: userId,
      p_pattern: pattern,
      p_limit: EVIDENCE_ROWS,
    });
    if (error) throw new Error(`evidence query failed: ${error.message}`);
    evidence = ((data ?? []) as EvidenceRow[])
      .map((row) => ({ ...row, snippet: cleanSnippet(row.snippet) }))
      .filter((row) => row.snippet.length >= 20);
  }

  const fingerprint = evidenceFingerprint(evidence, plan.note);
  const base = {
    user_id: userId,
    card_key: plan.key,
    name: plan.name,
    aliases: plan.aliases,
    alias_names: plan.aliasNames,
    pinned: plan.pinned,
    user_note: plan.note,
    mention_count: plan.mentionCount,
    evidence_count: evidence.length,
    evidence_fingerprint: fingerprint,
    latest_evidence_at: evidence.reduce<string | null>(
      (latest, row) => (!latest || String(row.created_at) > latest ? String(row.created_at) : latest),
      null,
    ),
    updated_at: new Date().toISOString(),
  };

  // Same evidence and note as last time: keep the text, refresh the bookkeeping.
  const settled = existing?.status === "ready" || existing?.status === "insufficient";
  if (!force && settled && existing?.evidence_fingerprint === fingerprint) {
    const { error } = await supabase.from("memory_cards")
      .update({ ...base, built_at: new Date().toISOString() })
      .eq("user_id", userId).eq("card_key", plan.key);
    if (error) throw new Error(`card update failed: ${error.message}`);
    return { outcome: "unchanged", modelCalled: false };
  }

  let card: CardText;
  let modelCalled = false;
  if (evidence.length === 0) {
    card = plan.note ? cardFromNoteOnly(plan.note) : { status: "insufficient", kind: null, description: null, keyFacts: [] };
  } else {
    modelCalled = true;
    try {
      const reply = await anthropic.generateJsonCompletion(
        CARD_SYSTEM_PROMPT,
        buildCardUserPrompt(plan, evidence),
        { maxTokens: 500, maxRetries: 1, timeoutMs: MODEL_TIMEOUT_MS, operation: "memory_card" },
      );
      card = parseCardReply(reply);
    } catch (e) {
      // The model answered (and was paid) but the reply is unusable: settle the
      // card as insufficient so the same evidence is not sent again on every
      // run. API and network errors are rethrown and the card stays pending.
      if (!(e instanceof AnthropicReplyError)) throw e;
      console.warn(`memory card "${plan.name}": unusable reply (${e.kind})`);
      card = { status: "insufficient", kind: null, description: null, keyFacts: [] };
    }
    if (card.status === "insufficient" && plan.note) card = cardFromNoteOnly(plan.note);
  }

  const { error } = await supabase.from("memory_cards").upsert({
    ...base,
    kind: card.kind ?? plan.kind?.toLowerCase() ?? null,
    description: card.description,
    key_facts: card.keyFacts,
    status: card.status,
    model: modelCalled ? ANTHROPIC_MODEL : null,
    built_at: new Date().toISOString(),
  }, { onConflict: "user_id,card_key" });
  if (error) throw new Error(`card save failed: ${error.message}`);

  return { outcome: card.status === "ready" ? "built" : "insufficient", modelCalled };
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

    const { userId: authUserId, isServiceRole } = await resolveUserId(
      req.headers.get("Authorization"),
      supabase,
      typeof body.user_id === "string" ? body.user_id : null,
    );
    // Signed-in users build their own cards; the service role may name a user.
    // Anon callers are refused: every card can cost a model call.
    const userId = authUserId;
    if (!userId) return json({ error: "Authentication required" }, 401);
    if (isServiceRole && typeof body.user_id !== "string") {
      return json({ error: "user_id is required for service-role calls" }, 400);
    }

    const limit = Math.min(typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_LIMIT, LIMIT_CAP);
    const maxAuto = Math.min(
      typeof body.max_auto === "number" && body.max_auto >= 0 ? Math.floor(body.max_auto) : DEFAULT_MAX_AUTO,
      MAX_AUTO_CAP,
    );
    const rebuildBefore = typeof body.rebuild_before === "string" && !Number.isNaN(Date.parse(body.rebuild_before))
      // Never in the future: a later cut-off would rewrite every card on every call.
      ? Math.min(Date.parse(body.rebuild_before), Date.now())
      : null;
    const isForced = (card: StoredCard | undefined): boolean =>
      rebuildBefore !== null && (!card?.built_at || Date.parse(card.built_at) < rebuildBefore);
    const dryRun = body.dry_run === true;
    const newPins = readPins(body.pins);
    const startedAt = Date.now();

    const [{ data: groupsData, error: groupsError }, { data: storedData, error: storedError }] = await Promise.all([
      supabase.rpc("memory_card_candidates", { p_user_id: userId }),
      supabase.from("memory_cards")
        .select("card_key, name, aliases, alias_names, pinned, user_note, status, mention_count, built_at, evidence_fingerprint")
        .eq("user_id", userId)
        .limit(2000),
    ]);
    if (groupsError) throw new Error(`candidate query failed: ${groupsError.message}`);
    if (storedError) throw new Error(`card query failed: ${storedError.message}`);

    const stored = new Map<string, StoredCard>(((storedData ?? []) as StoredCard[]).map((c) => [c.card_key, c]));

    // Pins sent now override stored ones for the same name; the rest are kept.
    const pinByName = new Map<string, CardPin>();
    for (const card of stored.values()) {
      if (card.pinned) {
        pinByName.set(card.card_key, {
          name: card.name,
          aliases: (card.alias_names ?? []).filter((a) => a !== card.name),
          note: card.user_note ?? undefined,
        });
      }
    }
    for (const pin of newPins) {
      const key = squash(pin.name);
      if (key.length >= 2) pinByName.set(key, pin);
    }

    const plans = planCards((groupsData ?? []) as EntityGroup[], [...pinByName.values()], { maxAuto });
    const now = Date.now();
    const stale = plans.filter((plan) => isCardStale(stored.get(plan.key), plan, now, isForced(stored.get(plan.key))));

    if (dryRun) {
      return json({
        success: true,
        dry_run: true,
        planned: plans.length,
        stale: stale.length,
        names: stale.slice(0, 60).map((p) => ({ name: p.name, spellings: p.aliasNames, mentions: p.mentionCount, pinned: p.pinned })),
      });
    }

    const anthropic = new AnthropicClient(anthropicApiKey, { userId, edgeFunction: "build_memory_cards" });
    const counts: Record<Outcome, number> = { built: 0, insufficient: 0, unchanged: 0, failed: 0 };
    let modelCalls = 0;
    let handled = 0;
    let stopped: string | null = null;
    const errors: string[] = [];

    const batch = stale.slice(0, limit);
    for (let i = 0; i < batch.length; i += PARALLEL) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        stopped = "time_budget";
        break;
      }
      // A whole chunk failing means the model or the database is down: stop
      // instead of failing (and paying for) the rest of the batch.
      if (counts.failed >= PARALLEL && counts.built + counts.insufficient + counts.unchanged === 0) {
        stopped = "repeated_failures";
        break;
      }
      const chunk = batch.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        chunk.map((plan) => buildOne(userId, plan, stored.get(plan.key), anthropic, isForced(stored.get(plan.key)))),
      );
      results.forEach((result, j) => {
        handled++;
        if (result.status === "fulfilled") {
          counts[result.value.outcome]++;
          if (result.value.modelCalled) modelCalls++;
        } else {
          counts.failed++;
          errors.push(`${chunk[j].name}: ${String(result.reason?.message ?? result.reason).slice(0, 160)}`);
        }
      });
    }

    const remaining = stale.length - handled;
    console.log(JSON.stringify({ fn: "build_memory_cards", planned: plans.length, stale: stale.length, ...counts, modelCalls, remaining, stopped }));
    return json({
      success: true,
      planned: plans.length,
      ...counts,
      model_calls: modelCalls,
      remaining,
      stopped,
      errors: errors.slice(0, 5),
    });
  } catch (error) {
    console.error("build_memory_cards failed:", (error as Error).message);
    return json({ success: false, error: (error as Error).message }, 500);
  }
});

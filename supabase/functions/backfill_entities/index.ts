/**
 * Edge Function: backfill_entities
 *
 * Runs entity extraction for chat_turns that are flagged as not yet extracted
 * (entities_extracted or preferences_extracted null/false), saves the result
 * and marks the turn.
 *
 * A pending flag is not proof of new work: the extension upserts every chunk of
 * a conversation on each sync with both flags false. So each turn's outcome is
 * recorded in chat_turns.metadata.entity_extraction with a fingerprint of the
 * content, and a turn whose content has not changed since it was extracted (or
 * given up on) is re-marked without calling the model. Failure handling is in
 * ../_shared/backfill-policy.ts (unit-tested).
 *
 * Body params: limit | max_rows (rows per run, default 200, cap 400),
 * fast_mode, user_id (service role only), content_type_filter, force_reextract.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractEntitiesOrThrow, saveEntitiesWithMentions, savePreferences } from "../_shared/entity-extractor.ts";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";
import { securityHeaders } from "../_shared/headers.ts";
import { resolveUserId } from "../_shared/auth-helpers.ts";
import {
  advanceCursor,
  classifyExtractionError,
  contentFingerprint,
  decideFailureAction,
  type FailureKind,
  type FetchCursor,
  hasTimeBudget,
  isSettled,
  nextFetchSize,
  notInFilter,
  readAttempts,
  shouldAbortRun,
  withExtracted,
  withFailedAttempt,
  withGivenUp,
} from "../_shared/backfill-policy.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey, { edgeFunction: 'backfill_entities' });

// Rows are handled in small chunks: extract CHUNK_SIZE rows in parallel (the
// model call is the slow part), then save and mark them one by one (avoids
// same-user entity-upsert races) before the next chunk starts. If the run is
// cut off, at most one chunk of paid extractions is lost. Before, 25 rows were
// extracted up front and marked only at the end.
const CHUNK_SIZE = 5;  // parallel model calls; 12 inflated latency -> timeouts
const MAX_ROWS = 200;
const MAX_ROWS_CAP = 400; // Absolute cap for max_rows param
const CHUNK_DELAY_MS = 500;
const FAST_CHUNK_DELAY_MS = 200;
// Stop starting chunks after this long, to finish inside the edge wall clock (150 s).
const RUN_BUDGET_MS = 90_000;
// One model call may take this long, and is retried once on API/network errors.
const EXTRACT_TIMEOUT_MS = 20_000;
const EXTRACT_MAX_RETRIES = 1;

const PENDING_FILTER =
  "entities_extracted.is.null,entities_extracted.eq.false," +
  "preferences_extracted.is.null,preferences_extracted.eq.false";
const ROW_COLUMNS = "id, created_at, content, speakers, conversation_id, user_id, is_question, deflection";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  ...securityHeaders(),
};

/** Update one chat_turn and throw when the database refuses (supabase-js does not throw). */
async function updateTurn(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("chat_turns").update(values).eq("id", id);
  if (error) throw new Error(`chat_turns update failed: ${error.message}`);
}

// Save decisions as enriched entities with metadata (supersession + audit trail).
async function saveDecisions(row: any, decisions: any[]): Promise<void> {
  for (const dec of decisions) {
    const canonicalName = dec.context.toLowerCase().replace(/[^\w]+/g, '_');
    // Upsert decision entity — if same context exists, check for supersession
    const { data: existing } = await supabase
      .from('entities')
      .select('id, metadata')
      .eq('user_id', row.user_id)
      .eq('entity_type', 'CONCEPT')
      .eq('normalized_name', canonicalName)
      .is('superseded_by', null)
      .limit(1);

    const decisionMetadata = {
      decision: dec.decision,
      value: dec.value,
      rationale: dec.rationale,
      alternatives: dec.alternatives,
      constraints: dec.constraints,
      type: 'decision',
    };

    if (existing && existing.length > 0) {
      const oldEntity = existing[0];
      const oldValue = (oldEntity.metadata as any)?.value;
      if (oldValue && dec.value && oldValue !== dec.value) {
        // Value changed — supersede the old entity
        const { data: newEntity } = await supabase
          .from('entities')
          .insert({
            user_id: row.user_id,
            entity_text: dec.decision,
            normalized_name: canonicalName,
            entity_type: 'CONCEPT',
            relationship: 'decision',
            context_category: 'technical',
            metadata: decisionMetadata,
          })
          .select('id')
          .single();

        if (newEntity) {
          await supabase
            .from('entities')
            .update({ superseded_by: newEntity.id })
            .eq('id', oldEntity.id);

          // Audit trail
          await supabase.from('memory_audit_log').insert({
            user_id: row.user_id,
            action: 'supersede',
            entity_id: oldEntity.id,
            old_value: oldValue,
            new_value: dec.value,
            reason: `Decision value changed: ${oldValue} → ${dec.value}`,
            metadata: { new_entity_id: newEntity.id, context: dec.context },
          });
        }
      } else {
        // Same value or no value — update metadata (enrich, don't supersede)
        await supabase
          .from('entities')
          .update({ metadata: decisionMetadata })
          .eq('id', oldEntity.id);
      }
    } else {
      // New decision — create entity
      const { data: newEntity } = await supabase
        .from('entities')
        .insert({
          user_id: row.user_id,
          entity_text: dec.decision,
          normalized_name: canonicalName,
          entity_type: 'CONCEPT',
          relationship: 'decision',
          context_category: 'technical',
          metadata: decisionMetadata,
        })
        .select('id')
        .single();

      if (newEntity) {
        // Audit trail
        await supabase.from('memory_audit_log').insert({
          user_id: row.user_id,
          action: 'create_decision',
          entity_id: newEntity.id,
          new_value: dec.value || dec.decision,
          reason: dec.rationale || 'New decision extracted',
          metadata: { context: dec.context },
        });
      }
    }
  }
}

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

    // Service-role gate: JWT callers are pinned to their own rows; the
    // service-role key (benchmark/admin) may pass any user_id or run
    // globally; anon-key callers are rejected (LLM cost-amplification vector).
    const { userId: authUserId, isServiceRole } = await resolveUserId(
      req.headers.get("Authorization"),
      supabase,
      filterUserId,
    );
    if (!authUserId && !isServiceRole) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!isServiceRole) {
      filterUserId = authUserId;
    }

    const effectiveMaxRows = requestedLimit;
    const chunkDelay = fastMode ? FAST_CHUNK_DELAY_MS : CHUNK_DELAY_MS;
    console.log(`  Options: fast_mode=${fastMode}, user_id=${filterUserId?.substring(0, 8) || 'all'}, content_type=${contentTypeFilter || 'all'}, max_rows=${effectiveMaxRows}`);
    const startedAt = Date.now();
    let totalProcessed = 0;
    let totalEntitiesCreated = 0;
    let errors = 0;
    let skippedUnchanged = 0;
    let givenUp = 0;
    let retryLater = 0;
    let modelCalls = 0;
    let consecutiveApiFailures = 0;
    let consecutiveMarkFailures = 0;
    let stopReason: string | null = null;
    // false once the database says chat_turns.metadata does not exist; outcomes
    // then cannot be recorded and the unchanged-content check is off.
    let metadataAvailable = true;
    // Every row is looked at once per run, whatever happens to it.
    let attempted = 0;
    let cursor: FetchCursor = { createdAt: null, idsAtCursor: [] };

    // A turn failed: record the attempt, then give up on it or leave it pending.
    const handleFailure = async (row: any, kind: FailureKind, message: string) => {
      errors++;
      const nowIso = new Date().toISOString();
      const fp = contentFingerprint(row.content);
      // An HTTP error from the API says nothing about this turn: not counted.
      const counted = metadataAvailable && kind !== "api_status";
      const failedMeta = counted ? withFailedAttempt(row.metadata, kind, message, nowIso, fp) : null;
      const action = decideFailureAction(kind, failedMeta ? readAttempts(failedMeta) : null);
      console.error(`  Row ${row.id} failed (${kind}, ${action}): ${message}`);
      try {
        if (action === "mark_failed") {
          const values: Record<string, unknown> = { entities_extracted: true, preferences_extracted: true };
          if (metadataAvailable) {
            values.metadata = withGivenUp(failedMeta ?? withFailedAttempt(row.metadata, kind, message, nowIso, fp), nowIso);
          }
          await updateTurn(row.id, values);
          givenUp++;
        } else {
          if (failedMeta) await updateTurn(row.id, { metadata: failedMeta });
          retryLater++;
        }
        consecutiveMarkFailures = 0;
      } catch (markErr) {
        consecutiveMarkFailures++;
        console.error(`  Row ${row.id}: could not record the failure: ${(markErr as Error).message}`);
      }
    };

    while (true) {
      const fetchSize = nextFetchSize(effectiveMaxRows, attempted, CHUNK_SIZE);
      if (fetchSize === 0) { stopReason = "limit"; break; }
      if (!hasTimeBudget(startedAt, Date.now(), RUN_BUDGET_MS)) { stopReason = "time_budget"; break; }
      if (shouldAbortRun(consecutiveApiFailures)) { stopReason = "api_failures"; break; }
      if (shouldAbortRun(consecutiveMarkFailures)) { stopReason = "db_failures"; break; }

      // Query chat_turns needing entity extraction, never the same row twice in a run
      const fetchRows = (columns: string): any => {
        let query: any = supabase
          .from("chat_turns")
          .select(columns)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(fetchSize);
        // When forceReextract=true, no pending filter — re-processes all rows
        if (!forceReextract) query = query.or(PENDING_FILTER);
        if (cursor.createdAt) query = query.lte("created_at", cursor.createdAt);
        if (cursor.idsAtCursor.length > 0) query = query.not("id", "in", notInFilter(cursor.idsAtCursor));
        if (filterUserId) query = query.eq("user_id", filterUserId);
        if (contentTypeFilter) query = query.eq("content_type", contentTypeFilter);
        return query;
      };

      let { data: rows, error: fetchError }: { data: any[] | null; error: any } = await fetchRows(metadataAvailable ? `${ROW_COLUMNS}, metadata` : ROW_COLUMNS);
      if (fetchError && metadataAvailable && /metadata/i.test(fetchError.message || "")) {
        console.error("chat_turns.metadata is not available: outcomes cannot be recorded, so unchanged turns WILL be extracted again. Apply migration 20260401000000_chat_turns_metadata_column.sql.");
        metadataAvailable = false;
        ({ data: rows, error: fetchError } = await fetchRows(ROW_COLUMNS));
      }

      if (fetchError) {
        console.error("Fetch error:", fetchError.message);
        throw fetchError;
      }

      if (!rows || rows.length === 0) {
        console.log("No more rows to process.");
        stopReason = "done";
        break;
      }

      console.log(`Chunk: ${rows.length} chat_turns (${attempted} done so far)`);
      attempted += rows.length;
      cursor = advanceCursor(cursor, rows);

      // Sort the rows: nothing to extract, already settled, or needs the model.
      const toExtract: any[] = [];
      for (const row of rows as any[]) {
        try {
          if (!row.content || !row.content.trim() || !row.user_id) {
            // Mark as extracted to skip in future runs
            await updateTurn(row.id, { entities_extracted: true, preferences_extracted: true });
            totalProcessed++;
          } else if (row.is_question === true || (row.deflection != null && row.deflection >= 0.70)) {
            // Skip questions and deflections — no useful entities to extract
            await updateTurn(row.id, { entities_extracted: true, preferences_extracted: true });
            totalProcessed++;
            console.log(`  Row ${row.id}: skipped (${row.is_question ? 'question' : 'deflection'})`);
          } else if (!forceReextract && metadataAvailable && isSettled(row.metadata, row.content)) {
            // Same content as last time: the flags were reset by a re-sync. No model call.
            await updateTurn(row.id, { entities_extracted: true, preferences_extracted: true });
            totalProcessed++;
            skippedUnchanged++;
          } else {
            toExtract.push(row);
          }
          consecutiveMarkFailures = 0;
        } catch (markErr) {
          errors++;
          consecutiveMarkFailures++;
          console.error(`  Row ${row.id} failed: ${(markErr as Error).message}`);
        }
      }

      // Phase 1: model extraction in parallel (read-only).
      const outcomes = await Promise.all(toExtract.map(async (r: any) => {
        modelCalls++;
        try {
          const result = await extractEntitiesOrThrow(
            { content: r.content, speakers: r.speakers || ["User", "Assistant"] },
            anthropicApiKey,
            { userId: r.user_id, edgeFunction: 'backfill_entities' },
            { maxRetries: EXTRACT_MAX_RETRIES, timeoutMs: EXTRACT_TIMEOUT_MS }
          );
          return { row: r, result, error: null as unknown };
        } catch (e) {
          return { row: r, result: null, error: e as unknown };
        }
      }));

      // Phase 2: save and mark, one row at a time.
      for (const { row, result, error } of outcomes) {
        if (!result) {
          const kind = classifyExtractionError(error);
          if (kind === "api_status" || kind === "transient") consecutiveApiFailures++;
          else consecutiveApiFailures = 0; // the API answered
          await handleFailure(row, kind, (error as Error)?.message || String(error));
          continue;
        }
        consecutiveApiFailures = 0;
        const { entities, preferences, decisions, contentCategory } = result;

        try {
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

          await saveDecisions(row, decisions);
        } catch (saveErr) {
          await handleFailure(row, "save_error", (saveErr as Error).message);
          continue;
        }

        try {
          // Mark as extracted + set content_category + record what was extracted
          const values: Record<string, unknown> = {
            entities_extracted: true,
            preferences_extracted: true,
            content_category: contentCategory,
          };
          if (metadataAvailable) {
            values.metadata = withExtracted(row.metadata, contentFingerprint(row.content), new Date().toISOString());
          }
          await updateTurn(row.id, values);
          consecutiveMarkFailures = 0;
          totalProcessed++;
          console.log(`  Row ${row.id}: ${entities.length} entities, ${preferences.length} preferences, ${decisions.length} decisions extracted`);
        } catch (markErr) {
          errors++;
          consecutiveMarkFailures++;
          console.error(`  Row ${row.id}: extracted and saved but not marked: ${(markErr as Error).message}`);
        }
      }

      if (rows.length < fetchSize) { stopReason = "done"; break; }
      await new Promise((r) => setTimeout(r, chunkDelay));
    }

    if (stopReason && stopReason !== "done" && stopReason !== "limit") {
      console.warn(`Backfill stopped early: ${stopReason}`);
    }

    // Count remaining (with matching filters)
    let remainingQuery = supabase
      .from("chat_turns")
      .select("id", { count: "exact", head: true })
      .or(PENDING_FILTER);
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
      // Pending flag reset by a re-sync, content unchanged: re-marked, no model call.
      skipped_unchanged: skippedUnchanged,
      // Given up on (marked processed with a failure recorded in metadata).
      failed: givenUp,
      // Left pending for a later run.
      retry_later: retryLater,
      model_calls: modelCalls,
      stopped: stopReason,
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

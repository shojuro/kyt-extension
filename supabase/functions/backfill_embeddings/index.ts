
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";
import type { ClientContext } from "../_shared/anthropic-client.ts";
import { securityHeaders } from "../_shared/headers.ts";
import { resolveUserId } from "../_shared/auth-helpers.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const hfApiKey = Deno.env.get("HUGGINGFACE_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const hfClient = new HuggingFaceClient(hfApiKey, { edgeFunction: 'backfill_embeddings' });

// Configuration
// Batched embeddings: one API call per BATCH_SIZE texts (was one call per row),
// so a run embeds thousands of rows within the gateway timeout.
const BATCH_SIZE = 50;
const MAX_BATCHES = 50; // Process up to 2500 rows per run
const BATCH_DELAY_MS = 100;

serve(async (req) => {
    try {
        console.log("Starting backfill_embeddings...");
        // Optional: restrict to one user's null embeddings, enabling parallel,
        // non-overlapping backfill (e.g. benchmark per-user fan-out).
        const _reqBody = await req.json().catch(() => ({}));
        let filterUserId: string | null = _reqBody?.user_id ?? null;

        // Service-role gate: JWT callers are pinned to their own rows; the
        // service-role key may pass any user_id or run globally; anon-key
        // callers are rejected (embedding cost-amplification vector).
        const { userId: authUserId, isServiceRole } = await resolveUserId(
            req.headers.get("Authorization"),
            supabase,
            filterUserId,
        );
        if (!authUserId && !isServiceRole) {
            return new Response(JSON.stringify({ error: "Authentication required" }), {
                status: 401,
                headers: { "Content-Type": "application/json", ...securityHeaders() },
            });
        }
        if (!isServiceRole) {
            filterUserId = authUserId;
        }

        // 1. Get current progress
        const { data: progress, error: progressError } = await supabase
            .from("backfill_progress")
            .select("*")
            .eq("id", "embeddings")
            .single();

        if (progressError && progressError.code !== 'PGRST116') { // PGRST116 is "not found"
            throw progressError;
        }

        let lastProcessedId = progress?.last_processed_id || "00000000-0000-0000-0000-000000000000"; // UUID min
        let totalProcessedInRun = 0;

        // 2. Loop through batches
        for (let i = 0; i < MAX_BATCHES; i++) {
            // Fetch batch of rows with NULL embedding
            // We don't use a cursor (gt id) because we are consuming the queue of NULLs.
            // As we update them, they leave the queue.
            let _q = supabase
                .from("chat_turns")
                .select("id, content, contextual_content")
                .is("embedding", null);
            if (filterUserId) _q = _q.eq("user_id", filterUserId);
            const { data: rows, error: fetchError } = await _q
                .order("id") // Deterministic order
                .limit(BATCH_SIZE);

            if (fetchError) throw fetchError;

            if (!rows || rows.length === 0) {
                console.log("No more rows to process.");
                break;
            }

            console.log(`Processing batch ${i + 1}: ${rows.length} rows`);

            // Generate embeddings in ONE batched API call (was per-row sequential).
            // Same embedding method (truncate+normalize), so vectors are identical
            // to the query-time path. ASYMMETRIC EMBEDDING: stored chunks use
            // contextual_content when present; query embeddings stay raw — don't "fix".
            const toEmbed = rows.filter(r => r.content);
            const texts = toEmbed.map(r => r.contextual_content || r.content);
            let embeddings: number[][] = [];
            try {
                embeddings = await hfClient.generateEmbeddingsBatch(texts);
            } catch (e) {
                console.error(`Batch embedding failed for ${texts.length} rows:`, e);
                embeddings = [];
            }
            const updates = [];
            for (let j = 0; j < toEmbed.length && j < embeddings.length; j++) {
                updates.push({ id: toEmbed[j].id, embedding: embeddings[j] });
            }

            // Update database (parallel single-column updates).
            if (updates.length > 0) {
                await Promise.all(updates.map(u =>
                    supabase.from("chat_turns").update({ embedding: u.embedding }).eq("id", u.id)
                ));
            }

            // Update progress
            const lastRow = rows[rows.length - 1];
            lastProcessedId = lastRow.id;
            totalProcessedInRun += rows.length;

            await supabase.rpc("update_backfill_progress", {
                p_id: "embeddings",
                p_last_id: lastProcessedId,
                p_increment: rows.length,
                p_status: "running"
            });

            // Rate limit delay
            if (i < MAX_BATCHES - 1) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            }
        }

        // ============================================================
        // Phase 2: Backfill entity embeddings (same run)
        // Entity embedding content matches saveEntitiesWithMentions format:
        // "entity_text (entity_type, relationship)"
        // ============================================================
        let entitiesProcessed = 0;
        console.log("Checking entities for null embeddings...");

        for (let i = 0; i < MAX_BATCHES; i++) {
            let entityQuery = supabase
                .from("entities")
                .select("id, entity_text, entity_type, relationship")
                .is("embedding", null)
                .order("id")
                .limit(BATCH_SIZE);
            if (filterUserId) {
                entityQuery = entityQuery.eq("user_id", filterUserId);
            }
            const { data: entityRows, error: entityFetchError } = await entityQuery;

            if (entityFetchError) {
                console.error("Entity fetch error:", entityFetchError);
                break; // Don't fail the whole run for entity errors
            }

            if (!entityRows || entityRows.length === 0) {
                console.log("No more entities to process.");
                break;
            }

            console.log(`Processing entity batch ${i + 1}: ${entityRows.length} rows`);

            const entityUpdates = [];
            for (const entity of entityRows) {
                if (!entity.entity_text) continue;
                try {
                    // Match the embedding content format from saveEntitiesWithMentions
                    const contentToEmbed = `${entity.entity_text} (${entity.entity_type}, ${entity.relationship})`;
                    const embedding = await hfClient.generateEmbeddings(contentToEmbed);
                    entityUpdates.push({
                        id: entity.id,
                        embedding: embedding[0]
                    });
                } catch (e) {
                    console.error(`Failed to generate embedding for entity ${entity.id}:`, e);
                }
            }

            if (entityUpdates.length > 0) {
                await Promise.all(entityUpdates.map(u =>
                    supabase.from("entities").update({ embedding: u.embedding }).eq("id", u.id)
                ));
            }

            entitiesProcessed += entityRows.length;

            if (i < MAX_BATCHES - 1) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            }
        }

        console.log(`Backfill complete: ${totalProcessedInRun} chat_turns, ${entitiesProcessed} entities`);

        return new Response(JSON.stringify({
            success: true,
            processed: totalProcessedInRun,
            entities_processed: entitiesProcessed,
            lastId: lastProcessedId
        }), { headers: { "Content-Type": "application/json", ...securityHeaders() } });

    } catch (error) {
        console.error("Backfill failed:", error);
        // Try to log error to DB
        await supabase.rpc("update_backfill_progress", {
            p_id: "embeddings",
            p_last_id: null, // Don't update cursor
            p_increment: 0,
            p_status: "failed",
            p_error: error.message
        });

        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json", ...securityHeaders() } });
    }
});

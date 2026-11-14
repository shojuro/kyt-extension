// supabase/functions/search_memories/index.ts
//
// Memory Search API with Hybrid HyDE support
//
// Parameters:
//   - query (required): Search query string
//   - userId (required): User ID for RLS
//   - useHyde (optional): Enable HyDE generation (default: true)
//   - hydeWeight (optional): Weight for HyDE results in RRF merge (default: 0.6)
//   - topK (optional): Number of candidates to retrieve (default: 20)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRelevantMemories, getRecentByPlatform, SearchOptions } from "../_shared/get_relevant_memories.ts";
import { Logger } from "../_shared/utils.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { securityHeaders } from "../_shared/headers.ts";
import { getUserTier, getTierLimits } from "../_shared/tier-check.ts";
import { resolveUserId } from "../_shared/auth-helpers.ts";
import { cardToResult, type CardRow, pickCards, queryAliasKeys, queryAsksAbout } from "../_shared/memory-cards.ts";

const MAX_CARDS_PER_SEARCH = 2;

/**
 * Memory cards for the names in the query (see _shared/memory-cards.ts).
 * Never fails the search: a missing table or a database error means no cards.
 */
async function findMemoryCards(admin: any, userId: string, query: string, requestId: string): Promise<Record<string, unknown>[]> {
    try {
        const keys = queryAliasKeys(query);
        if (keys.length === 0) return [];
        const { data, error } = await admin
            .from("memory_cards")
            .select("id, card_key, name, aliases, description, key_facts, user_note, mention_count, latest_evidence_at, built_at, pinned")
            .eq("user_id", userId)
            .eq("status", "ready")
            .overlaps("aliases", keys)
            .limit(20);
        if (error) {
            Logger.warn("Memory card lookup failed (search continues)", { requestId, error: error.message });
            return [];
        }
        return pickCards((data ?? []) as CardRow[], keys, MAX_CARDS_PER_SEARCH, queryAsksAbout(query)).map(cardToResult);
    } catch (e) {
        Logger.warn("Memory card lookup threw (search continues)", { requestId, error: (e as Error).message });
        return [];
    }
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    ...securityHeaders(),
};

serve(async (req) => {
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const requestId = crypto.randomUUID();
    Logger.info("Received search request", { requestId });

    try {
        const body = await req.json();
        const {
            query,
            userId: bodyUserId,
            profileId: bodyProfileId,
            useHyde = true,     // Default: HyDE enabled
            hydeWeight = 0.6,   // Default: 60% HyDE, 40% raw
            topK = 20,
            fast = false,       // Fast path: skip HyDE, reranking, entity search
            confidenceThreshold,  // Override default 0.40 confidence filter
            mmrLambda,            // MMR diversity/relevance (0.35 synthesis, 0.5 default)
            recentTopics,         // Recent topic words for implicit query enrichment
            conversationWindow,   // Recent messages from current conversation for coreference resolution
            projectId,            // Project scoping for K.Y.T. Vault
            excludePlatforms,     // Platforms to exclude from results (e.g. ["claude-code"])
            speakerFilter,        // Only return turns with this speaker (e.g. "user")
            queryType,            // 'technical' for code queries — adjusts BM25/HyDE weights
            isRecallQuery,        // True when user is recalling past conversation — tightens echo filtering
        } = body;

        // Resolve caller identity. The edge function uses the service-role key
        // internally (bypasses RLS), so we MUST establish who the caller is:
        //   - Real user JWT  → that user (production clients).
        //   - Service role   → trusted backend (benchmark harness / admin) may
        //                       impersonate any user via the body userId.
        //   - Anon key/other → no impersonation (prevents anon-key IDOR where
        //                       anyone could query any user's memories).
        // Requires verify_jwt = true so the decoded role claim is trustworthy.
        const supabaseAdmin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const { userId, isServiceRole } = await resolveUserId(
            req.headers.get("Authorization"),
            supabaseAdmin,
            bodyUserId,
        );
        if (isServiceRole) {
            Logger.info("Service-role caller — body userId honored", { requestId, userId });
        }

        if (!query || !userId) {
            Logger.warn("Missing query or userId", { requestId, query, userId });
            return new Response(JSON.stringify({ error: !userId ? "Authentication required" : "Missing query" }), {
                status: !userId ? 401 : 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Rate limit per userId (tier-aware). Service-role callers (benchmark
        // harness / admin tooling) bypass limits so bulk eval runs stay
        // deterministic and aren't throttled by the in-memory limiter.
        if (!isServiceRole) {
            const tier = await getUserTier(userId);
            const limits = getTierLimits(tier);
            if (!checkRateLimit('search_memories', userId, limits.searchesPerMin)) {
                Logger.warn("Rate limited", { requestId, userId, tier });
                return rateLimitResponse(corsHeaders);
            }
        }

        // Temporal + platform recency fallback: simple ORDER BY created_at DESC
        if (body.recentByPlatform) {
            Logger.info("Temporal+platform recency fallback", {
                requestId, platform: body.recentByPlatform, userId
            });
            const profileId = bodyProfileId || userId;
            const results = await getRecentByPlatform(
                body.recentByPlatform, userId, topK, profileId
            );
            return new Response(JSON.stringify({
                success: true,
                results,
                meta: { requestId, recentByPlatform: body.recentByPlatform },
            }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        Logger.info("Executing search", {
            requestId,
            query,
            userId,
            useHyde,
            hydeWeight
        });

        // Build search options
        const options: SearchOptions = {
            topK,
            useHyde: fast ? false : useHyde,
            hydeWeight,
            fast,
            confidenceThreshold,
            mmrLambda,
            recentTopics: recentTopics || undefined,
            conversationWindow: conversationWindow || undefined,
            edgeFunction: 'search_memories',
            excludePlatforms: excludePlatforms || undefined,
            speakerFilter: speakerFilter || undefined,
            queryType: queryType || undefined,
            isRecallQuery: isRecallQuery || undefined,
        };

        // Get relevant memories using the full Hybrid HyDE pipeline:
        // 1. Entity search + HyDE generation (parallel)
        // 2. Adaptive short-circuit for entity matches
        // 3. Dual embedding (HyDE + raw)
        // 4. Dual vector search (parallel)
        // 5. RRF merge
        // 6. Rerank → BM25 → Entity boost → Confidence filter → Top-5
        // MVP: profileId = userId (1:1). Future: pass to RPC calls for multi-profile isolation.
        const profileId = bodyProfileId || userId;
        const pipelineDiag: Record<string, any> = {};
        options._diagnostics = pipelineDiag;
        const [turnResults, cards] = await Promise.all([
            getRelevantMemories(query, userId, options, requestId, profileId, projectId || undefined),
            findMemoryCards(supabaseAdmin, userId, query, requestId),
        ]);
        // Cards first: a question that names a thing gets the short record of
        // what that thing is ahead of the supporting turns.
        const results = [...cards, ...turnResults];

        Logger.info("Search completed", {
            requestId,
            resultCount: results.length,
            memoryCards: cards.length,
            hydeUsed: useHyde
        });

        return new Response(JSON.stringify({
            success: true,
            results,
            meta: {
                requestId,
                hydeEnabled: fast ? false : useHyde,
                hydeWeight,
                fast,
                ...(Object.keys(pipelineDiag).length > 0 ? { pipeline: pipelineDiag } : {}),
            }
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (error) {
        Logger.error("Search failed", { requestId, error: error.message });
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

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

        // Extract user from JWT if present (authenticated mode)
        let userId = bodyUserId;
        const authHeader = req.headers.get("Authorization");
        if (authHeader?.startsWith("Bearer ") && authHeader.length > 50) {
            try {
                const supabaseAdmin = createClient(
                    Deno.env.get("SUPABASE_URL")!,
                    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
                );
                const { data: { user }, error } = await supabaseAdmin.auth.getUser(
                    authHeader.slice(7),
                );
                if (user && !error) {
                    userId = user.id; // Override with authenticated user ID
                    Logger.info("JWT user extracted", { requestId, userId });
                }
            } catch (jwtErr) {
                Logger.warn("JWT extraction failed, using body userId", { requestId, error: jwtErr.message });
            }
        }

        if (!query || !userId) {
            Logger.warn("Missing query or userId", { requestId, query, userId });
            return new Response(JSON.stringify({ error: "Missing query or userId" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Rate limit per userId (tier-aware)
        const tier = await getUserTier(userId);
        const limits = getTierLimits(tier);
        if (!checkRateLimit('search_memories', userId, limits.searchesPerMin)) {
            Logger.warn("Rate limited", { requestId, userId, tier });
            return rateLimitResponse(corsHeaders);
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
        const results = await getRelevantMemories(query, userId, options, requestId, profileId, projectId || undefined);

        Logger.info("Search completed", {
            requestId,
            resultCount: results.length,
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

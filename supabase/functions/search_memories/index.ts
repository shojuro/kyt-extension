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
import { cleanResults } from "../_shared/result-cleanup.ts";
import { isEchoOfQuery } from "../_shared/injected-context.ts";
import { isRecallAttempt } from "../_shared/recall-attempts.ts";
import { KEYWORD_LANE, KEYWORD_TURN_CANDIDATES, keywordPassages, keywordTerms } from "../_shared/keyword-lane.ts";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import {
    applyJudgement,
    buildJudgePrompt,
    JUDGE_SECTION_PASSAGES,
    judgedTurnResults,
    JUDGE_MAX_TOKENS,
    JUDGE_RULE,
    JUDGE_SYSTEM_PROMPT,
    JUDGE_TIMEOUT_MS,
    parseJudgeReply,
    TURN_KIND,
    type TurnCandidate,
    turnPassages,
} from "../_shared/section-judge.ts";
import {
    mergeSectionResults,
    SECTION_CANDIDATES,
    SECTION_CANDIDATE_SIMILARITY,
    SIMILARITY_RULE,
    type SectionHit,
    selectSections,
    turnsWantingOutline,
} from "../_shared/turn-sections.ts";
import { cardToResult, type CardRow, pickCards, queryAliasKeys, queryAsksAbout } from "../_shared/memory-cards.ts";

const MAX_CARDS_PER_SEARCH = 2;

/**
 * Decides what is returned besides memory cards.
 *
 * With the judge (the extension's path): the closest whole messages and the
 * closest sections of long messages go to one model call, which keeps the
 * ones that help answer the message (see _shared/section-judge.ts). Age and
 * "importance" play no part. Without the judge, or when it fails: the turn
 * results as scored before, plus sections chosen by similarity.
 *
 * Never fails the search: any error leaves the turn results as they were.
 */
async function withJudge(
    admin: any,
    userId: string,
    queryEmbedding: number[] | undefined,
    query: string,
    turnResults: any[],
    turnCandidates: TurnCandidate[] | undefined,
    projectId: string | undefined,
    requestId: string,
    judge: boolean,
): Promise<any[]> {
    try {
        let sectionCandidates: SectionHit[] = [];
        if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
            const { data, error } = await admin.rpc("match_turn_sections", {
                p_user_id: userId,
                query_embedding: queryEmbedding,
                match_threshold: SECTION_CANDIDATE_SIMILARITY,
                match_count: SECTION_CANDIDATES,
                p_project_id: projectId || null,
            });
            if (error) {
                Logger.warn("Section search failed (search continues)", { requestId, error: error.message });
            } else {
                // An earlier asking of this same question is not an answer to it,
                // and neither is the opening of a reply that says nothing was found.
                sectionCandidates = ((data ?? []) as SectionHit[]).filter((h) =>
                    !isEchoOfQuery(h.content, query) &&
                    !(h.kind === "section" && h.section_index === 0 && isRecallAttempt(h, query)));
            }
        }

        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
        const judgeTurns = judge && Array.isArray(turnCandidates);
        // Attempts to recall (the user asking what was said, an assistant saying
        // it could not find it) are not memories: see _shared/recall-attempts.ts.
        const cleanedTurns = judgeTurns ? cleanResults(turnCandidates as any[], query) as TurnCandidate[] : [];
        const usableTurns = cleanedTurns.filter((c) => !isRecallAttempt(c, query));
        let recallAttemptsDropped = cleanedTurns.length - usableTurns.length;

        // Keyword lane: messages that contain the question's rarer words join
        // the ones found by meaning. The judge decides; this only finds.
        let keywordTurns: TurnCandidate[] = [];
        const terms = judgeTurns && anthropicKey ? keywordTerms(query) : [];
        if (terms.length > 0) {
            const { data, error } = await admin.rpc("keyword_turn_candidates", {
                p_user_id: userId,
                p_terms: terms,
                p_limit: KEYWORD_TURN_CANDIDATES,
                p_project_id: projectId || null,
            });
            if (error) {
                Logger.warn("Keyword search failed (search continues)", { requestId, error: error.message });
            } else {
                const cleaned = cleanResults((data ?? []) as any[], query) as TurnCandidate[];
                keywordTurns = cleaned.filter((c) => !isRecallAttempt(c, query));
                recallAttemptsDropped += cleaned.length - keywordTurns.length;
            }
        }

        const meaningPassages = judge && anthropicKey ? turnPassages(usableTurns) : [];
        const wordPassages = judge && anthropicKey ? keywordPassages(keywordTurns, meaningPassages.map((p) => p.id)) : [];
        const passages = judge && anthropicKey
            ? [...meaningPassages, ...wordPassages, ...sectionCandidates.slice(0, JUDGE_SECTION_PASSAGES)]
            : [];

        let sectionHits = sectionCandidates;
        let rule = SIMILARITY_RULE;
        let scoredBy = "similarity";
        let rerankMs: number | null = null;
        let turns = turnResults;
        if (passages.length > 0) {
            try {
                const anthropic = new AnthropicClient(anthropicKey!, { userId, edgeFunction: "search_memories" });
                const judgeStarted = Date.now();
                const reply = await anthropic.generateJsonCompletion(
                    JUDGE_SYSTEM_PROMPT,
                    buildJudgePrompt(query, passages),
                    { maxTokens: JUDGE_MAX_TOKENS, maxRetries: 0, timeoutMs: JUDGE_TIMEOUT_MS, operation: "section_judge" },
                    requestId,
                );
                rerankMs = Date.now() - judgeStarted;
                const judgement = parseJudgeReply(reply, passages.length);
                const kept = applyJudgement(passages, judgement);
                sectionHits = kept.filter((p) => (p.kind as string) !== TURN_KIND);
                // Structured decisions (technical questions) are exact facts added
                // by the turn search, not judged passages: keep them.
                if (judgeTurns) turns = [...turnResults.filter((r) => r?.platform === "decision_entity"), ...judgedTurnResults(kept, [...usableTurns, ...keywordTurns])];
                rule = JUDGE_RULE;
                scoredBy = "judge";
                Logger.info("Judge", {
                    requestId,
                    ms: rerankMs,
                    shown: passages.map((p, i) => `${i + 1}:${(p as any).lane === KEYWORD_LANE ? "word" : p.kind}:${Number(p.similarity).toFixed(2)}:${String(p.heading ?? "").slice(0, 40)}`),
                    shownIds: passages.map((p) => String(p.turn_id ?? p.id).slice(0, 8)),
                    keywordTerms: terms,
                    relevant: judgement.relevant.map((i) => i + 1),
                    whole: judgement.whole.map((i) => i + 1),
                });
            } catch (e) {
                Logger.warn("Judge failed (using scores)", { requestId, error: (e as Error).message });
            }
        } else if (judgeTurns && judge && anthropicKey) {
            // Nothing close enough to show the judge: nothing to return.
            turns = turnResults.filter((r) => r?.platform === "decision_entity");
        }

        const selected = selectSections(sectionHits, undefined, rule);
        // A turn with two matching sections, or one the judge wants whole, is
        // being asked about as a whole: fetch its outline as well.
        let outlines: SectionHit[] = [];
        const wantOutline = turnsWantingOutline(selected, rule);
        if (wantOutline.length > 0) {
            const { data: outlineRows } = await admin
                .from("turn_sections")
                .select("id, turn_id, kind, section_index, heading, content")
                .eq("user_id", userId)
                .eq("kind", "outline")
                .in("turn_id", wantOutline);
            outlines = (outlineRows ?? []).map((row: any) => {
                const source = selected.find((s) => s.turn_id === row.turn_id)!;
                return { ...row, similarity: 0, platform: source.platform, speakers: source.speakers, created_at: source.created_at };
            });
        }
        Logger.info("Sections matched", {
            requestId,
            scoredBy,
            rerankMs,
            shown: passages.length,
            recallAttemptsDropped,
            keywordFound: keywordTurns.length,
            keywordShown: wordPassages.length,
            turnsReturned: turns.length,
            returned: selected.length,
            outlines: outlines.length,
            topSimilarity: sectionCandidates.slice(0, 5).map((h) => Number(h.similarity).toFixed(3)),
        });
        return selected.length > 0 ? mergeSectionResults(turns, selected, outlines) : turns;
    } catch (e) {
        Logger.warn("Judging threw (search continues)", { requestId, error: (e as Error).message });
        return turnResults;
    }
}

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
        const judgeResults = body?.judgeSections !== false;
        const capture: { queryEmbedding?: number[]; wantJudgeCandidates?: boolean; judgeCandidates?: any[] } = { wantJudgeCandidates: judgeResults && fast === true };
        options._capture = capture;
        const [turnResults, cards] = await Promise.all([
            getRelevantMemories(query, userId, options, requestId, profileId, projectId || undefined),
            findMemoryCards(supabaseAdmin, userId, query, requestId),
        ]);
        // Cards first: a question that names a thing gets the short record of
        // what that thing is ahead of the supporting turns.
        const withParts = await withJudge(supabaseAdmin, userId, capture.queryEmbedding, query, turnResults, capture.judgeCandidates, projectId || undefined, requestId, judgeResults);
        const results = [...cards, ...cleanResults(withParts, query)];

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

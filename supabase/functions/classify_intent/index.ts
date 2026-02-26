// supabase/functions/classify_intent/index.ts
//
// Intent Classification Layer 2 — LLM Judge for PASSIVE cases
//
// Called only when the client-side heuristic classifier (Layer 1) returns
// PASSIVE — meaning the message has moderate density but no strong retrieval
// signals. Haiku 4.5 decides: fire the retrieval pipeline or skip.
//
// Taxonomy: MEMORY_QUERY (fire pipeline at 0.50) | NO_RETRIEVAL (skip)
//
// Parameters:
//   - message (required): The user's message text (max 500 chars)
//   - scores (required): Layer 1 heuristic scores { directive, memory, question, personal, temporal, density }
//   - reason (required): Layer 1 classification reason string

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { Logger } from "../_shared/utils.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Classify this message as MEMORY_QUERY or NO_RETRIEVAL.
MEMORY_QUERY: User is asking about, referencing, or wanting to recall something from past conversations.
NO_RETRIEVAL: User is giving instructions, making statements, reacting emotionally, or asking generic questions not tied to past context.
Respond with only: MEMORY_QUERY or NO_RETRIEVAL`;

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const requestId = crypto.randomUUID();

    try {
        // ── Auth ──
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
        );
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Check API key ──
        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (!anthropicKey) {
            Logger.warn("ANTHROPIC_API_KEY not set — Layer 2 disabled", { requestId });
            return new Response(
                JSON.stringify({ classification: "NO_RETRIEVAL", source: "api_key_missing" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Validate input ──
        const body = await req.json();
        const { message, scores, reason } = body;

        if (!message || !scores) {
            return new Response(
                JSON.stringify({ error: "message and scores are required" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Truncate — classification doesn't need the full message
        const truncated = (typeof message === "string" ? message : "").slice(0, 500);
        const startTime = Date.now();

        const client = new AnthropicClient(anthropicKey);

        const result = await client.generateCompletion(
            SYSTEM_PROMPT,
            truncated,
            { temperature: 0.0, maxTokens: 10 },
            requestId
        );

        const latencyMs = Date.now() - startTime;
        const rawText = result.toUpperCase().trim();

        // Parse: MEMORY_QUERY if present, otherwise conservative NO_RETRIEVAL
        let classification = "NO_RETRIEVAL";
        if (rawText.includes("MEMORY_QUERY")) classification = "MEMORY_QUERY";

        Logger.info("Layer 2 classification", {
            requestId,
            message: truncated.substring(0, 80),
            l1Reason: reason,
            l2Raw: result,
            classification,
            latencyMs,
        });

        // ── Log for v3 training data (fire-and-forget) ──
        supabase
            .from("intent_classification_log")
            .insert({
                user_id: user.id,
                message_preview: truncated.slice(0, 200),
                classification,
                heuristic_scores: scores || null,
                source: "haiku_tiebreaker",
                latency_ms: latencyMs,
            })
            .then(({ error }) => {
                if (error) Logger.warn("Log insert failed", { requestId, error: error.message });
            });

        return new Response(
            JSON.stringify({ classification, latency_ms: latencyMs, source: "haiku_tiebreaker" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (error) {
        Logger.warn("Layer 2 classification failed — falling through", {
            requestId,
            error: error.message,
        });

        // On any failure, return NO_RETRIEVAL (conservative)
        // Client will fall through to PASSIVE if it sees an error/unexpected source
        return new Response(
            JSON.stringify({ classification: "NO_RETRIEVAL", source: "exception", error: error.message }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});

// supabase/functions/llm_completion/index.ts
//
// Generic LLM Completion Edge Function
//
// Single edge function for all client-side LLM calls.
// Keeps the Anthropic API key server-side. Clients send system + user prompts
// and receive generated text or parsed JSON.
//
// Used by: hyde-search-generator.js, hyde-preprocessor.js, gravity-scorer.js
//
// Parameters:
//   - system (required): System prompt
//   - user (required): User prompt
//   - temperature (optional): 0.0-1.0, default 0.0
//   - max_tokens (optional): default 300
//   - json_mode (optional): if true, uses prefill trick for JSON output
//   - operation (optional): cost tracking label (e.g. 'hyde_search', 'hyde_index', 'gravity_scoring')

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { Logger } from "../_shared/utils.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
            Logger.warn("ANTHROPIC_API_KEY not set — llm_completion disabled", { requestId });
            return new Response(
                JSON.stringify({ error: "LLM service unavailable" }),
                { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Validate input ──
        const body = await req.json();
        const { system, user: userPrompt, temperature, max_tokens, json_mode, operation } = body;

        if (!system || !userPrompt) {
            return new Response(
                JSON.stringify({ error: "system and user prompts are required" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Truncate prompts to reasonable limits
        const systemTruncated = typeof system === "string" ? system.slice(0, 4000) : "";
        const userTruncated = typeof userPrompt === "string" ? userPrompt.slice(0, 4000) : "";

        const startTime = Date.now();
        const client = new AnthropicClient(anthropicKey);

        const options = {
            temperature: typeof temperature === "number" ? temperature : 0.0,
            maxTokens: typeof max_tokens === "number" ? Math.min(max_tokens, 2000) : 300,
            maxRetries: 2,
            timeoutMs: 10000,
            operation: operation || "llm_completion",
        };

        let content: string;

        if (json_mode) {
            const jsonResult = await client.generateJsonCompletion(
                systemTruncated,
                userTruncated,
                options,
                requestId
            );
            content = JSON.stringify(jsonResult);
        } else {
            content = await client.generateCompletion(
                systemTruncated,
                userTruncated,
                options,
                requestId
            );
        }

        const latencyMs = Date.now() - startTime;

        Logger.info("llm_completion success", {
            requestId,
            operation: options.operation,
            json_mode: !!json_mode,
            latencyMs,
        });

        return new Response(
            JSON.stringify({ content, latency_ms: latencyMs }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (error) {
        Logger.error("llm_completion failed", {
            requestId,
            error: error.message,
        });

        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});

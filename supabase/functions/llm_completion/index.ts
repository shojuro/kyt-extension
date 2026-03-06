// supabase/functions/llm_completion/index.ts
//
// Generic LLM Completion Edge Function — Multi-Provider
//
// Single edge function for all client-side LLM calls.
// Keeps ALL API keys server-side. Clients send system + user prompts
// and receive generated text or parsed JSON.
//
// Providers:
//   - "anthropic" (default): Claude Haiku 4.5 — used by server-side modules
//   - "openai": GPT-4.1-mini — used by client-side HyDE/gravity (cost optimization)
//
// Used by: hyde-search-generator.js, hyde-preprocessor.js, gravity-scorer.js
//
// Parameters:
//   - system (required): System prompt
//   - user (required): User prompt
//   - provider (optional): "anthropic" | "openai", default "anthropic"
//   - model (optional): Model override (e.g. "gpt-4.1-mini"). If omitted, uses provider default.
//   - temperature (optional): 0.0-1.0, default 0.0
//   - max_tokens (optional): default 300
//   - json_mode (optional): if true, returns JSON (Anthropic: prefill trick, OpenAI: response_format)
//   - operation (optional): cost tracking label (e.g. 'hyde_search', 'hyde_index', 'gravity_scoring')

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { Logger, CostMonitor } from "../_shared/utils.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { securityHeaders } from "../_shared/headers.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    ...securityHeaders(),
};

const RATE_LIMIT_MAX_LLM = 10; // 10 LLM calls/min per user (costs real money)

// ── OpenAI completion handler ──────────────────────────────────────────
async function callOpenAI(
    apiKey: string,
    model: string,
    system: string,
    user: string,
    temperature: number,
    maxTokens: number,
    jsonMode: boolean,
    operation: string,
    requestId: string,
): Promise<string> {
    const body: Record<string, unknown> = {
        model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
        temperature,
        max_tokens: maxTokens,
    };

    if (jsonMode) {
        body.response_format = { type: "json_object" };
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || "";

    // Cost tracking — GPT-4.1-mini pricing: $0.40/1M input, $1.60/1M output
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    const estimatedCost = (inputTokens * 0.0000004) + (outputTokens * 0.0000016);

    await CostMonitor.logUsage("openai", model, operation, estimatedCost, requestId);

    Logger.info("OpenAI completion generated", {
        requestId,
        model,
        operation,
        inputTokens,
        outputTokens,
        estimatedCost,
    });

    return content;
}

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

        // ── Rate limit ──
        if (!checkRateLimit('llm_completion', user.id, RATE_LIMIT_MAX_LLM)) {
            Logger.warn("LLM rate limited", { requestId, userId: user.id });
            return rateLimitResponse(corsHeaders);
        }

        // ── Validate input ──
        const body = await req.json();
        const {
            system,
            user: userPrompt,
            provider: requestedProvider,
            model: requestedModel,
            temperature,
            max_tokens,
            json_mode,
            operation,
        } = body;

        if (!system || !userPrompt) {
            return new Response(
                JSON.stringify({ error: "system and user prompts are required" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Truncate prompts to reasonable limits
        const systemTruncated = typeof system === "string" ? system.slice(0, 4000) : "";
        const userTruncated = typeof userPrompt === "string" ? userPrompt.slice(0, 4000) : "";

        const tempValue = typeof temperature === "number" ? temperature : 0.0;
        const maxTokensValue = typeof max_tokens === "number" ? Math.min(max_tokens, 2000) : 300;
        const operationLabel = operation || "llm_completion";

        const startTime = Date.now();
        let content: string;

        // ── Provider routing ──
        const provider = requestedProvider === "openai" ? "openai" : "anthropic";

        if (provider === "openai") {
            // ── OpenAI path ──
            const openaiKey = Deno.env.get("OPENAI_API_KEY");
            if (!openaiKey) {
                Logger.warn("OPENAI_API_KEY not set — OpenAI provider unavailable", { requestId });
                return new Response(
                    JSON.stringify({ error: "OpenAI service unavailable" }),
                    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            const model = requestedModel || "gpt-4.1-mini";
            content = await callOpenAI(
                openaiKey,
                model,
                systemTruncated,
                userTruncated,
                tempValue,
                maxTokensValue,
                !!json_mode,
                operationLabel,
                requestId,
            );
        } else {
            // ── Anthropic path (default) ──
            const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
            if (!anthropicKey) {
                Logger.warn("ANTHROPIC_API_KEY not set — Anthropic provider unavailable", { requestId });
                return new Response(
                    JSON.stringify({ error: "LLM service unavailable" }),
                    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            const client = new AnthropicClient(anthropicKey);
            const options = {
                temperature: tempValue,
                maxTokens: maxTokensValue,
                maxRetries: 2,
                timeoutMs: 10000,
                operation: operationLabel,
            };

            if (json_mode) {
                const jsonResult = await client.generateJsonCompletion(
                    systemTruncated,
                    userTruncated,
                    options,
                    requestId,
                );
                content = JSON.stringify(jsonResult);
            } else {
                content = await client.generateCompletion(
                    systemTruncated,
                    userTruncated,
                    options,
                    requestId,
                );
            }
        }

        const latencyMs = Date.now() - startTime;

        Logger.info("llm_completion success", {
            requestId,
            provider,
            operation: operationLabel,
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

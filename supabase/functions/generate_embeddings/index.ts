// supabase/functions/generate_embeddings/index.ts
//
// Server-side embedding proxy — keeps HuggingFace API key server-side.
// Clients send texts, receive 1024d Matryoshka-truncated Qwen3 embeddings.
//
// Parameters:
//   - texts (required): string[] — texts to embed (max 50)
//
// Returns: { embeddings: number[][] } — one 1024d vector per input text
//
// Rate limit: 60 requests per minute per userId (sliding window).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { HuggingFaceClient } from "../_shared/huggingface-client.ts";
import { Logger } from "../_shared/utils.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BATCH = 50;

// Simple in-memory sliding window rate limiter (per edge function instance)
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

function checkRateLimit(key: string): boolean {
    const now = Date.now();
    const timestamps = rateLimitMap.get(key) || [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
        rateLimitMap.set(key, recent);
        return false;
    }
    recent.push(now);
    rateLimitMap.set(key, recent);
    return true;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const requestId = crypto.randomUUID();

    try {
        const { texts, userId } = await req.json();

        if (!texts || !Array.isArray(texts) || texts.length === 0) {
            return new Response(JSON.stringify({ error: "texts array required" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        if (texts.length > MAX_BATCH) {
            return new Response(JSON.stringify({ error: `Max ${MAX_BATCH} texts per request` }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Rate limit by userId or IP
        const rateLimitKey = userId || req.headers.get("x-forwarded-for") || "anonymous";
        if (!checkRateLimit(rateLimitKey)) {
            Logger.warn("Rate limited", { requestId, key: rateLimitKey });
            return new Response(JSON.stringify({ error: "Rate limited (60/min)" }), {
                status: 429,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const hfKey = Deno.env.get("HUGGINGFACE_API_KEY");
        if (!hfKey) {
            Logger.error("HUGGINGFACE_API_KEY not set", { requestId });
            return new Response(JSON.stringify({ error: "Embedding service unavailable" }), {
                status: 503,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const client = new HuggingFaceClient(hfKey);
        const embeddings = await client.generateEmbeddingsBatch(texts, requestId);

        Logger.info("Embeddings generated", { requestId, count: embeddings.length });

        return new Response(JSON.stringify({ embeddings }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (error) {
        Logger.error("Embedding generation failed", { requestId, error: error.message });
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

// supabase/functions/classify_intent/index.ts
//
// Intent Classification Layer 2 — LLM Judge for PASSIVE cases
//
// Called only when the client-side heuristic classifier (Layer 1) returns
// PASSIVE — meaning the message has moderate density but no strong retrieval
// signals. Haiku 4.5 decides: fire the retrieval pipeline or skip.
//
// Parameters:
//   - message (required): The user's message text
//   - scores (required): Layer 1 heuristic scores { directive, memory, question, personal, temporal, density }
//   - reason (required): Layer 1 classification reason string

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { AnthropicClient } from "../_shared/anthropic-client.ts";
import { Logger } from "../_shared/utils.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are an intent classifier for a personal memory retrieval system. The system captures a user's ChatGPT and Claude conversations and can inject relevant past context when the user asks a new question.

Your job: decide whether a user message would benefit from retrieving past conversation context.

Respond with exactly one word: RETRIEVE or SKIP

RETRIEVE when the message:
- Asks about something the user has discussed before
- References a topic, project, person, or preference the user might have mentioned
- Would benefit from past conversation context to give a better answer
- Is a substantive statement that establishes facts the system should cross-reference

SKIP when the message:
- Is a casual personal declaration or opinion with no retrieval value ("I only read thought books")
- Is small talk, greetings, or filler
- Is a pure instruction to the AI ("write this in python", "make it shorter")
- Is a self-contained statement that doesn't benefit from past context
- Is a generic factual statement with no personal connection ("Python is a great language")`;

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const requestId = crypto.randomUUID();

    try {
        const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (!anthropicKey) {
            // No key configured — fall through to PASSIVE (don't block pipeline)
            Logger.warn("ANTHROPIC_API_KEY not set — Layer 2 disabled", { requestId });
            return new Response(
                JSON.stringify({ intent: "PASSIVE", layer: 1, reason: "layer2_disabled" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const body = await req.json();
        const { message, scores, reason } = body;

        if (!message || !scores) {
            return new Response(
                JSON.stringify({ error: "message and scores are required" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const client = new AnthropicClient(anthropicKey);

        const userPrompt = `Message: "${message}"

Heuristic scores (0-1): directive=${scores.directive}, memory=${scores.memory}, question=${scores.question}, personal=${scores.personal}, temporal=${scores.temporal}, density=${scores.density}
Heuristic reason: ${reason}

Should the memory retrieval pipeline fire for this message? Answer RETRIEVE or SKIP.`;

        const result = await client.generateCompletion(
            SYSTEM_PROMPT,
            userPrompt,
            { temperature: 0.0, maxTokens: 10 },
            requestId
        );

        const normalized = result.toUpperCase().trim();
        const intent = normalized.startsWith("RETRIEVE") ? "PASSIVE" : "SKIP";

        Logger.info("Layer 2 classification", {
            requestId,
            message: message.substring(0, 80),
            l1Reason: reason,
            l2Raw: result,
            l2Intent: intent
        });

        return new Response(
            JSON.stringify({
                intent,
                layer: 2,
                reason: intent === "SKIP" ? "llm_judge_skip" : "llm_judge_retrieve",
                l2Raw: result,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (error) {
        Logger.warn("Layer 2 classification failed — falling through to PASSIVE", {
            requestId,
            error: error.message,
        });

        // On any failure, fall through to PASSIVE — don't block the pipeline
        return new Response(
            JSON.stringify({ intent: "PASSIVE", layer: 1, reason: "layer2_error" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});

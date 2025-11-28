// supabase/functions/search_memories/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRelevantMemories } from "../_shared/get_relevant_memories.ts";
import { Logger } from "../_shared/utils.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const requestId = crypto.randomUUID();
    Logger.info("Received search request", { requestId });

    try {
        const { query, userId } = await req.json();

        if (!query || !userId) {
            Logger.warn("Missing query or userId", { requestId, query, userId });
            return new Response(JSON.stringify({ error: "Missing query or userId" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Initialize Supabase client for direct DB checks if needed (optional)
        // const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        // const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        // const supabase = createClient(supabaseUrl, supabaseServiceKey);

        Logger.info("Executing search", { requestId, query, userId });

        // Get top 5 relevant memories using the full pipeline:
        // Vector Search -> Rerank -> BM25 Boost -> Confidence Filter
        // Pass requestId to getRelevantMemories for tracing
        const results = await getRelevantMemories(query, userId, 20, requestId);

        Logger.info("Search completed", { requestId, resultCount: results.length });

        return new Response(JSON.stringify({ success: true, results }), {
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

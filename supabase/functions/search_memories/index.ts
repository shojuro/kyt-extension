// supabase/functions/search_memories/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getRelevantMemories } from "../_shared/get_relevant_memories.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { query, userId } = await req.json();

        if (!query) {
            return new Response(
                JSON.stringify({ error: "query is required" }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        if (!userId) {
            return new Response(
                JSON.stringify({ error: "userId is required for search" }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Search memories using gravity-weighted vector search + reranking
        console.log(`Searching memories for user ${userId} with query: "${query.substring(0, 50)}..."`);
        const memories = await getRelevantMemories(query);

        console.log(`Found ${memories.length} relevant memories`);

        return new Response(
            JSON.stringify({
                success: true,
                query,
                userId,
                memories: memories.map(m => ({
                    id: m.id,
                    content: m.content,
                    score: m.rerank_score,
                    gravity_score: m.gravity_score
                })),
                count: memories.length
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        console.error("Search error:", error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

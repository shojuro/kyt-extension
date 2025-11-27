// supabase/functions/search_memories/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRelevantMemories } from "../_shared/get_relevant_memories.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client for direct DB checks
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

        // DEBUG: Check if user has any rows
        const { count, error: countError } = await supabase
            .from('chat_turns')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        // DEBUG: Check for non-null embeddings
        const { count: embeddingCount } = await supabase
            .from('chat_turns')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .not('embedding', 'is', null);

        // Get top 5 relevant memories using the full pipeline:
        // Vector Search -> Rerank -> BM25 Boost -> Confidence Filter
        const results = await getRelevantMemories(query, userId, 20);

        return new Response(
            JSON.stringify({
                success: true,
                results,
                debug: {
                    user_row_count: count,
                    embedding_count: embeddingCount,
                    count_error: countError
                }
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

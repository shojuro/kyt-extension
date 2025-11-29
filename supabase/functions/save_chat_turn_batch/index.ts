import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { HuggingFaceClient } from '../_shared/huggingface-client.ts';
import { extractEntities } from '../_shared/entity-extractor.ts';
import { classifyMemory } from '../_shared/memory-classifier.ts';

const MAX_BATCH_SIZE = 50;

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
        const { turns, skip_ai_processing } = await req.json();

        // Validate batch size
        if (!turns || turns.length === 0) {
            return new Response(JSON.stringify({ error: 'No turns provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        if (turns.length > MAX_BATCH_SIZE) {
            return new Response(JSON.stringify({ error: `Max batch size is ${MAX_BATCH_SIZE}` }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        const hfClient = new HuggingFaceClient(Deno.env.get('HUGGINGFACE_API_KEY')!);
        const openaiKey = Deno.env.get('OPENAI_API_KEY')!;

        const results = [];

        for (const turn of turns) {
            try {
                let embedding = null;
                let gravity = { impact_score: 0, intimacy_level: 0 };
                let extractedEntities = [];

                if (!skip_ai_processing) {
                    // 1. Generate embedding
                    [embedding] = await hfClient.generateEmbeddings(turn.content);

                    // 2. Parallel: Classify + Extract entities
                    const [classification, entities] = await Promise.allSettled([
                        classifyMemory({ content: turn.content }, openaiKey),
                        extractEntities({ content: turn.content, speakers: [] }, openaiKey)
                    ]);

                    gravity = classification.status === 'fulfilled'
                        ? classification.value
                        : { impact_score: 0, intimacy_level: 0 };

                    extractedEntities = entities.status === 'fulfilled'
                        ? entities.value
                        : [];
                }

                // 3. Save to database with ON CONFLICT handling for deduplication
                // Uses chat_turns_dedup_idx on (user_id, conversation_id, platform, start_timestamp)
                const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();

                const { data, error } = await supabase
                    .from('chat_turns')
                    .upsert({
                        user_id: turn.user_id,
                        conversation_id: turn.conversation_id,
                        platform: turn.platform,
                        content: turn.content,
                        embedding, // Can be null if skipped
                        impact_score: gravity.impact_score,
                        intimacy_level: gravity.intimacy_level,
                        // Required NOT NULL fields with sensible defaults for imports
                        turn_range: '1-1',
                        speakers: [turn.role || 'user'],
                        turn_count: 1,
                        start_timestamp: timestamp,
                        end_timestamp: timestamp,
                        // Optional fields
                        last_accessed: new Date().toISOString(),
                        access_count: 0
                    }, {
                        // ON CONFLICT: skip duplicates (based on chat_turns_dedup_idx)
                        onConflict: 'user_id,conversation_id,platform,start_timestamp',
                        ignoreDuplicates: true
                    })
                    .select('id');

                // Handle the result - may be empty if duplicate was skipped
                if (error) throw error;

                if (data && data.length > 0) {
                    // New row inserted
                    results.push({ id: data[0].id, success: true, duplicate: false });
                } else {
                    // Duplicate skipped (ON CONFLICT DO NOTHING)
                    results.push({ success: true, duplicate: true });
                }

            } catch (e) {
                console.error(`Error processing turn: ${e.message}`);
                results.push({ success: false, error: e.message });
            }
        }

        // Count duplicates
        const duplicateCount = results.filter(r => r.duplicate === true).length;
        const insertedCount = results.filter(r => r.success && !r.duplicate).length;
        const errorCount = results.filter(r => !r.success).length;

        return new Response(JSON.stringify({
            success: true,
            processed: results.length,
            inserted: insertedCount,
            duplicates_skipped: duplicateCount,
            errors: errorCount,
            results
        }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});

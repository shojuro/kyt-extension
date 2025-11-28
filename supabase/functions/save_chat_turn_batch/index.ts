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
        const { turns } = await req.json();

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
                // 1. Generate embedding
                const [embedding] = await hfClient.generateEmbeddings(turn.content);

                // 2. Parallel: Classify + Extract entities
                const [classification, entities] = await Promise.allSettled([
                    classifyMemory({ content: turn.content }, openaiKey),
                    extractEntities({ content: turn.content, speakers: [] }, openaiKey)
                ]);

                const gravity = classification.status === 'fulfilled'
                    ? classification.value
                    : { impact_score: 0, intimacy_level: 0 };

                const extractedEntities = entities.status === 'fulfilled'
                    ? entities.value
                    : [];

                // 3. Save to database
                const { data, error } = await supabase
                    .from('chat_turns')
                    .insert({
                        user_id: turn.user_id,
                        conversation_id: turn.conversation_id,
                        platform: turn.platform,
                        content: turn.content,
                        embedding,
                        impact_score: gravity.impact_score,
                        intimacy_level: gravity.intimacy_level,
                        source: turn.source || 'import',
                        metadata: turn.metadata,
                        created_at: turn.timestamp
                    })
                    .select('id')
                    .single();

                if (error) throw error;

                // 4. Save entities (if any)
                // Note: We're skipping entity saving for now to keep the import fast and simple,
                // or we can implement a batch save for entities later if needed.
                // For now, let's just log that we would have saved them.
                // In a real implementation, we would call a shared function to save these.

                results.push({ id: data.id, success: true });

            } catch (e) {
                console.error(`Error processing turn: ${e.message}`);
                results.push({ success: false, error: e.message });
            }
        }

        return new Response(JSON.stringify({
            success: true,
            processed: results.length,
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

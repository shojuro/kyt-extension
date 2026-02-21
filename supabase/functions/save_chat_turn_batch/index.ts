import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { HuggingFaceClient } from '../_shared/huggingface-client.ts';
import { extractEntities, saveEntitiesWithMentions, savePreferences } from '../_shared/entity-extractor.ts';
import { classifyMemory } from '../_shared/memory-classifier.ts';

const MAX_BATCH_SIZE = 50;

// Platform normalization (inline — Deno edge functions can't import from client src/)
const VALID_PLATFORMS = new Set(['chatgpt', 'claude', 'cli']);
function normalizePlatform(p: string | undefined): 'chatgpt' | 'claude' | 'cli' {
  if (p && VALID_PLATFORMS.has(p)) return p as 'chatgpt' | 'claude' | 'cli';
  return 'chatgpt';
}

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

        // Extract user from JWT if present (authenticated mode)
        // Override user_id on all turns with the authenticated user's ID
        const authHeader = req.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ') && authHeader.length > 50) {
            try {
                const { data: { user }, error } = await supabase.auth.getUser(
                    authHeader.slice(7),
                );
                if (user && !error) {
                    console.log(`JWT user extracted: ${user.id}, applying to ${turns.length} turns`);
                    for (const turn of turns) {
                        turn.user_id = user.id;
                    }
                }
            } catch (jwtErr) {
                console.warn('JWT extraction failed, using body user_id:', (jwtErr as Error).message);
            }
        }

        // FAST PATH: When skipping AI processing, do a single batch upsert
        // This is ~10x faster than sequential writes
        if (skip_ai_processing) {
            const records = turns.map((turn: any) => {
                const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();
                return {
                    user_id: turn.user_id,
                    conversation_id: turn.conversation_id,
                    platform: normalizePlatform(turn.platform),
                    content: turn.content,
                    embedding: null, // Will be backfilled later
                    impact_score: 0,
                    intimacy_level: 0,
                    turn_range: '1-1',
                    speakers: [turn.role || 'user'],
                    turn_count: 1,
                    start_timestamp: timestamp,
                    end_timestamp: timestamp,
                    last_accessed: new Date().toISOString(),
                    access_count: 0
                };
            });

            const { data, error } = await supabase
                .from('chat_turns')
                .upsert(records, {
                    onConflict: 'user_id,conversation_id,platform,start_timestamp',
                    ignoreDuplicates: true
                })
                .select('id');

            if (error) {
                console.error('Batch upsert error:', error);
                throw error;
            }

            // Data contains only inserted rows (duplicates are not returned)
            const insertedCount = data?.length || 0;
            const duplicateCount = turns.length - insertedCount;

            return new Response(JSON.stringify({
                success: true,
                processed: turns.length,
                inserted: insertedCount,
                duplicates_skipped: duplicateCount,
                errors: 0,
                results: data?.map((d: any) => ({ id: d.id, success: true, duplicate: false })) || []
            }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // SLOW PATH: With AI processing (sequential for embedding/classification)
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

                // 3. Save to database with ON CONFLICT handling for deduplication
                const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();

                const { data, error } = await supabase
                    .from('chat_turns')
                    .upsert({
                        user_id: turn.user_id,
                        conversation_id: turn.conversation_id,
                        platform: normalizePlatform(turn.platform),
                        content: turn.content,
                        embedding,
                        impact_score: gravity.impact_score,
                        intimacy_level: gravity.intimacy_level,
                        turn_range: '1-1',
                        speakers: [turn.role || 'user'],
                        turn_count: 1,
                        start_timestamp: timestamp,
                        end_timestamp: timestamp,
                        last_accessed: new Date().toISOString(),
                        access_count: 0
                    }, {
                        onConflict: 'user_id,conversation_id,platform,start_timestamp',
                        ignoreDuplicates: true
                    })
                    .select('id');

                if (error) throw error;

                if (data && data.length > 0) {
                    // Save extracted entities + preferences
                    const extractionResult = entities.status === 'fulfilled' ? entities.value : { entities: [], preferences: [] };
                    const extractedEntities = extractionResult.entities;
                    const extractedPreferences = extractionResult.preferences;
                    if (extractedEntities.length > 0 && turn.user_id) {
                        try {
                            await saveEntitiesWithMentions(
                                extractedEntities,
                                data[0].id,
                                turn.conversation_id || data[0].id,
                                turn.user_id,
                                supabase,
                                hfClient
                            );
                            // Mark chat_turn as having entities extracted
                            await supabase
                                .from('chat_turns')
                                .update({ entities_extracted: true })
                                .eq('id', data[0].id);
                        } catch (e) {
                            console.warn(`Entity save failed for turn ${data[0].id}: ${(e as Error).message}`);
                        }
                    }

                    // Save preferences
                    if (extractedPreferences.length > 0 && turn.user_id) {
                        try {
                            await savePreferences(extractedPreferences, data[0].id, turn.user_id, supabase);
                            await supabase.from('chat_turns')
                                .update({ preferences_extracted: true })
                                .eq('id', data[0].id);
                        } catch (e) {
                            console.warn(`Preference save failed for turn ${data[0].id}: ${(e as Error).message}`);
                        }
                    }

                    results.push({ id: data[0].id, success: true, duplicate: false });
                } else {
                    results.push({ success: true, duplicate: true });
                }

            } catch (e) {
                console.error(`Error processing turn: ${e.message}`);
                results.push({ success: false, error: e.message });
            }
        }

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

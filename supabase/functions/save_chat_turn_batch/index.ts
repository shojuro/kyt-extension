import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { HuggingFaceClient } from '../_shared/huggingface-client.ts';
import { extractEntities, saveEntitiesWithMentions, savePreferences } from '../_shared/entity-extractor.ts';
import { classifyMemory } from '../_shared/memory-classifier.ts';
import { generateChunkContext } from '../_shared/context-generator.ts';

const MAX_BATCH_SIZE = 50;

// Platform normalization (inline — Deno edge functions can't import from client src/)
const VALID_PLATFORMS = new Set(['chatgpt', 'claude', 'cli', 'claude-code']);
type Platform = 'chatgpt' | 'claude' | 'cli' | 'claude-code';
function normalizePlatform(p: string | undefined): Platform {
  if (p && VALID_PLATFORMS.has(p)) return p as Platform;
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

        // Question detection heuristic — duplicated from background.js INTERROGATIVE_RE
        // (edge functions can't import from extension code)
        // Expanded: imperative request patterns (list/show/find/etc.) + short-content heuristic
        const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;
        function detectIsQuestion(turn: any): boolean {
            if (turn.role !== 'user') return false;
            const text = (turn.content || '').trim();
            if (text.endsWith('?')) return true;
            if (INTERROGATIVE_RE.test(text)) return true;
            // Short user prompts without assertions are likely requests/questions
            if (text.length < 60 && !text.includes('.') && !text.includes('!')) return true;
            return false;
        }

        // Deflection detection — assistant responses that dodge/deflect rather than answer
        const DEFLECTION_RE = /(?:I don'?t (?:have|think|recall|remember|see|know)|I'?m not (?:sure|aware|certain)|I can'?t (?:find|recall|remember|see)|no (?:specific|particular|clear).{0,30}(?:record|memory|data|information)|not (?:aware|certain) (?:of|about|whether))/i;
        function detectDeflection(turn: any): number | null {
            if (turn.role !== 'assistant') return null;
            const text = (turn.content || '').trim();
            if (DEFLECTION_RE.test(text)) return 0.80;
            return null;
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
                    access_count: 0,
                    is_injection: turn.is_injection || false,
                    is_question: detectIsQuestion(turn),
                    deflection: detectDeflection(turn),
                    profile_id: turn.profile_id || turn.user_id,
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
                const isQuestion = detectIsQuestion(turn);

                // Questions are filtered from retrieval — skip expensive AI processing
                // Still save to DB with is_question=true for completeness
                if (isQuestion) {
                    const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();
                    const { data, error } = await supabase
                        .from('chat_turns')
                        .upsert({
                            user_id: turn.user_id,
                            conversation_id: turn.conversation_id,
                            platform: normalizePlatform(turn.platform),
                            content: turn.content,
                            embedding: null,
                            impact_score: 0,
                            intimacy_level: 0,
                            turn_range: '1-1',
                            speakers: [turn.role || 'user'],
                            turn_count: 1,
                            start_timestamp: timestamp,
                            end_timestamp: timestamp,
                            last_accessed: new Date().toISOString(),
                            access_count: 0,
                            is_injection: turn.is_injection || false,
                            is_question: true,
                            deflection: null, // Questions can't be deflections
                            context_generated: true, // Skip backfill too
                            profile_id: turn.profile_id || turn.user_id,
                        }, {
                            onConflict: 'user_id,conversation_id,platform,start_timestamp',
                            ignoreDuplicates: true
                        })
                        .select('id');

                    if (error) throw error;
                    if (data && data.length > 0) {
                        results.push({ id: data[0].id, success: true, duplicate: false });
                    } else {
                        results.push({ success: true, duplicate: true });
                    }
                    continue;
                }

                // 1. Parallel: Classify + Extract entities + Generate context
                // Skip extraction for injection-polluted turns and assistant-only turns
                const skipExtraction = turn.is_injection || (turn.role === 'assistant');
                if (skipExtraction) {
                    console.log(`Skipping extraction: role=${turn.role}, is_injection=${turn.is_injection}`);
                }
                const [classification, entities, contextResult] = await Promise.allSettled([
                    classifyMemory({ content: turn.content }, openaiKey),
                    skipExtraction
                        ? Promise.resolve({ entities: [], preferences: [] })
                        : extractEntities({ content: turn.content, speakers: [turn.role || 'user'] }, openaiKey),
                    // Context generation — no surrounding chunks in inline path (single-turn batch)
                    generateChunkContext({
                        chunkContent: turn.content,
                        platform: normalizePlatform(turn.platform),
                        conversationId: turn.conversation_id,
                        timestamp: turn.timestamp ? new Date(turn.timestamp).toISOString() : undefined,
                    }, openaiKey)
                ]);

                const gravity = classification.status === 'fulfilled'
                    ? classification.value
                    : { impact_score: 0, intimacy_level: 0 };

                // Determine what to embed: contextual content if available, else raw
                // ASYMMETRIC EMBEDDING: stored chunks get context prefix,
                // query embeddings stay raw. DO NOT "fix" this.
                const ctxResult = contextResult.status === 'fulfilled' ? contextResult.value : null;
                const contentToEmbed = ctxResult?.contextualContent || turn.content;
                const [embedding] = await hfClient.generateEmbeddings(contentToEmbed);

                // 2. Save to database with ON CONFLICT handling for deduplication
                const timestamp = turn.timestamp ? new Date(turn.timestamp).getTime() : Date.now();

                const upsertData: Record<string, any> = {
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
                    access_count: 0,
                    is_injection: turn.is_injection || false,
                    is_question: false, // Already verified above (questions short-circuit)
                    deflection: detectDeflection(turn),
                    profile_id: turn.profile_id || turn.user_id,
                };

                // Add contextual retrieval fields if context was generated
                if (ctxResult) {
                    upsertData.contextual_content = ctxResult.contextualContent;
                    upsertData.context_generated = true;
                    upsertData.context_generated_at = new Date().toISOString();
                } else {
                    upsertData.context_generated = false;
                }

                const { data, error } = await supabase
                    .from('chat_turns')
                    .upsert(upsertData, {
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

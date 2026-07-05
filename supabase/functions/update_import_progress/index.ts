import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { securityHeaders } from '../_shared/headers.ts';
import { resolveUserId } from '../_shared/auth-helpers.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    ...securityHeaders(),
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const progress = await req.json();

        // Validate required fields
        if (!progress.id || !progress.user_id || !progress.platform) {
            return new Response(JSON.stringify({ error: 'Missing required fields: id, user_id, platform' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        // Service-role gate: JWT callers write their own progress rows only;
        // service-role callers (benchmark/admin) may write any user's.
        const { userId: authUserId, isServiceRole } = await resolveUserId(
            req.headers.get('Authorization'),
            supabase,
            progress.user_id,
        );
        if (authUserId && !isServiceRole) {
            progress.user_id = authUserId; // pin to the caller
        } else if (!isServiceRole) {
            return new Response(JSON.stringify({ error: 'Authentication required' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Upsert is keyed on id — refuse to hijack a row that belongs to
        // someone else (a caller could otherwise overwrite foreign progress
        // by guessing its uuid).
        const { data: existingRow } = await supabase
            .from('user_history_imports')
            .select('user_id')
            .eq('id', progress.id)
            .maybeSingle();
        if (existingRow && existingRow.user_id !== progress.user_id) {
            return new Response(JSON.stringify({ error: 'Import row not owned by caller' }), {
                status: 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { data, error } = await supabase
            .from('user_history_imports')
            .upsert({
                id: progress.id,
                user_id: progress.user_id,
                platform: progress.platform,
                status: progress.status || 'pending',
                conversations_total: progress.conversations_total || 0,
                conversations_processed: progress.conversations_processed || 0,
                messages_imported: progress.messages_imported || 0,
                messages_skipped: progress.messages_skipped || 0,
                last_conversation_id: progress.last_conversation_id || null,
                estimated_cost_usd: progress.estimated_cost_usd || 0,
                started_at: progress.started_at || null,
                error_message: progress.error_message || null,
                completed_at: progress.status === 'completed' ? new Date().toISOString() : null
            }, {
                onConflict: 'id'
            })
            .select('id');

        if (error) {
            console.error('Failed to update import progress:', error);
            throw error;
        }

        return new Response(JSON.stringify({ success: true, id: data?.[0]?.id }), {
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

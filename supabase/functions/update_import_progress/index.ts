import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { securityHeaders } from '../_shared/headers.ts';

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

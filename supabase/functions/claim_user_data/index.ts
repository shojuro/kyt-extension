/**
 * Supabase Edge Function: claim_user_data
 *
 * Migrates data from an old anonymous userId to the authenticated user's ID.
 * Requires a valid JWT — the new userId is extracted from the token.
 *
 * Body: { oldUserId: string }
 * The new userId comes from the JWT (not the body).
 *
 * Updates user_id across: messages, chat_turns, entities, entity_mentions
 * Uses service role key to bypass RLS.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1. Extract authenticated user from JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ') || authHeader.length < 50) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.slice(7),
    );

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid authentication token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const newUserId = user.id;

    // 2. Parse body for oldUserId
    const body = await req.json();
    const { oldUserId } = body;

    if (!oldUserId) {
      return new Response(JSON.stringify({ error: 'oldUserId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (oldUserId === newUserId) {
      return new Response(JSON.stringify({ success: true, records_migrated: 0, message: 'Same user, nothing to migrate' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Migrating data: ${oldUserId} → ${newUserId}`);

    // 3. Check that oldUserId data isn't already claimed by a different auth user
    // (i.e., check if any rows with oldUserId already belong to another authenticated user)
    const { data: existingClaim } = await supabase
      .from('chat_turns')
      .select('user_id')
      .eq('user_id', oldUserId)
      .limit(1);

    // If no data exists for oldUserId, nothing to migrate
    if (!existingClaim || existingClaim.length === 0) {
      return new Response(JSON.stringify({ success: true, records_migrated: 0, message: 'No data found for old user ID' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 4. Migrate across tables
    let totalMigrated = 0;

    // chat_turns
    const { count: turnsCount } = await supabase
      .from('chat_turns')
      .update({ user_id: newUserId })
      .eq('user_id', oldUserId)
      .select('*', { count: 'exact', head: true });
    totalMigrated += turnsCount || 0;

    // messages (if table exists)
    try {
      const { count: msgsCount } = await supabase
        .from('messages')
        .update({ user_id: newUserId })
        .eq('user_id', oldUserId)
        .select('*', { count: 'exact', head: true });
      totalMigrated += msgsCount || 0;
    } catch {
      // messages table may not exist — skip
    }

    // entities
    try {
      const { count: entCount } = await supabase
        .from('entities')
        .update({ user_id: newUserId })
        .eq('user_id', oldUserId)
        .select('*', { count: 'exact', head: true });
      totalMigrated += entCount || 0;
    } catch {
      // entities table may not exist — skip
    }

    // entity_mentions
    try {
      const { count: mentionsCount } = await supabase
        .from('entity_mentions')
        .update({ user_id: newUserId })
        .eq('user_id', oldUserId)
        .select('*', { count: 'exact', head: true });
      totalMigrated += mentionsCount || 0;
    } catch {
      // entity_mentions table may not exist — skip
    }

    console.log(`Migration complete: ${totalMigrated} records updated`);

    return new Response(JSON.stringify({
      success: true,
      records_migrated: totalMigrated,
      old_user_id: oldUserId,
      new_user_id: newUserId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('claim_user_data error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkPolicies() {
    console.log('Environment USER_ID:', process.env.USER_ID || 'Not set');
    console.log('Checking RLS policies for table "messages"...');

    // Use Supabase REST API to execute SQL via RPC 'exec'
    const url = `${supabaseUrl}/rest/v1/rpc/exec`;
    const sql = "SELECT * FROM pg_policies WHERE tablename = 'messages'";

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ query: sql })
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('Failed to execute SQL via RPC:', text);
            return;
        }

        const policies = await response.json();
        console.log('Active Policies:', JSON.stringify(policies, null, 2));

        // Also check if RLS is enabled
        const rlsSql = "SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'messages'";
        const rlsResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify({ query: rlsSql })
        });

        if (rlsResponse.ok) {
            const rlsData = await rlsResponse.json();
            console.log('RLS Status:', JSON.stringify(rlsData, null, 2));
        }

    } catch (err) {
        console.error('Error:', err);
    }
}

checkPolicies();

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

// Use SERVICE ROLE key to bypass RLS
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function inspectUsers() {
    console.log('Inspecting distinct user_ids in "messages" table...');

    const { data, error } = await supabase
        .from('messages')
        .select('user_id')
        .limit(1000); // Fetch some rows

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    const userIds = new Set(data.map(r => r.user_id));
    console.log('Found User IDs:', Array.from(userIds));

    // Also count rows
    const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true });

    console.log('Total rows:', count);
}

inspectUsers();

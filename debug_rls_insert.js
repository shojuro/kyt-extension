import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
}

// Use ANON key to respect RLS
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testInsert(userId, label) {
    console.log(`\nTesting insert for ${label} (User ID: ${userId})...`);

    const messageId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const payload = {
        content: 'RLS Test Message',
        role: 'user',
        timestamp: Date.now(),
        message_id: messageId,
        user_id: userId,
        source: 'test_script'
    };

    const { data, error } = await supabase
        .from('messages')
        .insert([payload])
        .select();

    if (error) {
        console.error(`❌ Failed: ${error.message}`);
        if (error.message.includes('violates row-level security')) {
            console.error('   -> RLS Violation confirmed.');
        }
    } else {
        console.log('✅ Success! Row inserted.');
        // Clean up
        await supabase.from('messages').delete().eq('message_id', messageId);
    }
}

async function runTests() {
    const tempId = '00000000-0000-0000-0000-000000000000';
    const customId = process.env.USER_ID || '0499c405-3bff-4901-bc94-d5d0a0c301e4';
    const randomId = '11111111-1111-1111-1111-111111111111';

    await testInsert(tempId, 'Temp User');
    await testInsert(customId, 'Custom User');
    await testInsert(randomId, 'Random User (Should Fail)');
}

runTests();

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ Missing required environment variables in .env');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function verifyIngestion() {
    try {
        console.log('🔍 Verifying IDE Chat Ingestion...');

        // Query for messages with source 'cli'
        const { data, error } = await supabase
            .from('messages')
            .select('content, role, timestamp, source')
            .eq('source', 'cli')
            .order('timestamp', { ascending: true });

        if (error) {
            throw new Error(`Supabase query failed: ${error.message}`);
        }

        if (data.length === 0) {
            console.warn('⚠️ No messages found with source "cli". Ingestion might have failed.');
        } else {
            console.log(`✅ Found ${data.length} messages from IDE chat:`);
            data.forEach((msg, i) => {
                console.log(`   ${i + 1}. [${msg.role}] ${msg.content.substring(0, 50)}...`);
            });
        }

    } catch (error) {
        console.error('❌ Verification failed:', error);
        process.exit(1);
    }
}

verifyIngestion();

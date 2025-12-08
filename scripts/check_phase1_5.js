import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ Missing required environment variables in .env');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function verifyAssistantCapture() {
    try {
        console.log('🔍 Verifying Phase 1.5: Assistant Response Capture...');

        // 1. Check for recent assistant messages
        // Note: Schema uses 'source' column, not 'platform'
        const { data: messages, error } = await supabase
            .from('messages')
            .select('content, role, source, timestamp, conversation_id')
            .eq('role', 'assistant')
            .order('timestamp', { ascending: false })
            .limit(10);

        if (error) throw error;

        if (messages.length === 0) {
            console.warn('⚠️ No assistant messages found. Have you run the manual browser tests yet?');
            return;
        }

        console.log(`✅ Found ${messages.length} recent assistant messages:`);

        // Group by source (platform)
        const bySource = messages.reduce((acc, msg) => {
            const src = msg.source || 'unknown';
            acc[src] = (acc[src] || 0) + 1;
            return acc;
        }, {});

        console.log('📊 Capture Stats (Last 10):', bySource);

        messages.forEach((msg, i) => {
            const src = msg.source || 'unknown';
            const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
            console.log(`   ${i + 1}. [${src}] ${preview}... (${msg.content.length} chars)`);
        });

        // 2. Check for "Rich" Content (Length > 100 chars)
        const richMessages = messages.filter(m => m.content.length > 100);
        console.log(`\n💎 Rich Content Check: ${richMessages.length}/${messages.length} messages > 100 chars`);

        if (richMessages.length > 0) {
            console.log('   ✅ Assistant responses are being captured with content!');
        } else {
            console.warn('   ⚠️ Assistant messages are short. Check if capture is cutting off early.');
        }

    } catch (error) {
        console.error('❌ Verification failed:', error);
        process.exit(1);
    }
}

verifyAssistantCapture();

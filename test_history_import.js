import 'dotenv/config';
import { HistoryImporter } from './src/history-import/index.js';
import fs from 'fs';

// Mock chrome API
global.chrome = {
    storage: {
        local: {
            get: async () => ({}),
            set: async () => { },
            remove: async () => { }
        }
    },
    runtime: {
        sendMessage: async () => { }
    }
};

// Mock fetch for ChatGPT/Claude APIs (we don't want to hit real APIs in this test)
// But we DO want to hit Supabase.
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
    // Mock Supabase Edge Function
    if (url.includes('save_chat_turn_batch')) {
        return {
            ok: true,
            json: async () => ({ success: true })
        };
    }

    // Mock Database: user_history_imports
    if (url.includes('user_history_imports')) {
        if (options.method === 'POST') {
            // Update/Insert
            const body = JSON.parse(options.body);
            global.mockDb = global.mockDb || {};
            global.mockDb[body.id] = body;
            return { ok: true };
        } else {
            // GET (Query)
            // Simple mock: return all items in mockDb that match basic criteria
            const items = Object.values(global.mockDb || {});
            // Filter logic would be complex to mock fully, but for this test we can just return what we have
            // if we assume only one import is happening.

            // If checking for completed
            if (url.includes('status=eq.completed')) {
                const completed = items.filter(i => i.status === 'completed');
                return {
                    ok: true,
                    json: async () => completed
                };
            }

            // If checking for in_progress
            if (url.includes('status=eq.in_progress')) {
                const inProgress = items.filter(i => i.status === 'in_progress');
                return {
                    ok: true,
                    json: async () => inProgress
                };
            }

            return { ok: true, json: async () => [] };
        }
    }

    if (url.includes('supabase')) {
        return originalFetch(url, options);
    }

    // Mock ChatGPT API
    if (url.includes('chatgpt.com/backend-api/conversations')) {
        // Check offset to prevent infinite loop
        if (url.includes('offset=0')) {
            return {
                ok: true,
                json: async () => ({
                    items: [
                        { id: 'conv1', title: 'Test Conversation 1', update_time: Date.now() / 1000 },
                        { id: 'conv2', title: 'Test Conversation 2', update_time: Date.now() / 1000 }
                    ]
                })
            };
        } else {
            return {
                ok: true,
                json: async () => ({ items: [] })
            };
        }
    }

    if (url.includes('chatgpt.com/backend-api/conversation/')) {
        return {
            ok: true,
            json: async () => ({
                mapping: {
                    'node1': {
                        message: {
                            id: 'msg1',
                            author: { role: 'user' },
                            create_time: Date.now() / 1000,
                            content: { parts: ['Hello world'] }
                        }
                    },
                    'node2': {
                        message: {
                            id: 'msg2',
                            author: { role: 'assistant' },
                            create_time: Date.now() / 1000,
                            content: { parts: ['Hi there!'] }
                        }
                    }
                }
            })
        };
    }

    return { ok: false, status: 404 };
};

async function runTest() {
    console.log('🧪 Starting History Import Test...');

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service key for test to bypass RLS if needed, or anon key
    const userId = '00000000-0000-0000-0000-000000000000'; // Test user

    if (!supabaseUrl || !supabaseKey) {
        console.error('❌ Missing Supabase credentials in .env');
        return;
    }

    const importer = new HistoryImporter(supabaseUrl, supabaseKey, userId);

    // 1. Check status (should be empty or previous test)
    console.log('1️⃣ Checking status...');
    const status = await importer.checkImportStatus('chatgpt');
    console.log('Status:', status);

    // 2. Start Import
    console.log('2️⃣ Starting import...');
    const result = await importer.startImport(
        'chatgpt',
        (progress) => {
            console.log(`   Progress: ${progress.messagesImported} msgs (${progress.status})`);
        },
        async () => {
            console.log('   ⚠️ Fallback requested (not expected in this test)');
            return null;
        }
    );

    fs.writeFileSync('import_result.json', JSON.stringify(result, null, 2));
    console.log('Import Result written to import_result.json');

    if (result.success && result.messagesImported > 0) {
        console.log('✅ Import successful!');
    } else {
        console.error('❌ Import failed or no messages imported');
    }

    // 3. Verify "Reinstall Detection" (Check status again)
    console.log('3️⃣ Verifying Reinstall Detection...');
    const statusAfter = await importer.checkImportStatus('chatgpt');
    console.log('Status After:', statusAfter);

    if (statusAfter.hasCompletedImport) {
        console.log('✅ Reinstall detection working (found completed import)');
    } else {
        console.error('❌ Reinstall detection failed');
    }
}

runTest().catch(console.error);

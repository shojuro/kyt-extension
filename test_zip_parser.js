import 'dotenv/config';
import JSZip from 'jszip';

// Make JSZip available globally for the wrapper
globalThis.JSZip = JSZip;

// Now import our parser
import { parseZipExport } from './src/history-import/zip-parser.js';

async function createMockChatGPTZip() {
    const zip = new JSZip();

    const conversations = [
        {
            id: 'conv-001',
            title: 'Test Conversation 1',
            create_time: Date.now() / 1000 - 86400, // 1 day ago
            mapping: {
                'node-1': {
                    message: {
                        id: 'msg-001',
                        author: { role: 'user' },
                        create_time: Date.now() / 1000 - 86400,
                        content: { parts: ['Hello, this is a test message from user'] }
                    }
                },
                'node-2': {
                    message: {
                        id: 'msg-002',
                        author: { role: 'assistant' },
                        create_time: Date.now() / 1000 - 86300,
                        content: { parts: ['Hello! How can I help you today?'] },
                        metadata: { model_slug: 'gpt-4' }
                    }
                },
                'node-3': {
                    message: {
                        id: 'msg-003',
                        author: { role: 'system' },  // Should be skipped
                        create_time: Date.now() / 1000 - 86200,
                        content: { parts: ['System message'] }
                    }
                }
            }
        },
        {
            id: 'conv-002',
            title: 'Test Conversation 2',
            create_time: Date.now() / 1000 - 172800, // 2 days ago
            mapping: {
                'node-4': {
                    message: {
                        id: 'msg-004',
                        author: { role: 'user' },
                        create_time: Date.now() / 1000 - 172800,
                        content: { parts: ['Another test message'] }
                    }
                },
                'node-5': {
                    message: {
                        id: 'msg-005',
                        author: { role: 'assistant' },
                        create_time: Date.now() / 1000 - 172700,
                        content: { parts: ['Sure, I can help with that!'] }
                    }
                }
            }
        }
    ];

    zip.file('conversations.json', JSON.stringify(conversations));

    // Generate as ArrayBuffer (simulates File object)
    return await zip.generateAsync({ type: 'arraybuffer' });
}

async function createMockClaudeZip() {
    const zip = new JSZip();

    const conversations = [
        {
            uuid: 'claude-conv-001',
            name: 'Claude Test Chat',
            chat_messages: [
                {
                    uuid: 'claude-msg-001',
                    sender: 'human',
                    text: 'Hello Claude!',
                    created_at: new Date(Date.now() - 86400000).toISOString()
                },
                {
                    uuid: 'claude-msg-002',
                    sender: 'assistant',
                    text: 'Hello! How can I assist you today?',
                    created_at: new Date(Date.now() - 86300000).toISOString()
                }
            ]
        }
    ];

    zip.file('conversations.json', JSON.stringify(conversations));

    return await zip.generateAsync({ type: 'arraybuffer' });
}

async function runTests() {
    console.log('🧪 Testing ZIP Parser...\n');

    let passed = 0;
    let failed = 0;

    // Test 1: ChatGPT ZIP parsing
    console.log('📦 Test 1: ChatGPT ZIP Parser');
    try {
        const chatgptZip = await createMockChatGPTZip();
        const messages = await parseZipExport(chatgptZip, 'chatgpt');

        console.log(`   Found ${messages.length} messages`);

        // Verify expected results
        if (messages.length !== 4) {
            throw new Error(`Expected 4 messages, got ${messages.length}`);
        }

        // Check message structure
        const userMsgs = messages.filter(m => m.role === 'user');
        const assistantMsgs = messages.filter(m => m.role === 'assistant');

        if (userMsgs.length !== 2) {
            throw new Error(`Expected 2 user messages, got ${userMsgs.length}`);
        }
        if (assistantMsgs.length !== 2) {
            throw new Error(`Expected 2 assistant messages, got ${assistantMsgs.length}`);
        }

        // Check platform is set
        if (messages[0].platform !== 'chatgpt') {
            throw new Error(`Expected platform 'chatgpt', got '${messages[0].platform}'`);
        }

        // Check content extraction
        if (!messages[0].content.includes('test message')) {
            throw new Error('Content not extracted correctly');
        }

        console.log('   ✅ PASSED: ChatGPT ZIP parsing works correctly');
        console.log(`      - User messages: ${userMsgs.length}`);
        console.log(`      - Assistant messages: ${assistantMsgs.length}`);
        console.log(`      - System messages filtered: YES`);
        passed++;
    } catch (err) {
        console.log(`   ❌ FAILED: ${err.message}`);
        failed++;
    }

    // Test 2: Claude ZIP parsing
    console.log('\n📦 Test 2: Claude ZIP Parser');
    try {
        const claudeZip = await createMockClaudeZip();
        const messages = await parseZipExport(claudeZip, 'claude');

        console.log(`   Found ${messages.length} messages`);

        if (messages.length !== 2) {
            throw new Error(`Expected 2 messages, got ${messages.length}`);
        }

        // Check role mapping (human -> user)
        const userMsgs = messages.filter(m => m.role === 'user');
        if (userMsgs.length !== 1) {
            throw new Error(`Expected 1 user message (mapped from human), got ${userMsgs.length}`);
        }

        // Check platform
        if (messages[0].platform !== 'claude') {
            throw new Error(`Expected platform 'claude', got '${messages[0].platform}'`);
        }

        console.log('   ✅ PASSED: Claude ZIP parsing works correctly');
        console.log(`      - Human -> User mapping: YES`);
        console.log(`      - Platform set correctly: YES`);
        passed++;
    } catch (err) {
        console.log(`   ❌ FAILED: ${err.message}`);
        failed++;
    }

    // Test 3: Missing conversations.json
    console.log('\n📦 Test 3: Error handling - Missing conversations.json');
    try {
        const emptyZip = new JSZip();
        const zipBuffer = await emptyZip.generateAsync({ type: 'arraybuffer' });

        try {
            await parseZipExport(zipBuffer, 'chatgpt');
            throw new Error('Should have thrown an error for missing file');
        } catch (innerErr) {
            if (innerErr.message.includes('conversations.json not found')) {
                console.log('   ✅ PASSED: Correctly throws error for missing conversations.json');
                passed++;
            } else {
                throw innerErr;
            }
        }
    } catch (err) {
        console.log(`   ❌ FAILED: ${err.message}`);
        failed++;
    }

    // Test 4: Message sorting by timestamp
    console.log('\n📦 Test 4: Messages sorted by timestamp');
    try {
        const chatgptZip = await createMockChatGPTZip();
        const messages = await parseZipExport(chatgptZip, 'chatgpt');

        let isSorted = true;
        for (let i = 1; i < messages.length; i++) {
            if (messages[i].timestamp < messages[i-1].timestamp) {
                isSorted = false;
                break;
            }
        }

        if (!isSorted) {
            throw new Error('Messages are not sorted by timestamp');
        }

        console.log('   ✅ PASSED: Messages are sorted by timestamp (oldest first)');
        passed++;
    } catch (err) {
        console.log(`   ❌ FAILED: ${err.message}`);
        failed++;
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50));

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test runner failed:', err);
    process.exit(1);
});

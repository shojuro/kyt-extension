/**
 * Test Queue Logic
 * Run with: node tests/test_queue_logic.js
 */

import { LocalQueueStorage } from '../src/storage/local-queue.js';
import { QueueProcessor } from '../src/background/queue-processor.js';
import { deriveKey } from '../src/utils/crypto.js';
import assert from 'assert';

// Mock Web Crypto API
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

// Mock chrome.storage.local
const mockStorage = {
    data: {},
    get: async (keys) => {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
            result[key] = mockStorage.data[key];
        }
        return result;
    },
    set: async (items) => {
        Object.assign(mockStorage.data, items);
    },
    remove: async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
            delete mockStorage.data[key];
        }
    }
};

globalThis.chrome = {
    storage: {
        local: mockStorage
    }
};

async function testQueueLogic() {
    console.log('📦 Testing Queue Logic...');

    const secret = 'sk-test-key';
    const cryptoKey = await deriveKey(secret);
    const localQueue = new LocalQueueStorage();

    try {
        // 1. Enqueue
        console.log('   Testing Enqueue...');
        const msg1 = { id: 'msg_1', content: 'Test 1', timestamp: 1000 };
        await localQueue.enqueue(msg1, cryptoKey);

        const stored = await mockStorage.get(['kyt_pending_sync_queue']);
        assert.strictEqual(stored.kyt_pending_sync_queue.length, 1);
        assert.ok(stored.kyt_pending_sync_queue[0].ciphertext, 'Should be encrypted');

        // 2. Dequeue
        console.log('   Testing Dequeue...');
        const dequeued = await localQueue.dequeueAll(cryptoKey);
        assert.strictEqual(dequeued.length, 1);
        assert.strictEqual(dequeued[0].content, 'Test 1');

        // 3. Overflow
        console.log('   Testing Overflow...');
        await localQueue.clear();

        // Fill with 105 items (limit is 100)
        for (let i = 0; i < 105; i++) {
            await localQueue.enqueue({
                id: `msg_${i}`,
                content: `Test ${i}`,
                timestamp: 1000 + i
            }, cryptoKey);
        }

        const overflowStored = await mockStorage.get(['kyt_pending_sync_queue']);
        assert.strictEqual(overflowStored.kyt_pending_sync_queue.length, 100, 'Should cap at 100');

        // Should have removed oldest (msg_0 to msg_4)
        const firstItem = await localQueue.dequeueAll(cryptoKey);
        // The first item in the queue should be msg_5 (since 0-4 were dropped)
        // Wait, dequeueAll returns all.
        // Let's check the ID of the first item returned.
        // Since we added in order, and it sorts by timestamp on overflow...
        // msg_0 has timestamp 1000, msg_104 has 1104.
        // Dropped 5 oldest -> msg_0...msg_4 dropped.
        // First one should be msg_5.
        assert.strictEqual(firstItem[0].id, 'msg_5');

        console.log('✅ Queue Logic Tests Passed!');
    } catch (error) {
        console.error('❌ Queue Logic Tests Failed:', error);
        process.exit(1);
    }
}

testQueueLogic();

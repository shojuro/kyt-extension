/**
 * Test Crypto Utilities
 * Run with: node tests/test_crypto.js
 */

import { deriveKey, encrypt, decrypt } from '../src/utils/crypto.js';
import assert from 'assert';

// Mock Web Crypto API for Node.js environment
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

async function testCrypto() {
    console.log('🔐 Testing Crypto Utilities...');

    const secret = 'sk-test-1234567890abcdef';
    const data = JSON.stringify({ message: 'Hello, World!', id: 123 });

    try {
        // 1. Derive Key
        console.log('   Deriving key...');
        const key = await deriveKey(secret);
        assert.ok(key, 'Key should be derived');

        // 2. Encrypt
        console.log('   Encrypting data...');
        const { ciphertext, iv } = await encrypt(data, key);
        assert.ok(ciphertext, 'Ciphertext should exist');
        assert.ok(iv, 'IV should exist');
        console.log(`   Ciphertext: ${ciphertext.substring(0, 20)}...`);

        // 3. Decrypt
        console.log('   Decrypting data...');
        const decrypted = await decrypt(ciphertext, iv, key);
        assert.strictEqual(decrypted, data, 'Decrypted data should match original');

        // 4. Wrong Key Test
        console.log('   Testing wrong key...');
        const wrongKey = await deriveKey('wrong-secret');
        try {
            await decrypt(ciphertext, iv, wrongKey);
            assert.fail('Should have failed with wrong key');
        } catch (e) {
            console.log('   ✅ Correctly failed with wrong key');
        }

        console.log('✅ Crypto Tests Passed!');
    } catch (error) {
        console.error('❌ Crypto Tests Failed:', error);
        process.exit(1);
    }
}

testCrypto();

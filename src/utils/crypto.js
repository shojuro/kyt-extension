/**
 * KYT Crypto Utilities
 * 
 * Provides AES-GCM encryption/decryption and PBKDF2 key derivation.
 * Used for securing the local retry queue.
 */

// Constants
const PBKDF2_ITERATIONS = 100000;
const SALT_STRING = 'kyt_local_storage_salt'; // Fixed salt for deterministic key derivation from API key
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

/**
 * Derive an encryption key from a secret (e.g., OpenAI API Key)
 * Uses PBKDF2 to generate a deterministic key from the secret.
 * 
 * @param {string} secret - The secret to derive the key from
 * @returns {Promise<CryptoKey>} The derived CryptoKey
 */
export async function deriveKey(secret) {
    if (!secret) {
        throw new Error('Cannot derive key: secret is empty');
    }

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode(SALT_STRING),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: ALGORITHM, length: KEY_LENGTH },
        false, // Key is not extractable
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data using AES-GCM
 * 
 * @param {string} data - The string data to encrypt
 * @param {CryptoKey} key - The encryption key
 * @returns {Promise<{ciphertext: string, iv: string}>} Encrypted data and IV (base64)
 */
export async function encrypt(data, key) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);

    // Generate random IV (12 bytes for AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedBuffer = await crypto.subtle.encrypt(
        {
            name: ALGORITHM,
            iv: iv
        },
        key,
        encodedData
    );

    return {
        ciphertext: arrayBufferToBase64(encryptedBuffer),
        iv: arrayBufferToBase64(iv)
    };
}

/**
 * Decrypt data using AES-GCM
 * 
 * @param {string} ciphertext - The encrypted data (base64)
 * @param {string} iv - The IV used for encryption (base64)
 * @param {CryptoKey} key - The encryption key
 * @returns {Promise<string>} The decrypted string
 */
export async function decrypt(ciphertext, iv, key) {
    const decoder = new TextDecoder();
    const encryptedData = base64ToArrayBuffer(ciphertext);
    const ivData = base64ToArrayBuffer(iv);

    try {
        const decryptedBuffer = await crypto.subtle.decrypt(
            {
                name: ALGORITHM,
                iv: ivData
            },
            key,
            encryptedData
        );

        return decoder.decode(decryptedBuffer);
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

// Helper: ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Helper: Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// ============================================
// SECURE API KEY ENCRYPTION (Random Salt)
// ============================================

/**
 * Generate a random salt for PBKDF2
 * @returns {Uint8Array} Random 16-byte salt
 */
export function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Derive a key from password with custom salt
 * @param {string} password - User's master password
 * @param {Uint8Array} salt - Random salt (16 bytes)
 * @returns {Promise<CryptoKey>} Derived encryption key
 */
export async function deriveKeyFromPassword(password, salt) {
    if (!password) {
        throw new Error('Password cannot be empty');
    }

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: ALGORITHM, length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt API configuration with password (includes random salt)
 * @param {Object} config - API configuration object
 * @param {string} password - User's master password
 * @returns {Promise<{salt: string, iv: string, ciphertext: string}>} Encrypted config bundle
 */
export async function encryptConfig(config, password) {
    // Generate random salt
    const salt = generateSalt();

    // Derive key from password + salt
    const key = await deriveKeyFromPassword(password, salt);

    // Encrypt config JSON
    const configJson = JSON.stringify(config);
    const { ciphertext, iv } = await encrypt(configJson, key);

    return {
        salt: arrayBufferToBase64(salt),
        iv: iv,
        ciphertext: ciphertext
    };
}

/**
 * Decrypt API configuration with password
 * @param {string} salt - Base64-encoded salt
 * @param {string} iv - Base64-encoded IV
 * @param {string} ciphertext - Base64-encoded encrypted config
 * @param {string} password - User's master password
 * @returns {Promise<Object>} Decrypted config object
 */
export async function decryptConfig(salt, iv, ciphertext, password) {
    // Convert salt from base64
    const saltBytes = new Uint8Array(base64ToArrayBuffer(salt));

    // Derive key from password + salt
    const key = await deriveKeyFromPassword(password, saltBytes);

    // Decrypt config
    const configJson = await decrypt(ciphertext, iv, key);

    return JSON.parse(configJson);
}

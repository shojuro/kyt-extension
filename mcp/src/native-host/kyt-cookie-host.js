#!/usr/bin/env node
/**
 * K.Y.T. Native Messaging Host — Cookie Bridge
 *
 * Receives Google auth cookies from the Chrome extension via native messaging,
 * encrypts them with the passphrase from mcp/.env, and writes to
 * ~/.kyt/notebooklm-auth.enc (same format as notebooklm-auth.js).
 *
 * Protocol: Chrome native messaging (4-byte LE length prefix + JSON).
 * Lifecycle: Chrome launches per sendNativeMessage() call, terminated after response.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, scryptSync, createCipheriv } from 'crypto';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KYT_DIR = join(homedir(), '.kyt');
const AUTH_PATH = join(KYT_DIR, 'notebooklm-auth.enc');

// --- Encryption (must match notebooklm-auth.js exactly) ---
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

function encryptData(data, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

// --- Load passphrase from mcp/.env ---
function loadPassphrase() {
  // Try mcp/.env first (2 levels up from native-host/)
  const envPath = join(__dirname, '..', '..', '.env');
  if (!existsSync(envPath)) {
    // Fall back to environment variable
    if (process.env.NOTEBOOKLM_PASSPHRASE) {
      return process.env.NOTEBOOKLM_PASSPHRASE;
    }
    throw new Error(`Passphrase not found: ${envPath} missing and NOTEBOOKLM_PASSPHRASE env var not set`);
  }
  const content = readFileSync(envPath, 'utf8');
  const match = content.match(/^NOTEBOOKLM_PASSPHRASE=(.+)$/m);
  if (!match) throw new Error('NOTEBOOKLM_PASSPHRASE not found in mcp/.env');
  return match[1].trim();
}

// --- Native messaging I/O ---
function readMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let msgLen = null;

    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (msgLen === null && buffer.length >= 4) {
        msgLen = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }

      if (msgLen !== null && buffer.length >= msgLen) {
        resolve(JSON.parse(buffer.subarray(0, msgLen).toString('utf8')));
      }
    });

    process.stdin.on('error', reject);
    // Timeout after 10s in case Chrome doesn't send anything
    setTimeout(() => reject(new Error('Read timeout')), 10_000);
  });
}

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

// --- Main ---
try {
  const msg = await readMessage();

  if (msg.action === 'export_cookies') {
    if (!Array.isArray(msg.cookies) || msg.cookies.length === 0) {
      writeMessage({ success: false, error: 'No cookies provided' });
      process.exit(0);
    }

    const passphrase = loadPassphrase();

    if (!existsSync(KYT_DIR)) mkdirSync(KYT_DIR, { recursive: true });

    const data = { cookies: msg.cookies, savedAt: new Date().toISOString() };
    const encrypted = encryptData(data, passphrase);
    writeFileSync(AUTH_PATH, encrypted, 'utf8');

    writeMessage({
      success: true,
      cookieCount: msg.cookies.length,
      savedAt: data.savedAt,
    });
  } else if (msg.action === 'ping') {
    writeMessage({ success: true, status: 'alive' });
  } else {
    writeMessage({ success: false, error: `Unknown action: ${msg.action}` });
  }
} catch (e) {
  try {
    writeMessage({ success: false, error: e.message });
  } catch {
    // Can't write to stdout — just exit
  }
}

process.exit(0);

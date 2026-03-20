#!/usr/bin/env node
/**
 * K.Y.T. Cookie Bridge Server
 *
 * Tiny HTTP server that accepts Google auth cookies from the Chrome extension
 * and encrypts them for the MCP server's NotebookLM client.
 *
 * Runs on localhost:19418 (KYT on phone keypad = 598, + 1 for auth = 19418).
 * Cross-platform: works on native Linux, macOS, and WSL (extension on Windows
 * Chrome hits localhost which WSL maps to the Linux side).
 *
 * Endpoints:
 *   POST /cookies  — receive and encrypt cookies
 *   GET  /status   — check auth freshness
 *   GET  /health   — liveness check
 *
 * Usage:
 *   node kyt-cookie-server.js                    # foreground
 *   node kyt-cookie-server.js &                  # background
 *   node kyt-cookie-server.js --port 19418       # custom port
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KYT_DIR = join(homedir(), '.kyt');
const AUTH_PATH = join(KYT_DIR, 'notebooklm-auth.enc');
const DEFAULT_PORT = 19418;

// --- Encryption (must match notebooklm-auth.js exactly) ---
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

function decryptData(base64Data, passphrase) {
  const packed = Buffer.from(base64Data, 'base64');
  const salt = packed.subarray(0, SALT_LEN);
  const iv = packed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = packed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
  const ciphertext = packed.subarray(SALT_LEN + IV_LEN + 16);
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

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

// --- Load passphrase ---
function loadPassphrase() {
  const envPath = join(__dirname, '..', '..', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^NOTEBOOKLM_PASSPHRASE=(.+)$/m);
    if (match) return match[1].trim();
  }
  if (process.env.NOTEBOOKLM_PASSPHRASE) {
    return process.env.NOTEBOOKLM_PASSPHRASE;
  }
  throw new Error('NOTEBOOKLM_PASSPHRASE not found in mcp/.env or environment');
}

// --- CORS headers (extension runs on chrome-extension:// origin) ---
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// --- Request handler ---
async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'kyt-cookie-bridge' }));
    return;
  }

  // Auth status
  if (url.pathname === '/status' && req.method === 'GET') {
    let authAge = null;
    let authExists = existsSync(AUTH_PATH);
    if (authExists) {
      const stat = statSync(AUTH_PATH);
      authAge = Math.round((Date.now() - stat.mtimeMs) / 1000);
    }
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authExists,
      authAge: authAge !== null ? `${authAge}s` : null,
      authStale: authAge !== null ? authAge > 3600 : true,
      authPath: AUTH_PATH,
    }));
    return;
  }

  // Cookie import
  if (url.pathname === '/cookies' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { cookies } = JSON.parse(body);

      if (!Array.isArray(cookies) || cookies.length === 0) {
        res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No cookies provided' }));
        return;
      }

      const passphrase = loadPassphrase();
      if (!existsSync(KYT_DIR)) mkdirSync(KYT_DIR, { recursive: true });

      // Merge with existing cookies (don't overwrite, add/update)
      let existingCookies = [];
      if (existsSync(AUTH_PATH)) {
        try {
          const existing = decryptData(readFileSync(AUTH_PATH, 'utf8').trim(), passphrase);
          existingCookies = existing.cookies || [];
          process.stderr.write(`[kyt-cookie-bridge] Merge: ${existingCookies.length} existing cookies loaded\n`);
        } catch (decErr) {
          process.stderr.write(`[kyt-cookie-bridge] Merge decrypt failed: ${decErr.message}\n`);
        }
      }
      const byName = new Map(existingCookies.map(c => [c.name, c]));
      for (const c of cookies) byName.set(c.name, c);
      const mergedCookies = [...byName.values()];

      const data = { cookies: mergedCookies, savedAt: new Date().toISOString() };
      const encrypted = encryptData(data, passphrase);
      writeFileSync(AUTH_PATH, encrypted, 'utf8');

      const msg = `Saved ${cookies.length} cookies at ${data.savedAt}`;
      process.stderr.write(`[kyt-cookie-bridge] ${msg}\n`);

      res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, cookieCount: cookies.length, savedAt: data.savedAt }));
    } catch (err) {
      res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// --- Start server ---
const port = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || DEFAULT_PORT, 10);

const server = createServer(handleRequest);
// Bind 0.0.0.0 so Windows Chrome can reach WSL2 via localhost proxy
server.listen(port, '0.0.0.0', () => {
  process.stderr.write(`[kyt-cookie-bridge] Listening on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[kyt-cookie-bridge] Endpoints: POST /cookies, GET /status, GET /health\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

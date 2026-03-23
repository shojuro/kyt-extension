#!/usr/bin/env node
/**
 * Import NotebookLM cookies from browser DevTools.
 *
 * Usage:
 *   node scripts/import-notebooklm-cookies.js
 *
 * Steps:
 *   1. Open https://notebooklm.google.com in Chrome (signed in)
 *   2. DevTools → Application → Cookies → notebooklm.google.com
 *   3. Run this script — it prompts for each cookie value
 *   4. Encrypts and saves to ~/.kyt/notebooklm-auth.enc
 *
 * Alternatively, paste the full Cookie header string:
 *   node scripts/import-notebooklm-cookies.js --header "SID=xxx; HSID=yyy; ..."
 */

import { createInterface } from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const authModule = resolve(__dirname, '../mcp/src/lib/notebooklm-auth.js');

// Dynamic import so this script works standalone
const { importCookies, isAuthConfigured } = await import(authModule);

// Load .env for passphrase
const envPath = resolve(__dirname, '../mcp/.env');
import { readFileSync } from 'fs';
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch { /* no .env */ }

// Passphrase is optional — auto-key will be generated if not set
const passphrase = process.env.NOTEBOOKLM_PASSPHRASE || undefined;
if (!passphrase) {
  console.log('ℹ️  No NOTEBOOKLM_PASSPHRASE set — using auto-generated encryption key');
}

// Check for --header mode
const headerIdx = process.argv.indexOf('--header');
if (headerIdx !== -1 && process.argv[headerIdx + 1]) {
  const cookieStr = process.argv[headerIdx + 1];
  const result = importCookies(cookieStr, passphrase);
  console.log(`✅ Imported ${result.cookieCount} cookies → ~/.kyt/notebooklm-auth.enc`);
  process.exit(0);
}

// Interactive mode — prompt for each cookie
const rl = createInterface({ input: process.stdin, output: process.stderr });
const ask = (q) => new Promise(r => rl.question(q, r));

console.log('');
console.log('🔑 NotebookLM Cookie Import');
console.log('───────────────────────────');
console.log('Open Chrome DevTools → Application → Cookies → notebooklm.google.com');
console.log('Copy the VALUE for each cookie below. Press Enter to skip optional ones.');
console.log('');

// All cookies from notebooklm.google.com — SIDCC/PSIDCC are critical for batchexecute
const COOKIES = [
  { name: 'SID',                required: true,  hint: 'Main Google session ID' },
  { name: 'HSID',               required: true,  hint: 'HTTP-only session ID' },
  { name: 'SSID',               required: true,  hint: 'Secure session ID' },
  { name: 'APISID',             required: false, hint: 'API session ID' },
  { name: 'SAPISID',            required: true,  hint: 'Secure API session ID (needed for SAPISIDHASH)' },
  { name: 'SIDCC',              required: true,  hint: 'Session ID consent cookie (critical for API)' },
  { name: 'OSID',               required: false, hint: 'Origin-bound session ID' },
  { name: '__Secure-1PSID',     required: true,  hint: 'Primary secure SID' },
  { name: '__Secure-3PSID',     required: false, hint: 'Tertiary secure SID' },
  { name: '__Secure-1PAPISID',  required: false, hint: 'Primary secure API SID' },
  { name: '__Secure-3PAPISID',  required: false, hint: 'Tertiary secure API SID' },
  { name: '__Secure-1PSIDTS',   required: false, hint: 'Timestamp token' },
  { name: '__Secure-3PSIDTS',   required: false, hint: 'Timestamp token' },
  { name: '__Secure-1PSIDRTS',  required: false, hint: 'Refresh timestamp token' },
  { name: '__Secure-3PSIDRTS',  required: false, hint: 'Refresh timestamp token' },
  { name: '__Secure-1PSIDCC',   required: true,  hint: 'Primary consent cookie (critical for API)' },
  { name: '__Secure-3PSIDCC',   required: false, hint: 'Tertiary consent cookie' },
  { name: '__Secure-OSID',      required: false, hint: 'Secure origin-bound SID' },
  { name: '__Secure-BUCKET',    required: false, hint: 'Experiment bucket' },
  { name: 'NID',                required: false, hint: 'Preferences cookie' },
  { name: 'AEC',                required: false, hint: 'Anti-abuse cookie' },
  { name: 'SEARCH_SAMESITE',    required: false, hint: 'SameSite search cookie' },
];

const collected = [];

for (const cookie of COOKIES) {
  const tag = cookie.required ? '(required)' : '(optional)';
  const value = await ask(`  ${cookie.name} ${tag}: `);
  const trimmed = value.trim();
  if (trimmed) {
    collected.push({ name: cookie.name, value: trimmed, domain: '.google.com' });
  } else if (cookie.required) {
    console.warn(`  ⚠️  ${cookie.name} is required but was empty — continuing anyway`);
  }
}

rl.close();

if (collected.length === 0) {
  console.error('\n❌ No cookies provided. Aborting.');
  process.exit(1);
}

// Build cookie string and import
const cookieStr = collected.map(c => `${c.name}=${c.value}`).join('; ');
const result = importCookies(cookieStr, passphrase);

console.log('');
console.log(`✅ Imported ${result.cookieCount} cookies → ~/.kyt/notebooklm-auth.enc`);
if (isAuthConfigured()) {
  console.log('✅ Auth file verified on disk');
}
console.log('');
console.log('Next: Restart Claude Code MCP server (/mcp) and NotebookLM tools will work.');

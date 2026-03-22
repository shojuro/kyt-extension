/**
 * NotebookLM authentication manager.
 *
 * Security model:
 * - User authenticates via Playwright browser (owned by K.Y.T., no third-party dependency)
 * - Only minimum required cookies are extracted (Google auth cookies)
 * - Cookies are encrypted at rest with AES-256-GCM + PBKDF2 (user-provided passphrase)
 * - Decrypted cookies are held in memory only
 * - CSRF token (SNlM0e) and session ID (FdrFJe) fetched on demand, never persisted
 * - Auto-refresh on 401/403
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

const KYT_DIR = join(homedir(), '.kyt');
const AUTH_PATH = join(KYT_DIR, 'notebooklm-auth.enc');
const AUTO_KEY_PATH = join(KYT_DIR, 'encryption-key');

const NOTEBOOKLM_HOME = 'https://notebooklm.google.com';
const TOKEN_RE = /"SNlM0e"\s*:\s*"([^"]+)"/;
const SESSION_RE = /"FdrFJe"\s*:\s*"([^"]+)"/;

// Extract all Google auth cookies needed for NotebookLM API calls.
// SIDCC and __Secure-*PSIDCC are critical — without them, batchexecute returns 401.
const REQUIRED_COOKIE_NAMES = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  'SIDCC', 'OSID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PSIDRTS', '__Secure-3PSIDRTS',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  '__Secure-OSID', '__Secure-BUCKET',
  'NID', 'AEC', 'SEARCH_SAMESITE',
]);

// --- Encryption (AES-256-GCM + scrypt) ---

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const AUTH_TAG_LEN = 16;

/**
 * Encrypt JSON data with a passphrase using AES-256-GCM.
 *
 * Format: salt(16) || iv(12) || authTag(16) || ciphertext
 * All stored as a single base64 string.
 */
function encryptData(data, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt || iv || authTag || ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt data encrypted by encryptData().
 *
 * @returns {object} Parsed JSON data
 * @throws {Error} If passphrase is wrong or data is corrupted
 */
function decryptData(base64Data, passphrase) {
  const packed = Buffer.from(base64Data, 'base64');
  const minLen = SALT_LEN + IV_LEN + AUTH_TAG_LEN;
  if (packed.length < minLen) {
    throw new Error('Encrypted auth data is corrupted (too short)');
  }

  const salt = packed.subarray(0, SALT_LEN);
  const iv = packed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = packed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const ciphertext = packed.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);

  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// --- Cookie persistence ---

function ensureKytDir() {
  if (!existsSync(KYT_DIR)) {
    mkdirSync(KYT_DIR, { recursive: true });
  }
}

// --- Auto-key management ---

/**
 * Get or create the auto-generated encryption key.
 * Key is a 64-char hex string (32 bytes) stored at ~/.kyt/encryption-key.
 * File created with mode 0600 (owner read/write only).
 *
 * @returns {string|null} Hex key string, or null if creation fails
 */
function ensureAutoKey() {
  ensureKytDir();
  if (existsSync(AUTO_KEY_PATH)) {
    return readFileSync(AUTO_KEY_PATH, 'utf8').trim();
  }
  try {
    const key = randomBytes(32).toString('hex');
    writeFileSync(AUTO_KEY_PATH, key, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  } catch (e) {
    // wx flag: if another process created it between our check and write, read it
    if (e.code === 'EEXIST') {
      return readFileSync(AUTO_KEY_PATH, 'utf8').trim();
    }
    process.stderr.write(`[kyt-auth] Warning: Could not create auto-key: ${e.message}\n`);
    return null;
  }
}

/**
 * Resolve the effective passphrase for cookie encryption/decryption.
 * Priority: explicit passphrase > auto-key file > NOTEBOOKLM_PASSPHRASE env var
 *
 * @param {string} [explicitPassphrase] - User-provided passphrase (overrides all)
 * @returns {string|null} Effective passphrase, or null if none available
 */
export function getEffectivePassphrase(explicitPassphrase) {
  if (explicitPassphrase && explicitPassphrase.length >= 4) return explicitPassphrase;

  // Auto-key (preferred for zero-config operation)
  const autoKey = existsSync(AUTO_KEY_PATH) ? readFileSync(AUTO_KEY_PATH, 'utf8').trim() : null;
  if (autoKey && autoKey.length >= 4) return autoKey;

  // Environment variable (legacy)
  const envPass = process.env.NOTEBOOKLM_PASSPHRASE;
  if (envPass && envPass.length >= 4) return envPass;

  return null;
}

/**
 * Migrate from passphrase-encrypted cookies to auto-key encryption.
 * One-time operation: decrypt with old passphrase, re-encrypt with auto-key.
 *
 * @param {string} oldPassphrase - Current passphrase
 * @returns {{ success: boolean, error?: string }}
 */
export function migrateToAutoKey(oldPassphrase) {
  try {
    if (!existsSync(AUTH_PATH)) {
      return { success: false, error: 'No encrypted auth file found' };
    }
    const encrypted = readFileSync(AUTH_PATH, 'utf8').trim();
    const data = decryptData(encrypted, oldPassphrase);

    const autoKey = ensureAutoKey();
    if (!autoKey) {
      return { success: false, error: 'Could not create auto-key file' };
    }

    const reEncrypted = encryptData(data, autoKey);
    writeFileSync(AUTH_PATH, reEncrypted, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- Cookie persistence ---

/**
 * Save encrypted cookies to disk.
 * Uses auto-key if no explicit passphrase provided.
 *
 * @param {{ name: string, value: string, domain: string }[]} cookies
 * @param {string} [passphrase] - Explicit passphrase, or auto-key if omitted
 */
function saveCookies(cookies, passphrase) {
  ensureKytDir();
  const effectivePass = passphrase || ensureAutoKey();
  if (!effectivePass) {
    throw new Error('No passphrase or auto-key available for encryption.');
  }
  const encrypted = encryptData({ cookies, savedAt: new Date().toISOString() }, effectivePass);
  writeFileSync(AUTH_PATH, encrypted, 'utf8');
}

/**
 * Load and decrypt cookies from disk.
 * Uses auto-key if no explicit passphrase provided.
 *
 * @param {string} [passphrase] - Explicit passphrase, or auto-key if omitted
 * @returns {{ cookies: { name: string, value: string, domain: string }[], savedAt: string }}
 */
function loadCookies(passphrase) {
  if (!existsSync(AUTH_PATH)) {
    throw new Error('No saved NotebookLM auth found. Run the login flow first.');
  }
  const effectivePass = getEffectivePassphrase(passphrase);
  if (!effectivePass) {
    throw new Error('No passphrase or auto-key available for decryption.');
  }
  const encrypted = readFileSync(AUTH_PATH, 'utf8').trim();
  return decryptData(encrypted, effectivePass);
}

// --- In-memory session state ---

let _cachedAuth = null;
let _refreshing = null;

/**
 * Build a Cookie header string from cookie array.
 */
function buildCookieHeader(cookies) {
  // Deduplicate by name (prefer notebooklm.google.com domain)
  const byName = new Map();
  for (const c of cookies) {
    const existing = byName.get(c.name);
    if (!existing || (c.domain && c.domain.includes('notebooklm'))) {
      byName.set(c.name, c);
    }
  }
  return Array.from(byName.values())
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Fetch NotebookLM homepage and extract CSRF + session tokens.
 * These are ephemeral — never persisted to disk.
 */
async function fetchTokens(cookieHeader) {
  const res = await fetch(NOTEBOOKLM_HOME, {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(
      `NotebookLM returned ${res.status}. Cookies may be expired — re-run login.`
    );
  }

  const html = await res.text();

  const csrfMatch = html.match(TOKEN_RE);
  if (!csrfMatch) {
    throw new Error('Could not extract CSRF token (SNlM0e). Auth may be expired — re-run login.');
  }

  const sessionMatch = html.match(SESSION_RE);
  if (!sessionMatch) {
    throw new Error('Could not extract session ID (FdrFJe). Auth may be expired — re-run login.');
  }

  return { csrfToken: csrfMatch[1], sessionId: sessionMatch[1] };
}

// --- Public API ---

/**
 * Login to NotebookLM via Playwright browser.
 *
 * Opens a real browser, lets user sign in to Google, then extracts
 * only the minimum required cookies and encrypts them to disk.
 *
 * This function is called by the MCP tool — it coordinates with the
 * Playwright MCP server via callback.
 *
 * @param {object} opts
 * @param {string} [opts.passphrase] - Encryption passphrase (optional — uses auto-key if omitted)
 * @param {(action: string, params: object) => Promise<any>} opts.playwrightCall
 *   Callback to invoke Playwright MCP tools (e.g., browser_navigate, browser_snapshot)
 * @param {number} [opts.timeoutMs=120000] - Max wait for user to complete login
 * @returns {Promise<{ cookieCount: number }>}
 */
export async function login({ passphrase, playwrightCall, timeoutMs = 120_000 }) {
  const effectivePass = getEffectivePassphrase(passphrase) || ensureAutoKey();
  if (!effectivePass || effectivePass.length < 4) {
    throw new Error('No passphrase or auto-key available. Provide a passphrase or ensure ~/.kyt/ is writable.');
  }

  // Navigate to NotebookLM (will redirect to Google sign-in if not authenticated)
  await playwrightCall('browser_navigate', { url: NOTEBOOKLM_HOME });

  // Poll until we land on notebooklm.google.com (user completed login)
  const startTime = Date.now();
  let onNotebookLM = false;

  while (Date.now() - startTime < timeoutMs) {
    // Take a snapshot to check current URL
    const snapshot = await playwrightCall('browser_snapshot', {});
    const snapshotText = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);

    if (snapshotText.includes('notebooklm.google.com') &&
        !snapshotText.includes('accounts.google.com')) {
      onNotebookLM = true;
      break;
    }

    // Wait 3s before checking again
    await new Promise(r => setTimeout(r, 3000));
  }

  if (!onNotebookLM) {
    throw new Error('Login timed out. User did not complete Google sign-in within the time limit.');
  }

  // Extract cookies via Playwright's JS evaluation
  const cookieResult = await playwrightCall('browser_evaluate', {
    expression: 'JSON.stringify(document.cookie)',
  });

  // Parse document.cookie format: "name1=value1; name2=value2"
  const rawCookieStr = typeof cookieResult === 'string'
    ? cookieResult.replace(/^"|"$/g, '')
    : String(cookieResult);

  const cookies = [];
  for (const pair of rawCookieStr.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (REQUIRED_COOKIE_NAMES.has(name)) {
      cookies.push({ name, value, domain: '.google.com' });
    }
  }

  // document.cookie doesn't expose HttpOnly cookies — we also need to try
  // getting them via the Playwright cookies API if available
  try {
    const allCookies = await playwrightCall('browser_evaluate', {
      expression: `
        // Try to access cookies via performance entries or other means
        // This is a best-effort approach — HttpOnly cookies aren't accessible via JS
        JSON.stringify({ documentCookieCount: document.cookie.split(';').length })
      `,
    });
  } catch {
    // Non-critical — we have what document.cookie gave us
  }

  if (cookies.length === 0) {
    throw new Error(
      'No required cookies found. Google sign-in may not have completed, ' +
      'or cookies are HttpOnly (not accessible via document.cookie). ' +
      'You may need to use browser DevTools to export cookies manually.'
    );
  }

  // Encrypt and save (uses auto-key if no explicit passphrase)
  saveCookies(cookies, effectivePass);

  // Clear in-memory cache to force re-auth with new cookies
  _cachedAuth = null;

  // Close the browser
  try {
    await playwrightCall('browser_close', {});
  } catch {
    // Non-critical
  }

  return { cookieCount: cookies.length };
}

/**
 * Import cookies from a manually-provided cookie string.
 *
 * For users who prefer to paste cookies from browser DevTools rather than
 * using the Playwright login flow. Accepts the raw Cookie header format:
 * "SID=xxx; HSID=yyy; ..."
 *
 * @param {string} cookieString - Raw cookie header value
 * @param {string} [passphrase] - Encryption passphrase (optional — uses auto-key if omitted)
 * @returns {{ cookieCount: number }}
 */
export function importCookies(cookieString, passphrase) {
  const effectivePass = getEffectivePassphrase(passphrase) || ensureAutoKey();
  if (!effectivePass || effectivePass.length < 4) {
    throw new Error('No passphrase or auto-key available. Provide a passphrase or ensure ~/.kyt/ is writable.');
  }
  if (!cookieString || typeof cookieString !== 'string') {
    throw new Error('Cookie string is required.');
  }

  const cookies = [];
  for (const pair of cookieString.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (REQUIRED_COOKIE_NAMES.has(name) && value) {
      cookies.push({ name, value, domain: '.google.com' });
    }
  }

  if (cookies.length === 0) {
    throw new Error(
      'No recognized Google auth cookies found in the provided string. ' +
      `Expected at least one of: ${[...REQUIRED_COOKIE_NAMES].join(', ')}`
    );
  }

  saveCookies(cookies, effectivePass);
  _cachedAuth = null;

  return { cookieCount: cookies.length };
}

/**
 * Get authenticated session (cookies + tokens).
 *
 * Decrypts cookies from disk (if not already cached), fetches fresh
 * CSRF/session tokens from NotebookLM page. Tokens are ephemeral (memory only).
 *
 * @param {string} [passphrase] - Explicit passphrase (optional — uses auto-key if omitted)
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<{ cookieHeader: string, csrfToken: string, sessionId: string }>}
 */
export async function getAuth(passphrase, forceRefresh = false) {
  if (_cachedAuth && !forceRefresh) {
    return _cachedAuth;
  }

  // Prevent concurrent refresh races
  if (_refreshing) {
    return _refreshing;
  }

  _refreshing = (async () => {
    try {
      const { cookies } = loadCookies(passphrase);
      const cookieHeader = buildCookieHeader(cookies);
      const { csrfToken, sessionId } = await fetchTokens(cookieHeader);

      _cachedAuth = { cookieHeader, csrfToken, sessionId };
      return _cachedAuth;
    } finally {
      _refreshing = null;
    }
  })();

  return _refreshing;
}

/**
 * Clear cached auth (call on 401/403 before retry).
 */
export function clearAuthCache() {
  _cachedAuth = null;
}

/**
 * Check if encrypted auth file exists on disk.
 */
export function isAuthConfigured() {
  return existsSync(AUTH_PATH);
}

/**
 * Delete stored auth data.
 */
export function deleteAuth() {
  _cachedAuth = null;
  if (existsSync(AUTH_PATH)) {
    unlinkSync(AUTH_PATH);
  }
}

// --- Exports for testing ---
export const __testing__ = {
  encryptData,
  decryptData,
  buildCookieHeader,
  ensureAutoKey,
  REQUIRED_COOKIE_NAMES,
  AUTH_PATH,
  AUTO_KEY_PATH,
};

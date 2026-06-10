/**
 * Auth Boundary Integration Tests — service-role gating
 *
 * Verifies the production trust model enforced by search_memories and
 * save_chat_turn_batch after the service-role gating fix:
 *
 *   - Real user JWT  → may only act on their own data.
 *   - Service role   → trusted backend (benchmark harness / admin) may act on
 *                      any user_id.
 *   - Anon key/other → MAY NOT impersonate or write arbitrary user_ids (401).
 *
 * This is the regression gate for the anon-key IDOR. It is designed to be run
 * AFTER deploying the two updated edge functions:
 *
 *   node --test tests/integration/auth-boundary.test.js
 *
 * NOTE: against the OLD (vulnerable) deployment the forged-anon-key tests will
 * FAIL — the anon key used to return 200 with another user's memories. That
 * failure is the proof the fix is needed; the test passes only once the gated
 * functions are live.
 *
 * Requires (in .env or mcp/.env), with anon and service keys as DISTINCT values:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY              (the public anon JWT)
 *   SUPABASE_SERVICE_KEY          (or SUPABASE_SERVICE_ROLE_KEY)
 *   USER_ID / KYT_USER_ID         (optional — a real user id for the positive path)
 *
 * Side effects: read-only by default. The service-role WRITE probe inserts one
 * benign row and runs ONLY when KYT_RUN_WRITE_PROBE=1.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load .env (mcp/.env then root .env), without overriding real env ──
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const paths = [
    join(__dirname, '..', '..', 'mcp', '.env'),
    join(__dirname, '..', '..', '.env'),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding matching quotes — .env values here are quoted
      // (e.g. KEY='eyJ...'); an unstripped quote makes a malformed Bearer token
      // that the gateway rejects as INVALID_JWT, masking the real auth behavior.
      if (val.length >= 2 &&
          ((val[0] === "'" && val[val.length - 1] === "'") ||
           (val[0] === '"' && val[val.length - 1] === '"'))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.USER_ID || process.env.KYT_USER_ID;

// A user the caller is NOT authorized to access — the impersonation target.
// Its real existence is irrelevant: an anon caller must be rejected regardless.
const VICTIM_USER_ID = USER_ID || '00000000-0000-0000-0000-0000000000aa';

// ── Raw edge-function POST (no throw on non-2xx — we assert on status) ──
async function callFn(fnName, { bearer, body }) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  // apikey is required by the Supabase gateway to route the request at all.
  if (ANON_KEY) headers['apikey'] = ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let parsed = null;
  const textBody = await res.text().catch(() => '');
  try { parsed = textBody ? JSON.parse(textBody) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, raw: textBody };
}

const haveBase = Boolean(SUPABASE_URL && ANON_KEY);

if (!haveBase) {
  console.warn('SKIP auth-boundary: missing SUPABASE_URL or SUPABASE_ANON_KEY');
} else {
  describe('Auth boundary — anon key cannot impersonate (IDOR closed)', () => {
    test('search_memories: anon key + foreign userId → 401', async () => {
      const { status, body } = await callFn('search_memories', {
        bearer: ANON_KEY,
        body: { query: 'what did I say about my sleep schedule', userId: VICTIM_USER_ID },
      });
      assert.equal(status, 401, `expected 401, got ${status} (${JSON.stringify(body)})`);
    });

    test('search_memories: no Authorization header → 401', async () => {
      const { status } = await callFn('search_memories', {
        bearer: null,
        body: { query: 'anything', userId: VICTIM_USER_ID },
      });
      assert.equal(status, 401, `expected 401, got ${status}`);
    });

    test('save_chat_turn_batch: anon key + arbitrary user_id → 401 (no write)', async () => {
      const { status, body } = await callFn('save_chat_turn_batch', {
        bearer: ANON_KEY,
        body: {
          skip_ai_processing: true,
          turns: [{
            user_id: VICTIM_USER_ID,
            conversation_id: 'auth-boundary-probe',
            platform: 'claude-code',
            content: '[auth-boundary] this write must be rejected',
            speakers: ['user'],
            start_timestamp: 0,
          }],
        },
      });
      assert.equal(status, 401, `expected 401, got ${status} (${JSON.stringify(body)})`);
    });
  });

  // Positive path: the benchmark harness authenticates with the service-role key.
  describe('Auth boundary — service role may act on any user (harness path)', { skip: !SERVICE_KEY && 'no SERVICE key in env' }, () => {
    test('search_memories: service role + userId → not 401 (pipeline runs)', async () => {
      const { status, body } = await callFn('search_memories', {
        bearer: SERVICE_KEY,
        body: { query: 'hello', userId: VICTIM_USER_ID, topK: 1 },
      });
      assert.notEqual(status, 401, `service role was rejected (${status}: ${JSON.stringify(body)})`);
      assert.notEqual(status, 403, `service role was forbidden (${status})`);
    });

    // Sanity: anon and service keys must be DIFFERENT, or the test proves nothing.
    test('anon and service keys are distinct', () => {
      assert.ok(SERVICE_KEY && SERVICE_KEY !== ANON_KEY,
        'SUPABASE_SERVICE_KEY must differ from SUPABASE_ANON_KEY for this suite to be meaningful');
    });

    // Opt-in write probe (inserts one benign row). Enable with KYT_RUN_WRITE_PROBE=1.
    test('save_chat_turn_batch: service role may write arbitrary user_id', { skip: process.env.KYT_RUN_WRITE_PROBE !== '1' && 'set KYT_RUN_WRITE_PROBE=1 to run (writes a row)' }, async () => {
      const { status, body } = await callFn('save_chat_turn_batch', {
        bearer: SERVICE_KEY,
        body: {
          skip_ai_processing: true,
          turns: [{
            user_id: VICTIM_USER_ID,
            conversation_id: 'auth-boundary-probe',
            platform: 'claude-code',
            content: '[auth-boundary] service-role write probe',
            speakers: ['user'],
            start_timestamp: 0,
          }],
        },
      });
      assert.notEqual(status, 401, `service role write rejected as unauthenticated (${status})`);
      assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status} (${JSON.stringify(body)})`);
    });
  });
}

/**
 * Production contract test for the 90-day history import auth fix (0e612cf).
 *
 * Verifies, against the DEPLOYED Supabase project:
 *   A. save_chat_turn_batch REJECTS anon-key Bearers (401) — the regression
 *      that broke the pre-fix importer in production.
 *   B. save_chat_turn_batch ACCEPTS a real user JWT (200) — the fixed
 *      importer path.
 *   C. update_import_progress + RLS read-back of user_history_imports work
 *      with a JWT (resume/status detection), and anon reads return [].
 *
 * Creates an ephemeral test user via public signup (anon key only, no
 * service-role needed). Prints statuses only — never tokens.
 *
 * Run: node validation/verify_import_auth_contract.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'mcp', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
    console.error('FAIL: SUPABASE_URL / SUPABASE_ANON_KEY missing from mcp/.env');
    process.exit(1);
}

const results = [];
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function headers(bearer) {
    return {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
    };
}

async function main() {
    // --- 0. Test user session ---
    // Preferred: KYT_CONTRACT_EMAIL/PASSWORD env (pre-seeded confirmed user;
    // public signup requires email confirmation on this project).
    let email = process.env.KYT_CONTRACT_EMAIL;
    let password = process.env.KYT_CONTRACT_PASSWORD;
    let jwt, userId;

    if (email && password) {
        const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: headers(ANON_KEY),
            body: JSON.stringify({ email, password }),
        });
        const token = await tokenRes.json().catch(() => ({}));
        jwt = token.access_token;
        userId = token.user?.id;
        if (!tokenRes.ok || !jwt || !userId) {
            console.error(`BLOCKED: password grant failed (status ${tokenRes.status}): ${token.error_description || token.msg || ''}`);
            process.exit(2);
        }
    } else {
        email = `kyt.contract.${Date.now()}@example.com`;
        password = crypto.randomBytes(18).toString('base64url');
        const signupRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
            method: 'POST',
            headers: headers(ANON_KEY),
            body: JSON.stringify({ email, password }),
        });
        const signup = await signupRes.json().catch(() => ({}));
        jwt = signup.access_token;
        userId = signup.user?.id;
        if (!signupRes.ok || !jwt || !userId) {
            console.error(`BLOCKED: signup did not return a session (status ${signupRes.status}).`);
            console.error('Email confirmation is likely required — seed a confirmed user and pass KYT_CONTRACT_EMAIL/PASSWORD.');
            process.exit(2);
        }
    }
    console.log(`Test user session established: ${email} (id ${userId.substring(0, 8)}…)\n`);

    const testConvId = `kyt-contract-test-${Date.now()}`;
    const turnPayload = JSON.stringify({
        turns: [{
            user_id: userId,
            conversation_id: testConvId,
            platform: 'chatgpt',
            content: 'KYT import auth contract test message',
            role: 'user',
            timestamp: new Date().toISOString(),
            source: 'import',
            metadata: { originalId: 'contract-test-1' },
        }],
        skip_ai_processing: true,
    });

    // --- A. anon Bearer must be rejected (this is what broke prod) ---
    const anonSave = await fetch(`${SUPABASE_URL}/functions/v1/save_chat_turn_batch`, {
        method: 'POST', headers: headers(ANON_KEY), body: turnPayload,
    });
    record('A: save_chat_turn_batch rejects anon-key Bearer',
        anonSave.status === 401, `status ${anonSave.status}`);

    // --- B. user JWT must be accepted (the fixed importer path) ---
    const jwtSave = await fetch(`${SUPABASE_URL}/functions/v1/save_chat_turn_batch`, {
        method: 'POST', headers: headers(jwt), body: turnPayload,
    });
    const jwtSaveBody = await jwtSave.text();
    record('B: save_chat_turn_batch accepts user JWT',
        jwtSave.ok, `status ${jwtSave.status}${jwtSave.ok ? '' : ` body ${jwtSaveBody.slice(0, 120)}`}`);

    // --- C1. progress write via update_import_progress (JWT) ---
    const importId = crypto.randomUUID();
    const progressRes = await fetch(`${SUPABASE_URL}/functions/v1/update_import_progress`, {
        method: 'POST', headers: headers(jwt),
        body: JSON.stringify({
            id: importId, user_id: userId, platform: 'chatgpt',
            status: 'in_progress', messages_imported: 1,
            started_at: new Date().toISOString(),
        }),
    });
    record('C1: update_import_progress accepts JWT caller',
        progressRes.ok, `status ${progressRes.status}`);

    // --- C2. RLS read-back with JWT (resume/status detection) ---
    const jwtRead = await fetch(
        `${SUPABASE_URL}/rest/v1/user_history_imports?user_id=eq.${userId}&status=eq.in_progress&limit=5`,
        { headers: headers(jwt) });
    const jwtRows = jwtRead.ok ? await jwtRead.json() : [];
    record('C2: user_history_imports readable with JWT (resume works)',
        jwtRead.ok && jwtRows.some(r => r.id === importId),
        `status ${jwtRead.status}, rows ${jwtRows.length}`);

    // --- C3. anon read returns empty (RLS holds; pre-fix importer saw this) ---
    const anonRead = await fetch(
        `${SUPABASE_URL}/rest/v1/user_history_imports?user_id=eq.${userId}&limit=5`,
        { headers: headers(ANON_KEY) });
    const anonRows = anonRead.ok ? await anonRead.json() : null;
    record('C3: anon read of user_history_imports returns no rows (RLS)',
        anonRead.ok && Array.isArray(anonRows) && anonRows.length === 0,
        `status ${anonRead.status}, rows ${anonRows?.length}`);

    // --- Cleanup: mark import completed; remove test chat turn ---
    await fetch(`${SUPABASE_URL}/functions/v1/update_import_progress`, {
        method: 'POST', headers: headers(jwt),
        body: JSON.stringify({ id: importId, user_id: userId, platform: 'chatgpt', status: 'completed' }),
    });
    const delTurn = await fetch(
        `${SUPABASE_URL}/rest/v1/chat_turns?conversation_id=eq.${testConvId}&user_id=eq.${userId}`,
        { method: 'DELETE', headers: headers(jwt) });
    console.log(`\nCleanup: import row marked completed; chat_turns delete status ${delTurn.status}`);
    console.log(`Note: ephemeral auth user ${email} remains (deletion needs service role).`);

    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('FAIL: unexpected error:', e.message);
    process.exit(1);
});

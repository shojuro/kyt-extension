#!/usr/bin/env node
/**
 * Diagnose query_memory empty results.
 * Runs Steps A-E from the investigation plan.
 *
 * Usage: node scripts/diagnose-query-memory.js
 * Requires: mcp/.env with SUPABASE_URL, SUPABASE_SERVICE_KEY, KYT_USER_ID
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../mcp/.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const USER_ID = process.env.KYT_USER_ID;
const token = SERVICE_KEY || ANON_KEY;

if (!SUPABASE_URL || !token) {
  console.error('Missing SUPABASE_URL or auth key in mcp/.env');
  process.exit(1);
}
if (!USER_ID) {
  console.error('Missing KYT_USER_ID in mcp/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY);

let failed = false;

function pass(step, msg) { console.log(`  \x1b[32mPASS\x1b[0m [${step}] ${msg}`); }
function fail(step, msg) { console.log(`  \x1b[31mFAIL\x1b[0m [${step}] ${msg}`); failed = true; }
function info(step, msg) { console.log(`  \x1b[36mINFO\x1b[0m [${step}] ${msg}`); }

// ─── Step A: Edge function reachability + auth ───────────────────────────────
async function stepA() {
  console.log('\n── Step A: Edge function reachability + auth ──');
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/search_memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': ANON_KEY || token,
      },
      body: JSON.stringify({ query: 'test diagnostic', userId: USER_ID, topK: 3, fast: true }),
    });

    info('A', `HTTP status: ${res.status}`);
    const body = await res.json();

    if (res.status === 401) {
      fail('A', `Authentication failed: ${body.error}`);
      return null;
    }
    if (res.status === 429) {
      fail('A', 'Rate limited — wait and retry');
      return null;
    }
    if (res.status === 500) {
      fail('A', `Server error: ${body.error}`);
      return null;
    }
    if (!res.ok) {
      fail('A', `Unexpected status ${res.status}: ${JSON.stringify(body)}`);
      return null;
    }

    const results = body.results || [];
    info('A', `Results returned: ${results.length}`);
    if (body.meta) info('A', `Request ID: ${body.meta.requestId}, HyDE: ${body.meta.hydeEnabled}, fast: ${body.meta.fast}`);

    if (results.length > 0) {
      pass('A', `Edge function works — got ${results.length} results`);
      console.log(`       Top result: "${results[0].content?.substring(0, 80)}..."`);
      return results;
    }

    info('A', 'Edge function reachable but returned 0 results — continuing diagnostics');
    return [];
  } catch (err) {
    fail('A', `Network/fetch error: ${err.message}`);
    return null;
  }
}

// ─── Step B: Embedding coverage ──────────────────────────────────────────────
async function stepB() {
  console.log('\n── Step B: Embedding coverage in chat_turns ──');
  const { data, error } = await supabase.rpc('execute_sql', {
    sql: `SELECT COUNT(*) as total,
           COUNT(embedding) as has_embedding,
           COUNT(*) - COUNT(embedding) as missing_embedding
    FROM chat_turns WHERE user_id = '${USER_ID}'`
  }).single();

  // Fallback: direct query if execute_sql RPC doesn't exist
  if (error) {
    info('B', `RPC execute_sql not available (${error.message}), using direct query`);
    const { count: total } = await supabase
      .from('chat_turns')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', USER_ID);

    const { count: withEmbedding } = await supabase
      .from('chat_turns')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', USER_ID)
      .not('embedding', 'is', null);

    info('B', `Total rows: ${total ?? '?'}, With embeddings: ${withEmbedding ?? '?'}`);
    if (total === 0) { fail('B', 'No chat_turns found for this user'); return; }
    if (withEmbedding === 0) { fail('B', 'ALL embeddings are NULL — need backfill'); return; }
    const pct = ((withEmbedding / total) * 100).toFixed(1);
    pass('B', `${withEmbedding}/${total} rows have embeddings (${pct}%)`);
    return;
  }

  if (data) {
    const { total, has_embedding, missing_embedding } = data;
    info('B', `Total: ${total}, Embedded: ${has_embedding}, Missing: ${missing_embedding}`);
    if (total === 0) { fail('B', 'No chat_turns found for this user'); return; }
    if (has_embedding === 0) { fail('B', 'ALL embeddings are NULL — run backfill_embeddings'); return; }
    const pct = ((has_embedding / total) * 100).toFixed(1);
    pass('B', `${has_embedding}/${total} rows have embeddings (${pct}%)`);
  }
}

// ─── Step C: RPC function signature check ────────────────────────────────────
async function stepC() {
  console.log('\n── Step C: RPC match_messages_with_gravity works ──');

  // Get a sample embedding to use as query
  const { data: sample, error: sampleErr } = await supabase
    .from('chat_turns')
    .select('embedding')
    .eq('user_id', USER_ID)
    .not('embedding', 'is', null)
    .limit(1)
    .single();

  if (sampleErr || !sample?.embedding) {
    fail('C', `Cannot get sample embedding: ${sampleErr?.message || 'no data'}`);
    return;
  }

  info('C', `Sample embedding dimensions: ${sample.embedding.length}`);

  const { data, error } = await supabase.rpc('match_messages_with_gravity', {
    query_embedding: sample.embedding,
    match_threshold: 0.3,
    match_count: 5,
    exclude_recent_seconds: 0,
    p_user_id: USER_ID,
    boost_entity_ids: null,
    p_profile_id: null,
    p_platform: null,
    p_project_id: null,
  });

  if (error) {
    fail('C', `RPC error: ${error.message}`);
    if (error.message.includes('could not find')) {
      info('C', 'Function signature mismatch — check which migration is applied');
    }
    return;
  }

  info('C', `RPC returned ${data?.length ?? 0} results`);
  if (data && data.length > 0) {
    pass('C', `RPC works — top result similarity: ${data[0].vector_similarity?.toFixed(3)}, gravity: ${data[0].gravity_score?.toFixed(3)}`);
    console.log(`       Content: "${data[0].content?.substring(0, 80)}..."`);
  } else {
    fail('C', 'RPC returned 0 results even with threshold 0.3 — possible data or filter issue');
  }
}

// ─── Step D: Vault exclusion impact ──────────────────────────────────────────
async function stepD() {
  console.log('\n── Step D: Vault exclusion impact ──');

  // Check rows with project assignments
  const { data: withProject, count: withProjectCount } = await supabase
    .from('chat_turns')
    .select('project_id', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
    .not('project_id', 'is', null);

  const { count: totalCount } = await supabase
    .from('chat_turns')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', USER_ID);

  const noProject = (totalCount || 0) - (withProjectCount || 0);
  info('D', `Total: ${totalCount}, With project: ${withProjectCount}, No project (searchable): ${noProject}`);

  if (noProject === 0 && (withProjectCount || 0) > 0) {
    fail('D', 'ALL rows are assigned to projects — if any are vault projects, general search returns nothing');

    // Check if projects are vaults
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name, is_vault')
      .eq('user_id', USER_ID);

    if (projects) {
      for (const p of projects) {
        info('D', `  Project "${p.name}": is_vault=${p.is_vault}`);
      }
      const vaultProjects = projects.filter(p => p.is_vault);
      if (vaultProjects.length > 0) {
        fail('D', `${vaultProjects.length} vault project(s) found — data in vaults is hidden from general search`);
      }
    }
    return;
  }

  if (noProject > 0) {
    pass('D', `${noProject} rows have no project assignment — vault exclusion is not the issue`);
  } else {
    pass('D', 'No project assignments at all — vault exclusion is not applicable');
  }
}

// ─── Step E: Embedding generation check ──────────────────────────────────────
async function stepE() {
  console.log('\n── Step E: Query embedding generation ──');
  info('E', 'This checks if the edge function can generate embeddings for query text.');
  info('E', 'If Steps A-D pass but query_memory still returns empty, check:');
  info('E', '  1. HUGGINGFACE_API_KEY is set in Supabase secrets (Dashboard > Settings > Secrets)');
  info('E', '  2. Supabase function logs for "Embedding generation" errors');
  info('E', '  3. The HuggingFace endpoint is reachable from Supabase Edge Functions');
  info('E', 'Cannot verify this programmatically from outside the edge function runtime.');
}

// ─── Run all steps ───────────────────────────────────────────────────────────
console.log('=== query_memory Diagnostic ===');
console.log(`User ID: ${USER_ID}`);
console.log(`Supabase URL: ${SUPABASE_URL}`);
console.log(`Auth: ${SERVICE_KEY ? 'service key' : 'anon key'}`);

const resultsA = await stepA();
await stepB();
await stepC();
await stepD();
await stepE();

console.log('\n' + (failed ? '\x1b[31m=== FAILURES DETECTED ===\x1b[0m' : '\x1b[32m=== ALL CHECKS PASSED ===\x1b[0m'));
process.exit(failed ? 1 : 0);

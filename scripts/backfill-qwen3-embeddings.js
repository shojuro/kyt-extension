#!/usr/bin/env node
/**
 * Backfill Qwen3 Embeddings Script
 *
 * Re-embeds all messages/chat_turns with NULL embeddings using Qwen3-Embedding-8B
 * via HuggingFace Inference Providers (Scaleway backend).
 *
 * CRITICAL: Produces 1024d Matryoshka-truncated + L2-normalized vectors,
 * matching the extension's browser-sync.js generateEmbeddings() output.
 *
 * Usage:
 *   node scripts/backfill-qwen3-embeddings.js
 *   node scripts/backfill-qwen3-embeddings.js --dry-run
 *   node scripts/backfill-qwen3-embeddings.js --batch-size 20 --limit 50
 *   node scripts/backfill-qwen3-embeddings.js --table messages
 *   node scripts/backfill-qwen3-embeddings.js --table chat_turns
 *   node scripts/backfill-qwen3-embeddings.js --platform gemini
 *   node scripts/backfill-qwen3-embeddings.js --table chat_turns --platform gemini
 *
 * Environment (loaded from .env via dotenv):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, HUGGINGFACE_API_KEY
 */

import 'dotenv/config';

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY;

const EMBEDDING_DIMS = 1024;  // Matryoshka truncation target (matches extension)
const HF_ROUTER_URL = 'https://router.huggingface.co/scaleway/v1/embeddings';
const HF_MODEL = 'qwen3-embedding-8b';

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args[args.indexOf('--batch-size') + 1]) || 10;
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const TABLE_FILTER = args.includes('--table') ? args[args.indexOf('--table') + 1] : null;
const PLATFORM_FILTER = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null;

// Validate
if (!SUPABASE_URL || !SUPABASE_KEY || !HF_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('   SUPABASE_URL:', SUPABASE_URL ? 'OK' : 'MISSING');
  console.error('   SUPABASE_SERVICE_KEY:', SUPABASE_KEY ? 'OK' : 'MISSING');
  console.error('   HUGGINGFACE_API_KEY:', HF_API_KEY ? 'OK' : 'MISSING');
  console.error('\nEnsure .env exists in project root.');
  process.exit(1);
}

console.log('Qwen3 Embedding Backfill (1024d Matryoshka)');
console.log(`   Supabase: ${SUPABASE_URL}`);
console.log(`   Batch size: ${BATCH_SIZE}`);
console.log(`   Limit: ${LIMIT || 'all'}`);
console.log(`   Table filter: ${TABLE_FILTER || 'both (messages + chat_turns)'}`);
console.log(`   Platform filter: ${PLATFORM_FILTER || 'all'}`);
console.log(`   Dry run: ${DRY_RUN}`);
console.log(`   Endpoint: ${HF_ROUTER_URL}`);
console.log(`   Output dims: ${EMBEDDING_DIMS}`);
console.log('');

// ── Matryoshka truncation (matches browser-sync.js) ─────────────────────

function truncateAndNormalize(embedding, dims) {
  const truncated = embedding.slice(0, dims);
  const norm = Math.sqrt(truncated.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return truncated;
  return truncated.map(val => val / norm);
}

// ── Supabase helpers ────────────────────────────────────────────────────

const supaHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchNullEmbeddings(table, offset, limit) {
  const idCol = table === 'messages' ? 'message_id' : 'id';
  // For chat_turns, also fetch contextual_content (richer embedding text)
  const selectCols = table === 'chat_turns'
    ? `${idCol},content,contextual_content`
    : `${idCol},content`;
  let url = `${SUPABASE_URL}/rest/v1/${table}?embedding=is.null&select=${selectCols}&order=created_at.asc&offset=${offset}&limit=${limit}`;

  // Platform filter: column name differs between tables
  if (PLATFORM_FILTER) {
    const platformCol = table === 'messages' ? 'source' : 'platform';
    url += `&${platformCol}=eq.${PLATFORM_FILTER}`;
  }

  const resp = await fetch(url, { headers: supaHeaders });
  if (!resp.ok) throw new Error(`Query ${table} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function patchEmbedding(table, id, embedding) {
  if (DRY_RUN) {
    console.log(`   [DRY RUN] Would patch ${table} ${id.substring(0, 20)}... (${embedding.length}d)`);
    return true;
  }

  const idCol = table === 'messages' ? 'message_id' : 'id';
  const url = `${SUPABASE_URL}/rest/v1/${table}?${idCol}=eq.${encodeURIComponent(id)}`;

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ embedding }),
  });

  if (!resp.ok) {
    console.error(`   PATCH failed for ${id}: ${resp.status}`);
    return false;
  }
  return true;
}

// ── Embedding generation (matches extension's Scaleway path) ────────────

async function generateEmbeddings(texts, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(HF_ROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: HF_MODEL, input: texts }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HuggingFace API ${resp.status}: ${errText}`);
      }

      const data = await resp.json();

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Unexpected response format from HuggingFace');
      }

      // Truncate to 1024d + L2-normalize (Matryoshka, same as browser-sync.js)
      return data.data.map(item => truncateAndNormalize(item.embedding, EMBEDDING_DIMS));
    } catch (err) {
      if (attempt === retries) throw err;
      // 403 = provider outage → longer backoff (30s)
      // Others = transient → exponential backoff (1s, 2s, 4s, 8s, 16s)
      const is403 = err.message.includes('403');
      const delay = is403 ? 30000 : 1000 * Math.pow(2, attempt);
      console.log(`   ⚠️ Attempt ${attempt + 1}/${retries + 1} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Process one table ───────────────────────────────────────────────────

async function processTable(table) {
  console.log(`\nProcessing ${table} table...`);

  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  while (true) {
    // Always offset=0 because patched rows disappear from IS NULL result set
    const rows = await fetchNullEmbeddings(table, 0, BATCH_SIZE);

    if (rows.length === 0) {
      console.log(`   No more ${table} with NULL embeddings`);
      break;
    }

    console.log(`   Batch: ${rows.length} rows`);

    // For chat_turns, prefer contextual_content (richer) over raw content
    const texts = rows.map(r => (r.contextual_content || r.content || '').trim() || ' ');
    const idCol = table === 'messages' ? 'message_id' : 'id';

    try {
      const embeddings = await generateEmbeddings(texts);

      for (let i = 0; i < rows.length; i++) {
        const id = rows[i][idCol];
        const ok = await patchEmbedding(table, id, embeddings[i]);

        if (ok) {
          totalSuccess++;
          console.log(`   [${totalProcessed + 1}] OK: ${id.substring(0, 24)}... (${embeddings[i].length}d)`);
        } else {
          totalFailed++;
        }
        totalProcessed++;

        if (LIMIT && totalProcessed >= LIMIT) break;
      }
    } catch (err) {
      console.error(`   Batch failed: ${err.message}`);
      totalFailed += rows.length;
      totalProcessed += rows.length;

      // If rate limited, wait and retry
      if (err.message.includes('429')) {
        console.log('   Waiting 30s for rate limit cooldown...');
        await new Promise(r => setTimeout(r, 30000));
        continue;  // Retry the same batch
      }
    }

    if (LIMIT && totalProcessed >= LIMIT) break;

    // Rate limit protection between batches
    await new Promise(r => setTimeout(r, 1000));
  }

  return { processed: totalProcessed, success: totalSuccess, failed: totalFailed };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  let totalSuccess = 0;
  let totalFailed = 0;

  // Count null embeddings first
  for (const table of ['messages', 'chat_turns']) {
    if (TABLE_FILTER && TABLE_FILTER !== table) continue;
    try {
      const rows = await fetchNullEmbeddings(table, 0, 1000);
      console.log(`${table}: ${rows.length} rows with NULL embeddings`);
    } catch (e) {
      console.log(`${table}: error counting — ${e.message}`);
    }
  }
  console.log('');

  // Process tables
  if (!TABLE_FILTER || TABLE_FILTER === 'messages') {
    const r = await processTable('messages');
    totalSuccess += r.success;
    totalFailed += r.failed;
  }

  if (!TABLE_FILTER || TABLE_FILTER === 'chat_turns') {
    const r = await processTable('chat_turns');
    totalSuccess += r.success;
    totalFailed += r.failed;
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  console.log(`Backfill complete in ${elapsed}s`);
  console.log(`   Success: ${totalSuccess}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`   Dry run: ${DRY_RUN}`);

  if (DRY_RUN) {
    console.log('\nRun without --dry-run to apply changes.');
  } else {
    console.log('\nVerify:');
    console.log('  SELECT platform, COUNT(*) FILTER (WHERE embedding IS NULL) as missing');
    console.log('  FROM messages GROUP BY platform;');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

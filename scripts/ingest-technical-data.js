#!/usr/bin/env node
/**
 * Ingest technical synthetic conversations into K.Y.T.
 *
 * Unlike ingest-synthetic-data.js (which bundles turns into one chunk),
 * this script ingests EACH turn individually for clean speaker separation.
 * User turns and assistant turns become separate rows in chat_turns.
 *
 * Usage:
 *   node scripts/ingest-technical-data.js [--input path.json] [--batch 10] [--delay 3000]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = resolve(__dirname, '../mcp/.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch { /* no .env */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TEST_USER_ID = 'b0000002-0000-4000-a000-000000000002';

async function callEdgeFunction(functionName, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`${functionName} ${res.status}: ${errBody.substring(0, 200)}`);
  }

  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');
  const batchIdx = args.indexOf('--batch');
  const delayIdx = args.indexOf('--delay');

  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : resolve(__dirname, 'synthetic-technical-conversations.json');
  const turnsPerBatch = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : 10;
  const delayMs = delayIdx !== -1 ? parseInt(args[delayIdx + 1], 10) : 3000;

  console.log(`\n🔧 K.Y.T. Technical Data Ingestion`);
  console.log(`   Input:     ${inputPath}`);
  console.log(`   Batch:     ${turnsPerBatch} turns per call`);
  console.log(`   Delay:     ${delayMs}ms`);
  console.log(`   User:      ${TEST_USER_ID}\n`);

  const conversations = JSON.parse(readFileSync(inputPath, 'utf-8'));
  if (!Array.isArray(conversations) || conversations.length === 0) {
    console.error('No conversations found in input file');
    process.exit(1);
  }

  // Flatten all conversations into individual turns
  const allTurns = [];
  const baseTime = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const convId = `tech-${conv.persona}-${conv.category}-${ci}`;
    const convStartTime = baseTime + (ci * 6 * 60 * 60 * 1000); // Space conversations 6 hours apart

    for (let ti = 0; ti < conv.turns.length; ti++) {
      const turn = conv.turns[ti];
      if (!turn.content || turn.content.trim().length < 10) continue;

      allTurns.push({
        user_id: TEST_USER_ID,
        conversation_id: convId,
        platform: conv.platform || 'chatgpt',
        content: turn.content.trim(),
        role: turn.role || 'user',
        speakers: [turn.role || 'user'],
        timestamp: convStartTime + (ti * 30 * 1000), // 30s between turns
        content_type: 'conversation',
        profile_id: TEST_USER_ID,
      });
    }
  }

  const totalTurns = allTurns.length;
  console.log(`   Conversations: ${conversations.length}`);
  console.log(`   Total turns:   ${totalTurns}\n`);

  let ingested = 0;
  let duplicates = 0;
  let errors = 0;

  for (let i = 0; i < allTurns.length; i += turnsPerBatch) {
    const batch = allTurns.slice(i, i + turnsPerBatch);
    const batchNum = Math.floor(i / turnsPerBatch) + 1;
    const totalBatches = Math.ceil(allTurns.length / turnsPerBatch);

    try {
      const result = await callEdgeFunction('save_chat_turn_batch', {
        turns: batch,
        skip_ai_processing: false, // Full pipeline: classification + embedding + entity extraction + content_category
      });

      const batchInserted = result.inserted || result.processed || 0;
      const batchDupes = result.duplicates_skipped || 0;
      ingested += batchInserted;
      duplicates += batchDupes;
      console.log(`  ✅ Batch ${batchNum}/${totalBatches}: ${batchInserted} ingested, ${batchDupes} dupes (total: ${ingested}/${totalTurns})`);
    } catch (e) {
      errors += batch.length;
      console.warn(`  ❌ Batch ${batchNum}/${totalBatches}: ${e.message.substring(0, 120)}`);

      // On 429, wait longer
      if (e.message.includes('429')) {
        console.log('  ⏳ Rate limited, waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }

    // Rate limit between batches
    if (i + turnsPerBatch < allTurns.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n📊 Ingestion complete:`);
  console.log(`   Ingested:    ${ingested}`);
  console.log(`   Duplicates:  ${duplicates}`);
  console.log(`   Errors:      ${errors}`);
  console.log(`   Conversations: ${conversations.length}`);
  console.log(`   Total turns:   ${totalTurns}\n`);

  // Summary by category
  const byCategory = {};
  for (const conv of conversations) {
    byCategory[conv.category] = (byCategory[conv.category] || 0) + 1;
  }
  console.log(`   By category:`);
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cat}: ${count}`);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

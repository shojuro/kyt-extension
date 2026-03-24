#!/usr/bin/env node
/**
 * Ingest synthetic conversations into K.Y.T. via save_chat_turn_batch.
 *
 * Reads the JSON output from generate-synthetic-data.js and sends each
 * conversation through the real pipeline (classification + embedding).
 *
 * Usage:
 *   node scripts/ingest-synthetic-data.js [--input path.json] [--batch 10] [--delay 2000]
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

  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : resolve(__dirname, 'synthetic-conversations.json');
  const batchSize = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : 10;
  const delayMs = delayIdx !== -1 ? parseInt(args[delayIdx + 1], 10) : 2000;

  console.log(`\n📥 K.Y.T. Synthetic Data Ingestion`);
  console.log(`   Input:  ${inputPath}`);
  console.log(`   Batch:  ${batchSize}`);
  console.log(`   Delay:  ${delayMs}ms`);
  console.log(`   User:   ${TEST_USER_ID}\n`);

  const data = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const conversations = data.conversations;

  if (!conversations || conversations.length === 0) {
    console.error('No conversations found in input file');
    process.exit(1);
  }

  console.log(`   Conversations: ${conversations.length}\n`);

  let ingested = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < conversations.length; i += batchSize) {
    const batch = conversations.slice(i, i + batchSize);

    // Flatten batch into individual turns for save_chat_turn_batch
    const turns = [];
    for (const conv of batch) {
      // Combine all messages into a single turn (user+assistant pairs)
      const contentParts = conv.messages.map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      );
      const content = contentParts.join('\n\n');

      // Determine speakers
      const speakers = [...new Set(conv.messages.map(m => m.role))];

      turns.push({
        user_id: TEST_USER_ID,
        conversation_id: conv.conversation_id,
        platform: conv.platform,
        content,
        role: 'user', // For classification routing
        speakers,
        timestamp: Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000, // Random date within last 90 days
        content_type: conv.icp === 'noise' ? 'conversation' : conv.icp === 'dev' ? 'conversation' : 'conversation',
      });
    }

    try {
      const result = await callEdgeFunction('save_chat_turn_batch', {
        turns,
        userId: TEST_USER_ID,
        skip_ai_processing: true, // Fast path — classification backfilled separately
      });

      const batchInserted = result.inserted || result.processed || batch.length;
      ingested += batchInserted;
      console.log(`  ✅ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(conversations.length / batchSize)}: ${batchInserted} ingested (total: ${ingested})`);
    } catch (e) {
      errors += batch.length;
      console.warn(`  ❌ Batch ${Math.floor(i / batchSize) + 1}: ${e.message.substring(0, 100)}`);
    }

    // Rate limit
    if (i + batchSize < conversations.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n📊 Ingestion complete:`);
  console.log(`   Ingested: ${ingested}`);
  console.log(`   Errors:   ${errors}`);
  console.log(`   Total:    ${conversations.length}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

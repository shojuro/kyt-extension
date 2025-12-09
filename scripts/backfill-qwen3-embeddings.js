#!/usr/bin/env node
/**
 * Backfill Qwen3 Embeddings Script
 *
 * Re-embeds all messages with NULL embeddings using Qwen3-Embedding-8B (4096d)
 * via HuggingFace Inference Providers (Nebius backend).
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
 *   HUGGINGFACE_API_KEY=hf_... \
 *   node scripts/backfill-qwen3-embeddings.js
 *
 * Options:
 *   --dry-run       Preview without making changes
 *   --batch-size N  Process N messages per batch (default: 10)
 *   --limit N       Process only N total messages (default: all)
 *
 * Requires: npm install @huggingface/inference
 */

import { InferenceClient } from '@huggingface/inference';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args[args.indexOf('--batch-size') + 1]) || 10;
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;

// Validate environment
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !HUGGINGFACE_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('   SUPABASE_URL:', SUPABASE_URL ? 'Set' : 'Missing');
  console.error('   SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Missing');
  console.error('   HUGGINGFACE_API_KEY:', HUGGINGFACE_API_KEY ? 'Set' : 'Missing');
  process.exit(1);
}

// Initialize HuggingFace Inference Client with Nebius provider
const hfClient = new InferenceClient(HUGGINGFACE_API_KEY);

console.log('Qwen3 Embedding Backfill Script');
console.log(`   Supabase URL: ${SUPABASE_URL}`);
console.log(`   Batch size: ${BATCH_SIZE}`);
console.log(`   Limit: ${LIMIT || 'all'}`);
console.log(`   Dry run: ${DRY_RUN}`);
console.log(`   Provider: nebius (Qwen3-Embedding-8B 4096d)`);
console.log('');

/**
 * Fetch messages with NULL embeddings from messages table
 */
async function fetchMessagesWithNullEmbeddings(offset = 0, limit = 100) {
  const url = `${SUPABASE_URL}/rest/v1/messages?embedding=is.null&select=id,message_id,content&order=created_at.asc&offset=${offset}&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch chat_turns with NULL embeddings
 */
async function fetchTurnsWithNullEmbeddings(offset = 0, limit = 100) {
  const url = `${SUPABASE_URL}/rest/v1/chat_turns?embedding=is.null&select=id,content&order=created_at.asc&offset=${offset}&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch chat_turns: ${response.status}`);
  }

  return response.json();
}

/**
 * Generate embeddings using Qwen3-Embedding-8B via HuggingFace Inference Providers
 * Uses Nebius as the backend provider for Qwen3 models
 */
async function generateQwen3Embeddings(texts) {
  const embeddings = [];

  // Process texts one at a time (featureExtraction doesn't support batch in same way)
  for (const text of texts) {
    const result = await hfClient.featureExtraction({
      provider: 'nebius',
      model: 'Qwen/Qwen3-Embedding-8B',
      inputs: text || ' '  // Use space for empty strings to avoid API errors
    });

    // Result is [[...4096 floats...]] - nested array (batch wrapper)
    // We need to extract result[0] to get the actual embedding vector
    if (Array.isArray(result) && Array.isArray(result[0])) {
      embeddings.push(result[0]);  // Unwrap the batch wrapper
    } else if (Array.isArray(result)) {
      embeddings.push(result);  // Already flat array
    } else {
      console.warn(`   Warning: Unexpected embedding format for text`);
      embeddings.push(result);
    }
  }

  // Validate dimensions
  if (embeddings.length > 0 && Array.isArray(embeddings[0])) {
    const dim = embeddings[0].length;
    if (dim !== 4096) {
      console.warn(`   Warning: Expected 4096d, got ${dim}d`);
    }
  }

  return embeddings;
}

/**
 * Update message embeddings in database
 */
async function updateMessageEmbedding(messageId, embedding) {
  if (DRY_RUN) {
    const dim = Array.isArray(embedding) ? embedding.length : 'unknown';
    console.log(`   [DRY RUN] Would update message ${messageId} with ${dim}d embedding`);
    return true;
  }

  const url = `${SUPABASE_URL}/rest/v1/messages?message_id=eq.${messageId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ embedding })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`   Failed to update message ${messageId}: ${error}`);
    return false;
  }

  return true;
}

/**
 * Update chat_turn embeddings in database
 */
async function updateTurnEmbedding(turnId, embedding) {
  if (DRY_RUN) {
    const dim = Array.isArray(embedding) ? embedding.length : 'unknown';
    console.log(`   [DRY RUN] Would update turn ${turnId} with ${dim}d embedding`);
    return true;
  }

  const url = `${SUPABASE_URL}/rest/v1/chat_turns?id=eq.${turnId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ embedding })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`   Failed to update turn ${turnId}: ${error}`);
    return false;
  }

  return true;
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main backfill process
 */
async function main() {
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  // Process messages table
  console.log('Processing messages table...');
  let offset = 0;

  while (true) {
    const messages = await fetchMessagesWithNullEmbeddings(offset, BATCH_SIZE);

    if (messages.length === 0) {
      console.log('   No more messages with NULL embeddings');
      break;
    }

    console.log(`   Processing batch at offset ${offset}: ${messages.length} messages`);

    // Generate embeddings for batch
    const texts = messages.map(m => m.content || '');

    try {
      const embeddings = await generateQwen3Embeddings(texts);

      // Update each message
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const embedding = embeddings[i];

        const success = await updateMessageEmbedding(msg.message_id, embedding);

        if (success) {
          totalSuccess++;
          console.log(`   [${totalProcessed + 1}] Updated: ${msg.message_id.substring(0, 20)}...`);
        } else {
          totalFailed++;
        }

        totalProcessed++;

        // Check limit
        if (LIMIT && totalProcessed >= LIMIT) {
          console.log(`   Reached limit of ${LIMIT} messages`);
          break;
        }
      }

    } catch (error) {
      console.error(`   Batch failed: ${error.message}`);
      totalFailed += messages.length;
    }

    // Rate limit
    await sleep(1000);

    // NOTE: Don't increment offset - records disappear from "IS NULL" result set after update
    // offset += BATCH_SIZE;  // BUG: This skips records!

    if (LIMIT && totalProcessed >= LIMIT) break;
  }

  // Process chat_turns table
  console.log('\nProcessing chat_turns table...');
  offset = 0;
  let turnsProcessed = 0;

  while (true) {
    const turns = await fetchTurnsWithNullEmbeddings(offset, BATCH_SIZE);

    if (turns.length === 0) {
      console.log('   No more turns with NULL embeddings');
      break;
    }

    console.log(`   Processing batch at offset ${offset}: ${turns.length} turns`);

    const texts = turns.map(t => t.content || '');

    try {
      const embeddings = await generateQwen3Embeddings(texts);

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const embedding = embeddings[i];

        const success = await updateTurnEmbedding(turn.id, embedding);

        if (success) {
          totalSuccess++;
          turnsProcessed++;
          console.log(`   [${turnsProcessed}] Updated turn: ${turn.id.substring(0, 20)}...`);
        } else {
          totalFailed++;
        }
      }

    } catch (error) {
      console.error(`   Batch failed: ${error.message}`);
      totalFailed += turns.length;
    }

    await sleep(1000);
    // NOTE: Don't increment offset - records disappear from "IS NULL" result set after update
    // offset += BATCH_SIZE;  // BUG: This skips records!
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\nBackfill Summary');
  console.log('='.repeat(40));
  console.log(`   Total processed: ${totalProcessed + turnsProcessed}`);
  console.log(`   Successful: ${totalSuccess}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`   Time elapsed: ${elapsed} minutes`);
  console.log(`   Dry run: ${DRY_RUN}`);
  console.log('');

  if (DRY_RUN) {
    console.log('Run without --dry-run to apply changes');
  } else {
    console.log('Backfill complete!');
    console.log('');
    console.log('Verify with:');
    console.log('  SELECT COUNT(*) FROM messages WHERE embedding IS NULL;');
    console.log('  SELECT vector_dims(embedding) FROM messages WHERE embedding IS NOT NULL LIMIT 1;');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

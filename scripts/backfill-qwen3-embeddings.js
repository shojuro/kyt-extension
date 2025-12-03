#!/usr/bin/env node
/**
 * Backfill Qwen3 Embeddings Script
 *
 * Re-embeds all messages with NULL embeddings using Qwen3-Embedding-8B (4096d)
 * to fix the dimension mismatch bug.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   HUGGINGFACE_API_KEY=hf_... \
 *   node scripts/backfill-qwen3-embeddings.js
 *
 * Options:
 *   --dry-run       Preview without making changes
 *   --batch-size N  Process N messages per batch (default: 10)
 *   --limit N       Process only N total messages (default: all)
 */

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
  console.error('❌ Missing required environment variables:');
  console.error('   SUPABASE_URL:', SUPABASE_URL ? '✅' : '❌ Missing');
  console.error('   SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_ROLE_KEY ? '✅' : '❌ Missing');
  console.error('   HUGGINGFACE_API_KEY:', HUGGINGFACE_API_KEY ? '✅' : '❌ Missing');
  process.exit(1);
}

console.log('🔧 Qwen3 Embedding Backfill Script');
console.log(`   Supabase URL: ${SUPABASE_URL}`);
console.log(`   Batch size: ${BATCH_SIZE}`);
console.log(`   Limit: ${LIMIT || 'all'}`);
console.log(`   Dry run: ${DRY_RUN}`);
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
 * Generate embeddings using Qwen3-Embedding-8B via HuggingFace
 */
async function generateQwen3Embeddings(texts) {
  const response = await fetch(
    'https://router.huggingface.co/hf-inference/models/Qwen/Qwen3-Embedding-8B',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: texts,
        options: { wait_for_model: true }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HuggingFace API error: ${response.status} - ${errorText}`);
  }

  const embeddings = await response.json();

  // Validate dimensions
  if (Array.isArray(embeddings) && embeddings.length > 0) {
    const dim = Array.isArray(embeddings[0]) ? embeddings[0].length : 0;
    if (dim !== 4096) {
      console.warn(`⚠️  Warning: Expected 4096d, got ${dim}d`);
    }
  }

  return embeddings;
}

/**
 * Update message embeddings in database
 */
async function updateMessageEmbedding(messageId, embedding) {
  if (DRY_RUN) {
    console.log(`   [DRY RUN] Would update message ${messageId} with ${embedding.length}d embedding`);
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
    console.error(`   ❌ Failed to update message ${messageId}: ${error}`);
    return false;
  }

  return true;
}

/**
 * Update chat_turn embeddings in database
 */
async function updateTurnEmbedding(turnId, embedding) {
  if (DRY_RUN) {
    console.log(`   [DRY RUN] Would update turn ${turnId} with ${embedding.length}d embedding`);
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
    console.error(`   ❌ Failed to update turn ${turnId}: ${error}`);
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
  console.log('📦 Processing messages table...');
  let offset = 0;

  while (true) {
    const messages = await fetchMessagesWithNullEmbeddings(offset, BATCH_SIZE);

    if (messages.length === 0) {
      console.log('   ✅ No more messages with NULL embeddings');
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
        const embedding = Array.isArray(embeddings[0]) ? embeddings[i] : embeddings;

        const success = await updateMessageEmbedding(msg.message_id, embedding);

        if (success) {
          totalSuccess++;
          console.log(`   ✅ [${totalProcessed + 1}] Updated: ${msg.message_id.substring(0, 20)}...`);
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
      console.error(`   ❌ Batch failed: ${error.message}`);
      totalFailed += messages.length;
    }

    // Rate limit
    await sleep(1000);

    offset += BATCH_SIZE;

    if (LIMIT && totalProcessed >= LIMIT) break;
  }

  // Process chat_turns table
  console.log('\n📦 Processing chat_turns table...');
  offset = 0;
  let turnsProcessed = 0;

  while (true) {
    const turns = await fetchTurnsWithNullEmbeddings(offset, BATCH_SIZE);

    if (turns.length === 0) {
      console.log('   ✅ No more turns with NULL embeddings');
      break;
    }

    console.log(`   Processing batch at offset ${offset}: ${turns.length} turns`);

    const texts = turns.map(t => t.content || '');

    try {
      const embeddings = await generateQwen3Embeddings(texts);

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const embedding = Array.isArray(embeddings[0]) ? embeddings[i] : embeddings;

        const success = await updateTurnEmbedding(turn.id, embedding);

        if (success) {
          totalSuccess++;
          turnsProcessed++;
          console.log(`   ✅ [${turnsProcessed}] Updated turn: ${turn.id.substring(0, 20)}...`);
        } else {
          totalFailed++;
        }
      }

    } catch (error) {
      console.error(`   ❌ Batch failed: ${error.message}`);
      totalFailed += turns.length;
    }

    await sleep(1000);
    offset += BATCH_SIZE;
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('\n📊 Backfill Summary');
  console.log('═'.repeat(40));
  console.log(`   Total processed: ${totalProcessed + turnsProcessed}`);
  console.log(`   Successful: ${totalSuccess}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`   Time elapsed: ${elapsed} minutes`);
  console.log(`   Dry run: ${DRY_RUN}`);
  console.log('');

  if (DRY_RUN) {
    console.log('💡 Run without --dry-run to apply changes');
  } else {
    console.log('✅ Backfill complete!');
    console.log('');
    console.log('Verify with:');
    console.log('  SELECT COUNT(*) FROM messages WHERE embedding IS NULL;');
    console.log('  SELECT vector_dims(embedding) FROM messages WHERE embedding IS NOT NULL LIMIT 1;');
  }
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});

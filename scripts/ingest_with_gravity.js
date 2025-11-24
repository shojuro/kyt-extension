#!/usr/bin/env node

/**
 * Ingest conversations with Temporal Decay (Gravity Scoring)
 *
 * This script ingests conversation data and calls the save_chat_turn Edge Function
 * to automatically classify memories with impact + intimacy scores.
 *
 * Usage:
 *   1. Export conversations to conversation_export.json
 *   2. Run: node scripts/ingest_with_gravity.js
 *
 * Expected format: conversation_export.json
 * [
 *   {
 *     "content": "Conversation text...",
 *     "speakers": ["User", "Assistant"],
 *     "topics": ["topic1", "topic2"],
 *     "timestamp": 1234567890,
 *     "conversation_id": "optional-id"
 *   }
 * ]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuration
const CONFIG = {
  embeddingModel: 'text-embedding-3-small',
  platform: 'cli',
  conversationFile: 'conversation_export.json',
  rateLimitMs: 1000 // 1 second between requests
};

// Initialize clients
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.OPENAI_API_KEY) {
  console.error('❌ Missing required environment variables in .env');
  console.error('   Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });

// Get user ID from environment or use default
const USER_ID = process.env.USER_ID || process.env.SUPABASE_USER_ID;
if (!USER_ID) {
  console.error('❌ Missing USER_ID environment variable');
  console.error('   Add to .env: USER_ID=your-user-uuid');
  process.exit(1);
}

async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: CONFIG.embeddingModel,
      input: text,
      encoding_format: 'float'
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error(`❌ Embedding failed: ${error.message}`);
    throw error;
  }
}

async function ingestConversation(conversation, index, total) {
  console.log(`\n📝 Processing conversation ${index + 1}/${total}`);
  console.log(`   Content preview: "${conversation.content.substring(0, 60)}..."`);

  try {
    // 1. Generate embedding
    console.log('   🔢 Generating embedding...');
    const embedding = await generateEmbedding(conversation.content);

    // 2. Call save_chat_turn Edge Function (with classification)
    console.log('   🤖 Calling Edge Function for AI classification...');
    const edgeFunctionUrl = `${supabaseUrl}/functions/v1/save_chat_turn`;

    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({
        user_id: USER_ID,
        content: conversation.content,
        turn_range: conversation.turn_range || '1-1',
        conversation_id: conversation.conversation_id || `import-${Date.now()}-${index}`,
        platform: conversation.platform || CONFIG.platform,
        speakers: conversation.speakers || ['User', 'Assistant'],
        turn_count: conversation.turn_count || 1,
        start_timestamp: conversation.timestamp || Date.now(),
        end_timestamp: conversation.timestamp || Date.now(),
        topics: conversation.topics || ['imported'],
        embedding: embedding
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Edge Function failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    if (result.success) {
      console.log(`   ✅ Saved with classification:`);
      console.log(`      Impact: ${result.classification.impact_score}/100`);
      console.log(`      Intimacy: ${result.classification.intimacy_level}/3`);
      console.log(`      Reasoning: ${result.classification.reasoning}`);
      return { success: true, id: result.id, classification: result.classification };
    } else {
      throw new Error(result.error || 'Unknown error');
    }

  } catch (error) {
    console.error(`   ❌ Failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function ingestAll() {
  try {
    console.log('🚀 Starting Conversation Ingestion with Gravity Scoring\n');

    // Read conversation file
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const conversationPath = path.join(__dirname, '..', CONFIG.conversationFile);

    console.log(`📂 Reading: ${conversationPath}`);
    const rawData = await fs.readFile(conversationPath, 'utf-8');
    const conversations = JSON.parse(rawData);

    console.log(`📦 Loaded ${conversations.length} conversations\n`);

    // Process each conversation
    const results = {
      success: 0,
      failed: 0,
      classifications: []
    };

    for (let i = 0; i < conversations.length; i++) {
      const result = await ingestConversation(conversations[i], i, conversations.length);

      if (result.success) {
        results.success++;
        results.classifications.push(result.classification);
      } else {
        results.failed++;
      }

      // Rate limit
      if (i < conversations.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.rateLimitMs));
      }
    }

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  INGESTION COMPLETE                                        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`✅ Successfully ingested: ${results.success}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`📊 Total: ${conversations.length}\n`);

    if (results.classifications.length > 0) {
      const avgImpact = results.classifications.reduce((sum, c) => sum + c.impact_score, 0) / results.classifications.length;
      const avgIntimacy = results.classifications.reduce((sum, c) => sum + c.intimacy_level, 0) / results.classifications.length;

      console.log('📈 Classification Summary:');
      console.log(`   Average Impact: ${avgImpact.toFixed(1)}/100`);
      console.log(`   Average Intimacy: ${avgIntimacy.toFixed(1)}/3\n`);
    }

    console.log('💡 Next steps:');
    console.log('   1. Verify with: SELECT COUNT(*), AVG(impact_score), AVG(intimacy_level) FROM chat_turns;');
    console.log('   2. Test search in your browser extension');
    console.log('   3. Monitor OpenAI API costs\n');

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`\n❌ File not found: ${CONFIG.conversationFile}`);
      console.error('\n📝 Create this file with your conversations:');
      console.error(`
[
  {
    "content": "Your conversation text here...",
    "speakers": ["User", "Assistant"],
    "topics": ["topic1", "topic2"],
    "timestamp": ${Date.now()}
  }
]
`);
    } else {
      console.error('\n❌ Ingestion failed:', error.message);
    }
    process.exit(1);
  }
}

ingestAll();

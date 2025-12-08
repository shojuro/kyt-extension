#!/usr/bin/env node

/**
 * Retest Tier-Based Classification System
 *
 * Purpose: Validate tier system against 35 test conversations
 *
 * What this does:
 * 1. Clears old test data from database
 * 2. Re-ingests 35 test conversations with tier-based classifier
 * 3. Displays results with tier labels for easy comparison
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const USER_ID = process.env.USER_ID;
const CONFIG = {
  platform: 'cli',
  delayBetweenCalls: 500 // ms
};

// Tier value mapping (for reference)
const TIER_MAP = {
  95: 'CORE',
  75: 'MAJOR',
  50: 'MODERATE',
  20: 'MINOR',
  5: 'NONE'
};

async function clearOldTestData() {
  console.log('\n🗑️  Clearing old test data...');

  const { error } = await supabase
    .from('chat_turns')
    .delete()
    .eq('user_id', USER_ID);

  if (error) {
    console.error('Error clearing data:', error.message);
    throw error;
  }

  console.log('   ✅ Old data cleared\n');
}

async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return response.data[0].embedding;
}

async function ingestConversation(conversation, index, total) {
  console.log(`📝 ${index + 1}/${total}: Processing...`);

  try {
    // 1. Generate embedding
    const embedding = await generateEmbedding(conversation.content);

    // 2. Call save_chat_turn Edge Function (with tier-based classification)
    const edgeFunctionUrl = `${process.env.SUPABASE_URL}/functions/v1/save_chat_turn`;

    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        user_id: USER_ID,
        content: conversation.content,
        turn_range: conversation.turn_range || '1-3',
        conversation_id: conversation.conversation_id || `retest-${Date.now()}-${index}`,
        platform: CONFIG.platform,
        speakers: conversation.speakers || ['User', 'Assistant'],
        turn_count: conversation.turn_count || 3,
        start_timestamp: conversation.timestamp || Date.now(),
        end_timestamp: conversation.timestamp || Date.now(),
        topics: conversation.topics || ['test'],
        embedding: embedding
      })
    });

    const result = await response.json();

    if (result.success) {
      const tierLabel = TIER_MAP[result.classification.impact_score] || 'UNKNOWN';

      // Extract first 60 chars of content for display
      const preview = conversation.content.split('\n')[0].substring(0, 60);

      console.log(`   ✅ Tier: ${tierLabel} (${result.classification.impact_score}), Intimacy: ${result.classification.intimacy_level}/3`);
      console.log(`      "${preview}..."`);
      console.log(`      ${result.classification.reasoning}\n`);

      return {
        success: true,
        content_preview: preview,
        tier: tierLabel,
        impact: result.classification.impact_score,
        intimacy: result.classification.intimacy_level,
        reasoning: result.classification.reasoning
      };
    } else {
      console.error(`   ❌ Failed: ${result.error}\n`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.error(`   ❌ Exception: ${error.message}\n`);
    return { success: false, error: error.message };
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runRetest() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TIER-BASED CLASSIFICATION SYSTEM RETEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Load test conversations
  const conversationsFile = 'conversation_export_multiturn_50.json';

  if (!fs.existsSync(conversationsFile)) {
    console.error(`❌ Test file not found: ${conversationsFile}`);
    process.exit(1);
  }

  const conversations = JSON.parse(fs.readFileSync(conversationsFile, 'utf8'));

  console.log(`📊 Loaded ${conversations.length} test conversations\n`);

  // 2. Clear old data
  await clearOldTestData();

  // 3. Ingest all conversations
  console.log('🔄 Starting ingestion with tier-based classifier...\n');

  const results = [];

  for (let i = 0; i < conversations.length; i++) {
    const result = await ingestConversation(conversations[i], i, conversations.length);
    results.push(result);

    // Rate limiting
    if (i < conversations.length - 1) {
      await delay(CONFIG.delayBetweenCalls);
    }
  }

  // 4. Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ Successful: ${successful.length}/${conversations.length}`);
  console.log(`❌ Failed: ${failed.length}/${conversations.length}\n`);

  // Tier distribution
  const tierCounts = {
    CORE: 0,
    MAJOR: 0,
    MODERATE: 0,
    MINOR: 0,
    NONE: 0
  };

  successful.forEach(r => {
    if (r.tier && tierCounts.hasOwnProperty(r.tier)) {
      tierCounts[r.tier]++;
    }
  });

  console.log('📊 Tier Distribution:');
  console.log(`   CORE (95):     ${tierCounts.CORE} conversations`);
  console.log(`   MAJOR (75):    ${tierCounts.MAJOR} conversations`);
  console.log(`   MODERATE (50): ${tierCounts.MODERATE} conversations`);
  console.log(`   MINOR (20):    ${tierCounts.MINOR} conversations`);
  console.log(`   NONE (5):      ${tierCounts.NONE} conversations\n`);

  // Intimacy distribution
  const intimacyCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  successful.forEach(r => {
    if (r.intimacy !== undefined) {
      intimacyCounts[r.intimacy]++;
    }
  });

  console.log('💭 Intimacy Distribution:');
  console.log(`   Level 3 (Core Identity):  ${intimacyCounts[3]} conversations`);
  console.log(`   Level 2 (Personal):       ${intimacyCounts[2]} conversations`);
  console.log(`   Level 1 (Facts):          ${intimacyCounts[1]} conversations`);
  console.log(`   Level 0 (Surface):        ${intimacyCounts[0]} conversations\n`);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Next Step: Compare these results to your cheat sheet');
  console.log('  Focus: Are the TIERS correct? (Not the exact numbers)');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run the retest
runRetest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

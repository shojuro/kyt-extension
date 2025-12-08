#!/usr/bin/env node

/**
 * Test semantic search with gravity ranking
 * Searches for "family health concerns" and shows gravity-ranked results
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function testGravitySearch() {
  console.log('\n🔍 Testing Gravity-Based Search\n');
  
  // 1. Generate query embedding
  const query = "health concerns family";
  console.log(`Query: "${query}"\n`);
  
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  });
  
  const queryEmbedding = response.data[0].embedding;
  
  // 2. Search with gravity ranking
  const { data, error } = await supabase.rpc('match_messages_with_gravity', {
    query_embedding: queryEmbedding,
    match_threshold: 0.5,
    match_count: 5,
    exclude_recent_seconds: 0,
    p_user_id: process.env.USER_ID
  });
  
  if (error) {
    console.error('❌ Search failed:', error.message);
    return;
  }
  
  console.log(`Found ${data.length} results:\n`);
  
  data.forEach((result, i) => {
    console.log(`${i + 1}. Gravity Score: ${result.gravity_score.toFixed(3)}`);
    console.log(`   Vector Similarity: ${result.vector_similarity.toFixed(3)}`);
    console.log(`   Impact: ${result.impact_score}/100, Intimacy: ${result.intimacy_level}/3`);
    console.log(`   Content: "${result.content.substring(0, 80)}..."`);
    console.log(`   Access Count: ${result.access_count}\n`);
  });
  
  console.log('💡 Notice: Father\'s cancer memory should rank highest due to gravity!\n');
}

testGravitySearch();

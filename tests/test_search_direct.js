#!/usr/bin/env node

/**
 * Test semantic search with direct SQL query
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
  
  // 2. Direct SQL query with gravity calculation
  const { data, error } = await supabase.rpc('sql', {
    query: `
      SELECT
        LEFT(content, 80) as preview,
        (1 - (embedding <=> $1::vector)) as vector_similarity,
        impact_score,
        intimacy_level,
        calculate_gravity_score(
          1 - (embedding <=> $1::vector),
          COALESCE(impact_score, 0),
          COALESCE(intimacy_level, 0),
          created_at,
          COALESCE(last_accessed, created_at),
          COALESCE(access_count, 0)
        ) as gravity_score,
        access_count
      FROM chat_turns
      WHERE user_id = $2::uuid
        AND (1 - (embedding <=> $1::vector)) > 0.5
      ORDER BY gravity_score DESC
      LIMIT 5
    `,
    params: [queryEmbedding, process.env.USER_ID]
  });
  
  if (error) {
    console.error('❌ Search failed:', error.message);
    
    // Try simpler query
    console.log('\n📊 Showing all memories with their gravity potential:\n');
    
    const { data: allData } = await supabase
      .from('chat_turns')
      .select('content, impact_score, intimacy_level, created_at, access_count')
      .eq('user_id', process.env.USER_ID)
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (allData) {
      allData.forEach((row, i) => {
        const importance = 1.0 + (row.impact_score / 100) + (row.intimacy_level * 0.2);
        console.log(`${i + 1}. "${row.content.substring(0, 60)}..."`);
        console.log(`   Impact: ${row.impact_score}/100, Intimacy: ${row.intimacy_level}/3`);
        console.log(`   Importance Multiplier: ${importance.toFixed(2)}x`);
        console.log(`   (Higher multiplier = slower decay)\n`);
      });
    }
    return;
  }
  
  console.log(`Found ${data.length} results:\n`);
  
  data.forEach((result, i) => {
    console.log(`${i + 1}. Gravity Score: ${result.gravity_score.toFixed(3)}`);
    console.log(`   Vector Similarity: ${result.vector_similarity.toFixed(3)}`);
    console.log(`   Impact: ${result.impact_score}/100, Intimacy: ${result.intimacy_level}/3`);
    console.log(`   Content: "${result.preview}..."`);
    console.log(`   Access Count: ${result.access_count}\n`);
  });
}

testGravitySearch();

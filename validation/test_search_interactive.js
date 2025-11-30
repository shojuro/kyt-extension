#!/usr/bin/env node
/**
 * KYT Interactive Search Tester
 *
 * Tests BM25 + Semantic hybrid search with predefined test cases
 * Inserts test data on first run, then provides interactive menu
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import readline from 'readline';

// Import search functions
import { searchBM25, getAdaptiveWeights, countQueryWords } from '../src/bm25-search.js';

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENAI_API_KEY) {
  console.error('❌ Missing environment variables');
  console.error('   Required: SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Test sentences
const TEST_SENTENCES = [
  {
    content: '@@@ REMEMBER: Blue folder in filing cabinet @@@',
    role: 'user',
    source: 'test_data',
    marker: 'bm25_marker_test'
  },
  {
    content: "My grandmother's peach cobbler recipe uses bourbon-soaked peaches and a crumbly oat topping.",
    role: 'user',
    source: 'test_data',
    marker: 'semantic_concept_test'
  },
  {
    content: 'The mitochondria is the powerhouse of the cell - learned that in Biology 101.',
    role: 'user',
    source: 'test_data',
    marker: 'hybrid_test'
  },
  {
    content: 'Flight booking ref: XQ-9847-ZZ',
    role: 'user',
    source: 'test_data',
    marker: 'bm25_code_test'
  },
  {
    content: "Trees communicate through underground fungal networks called mycorrhizal networks or the 'wood wide web'.",
    role: 'user',
    source: 'test_data',
    marker: 'semantic_natural_test'
  }
];

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
};

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return response.data[0].embedding;
}

/**
 * Check if test data already exists
 */
async function checkTestDataExists() {
  const { data, error } = await supabase
    .from('messages')
    .select('content')
    .eq('source', 'test_data')
    .limit(1);

  if (error) throw error;
  return data && data.length > 0;
}

/**
 * Insert test data into database
 */
async function insertTestData() {
  console.log(`\n${colors.cyan}📝 Inserting test data...${colors.reset}\n`);

  for (const [index, sentence] of TEST_SENTENCES.entries()) {
    console.log(`   [${index + 1}/${TEST_SENTENCES.length}] Generating embedding...`);

    const embedding = await generateEmbedding(sentence.content);

    const { error } = await supabase
      .from('messages')
      .insert({
        content: sentence.content,
        role: sentence.role,
        source: sentence.source,
        embedding: embedding,
        msg_timestamp: new Date().toISOString(),
        created_at: new Date().toISOString()
      });

    if (error && error.code !== '23505') { // Ignore duplicate key errors
      console.error(`   ❌ Error inserting: ${error.message}`);
    } else {
      console.log(`   ✅ "${sentence.content.substring(0, 50)}..."`);
    }
  }

  console.log(`\n${colors.green}✅ Test data inserted successfully!${colors.reset}\n`);
}

/**
 * Get all messages from database for local BM25 search
 */
async function getAllMessages() {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Semantic search via Supabase
 */
async function searchSemantic(query, threshold = 0.5, limit = 10) {
  const queryEmbedding = await generateEmbedding(query);

  const { data, error } = await supabase.rpc('match_messages', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
    exclude_recent_seconds: 0  // For testing, include all messages (no temporal filter)
  });

  if (error) throw error;
  return data || [];
}

/**
 * Hybrid search (BM25 + Semantic with RRF)
 */
async function searchHybrid(query, localMessages, options = {}) {
  const { limit = 5, bm25Threshold = 0.1, semanticThreshold = 0.5 } = options;

  const weights = getAdaptiveWeights(query);

  console.log(`\n${colors.cyan}🔍 Searching for: "${query}"${colors.reset}`);
  console.log(`   Strategy: ${colors.yellow}${weights.strategy}${colors.reset} (${weights.queryLength} words)`);
  console.log(`   Weights: BM25=${colors.blue}${weights.bm25Weight}${colors.reset}, Semantic=${colors.magenta}${weights.semanticWeight}${colors.reset}`);

  // Run BM25 locally
  console.log(`\n   ${colors.blue}🔤 Running BM25 keyword search...${colors.reset}`);
  const bm25Results = searchBM25(query, localMessages, {
    limit: limit * 2,
    threshold: bm25Threshold
  });
  console.log(`      Found ${bm25Results.length} results`);

  // Run semantic via Supabase
  console.log(`   ${colors.magenta}🧠 Running semantic vector search...${colors.reset}`);
  const semanticResults = await searchSemantic(query, semanticThreshold, limit * 2);
  console.log(`      Found ${semanticResults.length} results`);

  // Merge with RRF
  const merged = mergeWithRRF(bm25Results, semanticResults, weights);

  return merged.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion (RRF)
 */
function mergeWithRRF(bm25Results, semanticResults, weights) {
  const k = 60;
  const scoreMap = new Map();

  // Score BM25 results
  bm25Results.forEach((result, index) => {
    const rrfScore = 1 / (k + index + 1);
    const id = result.message_id || result.id;
    scoreMap.set(id, {
      ...result,
      bm25Score: result.score || 0,
      semanticScore: 0,
      rrfScore: rrfScore,
      totalScore: (result.score || 0) * weights.bm25Weight + rrfScore
    });
  });

  // Add semantic results
  semanticResults.forEach((result, index) => {
    const rrfScore = 1 / (k + index + 1);
    const id = result.message_id || result.id;
    const similarity = 1 - (result.distance || 0); // Convert distance to similarity

    if (scoreMap.has(id)) {
      const existing = scoreMap.get(id);
      existing.semanticScore = similarity;
      existing.totalScore =
        existing.bm25Score * weights.bm25Weight +
        similarity * weights.semanticWeight +
        existing.rrfScore +
        rrfScore;
    } else {
      scoreMap.set(id, {
        ...result,
        bm25Score: 0,
        semanticScore: similarity,
        rrfScore: rrfScore,
        totalScore: similarity * weights.semanticWeight + rrfScore
      });
    }
  });

  // Sort by total score
  return Array.from(scoreMap.values())
    .sort((a, b) => b.totalScore - a.totalScore);
}

/**
 * Display search results
 */
function displayResults(results) {
  if (results.length === 0) {
    console.log(`\n   ${colors.red}❌ No results found${colors.reset}\n`);
    return;
  }

  console.log(`\n${colors.bright}=== Results (${results.length} found) ===${colors.reset}\n`);

  results.forEach((result, index) => {
    const bm25 = (result.bm25Score || 0).toFixed(2);
    const semantic = (result.semanticScore || 0).toFixed(2);
    const total = (result.totalScore || 0).toFixed(2);

    // Determine winner
    const bm25Weight = result.bm25Score > result.semanticScore ? colors.blue : colors.reset;
    const semanticWeight = result.semanticScore > result.bm25Score ? colors.magenta : colors.reset;

    console.log(`${colors.bright}[${index + 1}]${colors.reset} Score: ${colors.green}${total}${colors.reset} (BM25: ${bm25Weight}${bm25}${colors.reset}, Semantic: ${semanticWeight}${semantic}${colors.reset})`);
    console.log(`    "${result.content}"`);
    console.log(`    Source: ${result.source} | ${new Date(result.created_at).toLocaleString()}`);
    console.log();
  });
}

/**
 * Interactive menu
 */
async function showMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const localMessages = await getAllMessages();
  console.log(`\n${colors.cyan}📊 Loaded ${localMessages.length} messages from database${colors.reset}`);

  const prompt = () => {
    console.log(`\n${colors.bright}=== KYT Search Tester ===${colors.reset}\n`);
    console.log(`1. ${colors.blue}BM25 Test:${colors.reset} Search for "@@@"`);
    console.log(`2. ${colors.blue}BM25 Test:${colors.reset} Search for "XQ-9847-ZZ"`);
    console.log(`3. ${colors.magenta}Semantic Test:${colors.reset} Search for "grandmother's dessert"`);
    console.log(`4. ${colors.magenta}Semantic Test:${colors.reset} Search for "how trees talk"`);
    console.log(`5. ${colors.yellow}Hybrid Test:${colors.reset} Search for "mitochondria"`);
    console.log(`6. ${colors.yellow}Hybrid Test:${colors.reset} Search for "cell energy"`);
    console.log(`7. ${colors.cyan}Custom query${colors.reset} (enter your own)`);
    console.log(`8. Show all captured messages`);
    console.log(`9. Exit\n`);

    rl.question('Choose option: ', async (answer) => {
      const choice = answer.trim();

      try {
        switch(choice) {
          case '1':
            await testSearch('@@@', localMessages);
            break;
          case '2':
            await testSearch('XQ-9847-ZZ', localMessages);
            break;
          case '3':
            await testSearch("grandmother's dessert", localMessages);
            break;
          case '4':
            await testSearch('how trees talk', localMessages);
            break;
          case '5':
            await testSearch('mitochondria', localMessages);
            break;
          case '6':
            await testSearch('cell energy', localMessages);
            break;
          case '7':
            rl.question('Enter search query: ', async (query) => {
              await testSearch(query, localMessages);
              prompt();
            });
            return;
          case '8':
            showAllMessages(localMessages);
            break;
          case '9':
            console.log(`\n${colors.green}Goodbye!${colors.reset}\n`);
            rl.close();
            process.exit(0);
            return;
          default:
            console.log(`${colors.red}Invalid option${colors.reset}`);
        }
      } catch (error) {
        console.error(`\n${colors.red}❌ Error: ${error.message}${colors.reset}\n`);
      }

      prompt();
    });
  };

  prompt();
}

/**
 * Test a search query
 */
async function testSearch(query, localMessages) {
  const results = await searchHybrid(query, localMessages, {
    limit: 5,
    bm25Threshold: 0.0,
    semanticThreshold: 0.4
  });

  displayResults(results);
}

/**
 * Show all messages
 */
function showAllMessages(messages) {
  console.log(`\n${colors.bright}=== All Messages (${messages.length}) ===${colors.reset}\n`);

  messages.slice(0, 20).forEach((msg, index) => {
    const preview = msg.content.substring(0, 80);
    const isTest = msg.source === 'test_data' ? `${colors.cyan}[TEST]${colors.reset}` : '';
    console.log(`${colors.bright}[${index + 1}]${colors.reset} ${isTest} ${preview}${msg.content.length > 80 ? '...' : ''}`);
    console.log(`    Source: ${msg.source} | ${new Date(msg.created_at).toLocaleString()}\n`);
  });

  if (messages.length > 20) {
    console.log(`${colors.yellow}... and ${messages.length - 20} more${colors.reset}\n`);
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log(`\n${colors.bright}${colors.cyan}🧪 KYT Interactive Search Tester${colors.reset}\n`);

  // Check if test data exists
  const hasTestData = await checkTestDataExists();

  if (!hasTestData) {
    console.log(`${colors.yellow}⚠️  No test data found in database${colors.reset}`);
    console.log(`   This script will insert 5 test sentences for search validation.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question('Insert test data now? (y/n): ', resolve);
    });

    rl.close();

    if (answer.toLowerCase() === 'y') {
      await insertTestData();
    } else {
      console.log(`\n${colors.yellow}⚠️  Skipping test data insertion${colors.reset}`);
      console.log(`   You can run this script again to insert test data later.\n`);
    }
  } else {
    console.log(`${colors.green}✅ Test data found in database${colors.reset}\n`);
  }

  // Show interactive menu
  await showMenu();
}

// Run
main().catch(error => {
  console.error(`\n${colors.red}❌ Fatal error: ${error.message}${colors.reset}\n`);
  process.exit(1);
});

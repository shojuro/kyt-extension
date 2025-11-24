/**
 * MMR Keyword Coverage Validation Script
 *
 * Tests whether MMR's diversity objective (λ=0.3) de-ranks keyword-rich candidates
 * in favor of variety, justifying a BM25 keyword boost.
 *
 * Validation Criteria (per user feedback):
 * - Proceed if: >10% of general queries show keyword mismatch, OR
 * - ANY entity query ranks lower-keyword-coverage item higher
 *
 * Rationale: "Entity queries are your power users' bread and butter.
 * Even a single mismatch justifies the fix since these queries have
 * disproportionate value."
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Test colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

// Test queries (10 entity + 10 general)
const ENTITY_QUERIES = [
  "Tell me about Jennifer's startup idea",
  "What did Michael say about the project timeline",
  "Sarah's recommendation for the database",
  "PostgreSQL configuration settings we discussed",
  "MongoDB vs PostgreSQL performance comparison",
  "React hooks tutorial Jennifer mentioned",
  "Python async await pattern Sarah explained",
  "Docker compose setup Michael shared",
  "TypeScript interface definitions we reviewed",
  "AWS Lambda cold start optimization tips"
];

const GENERAL_QUERIES = [
  "How do I implement authentication",
  "Explain async programming patterns",
  "What are best practices for API design",
  "Database indexing strategies",
  "Machine learning model deployment",
  "Frontend performance optimization",
  "Error handling in production systems",
  "Caching strategies for web apps",
  "Security best practices for APIs",
  "Scaling microservices architecture"
];

/**
 * Calculate keyword coverage for a document given a query
 */
function calculateKeywordCoverage(query, documentContent) {
  const queryTerms = query.toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 2 && !['the', 'and', 'for', 'with'].includes(term));

  const contentLower = documentContent.toLowerCase();
  const matchedTerms = queryTerms.filter(term => contentLower.includes(term)).length;

  return {
    coverage: matchedTerms / queryTerms.length,
    matchedTerms,
    totalTerms: queryTerms.length
  };
}

/**
 * Search using MMR (simulates current system)
 */
async function searchWithMMR(query) {
  // Simulate semantic search + MMR
  // In reality, this would call the full search pipeline
  // For validation, we'll use a simplified version

  const { data, error } = await supabase.rpc('search_memories_mmr', {
    query_text: query,
    user_id_input: process.env.TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
    match_count: 10,
    lambda: 0.3
  });

  if (error) {
    console.error(`${RED}Search error:${RESET}`, error);
    return [];
  }

  // Return top 3 results (typical MMR output)
  return (data || []).slice(0, 3).map(item => ({
    message_id: item.message_id,
    content: item.content,
    weighted_score: item.weighted_score,
    rank: item.rank
  }));
}

/**
 * Analyze results for keyword coverage issues
 */
function analyzeKeywordCoverage(query, results, queryType) {
  console.log(`\n${BLUE}Query (${queryType}):${RESET} "${query}"`);
  console.log('-'.repeat(80));

  const coverageData = results.map((result, idx) => {
    const coverage = calculateKeywordCoverage(query, result.content);
    const preview = result.content.slice(0, 60) + '...';

    console.log(`\n${idx + 1}. [Rank ${result.rank}] Score: ${result.weighted_score.toFixed(3)}`);
    console.log(`   Coverage: ${(coverage.coverage * 100).toFixed(1)}% (${coverage.matchedTerms}/${coverage.totalTerms} terms)`);
    console.log(`   Preview: "${preview}"`);

    return {
      ...result,
      ...coverage,
      rank: idx + 1
    };
  });

  // Check if lower-ranked items have higher keyword coverage
  let hasMismatch = false;
  for (let i = 1; i < coverageData.length; i++) {
    if (coverageData[i].coverage > coverageData[0].coverage) {
      console.log(`\n${YELLOW}⚠️  MISMATCH DETECTED:${RESET}`);
      console.log(`   Item at rank ${coverageData[i].rank} has higher keyword coverage (${(coverageData[i].coverage * 100).toFixed(1)}%)`);
      console.log(`   than top-ranked item (${(coverageData[0].coverage * 100).toFixed(1)}%)`);
      hasMismatch = true;
      break;
    }
  }

  if (!hasMismatch) {
    console.log(`\n${GREEN}✓ No mismatch - keyword coverage aligns with ranking${RESET}`);
  }

  return {
    query,
    queryType,
    hasMismatch,
    coverageData
  };
}

/**
 * Main validation logic
 */
async function validateKeywordBoostNeed() {
  console.log(`${BLUE}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BLUE}  MMR Keyword Coverage Validation${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════════════════════${RESET}\n`);

  console.log('Testing 20 queries (10 entity + 10 general)...\n');

  const entityResults = [];
  const generalResults = [];

  // Test entity queries
  console.log(`${BLUE}\n${'═'.repeat(80)}${RESET}`);
  console.log(`${BLUE}ENTITY QUERIES (High-Value Users)${RESET}`);
  console.log(`${BLUE}${'═'.repeat(80)}${RESET}`);

  for (const query of ENTITY_QUERIES) {
    const results = await searchWithMMR(query);
    if (results.length > 0) {
      const analysis = analyzeKeywordCoverage(query, results, 'ENTITY');
      entityResults.push(analysis);
    }
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Test general queries
  console.log(`${BLUE}\n${'═'.repeat(80)}${RESET}`);
  console.log(`${BLUE}GENERAL QUERIES${RESET}`);
  console.log(`${BLUE}${'═'.repeat(80)}${RESET}`);

  for (const query of GENERAL_QUERIES) {
    const results = await searchWithMMR(query);
    if (results.length > 0) {
      const analysis = analyzeKeywordCoverage(query, results, 'GENERAL');
      generalResults.push(analysis);
    }
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Calculate mismatch statistics
  const entityMismatches = entityResults.filter(r => r.hasMismatch).length;
  const generalMismatches = generalResults.filter(r => r.hasMismatch).length;
  const totalGeneralQueries = generalResults.length;
  const generalMismatchRate = (generalMismatches / totalGeneralQueries) * 100;

  // Display results
  console.log(`\n${BLUE}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BLUE}  VALIDATION RESULTS${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════════════════════${RESET}\n`);

  console.log(`${BLUE}Entity Queries:${RESET}`);
  console.log(`  Tested: ${entityResults.length}`);
  console.log(`  Mismatches: ${entityMismatches} ${entityMismatches > 0 ? RED : GREEN}(${entityMismatches > 0 ? 'FAIL' : 'PASS'})${RESET}`);

  console.log(`\n${BLUE}General Queries:${RESET}`);
  console.log(`  Tested: ${totalGeneralQueries}`);
  console.log(`  Mismatches: ${generalMismatches} (${generalMismatchRate.toFixed(1)}%)`);
  console.log(`  Threshold: >10% triggers implementation`);

  // Decision logic
  console.log(`\n${BLUE}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BLUE}  DECISION${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════════════════════${RESET}\n`);

  const entityCriterion = entityMismatches > 0;
  const generalCriterion = generalMismatchRate > 10;

  if (entityCriterion) {
    console.log(`${RED}✗ Entity Query Criterion: TRIGGERED${RESET}`);
    console.log(`  ${entityMismatches} entity quer${entityMismatches === 1 ? 'y' : 'ies'} show${entityMismatches === 1 ? 's' : ''} keyword coverage mismatch`);
    console.log(`  ${YELLOW}→ Entity queries are power users' bread and butter${RESET}`);
    console.log(`  ${YELLOW}→ Even a single mismatch justifies the fix${RESET}`);
  } else {
    console.log(`${GREEN}✓ Entity Query Criterion: PASS${RESET}`);
    console.log(`  No entity queries show keyword coverage mismatch`);
  }

  if (generalCriterion) {
    console.log(`\n${RED}✗ General Query Criterion: TRIGGERED${RESET}`);
    console.log(`  ${generalMismatchRate.toFixed(1)}% of general queries show mismatch (threshold: >10%)`);
  } else {
    console.log(`\n${GREEN}✓ General Query Criterion: PASS${RESET}`);
    console.log(`  ${generalMismatchRate.toFixed(1)}% of general queries show mismatch (threshold: >10%)`);
  }

  const shouldImplementBoost = entityCriterion || generalCriterion;

  console.log(`\n${'─'.repeat(80)}`);
  if (shouldImplementBoost) {
    console.log(`${RED}⚠️  IMPLEMENT BM25 KEYWORD BOOST${RESET}`);
    console.log(`\n${YELLOW}Rationale:${RESET}`);
    if (entityCriterion) {
      console.log(`  • Entity queries show keyword coverage mismatches`);
      console.log(`  • These represent high-value power user queries`);
    }
    if (generalCriterion) {
      console.log(`  • General queries exceed 10% mismatch threshold`);
    }
    console.log(`\n${YELLOW}Next Steps:${RESET}`);
    console.log(`  1. Implement src/keyword-boost.js`);
    console.log(`  2. Integrate at background.js:889 (after MMR)`);
    console.log(`  3. Expected impact: 5-10% precision boost`);
    console.log(`  4. Implementation time: 2 hours`);
  } else {
    console.log(`${GREEN}✓ BM25 KEYWORD BOOST NOT NEEDED${RESET}`);
    console.log(`\n${GREEN}MMR ranking aligns well with keyword coverage.${RESET}`);
    console.log(`${GREEN}No precision improvement expected from keyword boost.${RESET}`);
  }

  console.log('');

  return {
    entityCriterion,
    generalCriterion,
    shouldImplementBoost,
    stats: {
      entityMismatches,
      generalMismatches,
      generalMismatchRate,
      totalEntityQueries: entityResults.length,
      totalGeneralQueries
    }
  };
}

// Run validation
validateKeywordBoostNeed()
  .then(result => {
    process.exit(result.shouldImplementBoost ? 0 : 1);
  })
  .catch(error => {
    console.error(`${RED}Fatal error:${RESET}`, error);
    process.exit(2);
  });

/**
 * BM25 Keyword Boost Module
 *
 * Applies keyword coverage boost to search results after MMR diversity ranking.
 * Addresses cases where MMR's diversity objective (λ=0.3) may de-rank keyword-rich
 * candidates in favor of variety, particularly important for entity queries.
 *
 * Version: 1.2.1
 * Integration Point: background.js:889 (after MMR, before memory injection)
 * Expected Impact: 5-10% precision improvement
 * Dependencies: Zero (pure JavaScript)
 * Latency: <1ms
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const KEYWORD_BOOST_CONFIG = {
  // Boost configuration
  boostFactor: 0.3,                        // 0-30% score increase based on coverage
  minTermLength: 3,                        // Minimum term length to consider

  // Stopwords to exclude from matching
  stopwords: new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has',
    'what', 'when', 'where', 'which', 'who', 'how', 'why', 'are', 'was',
    'were', 'been', 'being', 'can', 'could', 'should', 'would'
  ]),

  // Feature flags
  enableBoost: true,                       // Master switch for keyword boost
  debugMode: false                         // Enable verbose logging
};

// ============================================================================
// KEYWORD COVERAGE CALCULATION
// ============================================================================

/**
 * Extract meaningful terms from query string
 *
 * @param {string} query - User query
 * @returns {string[]} Array of normalized query terms
 */
function extractQueryTerms(query) {
  if (!query || typeof query !== 'string') {
    return [];
  }

  const queryLower = query.toLowerCase();

  // Normalize possessives: "jennifer's" → "jennifer"
  const normalized = queryLower.replace(/'s\b/g, '');

  // Split on whitespace and punctuation, filter by length and stopwords
  const terms = normalized
    .split(/[\s\-_'.,;:!?()[\]{}]+/)
    .filter(term =>
      term.length >= KEYWORD_BOOST_CONFIG.minTermLength &&
      !KEYWORD_BOOST_CONFIG.stopwords.has(term)
    );

  if (KEYWORD_BOOST_CONFIG.debugMode) {
    console.log('[KeywordBoost] Extracted terms:', terms);
  }

  return terms;
}

/**
 * Calculate keyword coverage for a candidate
 *
 * @param {string[]} queryTerms - Extracted query terms
 * @param {string} content - Candidate content text
 * @returns {Object} Coverage metrics
 */
function calculateCoverage(queryTerms, content) {
  if (queryTerms.length === 0) {
    return {
      coverage: 0,
      matchedTerms: 0,
      totalTerms: 0,
      matchedTermsList: []
    };
  }

  const contentLower = content.toLowerCase();

  const matchedTermsList = queryTerms.filter(term => contentLower.includes(term));
  const matchedTerms = matchedTermsList.length;
  const coverage = matchedTerms / queryTerms.length;

  return {
    coverage,
    matchedTerms,
    totalTerms: queryTerms.length,
    matchedTermsList
  };
}

// ============================================================================
// BOOST APPLICATION
// ============================================================================

/**
 * Apply keyword coverage boost to a single candidate
 *
 * @param {Object} candidate - Search result candidate
 * @param {string[]} queryTerms - Extracted query terms
 * @param {number} boostFactor - Maximum boost factor (default: 0.3)
 * @returns {Object} Candidate with boosted score
 */
function boostCandidate(candidate, queryTerms, boostFactor) {
  const coverage = calculateCoverage(queryTerms, candidate.content);

  // Calculate boost: coverage (0-1) * boostFactor (0.3) = 0-30% increase
  const boost = coverage.coverage * boostFactor;
  const originalScore = candidate.weighted_score || 0;
  const boostedScore = originalScore * (1 + boost);

  if (KEYWORD_BOOST_CONFIG.debugMode) {
    console.log(`[KeywordBoost] ${candidate.message_id}:`);
    console.log(`  Coverage: ${(coverage.coverage * 100).toFixed(1)}% (${coverage.matchedTerms}/${coverage.totalTerms})`);
    console.log(`  Boost: +${(boost * 100).toFixed(1)}%`);
    console.log(`  Score: ${originalScore.toFixed(4)} → ${boostedScore.toFixed(4)}`);
  }

  return {
    ...candidate,
    weighted_score: boostedScore,
    keyword_coverage: coverage.coverage,
    keyword_boost: boost,
    keyword_matched_terms: coverage.matchedTerms,
    original_score: originalScore
  };
}

/**
 * Apply keyword coverage boost to all candidates
 *
 * @param {string} query - User query (original, not transformed)
 * @param {Array<Object>} candidates - Post-MMR candidates (message_id, content, weighted_score)
 * @param {Object} options - Configuration overrides
 * @param {number} [options.boostFactor] - Maximum boost factor (default: 0.3)
 * @param {boolean} [options.debugMode] - Enable verbose logging (default: false)
 * @returns {Array<Object>} Candidates with keyword boost applied, re-sorted by boosted score
 *
 * @example
 * const results = applyKeywordBoost(
 *   "Jennifer's startup idea",
 *   [
 *     { message_id: 'abc', content: 'Jennifer founded an AI tutoring startup...', weighted_score: 0.72 },
 *     { message_id: 'def', content: 'The startup focuses on personalized learning...', weighted_score: 0.68 },
 *     { message_id: 'ghi', content: 'Jennifer mentioned her pitch deck...', weighted_score: 0.65 }
 *   ],
 *   { boostFactor: 0.3, debugMode: true }
 * );
 * // Returns candidates with boosted scores, re-sorted by boosted score
 */
export function applyKeywordBoost(query, candidates, options = {}) {
  // Merge options with defaults
  const config = {
    boostFactor: options.boostFactor ?? KEYWORD_BOOST_CONFIG.boostFactor,
    debugMode: options.debugMode ?? KEYWORD_BOOST_CONFIG.debugMode
  };

  // Check if boost is enabled
  if (!KEYWORD_BOOST_CONFIG.enableBoost) {
    if (config.debugMode) {
      console.log('[KeywordBoost] Boost disabled, returning candidates unchanged');
    }
    return candidates;
  }

  // Validate inputs
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    console.warn('[KeywordBoost] Invalid query, returning candidates unchanged');
    return candidates;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (config.debugMode) {
      console.log('[KeywordBoost] No candidates to boost');
    }
    return candidates;
  }

  if (config.debugMode) {
    console.log(`[KeywordBoost] Boosting ${candidates.length} candidates for query: "${query}"`);
  }

  // Extract query terms
  const queryTerms = extractQueryTerms(query);

  if (queryTerms.length === 0) {
    if (config.debugMode) {
      console.log('[KeywordBoost] No meaningful query terms, returning candidates unchanged');
    }
    return candidates;
  }

  // Apply boost to each candidate
  const boostedCandidates = candidates.map(candidate =>
    boostCandidate(candidate, queryTerms, config.boostFactor)
  );

  // Re-sort by boosted score (descending)
  boostedCandidates.sort((a, b) => b.weighted_score - a.weighted_score);

  if (config.debugMode) {
    console.log('[KeywordBoost] Boost complete, candidates re-sorted');
  }

  return boostedCandidates;
}

// ============================================================================
// CONFIGURATION API
// ============================================================================

/**
 * Update keyword boost configuration
 *
 * @param {Object} updates - Configuration updates
 */
export function updateConfig(updates) {
  Object.assign(KEYWORD_BOOST_CONFIG, updates);

  if (KEYWORD_BOOST_CONFIG.debugMode) {
    console.log('[KeywordBoost] Configuration updated:', updates);
  }
}

/**
 * Get current configuration
 *
 * @returns {Object} Current configuration
 */
export function getConfig() {
  return { ...KEYWORD_BOOST_CONFIG };
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export const __testing__ = {
  extractQueryTerms,
  calculateCoverage,
  boostCandidate,
  getConfig: () => KEYWORD_BOOST_CONFIG
};

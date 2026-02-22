/**
 * KYT Phase 3: BM25 Keyword Search
 * 
 * Implements Best Matching 25 (BM25) ranking algorithm for keyword-based search
 * Complements semantic search for short queries and exact keyword matches
 * 
 * User's test markers ("@@@", "K.Y.T.") are short keywords where BM25 excels
 * 
 * Phase 3 Strategy:
 * - BM25 weight 0.7 for queries <5 words (short, keyword-focused)
 * - Semantic weight 0.6 for queries ≥5 words (natural language)
 */

/**
 * Tokenize text into terms (lowercase, alphanumeric + punctuation preserved)
 * Preserves special markers like "@@@", "K.Y.T." for exact matching
 * @param {string} text - Text to tokenize
 * @returns {string[]} Array of terms
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  
  // Lowercase and split on whitespace, preserving punctuation
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 0);
}

/**
 * Calculate term frequency (TF) for a document
 * @param {string[]} tokens - Document tokens
 * @returns {Map<string, number>} Term frequencies
 */
function calculateTermFrequency(tokens) {
  const tf = new Map();
  
  for (const term of tokens) {
    tf.set(term, (tf.get(term) || 0) + 1);
  }
  
  return tf;
}

/**
 * Calculate inverse document frequency (IDF) for a term across corpus
 * IDF = log((N - df + 0.5) / (df + 0.5) + 1)
 * where N = total documents, df = documents containing term
 * 
 * @param {string} term - Query term
 * @param {Array} corpus - Array of {tokens, tf} objects
 * @returns {number} IDF score
 */
function calculateIDF(term, corpus) {
  const N = corpus.length;
  
  // Count documents containing this term
  const df = corpus.filter(doc => doc.tf.has(term)).length;
  
  // BM25 IDF formula (prevents negative IDF for very common terms)
  const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
  
  return idf;
}

/**
 * Calculate BM25 score for a single document
 * BM25(D, Q) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 * 
 * @param {string[]} queryTerms - Query tokens
 * @param {Object} doc - Document with {tokens, tf, length}
 * @param {Object} corpusStats - {avgDocLength, idfScores}
 * @param {number} k1 - Term frequency saturation parameter (default: 1.5)
 * @param {number} b - Length normalization parameter (default: 0.75)
 * @returns {number} BM25 score
 */
function calculateBM25Score(queryTerms, doc, corpusStats, k1 = 1.5, b = 0.75) {
  const { avgDocLength, idfScores } = corpusStats;
  const docLength = doc.length;
  
  let score = 0;
  
  for (const term of queryTerms) {
    const idf = idfScores.get(term) || 0;
    const termFreq = doc.tf.get(term) || 0;
    
    if (termFreq === 0) continue; // Skip terms not in document
    
    // BM25 formula
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLength / avgDocLength));
    
    score += idf * (numerator / denominator);
  }
  
  return score;
}

/**
 * Perform BM25 keyword search on messages
 * @param {string} query - Search query
 * @param {Array} messages - Array of message objects with {content, ...}
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results to return (default: 5)
 * @param {number} options.threshold - Min BM25 score (default: 0.1)
 * @param {number} options.k1 - TF saturation (default: 1.5)
 * @param {number} options.b - Length normalization (default: 0.75)
 * @returns {Array} Ranked results with BM25 scores
 */
export function searchBM25(query, messages, options = {}) {
  const {
    limit = 5,
    threshold = 0.1,
    k1 = 1.5,
    b = 0.75
  } = options;
  
  if (!query || !messages || messages.length === 0) {
    return [];
  }
  
  // Tokenize query
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return [];
  }
  
  // Build corpus (tokenize and calculate TF for all documents)
  // Use contextual_content when available — includes topic keywords from context prefix
  const corpus = messages.map(msg => {
    const tokens = tokenize(msg.contextual_content || msg.content);
    const tf = calculateTermFrequency(tokens);
    
    return {
      message: msg,
      tokens,
      tf,
      length: tokens.length
    };
  });
  
  // Calculate corpus statistics
  const avgDocLength = corpus.reduce((sum, doc) => sum + doc.length, 0) / corpus.length;
  
  // Calculate IDF for each query term
  const idfScores = new Map();
  for (const term of queryTerms) {
    idfScores.set(term, calculateIDF(term, corpus));
  }
  
  const corpusStats = { avgDocLength, idfScores };
  
  // Score all documents
  const scoredResults = corpus.map(doc => {
    const bm25Score = calculateBM25Score(queryTerms, doc, corpusStats, k1, b);
    
    return {
      ...doc.message,
      bm25_score: bm25Score
    };
  });
  
  // Filter by threshold and sort by score
  const results = scoredResults
    .filter(r => r.bm25_score >= threshold)
    .sort((a, b) => b.bm25_score - a.bm25_score)
    .slice(0, limit);
  
  return results;
}

/**
 * Count words in query (for adaptive weighting)
 * @param {string} query - Search query
 * @returns {number} Word count
 */
export function countQueryWords(query) {
  return tokenize(query).length;
}

/**
 * Determine if query is short (keyword-focused) or long (natural language)
 * Short queries (<5 words) → BM25 dominant (weight 0.7)
 * Long queries (≥5 words) → Semantic dominant (weight 0.6)
 * 
 * @param {string} query - Search query
 * @returns {boolean} True if query is short
 */
export function isShortQuery(query) {
  return countQueryWords(query) < 5;
}

/**
 * Get adaptive weights for hybrid search based on query length
 * @param {string} query - Search query
 * @returns {Object} {bm25Weight, semanticWeight}
 */
export function getAdaptiveWeights(query) {
  const isShort = isShortQuery(query);
  
  return {
    bm25Weight: isShort ? 0.7 : 0.4,      // BM25 dominates short queries
    semanticWeight: isShort ? 0.3 : 0.6,  // Semantic dominates long queries
    queryLength: countQueryWords(query),
    strategy: isShort ? 'keyword-focused' : 'semantic-focused'
  };
}

/**
 * Test/debug: Show BM25 scores for query
 * @param {string} query - Search query  
 * @param {Array} messages - Messages to search
 * @param {number} topK - Number of top results to show (default: 10)
 */
export function debugBM25(query, messages, topK = 10) {
  console.log(`\n🔍 BM25 Debug: "${query}"`);
  console.log(`   Query length: ${countQueryWords(query)} words`);
  
  const weights = getAdaptiveWeights(query);
  console.log(`   Strategy: ${weights.strategy}`);
  console.log(`   Weights: BM25=${weights.bm25Weight}, Semantic=${weights.semanticWeight}`);
  
  const results = searchBM25(query, messages, { limit: topK, threshold: 0.0 });
  
  console.log(`\n📊 Top ${Math.min(topK, results.length)} BM25 Results:`);
  results.forEach((r, i) => {
    const preview = r.content.substring(0, 60).replace(/\n/g, ' ');
    console.log(`   ${i + 1}. [score: ${r.bm25_score.toFixed(4)}] ${preview}...`);
  });
}

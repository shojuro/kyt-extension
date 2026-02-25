/**
 * MMR (Maximal Marginal Relevance) Implementation
 * 
 * Purpose: Rerank search results to balance relevance and diversity
 * Critical for: Preventing similar results from dominating (e.g., "Jennifer" vs "Jenn")
 * 
 * Algorithm:
 * 1. Start with highest-relevance item
 * 2. For each subsequent item, score = λ * relevance - (1-λ) * max_similarity_to_selected
 * 3. Select item with highest MMR score
 * 4. Repeat until desired count reached
 * 
 * Parameters:
 * - lambda (λ): Trade-off between relevance and diversity (0.5 = balanced, 0.7 = favor relevance, 0.3 = favor diversity)
 * - Higher λ = more weight on relevance
 * - Lower λ = more weight on diversity
 * 
 * References:
 * - Original paper: Carbonell & Goldstein (1998) "The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries"
 * - pgvector cosine distance: 0 (identical) to 2 (opposite)
 */

/**
 * Calculate cosine similarity from pgvector distance
 * pgvector uses cosine distance: distance = 1 - similarity
 * So: similarity = 1 - distance
 * 
 * @param {number} distance - Cosine distance from pgvector (0 to 2)
 * @returns {number} Cosine similarity (-1 to 1, typically 0 to 1 for normalized vectors)
 */
function distanceToSimilarity(distance) {
  return 1 - distance;
}

/**
 * Calculate similarity to relevance score (0 to 1)
 * Higher similarity = higher relevance
 * 
 * @param {number} similarity - Cosine similarity (-1 to 1)
 * @returns {number} Relevance score (0 to 1)
 */
function similarityToRelevance(similarity) {
  // Normalize from [-1, 1] to [0, 1]
  return (similarity + 1) / 2;
}

/**
 * Calculate cosine similarity between two embeddings
 * Used for computing similarity between candidate items
 * 
 * @param {number[]} embedding1 - First embedding vector
 * @param {number[]} embedding2 - Second embedding vector
 * @returns {number} Cosine similarity (-1 to 1)
 */
function cosineSimilarity(embedding1, embedding2) {
  if (!embedding1 || !embedding2) {
    throw new Error('Both embeddings required for similarity calculation');
  }

  if (embedding1.length !== embedding2.length) {
    throw new Error(`Embedding dimension mismatch: ${embedding1.length} vs ${embedding2.length}`);
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  // Avoid division by zero
  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

/**
 * Extract entity identifiers from content for deduplication
 *
 * Heuristics:
 * 1. Use 'entity' field if present (from test data)
 * 2. Extract proper nouns (capitalized words) from content
 * 3. Normalize to lowercase for matching
 *
 * @param {Object} item - Candidate item with content field
 * @returns {Set<string>} Set of entity identifiers
 */
// Words that frequently appear capitalized at sentence boundaries but are not entities.
// Filters false positives like Recency boost: "the", "based", "if", etc.
const ENTITY_STOP_WORDS = new Set([
  // Articles & determiners
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every',
  'all', 'both', 'few', 'many', 'much', 'most', 'other', 'another', 'such', 'no',
  // Pronouns
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'who', 'whom', 'which', 'what', 'where', 'when',
  'how', 'why', 'one', 'ones',
  // Conjunctions & prepositions
  'and', 'or', 'but', 'nor', 'not', 'for', 'yet', 'so', 'if', 'then', 'than', 'as', 'of', 'in',
  'on', 'at', 'to', 'by', 'with', 'from', 'into', 'about', 'after', 'before', 'between',
  'through', 'during', 'without', 'within', 'along', 'against', 'under', 'over', 'above',
  // Common sentence-starters & transition words
  'however', 'therefore', 'furthermore', 'moreover', 'additionally', 'also', 'although',
  'because', 'since', 'while', 'whereas', 'meanwhile', 'instead', 'otherwise', 'thus',
  'hence', 'still', 'rather', 'indeed', 'perhaps', 'maybe', 'certainly', 'definitely',
  'basically', 'essentially', 'generally', 'typically', 'usually', 'often', 'sometimes',
  'actually', 'really', 'simply', 'just', 'only', 'even', 'already', 'here', 'there',
  // Discourse markers frequently capitalized
  'based', 'given', 'note', 'please', 'sure', 'yes', 'no', 'well', 'now', 'first',
  'second', 'third', 'next', 'finally', 'overall', 'currently', 'recently', 'today',
  // Common verbs that get capitalized at sentence boundaries
  'want', 'try', 'let', 'run', 'add', 'know', 'pick', 'have', 'has', 'had', 'need',
  'like', 'make', 'take', 'look', 'use', 'say', 'said', 'got', 'get', 'set', 'put',
  'keep', 'come', 'go', 'went', 'think', 'thought', 'see', 'saw', 'seem', 'call',
  'show', 'tell', 'give', 'find', 'start', 'end', 'move', 'turn', 'read', 'done',
  'did', 'does', 'do', 'been', 'were', 'was', 'am', 'are', 'is',
  // Numbers (regex catches capitalized "Two", "Three" etc.)
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  // Common nouns/adjectives that are never proper nouns
  'item', 'none', 'top', 'right', 'thing', 'way', 'part', 'something', 'nothing',
  'everything', 'anything', 'enough', 'several', 'being', 'quite', 'pretty',
  'worth', 'real', 'new', 'old', 'good', 'bad', 'same', 'different', 'last', 'users',
  // Adjectives & short modifiers that appear as false entities
  'wrong', 'short', 'fair', 'long', 'full', 'high', 'low', 'big', 'small',
  'hard', 'easy', 'free', 'open', 'close', 'best', 'worst', 'less', 'more',
  'back', 'own', 'able', 'likely', 'possible', 'available', 'important',
  // Contraction fragments (e.g. "Don't" → regex extracts "Don" → lowercased "don")
  'don', 'isn', 'didn', 'wasn', 'hasn', 'aren', 'won', 'couldn', 'wouldn', 'shouldn',
  // Informal discourse
  'yeah', 'okay', 'hey', 'thanks', 'sorry',
]);

export function extractEntities(item) {
  const entities = new Set();

  // If explicit entity field exists (test data), use it
  if (item.entity) {
    entities.add(item.entity.toLowerCase());
    return entities;
  }

  // Extract proper nouns from content (capitalized words)
  const content = item.content || '';

  // Pattern: word at start of sentence or after punctuation, or standalone capitalized word
  // This catches names like "Jennifer", "Sarah", "Mike", "Dr. Sarah", "Jenn"
  const properNouns = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) || [];

  properNouns.forEach(noun => {
    // Normalize: lowercase, remove common titles
    const normalized = noun
      .replace(/^(Dr|Mr|Mrs|Ms|Miss)\.\s*/i, '')
      .toLowerCase()
      .trim();

    // Filter out stop words that get capitalized at sentence boundaries
    const words = normalized.split(/\s+/).filter(w => !ENTITY_STOP_WORDS.has(w));
    if (words.length > 0) {
      entities.add(words.join(' '));
    }
  });

  return entities;
}

/**
 * Check if two items refer to the same entity
 *
 * @param {Object} item1 - First item
 * @param {Object} item2 - Second item
 * @returns {boolean} True if items share any entity
 */
function isSameEntity(item1, item2) {
  const entities1 = extractEntities(item1);
  const entities2 = extractEntities(item2);

  // Check for any overlap in entity sets
  for (const entity of entities1) {
    if (entities2.has(entity)) {
      return true;
    }
  }

  return false;
}

/**
 * Apply MMR (Maximal Marginal Relevance) reranking to search results
 *
 * This balances relevance (similarity to query) with diversity (dissimilarity to already-selected items).
 * Critical for preventing similar items from dominating results (e.g., multiple mentions of "Jennifer"
 * vs "Jenn" the dog would be diversified to include both contexts).
 *
 * Same-entity items are handled by MMR's native diversity penalty (embedding similarity),
 * not by hard deduplication. Complementary facts about the same entity can coexist.
 *
 * @param {Array<Object>} candidates - Search results from Supabase, each with:
 *   - distance: number (cosine distance from pgvector)
 *   - embedding: number[] (optional, for inter-item similarity calculation)
 *   - content: string
 *   - entity: string (optional, for explicit entity identification)
 *   - other fields...
 * @param {number} maxResults - Maximum number of results to return
 * @param {number} lambda - Trade-off parameter (0 to 1):
 *   - 1.0 = pure relevance (ignore diversity)
 *   - 0.5 = balanced (default)
 *   - 0.0 = pure diversity (ignore relevance)
 * @param {Object} options - Additional options:
 *   - requireEmbeddings: boolean - If true, throw error if embeddings missing (default: false)
 *   - fallbackToRelevance: boolean - If true and no embeddings, return top-k by relevance (default: true)
 *   - debugMode: boolean - If true, log MMR scoring details (default: false)
 * @returns {Array<Object>} Reranked results (up to maxResults items)
 */
export function applyMMR(candidates, maxResults, lambda = 0.5, options = {}) {
  const {
    requireEmbeddings = false,
    fallbackToRelevance = true,
    debugMode = false,
  } = options;

  // Validate inputs
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  if (maxResults <= 0) {
    return [];
  }

  if (lambda < 0 || lambda > 1) {
    throw new Error('Lambda must be between 0 and 1');
  }

  // If we don't need MMR (only 1 result or only 1 candidate), return top result
  if (maxResults === 1 || candidates.length === 1) {
    return candidates.slice(0, 1);
  }

  // Check if embeddings are available for inter-item similarity
  const hasEmbeddings = candidates.every(c => Array.isArray(c.embedding) && c.embedding.length > 0);

  if (!hasEmbeddings) {
    if (requireEmbeddings) {
      throw new Error('MMR requires embeddings for all candidates');
    }

    if (fallbackToRelevance) {
      if (debugMode) {
        console.log('⚠️ MMR: No embeddings available, falling back to relevance ranking');
      }
      // Sort by distance (ascending = most relevant first) and return top-k
      return candidates
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxResults);
    }

    // No fallback, return empty
    return [];
  }

  // MMR algorithm
  const selected = [];
  const remaining = [...candidates];

  if (debugMode) {
    console.log(`🎯 MMR: Starting with ${candidates.length} candidates, selecting ${maxResults}, λ=${lambda}`);
  }

  // Step 1: Select the most relevant item (lowest distance)
  remaining.sort((a, b) => a.distance - b.distance);
  const firstItem = remaining.shift();
  selected.push(firstItem);

  if (debugMode) {
    const firstRelevance = distanceToSimilarity(firstItem.distance);
    console.log(`   1. Selected (most relevant): distance=${firstItem.distance.toFixed(3)}, similarity=${firstRelevance.toFixed(3)}, content="${firstItem.content.substring(0, 50)}..."`);
  }

  // Step 2: Iteratively select items with highest MMR score
  while (selected.length < maxResults && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];

      // Relevance score (similarity to query)
      let relevance = similarityToRelevance(distanceToSimilarity(candidate.distance));

      // Apply custom boost if provided (e.g., for taxonomy boosting)
      if (options.boostFunction) {
        const boost = options.boostFunction(candidate);
        if (boost !== 0) {
          const oldRelevance = relevance;
          relevance = Math.min(1.0, relevance + boost); // Additive boost, capped at 1.0
          if (debugMode && boost > 0) {
            console.log(`   🚀 Boost applied: +${boost.toFixed(2)} (relevance ${oldRelevance.toFixed(3)} -> ${relevance.toFixed(3)}) for "${candidate.content.substring(0, 20)}..."`);
          }
        }
      }

      // Max similarity to any selected item (diversity penalty)
      let maxSimilarityToSelected = -Infinity;
      for (const selectedItem of selected) {
        const similarity = cosineSimilarity(candidate.embedding, selectedItem.embedding);
        if (similarity > maxSimilarityToSelected) {
          maxSimilarityToSelected = similarity;
        }
      }

      // MMR score: λ * relevance - (1-λ) * max_similarity_to_selected
      const mmrScore = lambda * relevance - (1 - lambda) * similarityToRelevance(maxSimilarityToSelected);

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }

      if (debugMode && i < 3) { // Log first 3 candidates
        console.log(`   Candidate: relevance=${relevance.toFixed(3)}, max_sim=${maxSimilarityToSelected.toFixed(3)}, MMR=${mmrScore.toFixed(3)}, content="${candidate.content.substring(0, 40)}..."`);
      }
    }

    // If no valid candidate found, stop
    if (bestIndex === -1) {
      if (debugMode) {
        console.log(`   ⚠️  No more candidates available, stopping at ${selected.length} items`);
      }
      break;
    }

    // Select item with best MMR score
    const selectedItem = remaining.splice(bestIndex, 1)[0];
    selected.push(selectedItem);

    if (debugMode) {
      const selectedRelevance = similarityToRelevance(distanceToSimilarity(selectedItem.distance));
      const selectedEntities = Array.from(extractEntities(selectedItem)).join(', ');
      console.log(`   ${selected.length}. Selected: MMR=${bestScore.toFixed(3)}, relevance=${selectedRelevance.toFixed(3)}, distance=${selectedItem.distance.toFixed(3)}, entities=[${selectedEntities}], content="${selectedItem.content.substring(0, 50)}..."`);
    }
  }

  if (debugMode) {
    console.log(`✅ MMR: Selected ${selected.length} items`);
  }

  return selected;
}

/**
 * Default MMR configuration for KYT
 * 
 * Tuned for "Lonely ICP" use case where precision is critical
 * (e.g., must distinguish "sister Jennifer" from "dog Jenn")
 */
export const MMR_PRESETS = {
  // Balanced: Equal weight to relevance and diversity (default)
  BALANCED: { lambda: 0.5, maxResults: 3 },

  // Precision: Favor diversity to avoid confusion (e.g., Jennifer vs Jenn)
  // Tuned for "Lonely ICP" use case - prevents entity confusion while maintaining relevance
  PRECISION: { lambda: 0.3, maxResults: 3 },

  // Relevance: Favor most relevant items (less diversity)
  // Higher lambda = more weight on relevance = more similar items allowed
  RELEVANCE: { lambda: 0.7, maxResults: 5 },

  // Conservative: Very high diversity, avoid any confusion
  // Lowest lambda = maximum diversity = no similar items
  CONSERVATIVE: { lambda: 0.2, maxResults: 2 }
};

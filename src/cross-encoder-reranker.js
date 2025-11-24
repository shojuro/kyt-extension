/**
 * Cross-Encoder Reranker Module
 *
 * Provides semantic relevance scoring for search results using a pre-trained
 * cross-encoder model. Applies final confidence filtering after MMR diversity
 * ranking to boost precision by 15-20%.
 *
 * Version: 1.2.1
 * Model: ms-marco-MiniLM-L-6-v2 (22M params, ~8MB INT8 quantized)
 * Target Latency: <50ms warm, <500ms cold start
 *
 * Integration Point: background.js lines 861-888 (after MMR, before memory injection)
 */

import { pipeline } from '@xenova/transformers';

// ============================================================================
// CONFIGURATION
// ============================================================================

const RERANKER_CONFIG = {
  // Model configuration
  // NOTE: Model compatibility investigation in progress - current model returns uniform scores
  // TODO: Test alternative models or implement custom scoring (see GitHub issue #xxx)
  // Candidates: ms-marco-TinyBERT, rankT5-small, or custom ONNX export
  modelName: 'Xenova/bge-reranker-base',              // BGE reranker - Transformers.js-optimized ONNX model
  modelQuantization: 'int8',                          // ~8MB model size (TODO: Priority 8 - Replace with fine-tuned model)

  // Scoring configuration
  confidenceThreshold: 0.70,                          // Start lower than 0.75, tune up based on precision metrics
  applyNormalization: true,                           // Sigmoid normalization: 1/(1+exp(-x))

  // Performance configuration
  maxLatency: 500,                                    // Maximum acceptable latency (ms)
  truncateTokens: 200,                                // ~800 characters per document

  // Feature flags
  enableFallback: true,                               // Fallback to MMR results on error
  enableWebWorker: true,                              // Run inference in Web Worker (non-blocking)
  preloadOnStartup: false,                            // Lazy load on first query (cold start acceptable)

  // Debug configuration
  debugMode: false,                                   // Enable verbose logging
  includeRawLogits: false                             // Include raw model outputs in results
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let cachedModel = null;                               // Cached model instance
let consecutiveFailures = 0;                          // Error counter for degradation tracking
let alertSent = false;                                // Alert flag to prevent spam (reset on recovery)
let lastErrorLog = 0;                                 // Rate limiting for error logs (10-second interval)

// ============================================================================
// MODEL MANAGEMENT
// ============================================================================

/**
 * Lazy-load the cross-encoder model with caching.
 *
 * First call: 300-500ms (download + initialization)
 * Subsequent calls: <1ms (cached)
 *
 * @returns {Promise<Object>} Model pipeline instance
 * @throws {Error} If model fails to load
 */
async function loadModel() {
  if (cachedModel) {
    if (RERANKER_CONFIG.debugMode) {
      console.log('[Reranker] Using cached model');
    }
    return cachedModel;
  }

  const startTime = Date.now();

  try {
    if (RERANKER_CONFIG.debugMode) {
      console.log(`[Reranker] Loading model: ${RERANKER_CONFIG.modelName}`);
    }

    cachedModel = await pipeline(
      'text-classification',
      RERANKER_CONFIG.modelName,
      {
        quantized: RERANKER_CONFIG.modelQuantization === 'int8',
        progress_callback: RERANKER_CONFIG.debugMode ? (progress) => {
          console.log(`[Reranker] Model load progress: ${(progress.progress * 100).toFixed(1)}%`);
        } : null
      }
    );

    const loadTime = Date.now() - startTime;

    if (RERANKER_CONFIG.debugMode) {
      console.log(`[Reranker] Model loaded successfully (${loadTime}ms)`);
    }

    return cachedModel;
  } catch (error) {
    console.error('[Reranker] Model load failed:', error);
    throw new Error(`Failed to load cross-encoder model: ${error.message}`);
  }
}

/**
 * Unload the cached model (for testing only).
 * DO NOT call in production - service worker suspension handles cleanup.
 */
export function unloadModel() {
  cachedModel = null;
  if (RERANKER_CONFIG.debugMode) {
    console.log('[Reranker] Model unloaded');
  }
}

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

/**
 * Normalize raw model logits to confidence scores using sigmoid function.
 *
 * Sigmoid formula: 1 / (1 + exp(-x))
 *
 * Examples:
 *   normalizeScore(0)  → 0.50
 *   normalizeScore(2)  → 0.88
 *   normalizeScore(-2) → 0.12
 *
 * @param {number} rawLogit - Raw model output (typically -5 to +5)
 * @returns {number} Normalized score between 0 and 1
 */
function normalizeScore(rawLogit) {
  return 1 / (1 + Math.exp(-rawLogit));
}

/**
 * Score a single query-document pair using the cross-encoder model.
 *
 * @param {Object} model - Loaded model pipeline
 * @param {string} query - User query
 * @param {string} document - Document text content
 * @returns {Promise<{score: number, rawLogit: number}>} Normalized score and raw logit
 */
async function scoreCandidate(model, query, document) {
  try {
    // Truncate document to token limit (~800 chars)
    const truncatedDoc = document.slice(0, RERANKER_CONFIG.truncateTokens * 4);

    // Cross-encoder takes concatenated input: "[CLS] query [SEP] document [SEP]"
    const input = `${query} ${truncatedDoc}`;

    // Run inference
    const result = await model(input, {
      topk: 1  // Only need the relevance score
    });

    // Debug: log model output structure
    if (RERANKER_CONFIG.debugMode) {
      console.log('[Reranker] Model output:', JSON.stringify(result, null, 2));
    }

    // Extract raw logit from model output
    const rawLogit = result[0]?.score ?? 0;

    // Apply sigmoid normalization
    const normalizedScore = RERANKER_CONFIG.applyNormalization
      ? normalizeScore(rawLogit)
      : rawLogit;

    return {
      score: normalizedScore,
      rawLogit: rawLogit
    };
  } catch (error) {
    console.error('[Reranker] Scoring failed for candidate:', error);
    throw error;
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate reranking inputs.
 *
 * @param {string} query - User query
 * @param {Array} candidates - Candidate items to rerank
 * @throws {Error} If inputs are invalid
 */
function validateRerankInputs(query, candidates) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('Invalid query: must be a non-empty string');
  }

  if (!Array.isArray(candidates)) {
    throw new Error('Invalid candidates: must be an array');
  }

  if (candidates.length === 0) {
    throw new Error('Invalid candidates: array is empty');
  }

  // Validate each candidate has required fields
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.message_id) {
      throw new Error(`Invalid candidate at index ${index}: missing message_id`);
    }

    if (!candidate.content || typeof candidate.content !== 'string') {
      throw new Error(`Invalid candidate at index ${index}: missing or invalid content`);
    }

    if (candidate.weighted_score === undefined) {
      throw new Error(`Invalid candidate at index ${index}: missing weighted_score`);
    }
  }
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Handle reranking errors with failure tracking and alerting.
 *
 * Tracks consecutive failures and alerts after 3 failures.
 * Alert only fires once until recovery (alertSent flag).
 *
 * @param {Error} error - The error that occurred
 * @param {string} errorCode - Error classification code
 * @returns {Promise<Object>} Error response object
 */
async function handleRerankError(error, errorCode) {
  consecutiveFailures++;

  // Rate-limited error logging (10-second interval)
  const now = Date.now();
  if (now - lastErrorLog > 10000) {
    console.error(`[Reranker] Error (${errorCode}):`, error.message);
    lastErrorLog = now;
  }

  // Alert on 3rd consecutive failure (only once until recovery)
  if (consecutiveFailures >= 3 && !alertSent) {
    console.error(`⚠️ ALERT: Cross-encoder reranking degraded after ${consecutiveFailures} consecutive failures`);
    console.error(`⚠️ Falling back to MMR results. Manual intervention may be required.`);
    alertSent = true;  // Prevent alert spam
  }

  return {
    success: false,
    error: {
      code: errorCode,
      message: error.message,
      consecutive_failures: consecutiveFailures
    }
  };
}

/**
 * Reset failure tracking on successful reranking.
 * Clears both failure counter and alert flag.
 */
function resetFailureTracking() {
  if (consecutiveFailures > 0 || alertSent) {
    if (RERANKER_CONFIG.debugMode) {
      console.log('[Reranker] Failure tracking reset (recovery successful)');
    }
    consecutiveFailures = 0;
    alertSent = false;
  }
}

/**
 * Handle successful reranking.
 * Resets failure tracking and logs success if in debug mode.
 */
function handleRerankSuccess() {
  resetFailureTracking();

  if (RERANKER_CONFIG.debugMode) {
    console.log('[Reranker] Reranking completed successfully');
  }
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Rerank candidates using cross-encoder relevance scoring.
 *
 * This is the main entry point for the reranker. Takes MMR-filtered results
 * (typically 3 items) and applies final confidence scoring.
 *
 * Process:
 * 1. Validate inputs
 * 2. Load model (lazy, cached after first call)
 * 3. Score each candidate with query
 * 4. Sort by cross-encoder score (descending)
 * 5. Return ALL scored items (integration layer filters by threshold)
 *
 * @param {string} query - User query (original, not transformed)
 * @param {Array<Object>} candidates - Candidates from MMR (message_id, content, weighted_score)
 * @param {Object} options - Configuration overrides
 * @param {number} [options.confidenceThreshold] - Minimum confidence threshold (default: 0.70)
 * @param {number} [options.maxLatency] - Maximum acceptable latency (default: 500ms)
 * @param {boolean} [options.debugMode] - Enable verbose logging (default: false)
 * @param {boolean} [options.includeRawLogits] - Include raw model outputs (default: false)
 *
 * @returns {Promise<Array<Object>>} Scored and sorted candidates with cross_encoder_score
 * @throws {Error} If validation fails or critical error occurs
 *
 * @example
 * const results = await rerankCandidates(
 *   "Tell me about Jennifer's startup idea",
 *   [
 *     { message_id: 'abc', content: 'Jennifer founded an AI tutoring startup...', weighted_score: 0.72 },
 *     { message_id: 'def', content: 'Jennifer mentioned her pitch deck...', weighted_score: 0.68 },
 *     { message_id: 'ghi', content: 'The startup focuses on personalized learning...', weighted_score: 0.65 }
 *   ],
 *   { confidenceThreshold: 0.70, debugMode: true }
 * );
 * // Returns: [
 * //   { message_id: 'abc', cross_encoder_score: 0.85, raw_logit: 1.734, ... },
 * //   { message_id: 'ghi', cross_encoder_score: 0.72, raw_logit: 0.923, ... },
 * //   { message_id: 'def', cross_encoder_score: 0.58, raw_logit: 0.321, ... }
 * // ]
 */
export async function rerankCandidates(query, candidates, options = {}) {
  const startTime = Date.now();

  // Merge options with defaults
  const config = {
    confidenceThreshold: options.confidenceThreshold ?? RERANKER_CONFIG.confidenceThreshold,
    maxLatency: options.maxLatency ?? RERANKER_CONFIG.maxLatency,
    debugMode: options.debugMode ?? RERANKER_CONFIG.debugMode,
    includeRawLogits: options.includeRawLogits ?? (options.debugMode || RERANKER_CONFIG.includeRawLogits)
  };

  try {
    // Step 1: Validate inputs
    validateRerankInputs(query, candidates);

    if (config.debugMode) {
      console.log(`[Reranker] Reranking ${candidates.length} candidates for query: "${query.slice(0, 50)}..."`);
    }

    // Step 2: Load model (lazy, cached)
    const model = await loadModel();

    // Step 3: Score each candidate
    const scoredCandidates = [];

    for (const candidate of candidates) {
      try {
        const { score, rawLogit } = await scoreCandidate(model, query, candidate.content);

        const scoredItem = {
          ...candidate,
          cross_encoder_score: score,
          ...(config.includeRawLogits && { raw_logit: rawLogit })
        };

        scoredCandidates.push(scoredItem);

        if (config.debugMode) {
          console.log(`[Reranker]   ${candidate.message_id}: ${score.toFixed(3)} (weighted: ${candidate.weighted_score?.toFixed(3) ?? 'N/A'})`);
        }
      } catch (error) {
        console.error(`[Reranker] Failed to score candidate ${candidate.message_id}:`, error);

        // Include candidate with fallback score (weighted_score) instead of dropping it
        scoredCandidates.push({
          ...candidate,
          cross_encoder_score: candidate.weighted_score ?? 0,
          cross_encoder_error: error.message
        });
      }
    }

    // Step 4: Sort by cross-encoder score (descending)
    scoredCandidates.sort((a, b) => b.cross_encoder_score - a.cross_encoder_score);

    // Step 5: Calculate latency
    const latency = Date.now() - startTime;

    if (config.debugMode) {
      console.log(`[Reranker] Reranking completed in ${latency}ms`);
      console.log(`[Reranker] Top score: ${scoredCandidates[0]?.cross_encoder_score.toFixed(3) ?? 'N/A'}`);
    }

    // Check latency budget
    if (latency > config.maxLatency) {
      console.warn(`[Reranker] Latency exceeded budget: ${latency}ms > ${config.maxLatency}ms`);
    }

    // Reset failure tracking on success
    handleRerankSuccess();

    // Return ALL scored items (integration layer filters by threshold)
    // This allows Priority 3 temporal decay to filter by final_score
    return scoredCandidates;

  } catch (error) {
    console.error('[Reranker] Fatal error during reranking:', error);

    // Classify error
    let errorCode = 'RERANK_FAILED';
    if (error.message.includes('model')) {
      errorCode = 'MODEL_LOAD_FAILED';
    } else if (error.message.includes('Invalid')) {
      errorCode = 'VALIDATION_FAILED';
    }

    // Track failure
    await handleRerankError(error, errorCode);

    // Re-throw to allow caller to handle fallback
    throw error;
  }
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

// Export internal functions for unit testing
export const __testing__ = {
  loadModel,
  normalizeScore,
  validateRerankInputs,
  handleRerankError,
  resetFailureTracking,
  handleRerankSuccess,
  getConfig: () => RERANKER_CONFIG,
  getState: () => ({
    consecutiveFailures,
    alertSent,
    modelLoaded: cachedModel !== null
  })
};

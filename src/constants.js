/**
 * Centralized configuration constants.
 *
 * EVERY threshold, timeout, and batch size lives here.
 * If you need a new constant, add it here — never hardcode in consumer files.
 */

// ── Confidence Thresholds ────────────────────────────────────────────────
export const CONFIDENCE_THRESHOLD_DEFAULT = 0.40;
export const CONFIDENCE_THRESHOLD_PASSIVE = 0.60;
export const CONFIDENCE_THRESHOLD_HAIKU_OVERRIDE = 0.65;
export const CONFIDENCE_THRESHOLD_RESCUE = 0.35;

// ── Timeouts (ms) ────────────────────────────────────────────────────────
export const TIMEOUT_PIPELINE_MS = 22_000;
export const TIMEOUT_EDGE_FUNCTION_MS = 20_000;
export const TIMEOUT_SEMANTIC_SEARCH_MS = 10_000;
export const TIMEOUT_HYDE_CHAIN_MS = 12_000;
export const TIMEOUT_HUGGINGFACE_MS = 8_000;
export const TIMEOUT_JINA_RERANK_MS = 5_000;
export const TIMEOUT_HAIKU_TIEBREAKER_MS = 2_000;
export const TIMEOUT_QUERY_TRANSFORM_MS = 3_000;
export const TIMEOUT_SYNC_API_MS = 30_000;

// ── Batch Sizes ──────────────────────────────────────────────────────────
export const BATCH_SIZE_SYNC = 5;
export const BATCH_SIZE_EDGE_SYNC = 50;
export const BATCH_SIZE_EMBEDDINGS = 5;

// ── Circuit Breaker ──────────────────────────────────────────────────────
export const CB_FAILURE_THRESHOLD = 3;
export const CB_COOLDOWN_STEPS_MS = [60_000, 120_000, 300_000, 600_000];

// ── Storage Quotas ───────────────────────────────────────────────────────
export const STORAGE_MAX_USAGE_PERCENT = 80;
export const STORAGE_TARGET_USAGE_PERCENT = 70;
export const STORAGE_MIN_MESSAGES_TO_KEEP = 100;

// ── Retry ────────────────────────────────────────────────────────────────
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1_000;

// ── Search Thresholds ────────────────────────────────────────────────────
export const SEMANTIC_THRESHOLD = 0.50;
export const BM25_THRESHOLD = 0.10;
export const HYDE_WEIGHT_DEFAULT = 0.60;

// ── Sync ─────────────────────────────────────────────────────────────────
export const SYNC_DEBOUNCE_MS = 5_000;
export const SYNC_MAX_WAIT_MS = 30_000;

// ── Config Cache ─────────────────────────────────────────────────────────
export const CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;

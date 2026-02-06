/**
 * Shared Embedding Circuit Breaker
 *
 * Persisted in chrome.storage.local (key: kyt_embedding_circuit_breaker).
 * Survives service worker restarts. Shared between sync and search paths
 * so that a 403 during sync immediately prevents wasted search-time API calls.
 */

export const CIRCUIT_BREAKER_STORAGE_KEY = 'kyt_embedding_circuit_breaker';
export const COOLDOWN_STEPS = [60000, 120000, 300000, 600000]; // 1m, 2m, 5m, 10m max

/**
 * Get embedding circuit breaker state from persistent storage
 * @returns {Promise<Object>} Circuit breaker state
 */
export async function getEmbeddingCircuitState() {
  const result = await chrome.storage.local.get([CIRCUIT_BREAKER_STORAGE_KEY]);
  return result[CIRCUIT_BREAKER_STORAGE_KEY] || {
    isOpen: false,
    openedAt: null,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailureMessage: null,
    cooldownMs: COOLDOWN_STEPS[0],
    totalTrips: 0
  };
}

/**
 * Update embedding circuit breaker state in persistent storage
 * @param {Object} updates - Partial state to merge
 */
export async function updateEmbeddingCircuitState(updates) {
  const current = await getEmbeddingCircuitState();
  const newState = { ...current, ...updates };
  await chrome.storage.local.set({ [CIRCUIT_BREAKER_STORAGE_KEY]: newState });
  return newState;
}

/**
 * Check if embedding circuit breaker is open (should skip API calls)
 * If cooldown has expired, returns false (allows one probe request)
 * @returns {Promise<{open: boolean, reason: string|null, waitMs: number}>}
 */
export async function isEmbeddingCircuitOpen() {
  const state = await getEmbeddingCircuitState();

  if (!state.isOpen) {
    return { open: false, reason: null, waitMs: 0 };
  }

  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= state.cooldownMs) {
    // Cooldown expired - allow a probe request (don't close yet, caller will close on success)
    console.log(`🔌 Embedding circuit: cooldown expired (${state.cooldownMs / 1000}s), allowing probe request`);
    return { open: false, reason: 'probe', waitMs: 0 };
  }

  const waitMs = state.cooldownMs - elapsed;
  return {
    open: true,
    reason: `circuit open since ${new Date(state.openedAt).toISOString()} (HTTP ${state.lastFailureCode}), ${Math.ceil(waitMs / 1000)}s remaining`,
    waitMs
  };
}

/**
 * Record embedding API success - close circuit, reset failures
 */
export async function recordEmbeddingSuccess() {
  await updateEmbeddingCircuitState({
    isOpen: false,
    openedAt: null,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailureMessage: null,
    cooldownMs: COOLDOWN_STEPS[0] // Reset cooldown escalation
  });
}

/**
 * Record embedding API failure - may open circuit
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function recordEmbeddingFailure(statusCode, message) {
  const state = await getEmbeddingCircuitState();
  const failures = state.consecutiveFailures + 1;

  // 403: provider unavailable - open immediately with 5min cooldown
  if (statusCode === 403) {
    const cooldownMs = 300000; // 5 minutes
    console.error(`🔌 Embedding circuit OPEN: provider unavailable (403). Cooldown: ${cooldownMs / 1000}s`);
    await updateEmbeddingCircuitState({
      isOpen: true,
      openedAt: Date.now(),
      consecutiveFailures: failures,
      lastFailureCode: statusCode,
      lastFailureMessage: message,
      cooldownMs,
      totalTrips: state.totalTrips + 1
    });
    return;
  }

  // 429/500/503: transient - open after 3 consecutive failures with escalating cooldown
  if (statusCode === 429 || statusCode === 500 || statusCode === 503) {
    if (failures >= 3) {
      // Escalate cooldown: find next step based on current
      const currentIdx = COOLDOWN_STEPS.indexOf(state.cooldownMs);
      const nextIdx = Math.min((currentIdx === -1 ? 0 : currentIdx) + 1, COOLDOWN_STEPS.length - 1);
      const cooldownMs = state.isOpen ? COOLDOWN_STEPS[nextIdx] : COOLDOWN_STEPS[0];

      console.error(`🔌 Embedding circuit OPEN: ${failures} consecutive failures (HTTP ${statusCode}). Cooldown: ${cooldownMs / 1000}s`);
      await updateEmbeddingCircuitState({
        isOpen: true,
        openedAt: Date.now(),
        consecutiveFailures: failures,
        lastFailureCode: statusCode,
        lastFailureMessage: message,
        cooldownMs,
        totalTrips: state.totalTrips + 1
      });
    } else {
      // Not enough failures yet, just increment counter
      await updateEmbeddingCircuitState({
        consecutiveFailures: failures,
        lastFailureCode: statusCode,
        lastFailureMessage: message
      });
    }
    return;
  }

  // Other errors: just track failures, don't trip circuit
  await updateEmbeddingCircuitState({
    consecutiveFailures: failures,
    lastFailureCode: statusCode,
    lastFailureMessage: message
  });
}

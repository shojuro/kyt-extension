/**
 * Shared Circuit Breaker Module
 *
 * Generic factory for circuit breakers persisted in chrome.storage.local.
 * Survives service worker restarts. Used by both embedding and Jina reranker paths.
 */

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a circuit breaker backed by chrome.storage.local.
 *
 * @param {string} storageKey  - chrome.storage.local key for this CB's state
 * @param {number[]} cooldownSteps - escalating cooldown durations in ms
 * @returns {{ getState, updateState, isOpen, recordSuccess, recordFailure }}
 */
export function createCircuitBreaker(storageKey, cooldownSteps) {
  const defaultState = () => ({
    isOpen: false,
    openedAt: null,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailureMessage: null,
    cooldownMs: cooldownSteps[0],
    totalTrips: 0
  });

  async function getState() {
    const result = await chrome.storage.local.get([storageKey]);
    return result[storageKey] || defaultState();
  }

  async function updateState(updates) {
    const current = await getState();
    const newState = { ...current, ...updates };
    await chrome.storage.local.set({ [storageKey]: newState });
    return newState;
  }

  async function isOpen() {
    const state = await getState();

    if (!state.isOpen) {
      return { open: false, reason: null, waitMs: 0 };
    }

    const elapsed = Date.now() - state.openedAt;
    if (elapsed >= state.cooldownMs) {
      console.log(`🔌 [${storageKey}] cooldown expired (${state.cooldownMs / 1000}s), allowing probe request`);
      return { open: false, reason: 'probe', waitMs: 0 };
    }

    const waitMs = state.cooldownMs - elapsed;
    return {
      open: true,
      reason: `circuit open since ${new Date(state.openedAt).toISOString()} (HTTP ${state.lastFailureCode}), ${Math.ceil(waitMs / 1000)}s remaining`,
      waitMs
    };
  }

  async function recordSuccess() {
    await updateState({
      isOpen: false,
      openedAt: null,
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastFailureMessage: null,
      cooldownMs: cooldownSteps[0]
    });
  }

  async function recordFailure(statusCode, message) {
    const state = await getState();
    const failures = state.consecutiveFailures + 1;

    // 403: provider unavailable — open immediately with 5 min cooldown
    if (statusCode === 403) {
      const cooldownMs = 300000;
      console.error(`🔌 [${storageKey}] OPEN: provider unavailable (403). Cooldown: ${cooldownMs / 1000}s`);
      await updateState({
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

    // 0 (timeout) / 429 / 500 / 503: transient — open after 3 consecutive failures
    if (statusCode === 0 || statusCode === 429 || statusCode === 500 || statusCode === 503) {
      if (failures >= 3) {
        const currentIdx = cooldownSteps.indexOf(state.cooldownMs);
        const nextIdx = Math.min((currentIdx === -1 ? 0 : currentIdx) + 1, cooldownSteps.length - 1);
        const cooldownMs = state.isOpen ? cooldownSteps[nextIdx] : cooldownSteps[0];

        console.error(`🔌 [${storageKey}] OPEN: ${failures} consecutive failures (code ${statusCode}). Cooldown: ${cooldownMs / 1000}s`);
        await updateState({
          isOpen: true,
          openedAt: Date.now(),
          consecutiveFailures: failures,
          lastFailureCode: statusCode,
          lastFailureMessage: message,
          cooldownMs,
          totalTrips: state.totalTrips + 1
        });
      } else {
        await updateState({
          consecutiveFailures: failures,
          lastFailureCode: statusCode,
          lastFailureMessage: message
        });
      }
      return;
    }

    // Other errors: just track failures, don't trip circuit
    await updateState({
      consecutiveFailures: failures,
      lastFailureCode: statusCode,
      lastFailureMessage: message
    });
  }

  return { getState, updateState, isOpen, recordSuccess, recordFailure };
}

// ── Embedding instance (default) ───────────────────────────────────────────

export const CIRCUIT_BREAKER_STORAGE_KEY = 'kyt_embedding_circuit_breaker';
export const COOLDOWN_STEPS = [60000, 120000, 300000, 600000]; // 1m, 2m, 5m, 10m

const embeddingCB = createCircuitBreaker(CIRCUIT_BREAKER_STORAGE_KEY, COOLDOWN_STEPS);

// Backward-compatible named exports (thin wrappers)
export const getEmbeddingCircuitState   = embeddingCB.getState;
export const updateEmbeddingCircuitState = embeddingCB.updateState;
export const isEmbeddingCircuitOpen     = embeddingCB.isOpen;
export const recordEmbeddingSuccess     = embeddingCB.recordSuccess;
export const recordEmbeddingFailure     = embeddingCB.recordFailure;

// ── Jina reranker instance ─────────────────────────────────────────────────

export const JINA_CB_STORAGE_KEY = 'kyt_jina_circuit_breaker';
const JINA_COOLDOWN_STEPS = [60000, 120000, 300000]; // 1m, 2m, 5m

export const jinaCB = createCircuitBreaker(JINA_CB_STORAGE_KEY, JINA_COOLDOWN_STEPS);

/**
 * Rate Limiter for OpenAI API
 *
 * Prevents hitting OpenAI rate limits:
 * - Tier 1: 200 RPM (requests per minute)
 * - Tier 1: 2M TPM (tokens per minute)
 *
 * Uses a 10% safety margin (180 RPM, 1.8M TPM)
 */

export class RateLimiter {
  constructor(options = {}) {
    // Apply 10% safety margin to limits
    this.rpmLimit = options.rpmLimit || 180;
    this.tpmLimit = options.tpmLimit || 1_800_000;

    // Tracking
    this.requestQueue = [];  // Timestamps of requests in current minute
    this.tokenQueue = [];    // {timestamp, tokens} in current minute

    // Stats
    this.totalRequests = 0;
    this.totalTokens = 0;
    this.retries = 0;
    this.throttleWaits = 0;
  }

  /**
   * Wait if necessary to respect rate limits
   * @param {number} estimatedTokens - Estimated tokens for this request
   * @returns {Promise<void>}
   */
  async acquireSlot(estimatedTokens = 500) {
    const now = Date.now();

    // Clean up old entries (older than 1 minute)
    this._cleanupOldEntries(now);

    // Check if we need to wait
    while (this._shouldThrottle(estimatedTokens)) {
      this.throttleWaits++;
      const waitMs = this._calculateWaitTime();

      if (waitMs > 0) {
        await this._sleep(waitMs);
        this._cleanupOldEntries(Date.now());
      }
    }

    // Record this request
    this.requestQueue.push(now);
    this.tokenQueue.push({ timestamp: now, tokens: estimatedTokens });
    this.totalRequests++;
    this.totalTokens += estimatedTokens;
  }

  /**
   * Update actual token usage after API call
   * @param {number} actualTokens - Actual tokens used
   */
  updateTokenUsage(actualTokens) {
    // Find the most recent entry and update it
    if (this.tokenQueue.length > 0) {
      const lastEntry = this.tokenQueue[this.tokenQueue.length - 1];
      const diff = actualTokens - lastEntry.tokens;
      lastEntry.tokens = actualTokens;
      this.totalTokens += diff;
    }
  }

  /**
   * Retry wrapper with exponential backoff
   * @param {Function} fn - Async function to retry
   * @param {Object} options - Retry options
   * @returns {Promise<any>}
   */
  async retryWithBackoff(fn, options = {}) {
    const maxRetries = options.maxRetries || 5;
    const baseDelay = options.baseDelay || 1000;
    const maxDelay = options.maxDelay || 60000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        // Don't retry on non-rate-limit errors
        if (error.status && error.status !== 429 && error.status !== 503) {
          throw error;
        }

        // Last attempt - throw error
        if (attempt === maxRetries - 1) {
          throw error;
        }

        // Calculate exponential backoff with jitter
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
          maxDelay
        );

        this.retries++;
        console.log(`Rate limit hit, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);

        await this._sleep(delay);
      }
    }
  }

  /**
   * Get current rate limit stats
   * @returns {Object}
   */
  getStats() {
    const now = Date.now();
    this._cleanupOldEntries(now);

    return {
      currentRPM: this.requestQueue.length,
      currentTPM: this.tokenQueue.reduce((sum, entry) => sum + entry.tokens, 0),
      rpmLimit: this.rpmLimit,
      tpmLimit: this.tpmLimit,
      rpmUtilization: (this.requestQueue.length / this.rpmLimit * 100).toFixed(1) + '%',
      tpmUtilization: (this.tokenQueue.reduce((sum, e) => sum + e.tokens, 0) / this.tpmLimit * 100).toFixed(1) + '%',
      totalRequests: this.totalRequests,
      totalTokens: this.totalTokens,
      retries: this.retries,
      throttleWaits: this.throttleWaits
    };
  }

  /**
   * Clean up entries older than 1 minute
   * @private
   */
  _cleanupOldEntries(now) {
    const oneMinuteAgo = now - 60000;

    // Remove old requests
    this.requestQueue = this.requestQueue.filter(ts => ts > oneMinuteAgo);

    // Remove old token entries
    this.tokenQueue = this.tokenQueue.filter(entry => entry.timestamp > oneMinuteAgo);
  }

  /**
   * Check if we should throttle
   * @private
   */
  _shouldThrottle(estimatedTokens) {
    const currentRPM = this.requestQueue.length;
    const currentTPM = this.tokenQueue.reduce((sum, entry) => sum + entry.tokens, 0);

    // Check RPM limit
    if (currentRPM >= this.rpmLimit) {
      return true;
    }

    // Check TPM limit
    if (currentTPM + estimatedTokens > this.tpmLimit) {
      return true;
    }

    return false;
  }

  /**
   * Calculate how long to wait
   * @private
   */
  _calculateWaitTime() {
    if (this.requestQueue.length === 0) {
      return 0;
    }

    // Find the oldest request
    const oldestRequest = Math.min(...this.requestQueue);
    const ageMs = Date.now() - oldestRequest;

    // Wait until oldest request is > 60 seconds old
    const waitMs = Math.max(0, 60000 - ageMs + 100); // +100ms buffer

    return waitMs;
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

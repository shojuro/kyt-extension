// Token bucket rate limiter - prevents hitting platform rate limits

/**
 * Parse an HTTP Retry-After header (integer seconds form) into milliseconds.
 * Missing/garbage/negative values fall back to defaultMs; results are capped
 * at maxMs so a hostile/buggy header can't stall an import for hours.
 *
 * @param {string|null} headerValue
 * @param {{defaultMs?: number, maxMs?: number}} [options]
 * @returns {number}
 */
export function parseRetryAfterMs(headerValue, { defaultMs = 30000, maxMs = 120000 } = {}) {
    const seconds = Number(headerValue);
    if (headerValue == null || headerValue === '' || !Number.isFinite(seconds) || seconds < 0) {
        return Math.min(defaultMs, maxMs);
    }
    return Math.min(seconds * 1000, maxMs);
}

/**
 * @typedef {Object} RateLimiterConfig
 * @property {number} requestsPerMinute
 * @property {number} [burstSize]
 */

export class RateLimiter {
    /**
     * @param {RateLimiterConfig} config 
     */
    constructor(config) {
        this.maxTokens = config.burstSize || config.requestsPerMinute;
        this.tokens = this.maxTokens;
        this.refillRate = config.requestsPerMinute / 60000;  // per ms
        this.lastRefill = Date.now();
    }

    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    async acquire() {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        // Wait for token to become available
        const waitTime = (1 - this.tokens) / this.refillRate;
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Recalculate after wait (to be safe)
        this.refill();
        this.tokens -= 1;
    }

    // Factory methods for platform-specific limiters
    static forChatGPT() {
        return new RateLimiter({ requestsPerMinute: 30, burstSize: 5 });
    }

    static forClaude() {
        return new RateLimiter({ requestsPerMinute: 20, burstSize: 3 });
    }

    static forGemini() {
        return new RateLimiter({ requestsPerMinute: 20, burstSize: 3 });
    }
}

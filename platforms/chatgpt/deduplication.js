/**
 * Message Deduplication Layer
 *
 * Prevents duplicate message captures from multiple sources (WebSocket, fetch, DOM observer).
 * Uses content hashing and confidence-based priority to ensure each message is captured only once.
 *
 * Confidence Levels:
 * - WebSocket: 95% (protocol-level, voice transcripts)
 * - Fetch: 95% (protocol-level, typed messages)
 * - DOM: 70% (presentation layer, fragile fallback)
 *
 * Deduplication Window: 5 seconds (configurable)
 *
 * Note: This is a standalone script (not ES6 module) to work with Manifest V3 content scripts
 */

class MessageDeduplicator {
  constructor(options = {}) {
    // Recent messages: content_hash -> { timestamp, confidence, captureMethod }
    this.recentMessages = new Map();

    // Deduplication window in milliseconds (default: 5 seconds)
    this.dedupeWindow = options.dedupeWindow || 5000;

    // Cleanup interval (every 10 seconds)
    this.cleanupInterval = setInterval(() => this.cleanup(), 10000);

    // Statistics
    this.stats = {
      totalAttempts: 0,
      captured: 0,
      duplicatesSkipped: 0,
      upgradeCaptures: 0
    };
  }

  /**
   * Check if message should be captured
   *
   * @param {string} content - Message content
   * @param {string} captureMethod - 'websocket' | 'fetch' | 'dom'
   * @returns {boolean} True if message should be captured, false if duplicate
   */
  shouldCapture(content, captureMethod) {
    this.stats.totalAttempts++;

    // Normalize content for hashing
    const normalizedContent = this.normalizeContent(content);
    const hash = this.hashContent(normalizedContent);
    const now = Date.now();
    const confidence = this.getConfidence(captureMethod);

    // Check if recently captured
    if (this.recentMessages.has(hash)) {
      const lastCapture = this.recentMessages.get(hash);
      const timeSinceCapture = now - lastCapture.timestamp;

      // Within deduplication window?
      if (timeSinceCapture < this.dedupeWindow) {
        // Check confidence priority
        if (confidence > lastCapture.confidence) {
          // Upgrade to higher-confidence capture
          console.log(`🔄 KYT Dedupe: Upgrading capture from ${lastCapture.captureMethod} (${lastCapture.confidence}%) to ${captureMethod} (${confidence}%)`);
          this.recentMessages.set(hash, {
            timestamp: now,
            confidence: confidence,
            captureMethod: captureMethod
          });
          this.stats.upgradeCaptures++;
          return true; // Allow upgrade
        } else {
          // Lower or equal confidence - skip duplicate
          console.log(`⏭️ KYT Dedupe: Skipping duplicate (${captureMethod} ${confidence}% <= ${lastCapture.captureMethod} ${lastCapture.confidence}%)`);
          this.stats.duplicatesSkipped++;
          return false; // Skip duplicate
        }
      }
    }

    // First time or outside window - capture it
    this.recentMessages.set(hash, {
      timestamp: now,
      confidence: confidence,
      captureMethod: captureMethod
    });
    this.stats.captured++;
    return true;
  }

  /**
   * Get confidence score for capture method
   *
   * @param {string} method - Capture method
   * @returns {number} Confidence score (0-100)
   */
  getConfidence(method) {
    const confidenceMap = {
      'websocket': 95,  // Protocol-level, voice transcripts
      'fetch': 95,      // Protocol-level, typed messages
      'dom': 70         // Presentation layer, fragile
    };
    return confidenceMap[method] || 50; // Unknown method gets 50%
  }

  /**
   * Normalize content for consistent hashing
   * Removes whitespace variations, case differences, etc.
   *
   * @param {string} content - Raw message content
   * @returns {string} Normalized content
   */
  normalizeContent(content) {
    if (typeof content !== 'string') {
      return String(content);
    }

    return content
      .trim()                        // Remove leading/trailing whitespace
      .replace(/\s+/g, ' ')          // Normalize multiple spaces to single space
      .toLowerCase();                 // Case-insensitive matching
  }

  /**
   * Hash content for deduplication key
   * Simple hash function - good enough for deduplication
   *
   * @param {string} content - Normalized content
   * @returns {string} Hash string
   */
  hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36); // Base36 encoding (alphanumeric)
  }

  /**
   * Clean up old entries outside deduplication window
   * Prevents memory leak from unbounded Map growth
   */
  cleanup() {
    const now = Date.now();
    const cutoff = now - this.dedupeWindow;
    let removed = 0;

    for (const [hash, entry] of this.recentMessages.entries()) {
      if (entry.timestamp < cutoff) {
        this.recentMessages.delete(hash);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`🧹 KYT Dedupe: Cleaned up ${removed} old entries`);
    }
  }

  /**
   * Get deduplication statistics
   *
   * @returns {object} Statistics
   */
  getStats() {
    return {
      ...this.stats,
      mapSize: this.recentMessages.size,
      duplicateRate: this.stats.totalAttempts > 0
        ? (this.stats.duplicatesSkipped / this.stats.totalAttempts * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalAttempts: 0,
      captured: 0,
      duplicatesSkipped: 0,
      upgradeCaptures: 0
    };
  }

  /**
   * Destroy deduplicator (cleanup interval)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.recentMessages.clear();
  }
}

/**
 * Singleton instance for global use
 * Attach to window for access from content script
 */
window.KYT_Deduplicator = new MessageDeduplicator();

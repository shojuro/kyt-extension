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
    // Input validation
    if (options && typeof options !== 'object') {
      console.error('❌ KYT Dedupe: Invalid constructor options, using defaults');
      options = {};
    }

    // Recent messages: content_hash -> { timestamp, confidence, captureMethod }
    this.recentMessages = new Map();

    // Deduplication window in milliseconds (default: 5 seconds)
    this.dedupeWindow = options.dedupeWindow || 5000;

    // Maximum Map size to prevent DoS attacks (default: 1000 entries)
    this.maxMapSize = options.maxMapSize || 1000;

    // Cleanup interval (every 2 seconds - must be faster than 5s dedup window)
    this.cleanupInterval = setInterval(() => this.cleanup(), 2000);

    // Statistics
    this.stats = {
      totalAttempts: 0,
      captured: 0,
      duplicatesSkipped: 0,
      upgradeCaptures: 0
    };

    // Error tracking for health monitoring
    this.errorLog = [];
    this.maxErrorLogSize = options.maxErrorLogSize || 100;

    // Concurrent access protection
    this._cleanupInProgress = false;
  }

  /**
   * Check if message should be captured
   *
   * @param {string} content - Message content
   * @param {string} captureMethod - 'websocket' | 'fetch' | 'dom'
   * @returns {boolean} True if message should be captured, false if duplicate
   */
  shouldCapture(content, captureMethod) {
    // Input validation
    if (content === undefined || content === null || content === '') {
      console.warn('⚠️ KYT Dedupe: Invalid content (empty/null/undefined), skipping deduplication');
      return true; // Fail-open: capture anyway
    }

    if (typeof content !== 'string' && typeof content !== 'number') {
      console.warn('⚠️ KYT Dedupe: Invalid content type:', typeof content, 'skipping deduplication');
      return true; // Fail-open: capture anyway
    }

    if (!captureMethod || typeof captureMethod !== 'string') {
      console.warn('⚠️ KYT Dedupe: Invalid captureMethod:', captureMethod, 'defaulting to "unknown"');
      captureMethod = 'unknown';
    }

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
    // FIFO eviction if Map is at max size
    if (this.recentMessages.size >= this.maxMapSize) {
      const oldestKey = this.recentMessages.keys().next().value;
      this.recentMessages.delete(oldestKey);
      console.log('🗑️ KYT Dedupe: FIFO eviction, Map at max size:', this.maxMapSize);
    }

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

    let normalized = content
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    
    // Unicode normalization (NFKC): handles composed vs decomposed characters
    if (typeof normalized.normalize === 'function') {
      try {
        normalized = normalized.normalize('NFKC');
      } catch (e) {
        console.warn('⚠️ KYT Dedupe: Unicode normalization failed:', e);
      }
    }
    
    return normalized;
  }

  /**
   * Hash content for deduplication key using FNV-1a algorithm
   * FNV-1a provides better distribution and fewer collisions than simple hash
   * 
   * @param {string} content - Normalized content
   * @returns {string} Hash string (hex encoded)
   */
  hashContent(content) {
    // FNV-1a 32-bit hash algorithm
    const FNV_PRIME = 0x01000193;
    const FNV_OFFSET_BASIS = 0x811c9dc5;
    
    let hash = FNV_OFFSET_BASIS;
    
    for (let i = 0; i < content.length; i++) {
      // XOR with byte value
      hash ^= content.charCodeAt(i);
      // Multiply by FNV prime (with 32-bit overflow)
      hash = Math.imul(hash, FNV_PRIME);
    }
    
    // Convert to unsigned 32-bit and return as hex string
    return (hash >>> 0).toString(16);
  }

  /**
   * Clean up old entries outside deduplication window
   * Prevents memory leak from unbounded Map growth
   */
  cleanup() {
    // Concurrent access protection: skip if cleanup already running
    if (this._cleanupInProgress) {
      console.log('⏭️ KYT Dedupe: Cleanup already in progress, skipping');
      return;
    }

    this._cleanupInProgress = true;

    try {
      const now = Date.now();
    const cutoff = now - this.dedupeWindow;
    let removed = 0;

    // Safety check: only cleanup if window is reasonable
    if (this.dedupeWindow <= 0 || this.dedupeWindow > 3600000) {
      console.warn('⚠️ KYT Dedupe: Invalid dedup window, skipping cleanup');
      return;
    }

    // Safety check: verify timestamp is reasonable
    if (now < 1600000000000) { // Sep 2020 sanity check
      console.error('❌ KYT Dedupe: System time appears incorrect, skipping cleanup');
      return;
    }

    for (const [hash, entry] of this.recentMessages.entries()) {
      // Safety: verify entry has required properties
      if (!entry || typeof entry.timestamp !== 'number') {
        console.warn('⚠️ KYT Dedupe: Invalid entry found, removing:', hash);
        this.recentMessages.delete(hash);
        removed++;
        continue;
      }

      if (entry.timestamp < cutoff) {
        this.recentMessages.delete(hash);
        removed++;
      }
    }

    if (removed > 0) {
        console.log(`🧹 KYT Dedupe: Cleaned up ${removed} old entries`);
      }
    } finally {
      // Always release lock, even if error occurs
      this._cleanupInProgress = false;
    }
  }

  /**
   * Get deduplication statistics
   *
   * @returns {object} Statistics
   */
  getStats() {
    const now = Date.now();
    const recentErrors = this.errorLog.filter(e => now - e.timestamp < 60000); // Last minute

    return {
      ...this.stats,
      mapSize: this.recentMessages.size,
      duplicateRate: this.stats.totalAttempts > 0
        ? (this.stats.duplicatesSkipped / this.stats.totalAttempts * 100).toFixed(1) + '%'
        : '0%',
      health: {
        totalErrors: this.errorLog.length,
        recentErrors: recentErrors.length,
        lastError: this.errorLog.length > 0 
          ? this.errorLog[this.errorLog.length - 1] 
          : null
      }
    };
  }

  /**
   * Record an error for health monitoring
   * @private
   */
  _recordError(error) {
    const errorEntry = {
      timestamp: Date.now(),
      message: error?.message || String(error),
      stack: error?.stack || null
    };

    this.errorLog.push(errorEntry);

    // FIFO eviction if log is too large
    if (this.errorLog.length > this.maxErrorLogSize) {
      this.errorLog.shift();
    }
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

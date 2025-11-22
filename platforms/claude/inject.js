/**
 * KYT Memory Extension - Claude Inject Script
 *
 * This script runs in the PAGE CONTEXT (not content script context)
 * allowing it to wrap fetch at the same level as other page scripts.
 *
 * Platform: Claude
 */

(function () {
  'use strict';

  console.log('🚀 KYT Claude Inject: Initializing in page context...');

  // === DEDUPLICATION LAYER ===
  /**
   * Message Deduplication Layer
   * Prevents duplicate captures from multiple sources (fetch, WebSocket, DOM)
   * Uses content hashing and confidence-based priority
   */
  class MessageDeduplicator {
    constructor(options = {}) {
      this.recentMessages = new Map();
      this.dedupeWindow = options.dedupeWindow || 5000; // 5 seconds
      this.cleanupInterval = setInterval(() => this.cleanup(), 2000); // Run every 2s (faster than 5s dedupe window)
      this.stats = {
        totalAttempts: 0,
        captured: 0,
        duplicatesSkipped: 0,
        upgradeCaptures: 0
      };
    }

    shouldCapture(content, captureMethod) {
      this.stats.totalAttempts++;
      const normalizedContent = this.normalizeContent(content);
      const hash = this.hashContent(normalizedContent);
      const now = Date.now();
      const confidence = this.getConfidence(captureMethod);

      if (this.recentMessages.has(hash)) {
        const lastCapture = this.recentMessages.get(hash);
        const timeSinceCapture = now - lastCapture.timestamp;

        if (timeSinceCapture < this.dedupeWindow) {
          if (confidence > lastCapture.confidence) {
            console.log(`🔄 KYT Dedupe: Upgrading ${lastCapture.captureMethod} (${lastCapture.confidence}%) → ${captureMethod} (${confidence}%)`);
            this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
            this.stats.upgradeCaptures++;
            return true;
          } else {
            console.log(`⏭️ KYT Dedupe: Skipping duplicate (${captureMethod} ${confidence}% <= ${lastCapture.captureMethod} ${lastCapture.confidence}%)`);
            this.stats.duplicatesSkipped++;
            return false;
          }
        }
      }

      this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
      this.stats.captured++;
      return true;
    }

    getConfidence(method) {
      const map = { 'websocket': 95, 'fetch': 95, 'dom': 70 };
      return map[method] || 50;
    }

    normalizeContent(content) {
      return String(content).trim().replace(/\s+/g, ' ').toLowerCase();
    }

    hashContent(content) {
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString(36);
    }

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

    getStats() {
      return {
        ...this.stats,
        mapSize: this.recentMessages.size,
        duplicateRate: this.stats.totalAttempts > 0
          ? (this.stats.duplicatesSkipped / this.stats.totalAttempts * 100).toFixed(1) + '%'
          : '0%'
      };
    }

    resetStats() {
      this.stats = { totalAttempts: 0, captured: 0, duplicatesSkipped: 0, upgradeCaptures: 0 };
    }

    destroy() {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      this.recentMessages.clear();
    }
  }

  // Create singleton deduplicator instance
  window.KYT_Deduplicator = new MessageDeduplicator();
  console.log('🔄 KYT Claude: Deduplication layer initialized in page context');

  // Track interception health
  let lastInterceptionTime = Date.now();
  let totalInterceptions = 0;
  let totalErrors = 0;

  // Platform-specific detection and extraction
  const platform = {
    name: 'claude',

    detectAPICall: function (url, options) {
      const isClaudeAPI = (
        typeof url === 'string' &&
        url.includes('claude.ai/api/') &&
        url.includes('/chat_conversations/') &&
        url.includes('/completion')
      );
      const isPostRequest = options?.method === 'POST' || options?.body;
      return isClaudeAPI && isPostRequest;
    },

    extractConversationId: function (url) {
      // Extract from URL: /api/organizations/{org_id}/chat_conversations/{conv_id}/completion
      const match = url.match(/\/chat_conversations\/([^\/]+)\//);
      return match ? match[1] : 'unknown';
    },

    /**
     * Strip K.Y.T. Memory Injection Protocol blocks from content
     * Prevents recursive pollution where injection blocks get saved as memories
     * @param {string} content - Message content that may contain injection blocks
     * @returns {string} - Clean content without injection blocks
     */
    stripInjectionBlock: function (content) {
      // AGGRESSIVE PATTERN: Strip ANYTHING that looks like a K.Y.T. injection block
      // This catches blocks even if truncated, malformed, or missing end markers

      // Pattern 1: Any content starting with K.Y.T. header until end marker OR next user message
      const kytHeaderPattern = /={3,}[\s\S]*?K\.Y\.T\.[\s\S]*?(?:={3,}|$)/g;

      // Pattern 2: SESSION_CONTEXT, RETRIEVAL_CONTEXT, DATA_PROVENANCE blocks
      const contextBlockPattern = /\[(SESSION_CONTEXT|RETRIEVAL_CONTEXT|DATA_PROVENANCE|Retrieved Items)\][\s\S]*?(?=\n\n[^\[]|$)/g;

      // Pattern 3: Standalone context markers
      const standaloneMarkers = /\[(?:Memory Context|Query Optimized|End of (?:Memory|Knowledge Base) Context)\][^\n]*/g;

      // Pattern 4: Separator lines (80+ equals signs)
      const separatorPattern = /={80,}/g;

      let cleaned = content;

      // Apply all patterns
      cleaned = cleaned.replace(kytHeaderPattern, '');
      cleaned = cleaned.replace(contextBlockPattern, '');
      cleaned = cleaned.replace(standaloneMarkers, '');
      cleaned = cleaned.replace(separatorPattern, '');

      // Clean up excessive whitespace/newlines left by removals
      cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

      return cleaned;
    },

    extractMessage: function (bodyString, url) {
      try {
        const body = JSON.parse(bodyString);

        if (!body.prompt || typeof body.prompt !== 'string') {
          throw new Error('No prompt found in request body');
        }

        // CRITICAL: Strip injection blocks BEFORE saving
        const cleanedPrompt = this.stripInjectionBlock(body.prompt);

        // Extract conversation ID from URL (more reliable than body)
        const conversationId = this.extractConversationId(url);

        return {
          content: cleanedPrompt.trim(),
          role: 'user',
          conversationId: conversationId,
          model: body.model || 'claude-3-opus',
          timestamp: Date.now(),
          messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          platform: 'claude'
        };
      } catch (error) {
        console.error('❌ KYT Claude: Extraction error:', error.message);
        return null;
      }
    }
  };

  /**
   * Override fetch in page context
   */
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [url, options] = args;

    // Check if this is a platform API call
    if (platform.detectAPICall(url, options)) {
      console.log('🎯 KYT Claude: Intercepted API call');
      totalInterceptions++;
      lastInterceptionTime = Date.now();

      // Extract message data (pass URL for conversation ID extraction)
      const messageData = platform.extractMessage(options.body, url);

      if (messageData) {
        // Check deduplication before capturing
        if (window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch')) {
          console.log('✅ KYT Claude: Message extracted and captured:', messageData.content.substring(0, 50) + '...');

          // Send to content script via custom event
          window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
            detail: messageData
          }));
        } else {
          console.log('⏭️ KYT Claude: Duplicate message skipped by deduplicator');
        }
      } else {
        console.warn('⚠️ KYT Claude: Failed to extract message');
        totalErrors++;
      }
    }

    // Continue with original fetch
    return originalFetch.apply(this, args);
  };

  // Expose enhanced health check
  window.KYT_Claude_Health = {
    getStats: function () {
      return {
        platform: 'claude',
        context: 'PAGE_CONTEXT',
        deduplication: window.KYT_Deduplicator.getStats(),
        interception: {
          totalInterceptions: totalInterceptions,
          totalErrors: totalErrors,
          lastInterceptionTime: lastInterceptionTime,
          timeSinceLastIntercept: Date.now() - lastInterceptionTime,
          errorRate: totalInterceptions > 0 ? `${((totalErrors / totalInterceptions) * 100).toFixed(1)}%` : 'N/A'
        }
      };
    },

    resetStats: function () {
      window.KYT_Deduplicator.resetStats();
      totalInterceptions = 0;
      totalErrors = 0;
      lastInterceptionTime = Date.now();
      console.log('✅ KYT Claude: Stats reset');
    }
  };

  // Backward compatibility
  window.KYT_HEALTH_CHECK = window.KYT_Claude_Health.getStats;

  // Phase 2: Standardized stats function for diagnostic popup
  window.getInterceptionStats = function () {
    return {
      platform: 'claude',
      fetch: {
        active: totalInterceptions > 0,
        count: totalInterceptions
      },
      websocket: {
        active: false, // Claude uses fetch, not WebSocket
        count: 0
      },
      domObserver: {
        active: false, // Not implemented for Claude
        count: 0
      },
      deduplication: window.KYT_Deduplicator ? window.KYT_Deduplicator.getStats() : null,
      totalInterceptions: totalInterceptions,
      totalErrors: totalErrors,
      lastInterceptionTime: lastInterceptionTime
    };
  };

  console.log('✅ KYT Claude: Fetch override installed in PAGE CONTEXT');
  console.log('ℹ️ Use window.KYT_Deduplicator.getStats() to check deduplication stats');
  console.log('ℹ️ Use window.KYT_Claude_Health.getStats() for full health check');
  console.log('ℹ️ Use window.getInterceptionStats() for diagnostic popup');
})();

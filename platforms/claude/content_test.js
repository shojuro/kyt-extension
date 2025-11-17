/**
 * KYT Memory Extension - Claude Content Script (MAIN World)
 *
 * Runs in page context (world: MAIN) to intercept fetch calls
 * and capture Claude message submissions.
 *
 * Architecture:
 * MAIN world (this file) → CustomEvent → ISOLATED world (content_bridge.js) → chrome.runtime → background.js
 */

// PHASE 1 FIX #3: Duplicate injection guard
if (window.KYT_CLAUDE_INJECTED) {
  console.log('⚠️ KYT Claude already injected, skipping duplicate injection');
} else {
  window.KYT_CLAUDE_INJECTED = true;

  console.log('🟢 KYT Claude: Content script loaded in MAIN world at:', new Date().toISOString());

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
      this.cleanupInterval = setInterval(() => this.cleanup(), 2000); // Run every 2s
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

  /**
   * PHASE 1 FIX #1: Persistent event listener pattern
   * Map to track pending context requests - prevents garbage collection
   */
  const pendingContextRequests = new Map();

  /**
   * Persistent listener for context responses
   * Lives at module level - never garbage collected
   */
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timeout);
      pendingContextRequests.delete(requestId);

      if (event.detail.success && event.detail.formattedContext) {
        console.log('✅ KYT Claude: Context received, injecting...');

        // Prepend context to prompt
        pending.body.prompt = `${event.detail.formattedContext}\n\n---\n\n${pending.body.prompt}`;
        pending.resolve(JSON.stringify(pending.body));
      } else {
        console.log('ℹ️ KYT Claude: No context found or error');
        pending.resolve(pending.originalBody);
      }
    }
  });

  /**
   * Request context from bridge and inject into message
   */
  async function getAndInjectContext(bodyString) {
    try {
      const body = JSON.parse(bodyString);

      // Claude API uses prompt string
      if (!body.prompt || typeof body.prompt !== 'string') {
        return bodyString; // No modification
      }

      console.log('🔍 KYT Claude: Requesting context for:', body.prompt.substring(0, 50) + '...');

      // Generate unique request ID
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return new Promise((resolve) => {
        // PHASE 1 FIX #5: Increase timeout to 10s with better error logging
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          console.error('⏱️ KYT Claude: Context timeout after 10s', {
            requestId: requestId,
            userMessage: body.prompt.substring(0, 50),
            pendingRequests: pendingContextRequests.size
          });
          resolve(bodyString);
        }, 10000); // Increased from 5000ms

        // Store request in Map - prevents garbage collection
        pendingContextRequests.set(requestId, {
          resolve: resolve,
          timeout: timeout,
          body: body,
          originalBody: bodyString
        });

        // Dispatch context request
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: {
            requestId: requestId,
            userMessage: body.prompt,
            config: {
              threshold: 0.5, // pgvector distance: lower = stricter, 0.5 = balanced
              maxContextItems: 5, // Increased from 3 for more context
              debugMode: false
            }
          }
        }));
      });
    } catch (error) {
      console.error('❌ KYT Claude: Context injection error:', error);
      return bodyString; // Error - proceed with original
    }
  }

// Wrap window.fetch to intercept Claude API calls
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const [url, options] = args;

  // DIAGNOSTIC: Log ALL Claude API calls to identify memory check endpoint
  if (typeof url === 'string' && url.includes('claude.ai/api')) {
    const endpoint = url.replace(/https:\/\/claude\.ai\/api\//, '');
    console.log('🔍 KYT Claude API Call:', endpoint.substring(0, 100));
  }

  // Check if this is a Claude message completion request
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion')) {
    console.log('🟢 KYT Claude: Intercepted completion request:', url);

    try {
      // Extract conversation ID from URL
      // URL format: https://claude.ai/api/organizations/{org_id}/chat_conversations/{conv_id}/completion
      const conversationIdMatch = url.match(/chat_conversations\/([^\/]+)\/completion/);
      const conversationId = conversationIdMatch ? conversationIdMatch[1] : null;

      // FIX: Extract model BEFORE modifying options.body
      let modelName = 'claude-unknown';
      if (options && options.body) {
        try {
          const originalBody = JSON.parse(options.body);
          modelName = originalBody.model || 'claude-unknown';
        } catch (e) {
          console.warn('⚠️ KYT Claude: Could not parse request body for model');
        }
      }

      // PHASE 1: Context injection ENABLED - RAG memory retrieval
      if (options && options.body) {
        try {
          options.body = await getAndInjectContext(options.body);
          console.log('✅ KYT Claude: Context injection completed');
        } catch (error) {
          console.error('❌ KYT Claude: Pre-send context injection failed:', error);
        }
      }

      // PHASE 2: Extract message data for storage AFTER injection
      let messageData = null;
      if (options && options.body) {
        try {
          const body = JSON.parse(options.body);

          // Claude API structure: { prompt: "user message text", ... }
          if (body.prompt) {
            messageData = {
              content: body.prompt,
              role: 'user',
              conversationId: conversationId,
              model: modelName,
              timestamp: Date.now(),
              messageId: `msg_${conversationId}_${Date.now()}`,
              platform: 'claude',
              url: url
            };

            console.log('🟢 KYT Claude: Message captured:', {
              conversationId,
              model: messageData.model,
              contentLength: messageData.content.length
            });

            // Check deduplication before dispatching
            if (window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch')) {
              // Send to bridge via CustomEvent
              window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
                detail: messageData
              }));

              console.log('🟢 KYT Claude: Event dispatched to bridge');
            } else {
              console.log('⏭️ KYT Claude: Duplicate message skipped by deduplicator');
            }
          }
        } catch (parseError) {
          console.error('🟢 KYT Claude: Failed to parse request body:', parseError);
        }
      }
    } catch (error) {
      console.error('🟢 KYT Claude: Error processing completion request:', error);
    }
  }

  // Always call the original fetch (with modified body if context was injected)
  const response = await originalFetch.apply(this, args);

  // PHASE 1.5: Capture assistant response
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion') && response.ok) {
    // Extract conversation ID from URL
    const conversationIdMatch = url.match(/chat_conversations\/([^\/]+)\/completion/);
    const conversationId = conversationIdMatch ? conversationIdMatch[1] : 'unknown';

    // FIX: Use modelName extracted BEFORE body modification
    let model = 'claude-unknown';
    if (options && options.body) {
      try {
        const body = JSON.parse(options.body);
        model = body.model || 'claude-unknown';
      } catch (e) {
        // Keep default
      }
    }

    // Capture response asynchronously (don't block UI)
    captureClaudeAssistantResponse(response, {
      conversationId: conversationId,
      platform: 'claude',
      model: model,
      timestamp: Date.now()
    }).catch(error => {
      console.error('❌ KYT Claude: Failed to capture assistant response:', error);
    });
  }

  return response;
};

/**
 * PHASE 1.5: Capture streaming Claude assistant response
 * Reads SSE stream and extracts assistant message
 */
async function captureClaudeAssistantResponse(response, metadata) {
  try {
    // FIX: Defensive checks for response.body
    if (!response) {
      console.warn('⚠️ KYT Claude: Response is null/undefined');
      return;
    }

    if (!response.body) {
      console.warn('⚠️ KYT Claude: Response body is null/undefined');
      console.log('📊 Response object:', {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers ? 'present' : 'missing',
        bodyUsed: response.bodyUsed
      });
      return;
    }

    // Clone response to avoid consuming original stream
    const clonedResponse = response.clone();

    if (!clonedResponse.body) {
      console.warn('⚠️ KYT Claude: Cloned response body is null/undefined');
      return;
    }

    const reader = clonedResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let messageId = null;

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, {stream: true});
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.substring(6).trim();
        if (data === '' || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);

          // Extract text from Claude SSE format
          // Format: {"type":"content_block_delta","delta":{"text":"content"}}
          if (json.type === 'content_block_delta' && json.delta?.text) {
            fullText += json.delta.text;
          }

          // Capture message ID if available
          if (!messageId && json.message?.id) {
            messageId = json.message.id;
          }

          // Alternative: message_start event may contain ID
          if (!messageId && json.type === 'message_start' && json.message?.id) {
            messageId = json.message.id;
          }
        } catch (parseError) {
          // Skip malformed JSON chunks
          continue;
        }
      }
    }

    // Only store if we captured meaningful text
    if (fullText.trim().length > 0) {
      const assistantMessage = {
        content: fullText.trim(),
        role: 'assistant',
        conversationId: metadata.conversationId,
        model: metadata.model,
        timestamp: Date.now(),
        messageId: messageId || `msg_assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: metadata.platform
      };

      console.log('🤖 KYT Claude: Assistant response captured:', {
        conversationId: assistantMessage.conversationId,
        contentLength: assistantMessage.content.length,
        contentPreview: assistantMessage.content.substring(0, 100) + '...'
      });

      // Dispatch event to bridge
      window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
        detail: assistantMessage
      }));

      console.log('🤖 KYT Claude: Assistant message event dispatched');
    } else {
      console.warn('⚠️ KYT Claude: No text captured from assistant response');
    }
  } catch (error) {
    console.error('❌ KYT Claude: Error capturing assistant response:', error);
    console.error('   Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n')[0]
    });
    // Don't throw - graceful degradation
  }
}

  // === HEALTH CHECK API ===
  window.KYT_Claude_Health = {
    getStats: function() {
      return {
        deduplication: window.KYT_Deduplicator.getStats(),
        contextInjection: {
          enabled: true,
          status: 'Context injection is ENABLED - RAG memory retrieval active'
        },
        platform: 'claude',
        timestamp: Date.now()
      };
    },

    resetStats: function() {
      window.KYT_Deduplicator.resetStats();
      console.log('✅ KYT Claude: Stats reset');
    }
  };

  console.log('🟢 KYT Claude: Fetch wrapper installed - ready to capture messages');
  console.log('ℹ️ Use window.KYT_Deduplicator.getStats() to check deduplication stats');
  console.log('ℹ️ Use window.KYT_Claude_Health.getStats() for full health check');
}

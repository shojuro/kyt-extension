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
      // Input validation
      if (options && typeof options !== 'object') {
        console.error('❌ KYT Dedupe: Invalid constructor options, using defaults');
        options = {};
      }

      this.recentMessages = new Map();
      this.processedMessageIds = new Set(); // MessageId-first deduplication (API UUIDs)
      this.maxMessageIdSetSize = options.maxMessageIdSetSize || 2000; // Max IDs to track
      this.dedupeWindow = options.dedupeWindow || 5000; // 5 seconds
      this.maxMapSize = options.maxMapSize || 1000; // Max entries to prevent DoS
      this.cleanupInterval = setInterval(() => this.cleanup(), 2000); // Run every 2s
      this.stats = {
        totalAttempts: 0,
        captured: 0,
        duplicatesSkipped: 0,
        upgradeCaptures: 0
      };

      // Error tracking
      this.errorLog = [];
      this.maxErrorLogSize = options.maxErrorLogSize || 100;

      // Concurrent access protection
      this._cleanupInProgress = false;
    }

    shouldCapture(content, captureMethod, messageId = null) {
      // PRIORITY 1: MessageId-first deduplication (trust API UUIDs)
      // This is the most reliable - API provides unique UUIDs for each message
      if (messageId && typeof messageId === 'string' && messageId.trim()) {
        const cleanId = messageId.trim();
        if (this.processedMessageIds.has(cleanId)) {
          console.log(`⏭️ KYT Dedupe: Skipping by messageId (${cleanId.substring(0, 12)}...)`);
          this.stats.duplicatesSkipped++;
          return false;
        }

        // Track this messageId
        this.processedMessageIds.add(cleanId);

        // FIFO eviction if Set is at max size
        if (this.processedMessageIds.size >= this.maxMessageIdSetSize) {
          const oldestId = this.processedMessageIds.values().next().value;
          this.processedMessageIds.delete(oldestId);
          console.log('🗑️ KYT Dedupe: FIFO eviction for messageIds, Set at max size:', this.maxMessageIdSetSize);
        }

        console.log(`✅ KYT Dedupe: New message by ID (${cleanId.substring(0, 12)}...)`);
        this.stats.totalAttempts++;
        this.stats.captured++;
        return true;
      }

      // PRIORITY 2: Content-hash deduplication (fallback when no messageId)
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
            console.log(`⏭️ KYT Dedupe: Skipping duplicate by hash (${captureMethod} ${confidence}% <= ${lastCapture.captureMethod} ${lastCapture.confidence}%)`);
            this.stats.duplicatesSkipped++;
            return false;
          }
        }
      }

      // FIFO eviction if Map is at max size
      if (this.recentMessages.size >= this.maxMapSize) {
        const oldestKey = this.recentMessages.keys().next().value;
        this.recentMessages.delete(oldestKey);
        console.log('🗑️ KYT Dedupe: FIFO eviction, Map at max size:', this.maxMapSize);
      }

      this.recentMessages.set(hash, { timestamp: now, confidence, captureMethod });
      this.stats.captured++;
      return true;
    }

    getConfidence(method) {
      const map = { 'websocket': 95, 'fetch': 95, 'fetch_tree': 95, 'dom': 70 };
      return map[method] || 50;
    }

    normalizeContent(content) {
      let normalized = String(content).trim().replace(/\s+/g, ' ').toLowerCase();
      
      // Unicode normalization (NFKC)
      if (typeof normalized.normalize === 'function') {
        try {
          normalized = normalized.normalize('NFKC');
        } catch (e) {
          console.warn('⚠️ KYT Dedupe: Unicode normalization failed:', e);
        }
      }
      
      return normalized;
    }

    hashContent(content) {
      // FNV-1a 32-bit hash algorithm for better distribution
      const FNV_PRIME = 0x01000193;
      const FNV_OFFSET_BASIS = 0x811c9dc5;
      
      let hash = FNV_OFFSET_BASIS;
      
      for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME);
      }
      
      return (hash >>> 0).toString(16);
    }

    cleanup() {
      // Concurrent access protection
      if (this._cleanupInProgress) {
        console.log('⏭️ KYT Dedupe: Cleanup already in progress, skipping');
        return;
      }

      this._cleanupInProgress = true;

      try {
        const now = Date.now();
        const cutoff = now - this.dedupeWindow;
        let removed = 0;

        // Safety checks
      if (this.dedupeWindow <= 0 || this.dedupeWindow > 3600000) {
        console.warn('⚠️ KYT Dedupe: Invalid dedup window, skipping cleanup');
        return;
      }

      if (now < 1600000000000) {
        console.error('❌ KYT Dedupe: System time incorrect, skipping cleanup');
        return;
      }

      for (const [hash, entry] of this.recentMessages.entries()) {
        if (!entry || typeof entry.timestamp !== 'number') {
          console.warn('⚠️ KYT Dedupe: Invalid entry, removing:', hash);
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
        this._cleanupInProgress = false;
      }
    }

    getStats() {
      const now = Date.now();
      const recentErrors = this.errorLog.filter(e => now - e.timestamp < 60000);

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

    _recordError(error) {
      const errorEntry = {
        timestamp: Date.now(),
        message: error?.message || String(error),
        stack: error?.stack || null
      };

      this.errorLog.push(errorEntry);

      if (this.errorLog.length > this.maxErrorLogSize) {
        this.errorLog.shift();
      }
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
   * VALIDATION FIX: Track in-flight context requests by message hash
   * Prevents duplicate API calls for rapid-fire identical messages
   */
  const inflightContextByHash = new Map();
  const DEDUP_WINDOW_MS = 500; // 500ms window for deduplication

  /**
   * Simple hash function for message deduplication
   * @param {string} str - String to hash
   * @returns {number} 32-bit hash
   */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  /**
   * Check if a context error is recoverable (extension reloaded / SW cooling down)
   */
  function isRecoverableContextError(errorMsg) {
    return typeof errorMsg === 'string' && (
      errorMsg.includes('Extension context invalidated') ||
      errorMsg.includes('Service worker disconnected') ||
      errorMsg.includes('Service worker cooling down') ||
      errorMsg.includes('Service worker did not respond')
    );
  }

  /**
   * Persistent listener for context responses
   * Lives at module level - never garbage collected
   */
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);

    if (pending) {
      // Retry once on recoverable errors — gives re-injection / cooldown time to complete
      if (!event.detail.success && !pending.retried && isRecoverableContextError(event.detail.error)) {
        pending.retried = true;
        console.log('🔄 KYT Claude: Context failed (recoverable), retrying in 3s...');
        setTimeout(() => {
          if (!pendingContextRequests.has(requestId)) return; // Already timed out
          window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
            detail: {
              requestId: requestId,
              userMessage: pending.userMessage,
              config: pending.config
            }
          }));
        }, 3000);
        return; // Don't resolve yet — wait for retry response
      }

      clearTimeout(pending.timeout);
      pendingContextRequests.delete(requestId);
      inflightContextByHash.delete(pending.messageHash); // VALIDATION FIX: Cleanup dedup map

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

      // VALIDATION FIX: Check for duplicate in-flight requests
      const messageHash = simpleHash(body.prompt);
      const existingRequest = inflightContextByHash.get(messageHash);
      
      if (existingRequest && (Date.now() - existingRequest.timestamp) < DEDUP_WINDOW_MS) {
        console.log('🔄 KYT Claude: Reusing in-flight context request for duplicate message');
        return existingRequest.promise;
      }

      console.log('🔍 KYT Claude: Requesting context for:', body.prompt.substring(0, 50) + '...');

      // Test mode for Claude is handled entirely by content_bridge.js (ISOLATED world).
      // MAIN world cannot fetch Supabase due to claude.ai CSP restrictions.
      // The bridge uses natural-language format that avoids Claude's safety filter.

      // Generate unique request ID
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // VALIDATION FIX: Create promise and track for deduplication
      const promise = new Promise((resolve) => {
        // 30s MAIN world timeout — leaves 5s margin after 25s background timeout
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          inflightContextByHash.delete(messageHash); // VALIDATION FIX: Cleanup dedup map
          console.error('⏱️ KYT Claude: Context timeout after 30s', {
            requestId: requestId,
            userMessage: body.prompt.substring(0, 50),
            pendingRequests: pendingContextRequests.size
          });
          resolve(bodyString);
        }, 30000);

        // Config for context request
        const contextConfig = {
          threshold: 0.5, // pgvector distance: lower = stricter, 0.5 = balanced
          maxContextItems: 5, // Increased from 3 for more context
          debugMode: false
        };

        // Store request in Map - prevents garbage collection
        // userMessage + config stored for retry on recoverable errors
        pendingContextRequests.set(requestId, {
          resolve: resolve,
          timeout: timeout,
          body: body,
          originalBody: bodyString,
          messageHash: messageHash, // VALIDATION FIX: Store for dedup cleanup
          userMessage: body.prompt,
          config: contextConfig
        });

        // Dispatch context request
        window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
          detail: {
            requestId: requestId,
            userMessage: body.prompt,
            config: contextConfig
          }
        }));
      });

      // VALIDATION FIX: Store promise for deduplication and return it
      inflightContextByHash.set(messageHash, {
        promise: promise,
        timestamp: Date.now()
      });

      return promise;
    } catch (error) {
      console.error('❌ KYT Claude: Context injection error:', error);
      return bodyString; // Error - proceed with original
    }
  }

/**
 * Strip K.Y.T. Memory Injection Protocol blocks from content
 * Prevents recursive pollution where injection blocks get saved as memories
 * @param {string} content - Message content that may contain injection blocks
 * @returns {string} - Clean content without injection blocks
 */
function stripInjectionBlock(content) {
  // Pattern 5: Natural-language parenthetical injection format
  // Matches: (For context: I've talked about things like this before...I'm sharing these so you have the full picture.)
  // Also matches variant: (For context: I've mentioned some of these topics before...Do not add specific dates...)
  const naturalLangPattern = /\(For context: I've (?:talked about things like this before|mentioned some of these topics before)[\s\S]*?(?:I'm sharing these so you have the full picture[^)]*|Do not add specific dates[^)]*)\)\s*(?:---\s*)?/g;
  if (naturalLangPattern.test(content)) {
    content = content.replace(naturalLangPattern, '').trim();
  }

  // SAFER: Only strip structured formats if K.Y.T. markers are actually present
  const hasKYTMarkers = content.includes('[SESSION_CONTEXT]') ||
                        content.includes('[RETRIEVAL_CONTEXT]') ||
                        content.includes('[DATA_PROVENANCE]') ||
                        content.includes('[Retrieved Items]') ||
                        content.includes('K.Y.T.');

  if (!hasKYTMarkers) {
    return content; // Fast path: nothing more to strip
  }

  // Line-by-line approach - much safer than greedy regex
  const lines = content.split('\n');
  const result = [];
  let inBlock = false;
  let blockDepth = 0;

  for (const line of lines) {
    // Check for block start markers
    if (line.match(/^\[(SESSION_CONTEXT|RETRIEVAL_CONTEXT|DATA_PROVENANCE|Retrieved Items)\]/) ||
        line.match(/^={3,}.*K\.Y\.T\./)) {
      inBlock = true;
      blockDepth++;
      continue;
    }

    // Check for block end markers
    if (inBlock && (line.match(/^={3,}$/) || line.trim() === '')) {
      blockDepth--;
      if (blockDepth <= 0) {
        inBlock = false;
        blockDepth = 0;
      }
      continue;
    }

    // Skip standalone markers
    if (line.match(/^\[(?:Memory Context|Query Optimized|End of (?:Memory|Knowledge Base) Context)\]/)) {
      continue;
    }

    // Skip separator lines
    if (line.match(/^={80,}$/)) {
      continue;
    }

    // Keep non-block content
    if (!inBlock) {
      result.push(line);
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Process full conversation from JSON response (mobile sync capture)
 * Claude format: { uuid, name, chat_messages: [{ uuid, text, sender, created_at }] }
 */
function processClaudeConversation(response) {
  if (!response || !response.chat_messages || !Array.isArray(response.chat_messages)) {
    return;
  }

  try {
    const conversationId = response.uuid || 'unknown';

    // Sort by created_at timestamp
    const messages = [...response.chat_messages].sort((a, b) => {
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    let processedCount = 0;
    let skippedNoContent = 0;
    let skippedDuplicate = 0;

    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];

      // Extract content from ALL possible field locations with tracking
      let content = '';
      let extractedFrom = 'none';

      // Priority 1: Direct text field (most common for Claude)
      if (typeof msg.text === 'string' && msg.text.trim()) {
        content = msg.text.trim();
        extractedFrom = 'text';
      }
      // Priority 2: Content array (Claude API format)
      else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter(block => block && block.type === 'text')
          .map(block => block.text || '')
          .join('\n')
          .trim();
        extractedFrom = 'content_array';
      }
      // Priority 3: Content string
      else if (typeof msg.content === 'string' && msg.content.trim()) {
        content = msg.content.trim();
        extractedFrom = 'content_string';
      }
      // Priority 4: Message field (alternative API format)
      else if (typeof msg.message === 'string' && msg.message.trim()) {
        content = msg.message.trim();
        extractedFrom = 'message';
      }
      // Priority 5: Body field
      else if (typeof msg.body === 'string' && msg.body.trim()) {
        content = msg.body.trim();
        extractedFrom = 'body';
      }

      if (!content) {
        console.warn(`⚠️ KYT Claude: No content extracted [${idx}], keys: ${Object.keys(msg).join(', ')}`);
        skippedNoContent++;
        continue;
      }

      // Map Claude's sender to role - CASE INSENSITIVE
      const senderLower = (msg.sender || '').toLowerCase();
      const role = senderLower === 'human' ? 'user' : 'assistant';

      // Strip injection blocks from content
      const cleanedContent = stripInjectionBlock(content);

      if (!cleanedContent || cleanedContent.length < 2) {
        skippedNoContent++;
        continue;
      }

      const messageData = {
        content: cleanedContent,
        role: role,
        conversationId: conversationId,
        model: 'claude-3-opus',
        originalId: msg.uuid,
        timestamp: msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
        platform: 'claude',
        captureMethod: 'fetch_tree'
      };

      // Deduplication check - pass msg.uuid for MessageId-first dedup
      let shouldCapture = true;
      if (window.KYT_Deduplicator) {
        shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch_tree', msg.uuid);
      }

      if (shouldCapture) {
        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
        processedCount++;
      } else {
        console.log('⏭️ KYT Claude: Duplicate skipped');
        skippedDuplicate++;
      }
    }

    console.log(`🎯 KYT Claude: Processed conversation ${conversationId.substring(0, 8)}... — ${processedCount} captured, ${skippedDuplicate} dedup, ${skippedNoContent} empty`);

  } catch (error) {
    console.error('❌ KYT Claude: Error processing conversation:', error);
  }
}

// Conversation-level dedup to prevent 10x parallel processing
const recentConversationFetches = new Map();
const CONVERSATION_DEDUP_WINDOW = 2000; // 2 seconds

// Wrap window.fetch to intercept Claude API calls
// Idempotent: always wrap the TRUE original fetch, not an already-wrapped version.
// This makes re-injection safe after extension reload.
if (!window.__kytOriginalFetch) window.__kytOriginalFetch = window.fetch;
const originalFetch = window.__kytOriginalFetch;
window.fetch = async function(...args) {
  const [url, options] = args;

  // DIAGNOSTIC: Log ALL Claude API calls to identify memory check endpoint
  if (typeof url === 'string' && url.includes('claude.ai/api')) {
    const endpoint = url.replace(/https:\/\/claude\.ai\/api\//, '');
    console.log('🔍 KYT Claude API Call:', endpoint.substring(0, 100));
  }

  // Check if this is a GET request to fetch conversation (mobile sync scenario)
  const urlString = typeof url === 'string' ? url : String(url);
  const isConversationFetch =
    urlString.includes('claude.ai/api/') &&
    urlString.includes('/chat_conversations/') &&
    !urlString.includes('/completion') &&
    (!options?.body) &&
    (options?.method === 'GET' || !options?.method);

  if (isConversationFetch) {
    // Handle GET requests that fetch full conversation JSON (mobile-synced messages)
    console.log('🔍 KYT Claude: Intercepted conversation fetch (GET):', urlString.substring(0, 100));

    // Extract conversation ID from URL
    const match = urlString.match(/\/chat_conversations\/([^\/]+)/);
    const conversationId = match ? match[1] : 'unknown';

    // CONVERSATION-LEVEL DEDUP: Prevent 10x parallel processing of same conversation
    const now = Date.now();
    const lastFetch = recentConversationFetches.get(conversationId);
    if (lastFetch && (now - lastFetch) < CONVERSATION_DEDUP_WINDOW) {
      console.log(`⏭️ KYT Claude: Skipping duplicate conversation fetch (${conversationId.substring(0, 8)}...) - processed ${now - lastFetch}ms ago`);
      return originalFetch.apply(this, args);
    }
    recentConversationFetches.set(conversationId, now);

    // Cleanup old entries (older than 10s)
    for (const [id, timestamp] of recentConversationFetches) {
      if (now - timestamp > 10000) {
        recentConversationFetches.delete(id);
      }
    }

    const response = await originalFetch.apply(this, args);

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const clone = response.clone();
        clone.json().then(json => {
          if (json && json.chat_messages) {
            console.log('🎯 KYT Claude: Captured conversation from GET (mobile sync)');
            processClaudeConversation(json);
          }
        }).catch(err => console.warn('⚠️ KYT Claude: Error parsing GET response:', err));
      }
    }

    return response;
  }

  // Check if this is a Claude message completion request
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion') && !url.includes('/completion_status')) {
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
              content: stripInjectionBlock(body.prompt),
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

            // Check deduplication before dispatching (with error boundary)
            // Pass messageId for MessageId-first dedup (generated ID for POST, API UUID for GET)
            let shouldCapture = true; // Default: always capture (fail-open)
            try {
              shouldCapture = window.KYT_Deduplicator.shouldCapture(messageData.content, 'fetch', messageData.messageId);
            } catch (dedupeError) {
              console.error('❌ KYT Claude: Deduplication error, capturing anyway:', dedupeError);
              // Record error for health monitoring
              if (window.KYT_Deduplicator?._recordError) {
                window.KYT_Deduplicator._recordError(dedupeError);
              }
            }

            if (shouldCapture) {
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
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion') && !url.includes('/completion_status') && response.ok) {
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
    // VALIDATION FIX: Filter out expected AbortError (user stopped generation)
    if (error.name === 'AbortError') {
      console.debug('ℹ️ KYT Claude: Response stream aborted (user likely stopped generation)');
      return; // Silent exit for expected behavior
    }
    
    // Log unexpected errors only
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

  // === SSR CONVERSATION CAPTURE ===
  // Claude uses SSR for conversation pages — data is embedded in HTML,
  // not fetched via client-side API. The fetch wrapper only catches
  // user-initiated actions (POST /completion). For mobile-synced
  // conversations opened on web, we must extract data from the page.

  // Cache org_id once discovered — used for self-fetch fallback
  let _cachedOrgId = null;

  /**
   * Discover org_id from page data or API responses.
   * Claude's API URLs: /api/organizations/{org_id}/chat_conversations/{id}
   */
  function discoverOrgId() {
    if (_cachedOrgId) return _cachedOrgId;

    // Method 1: __NEXT_DATA__ page props
    try {
      const nd = window.__NEXT_DATA__;
      const id = nd?.props?.pageProps?.organizationId
              || nd?.props?.pageProps?.orgId
              || nd?.query?.organizationId;
      if (id) { _cachedOrgId = id; return id; }
    } catch (_) {}

    // Method 2: Scan meta tags
    try {
      const meta = document.querySelector('meta[name="organization-id"]');
      if (meta?.content) { _cachedOrgId = meta.content; return meta.content; }
    } catch (_) {}

    // Method 3: Cookie (Claude sets lastActiveOrg)
    try {
      const m = document.cookie.match(/lastActiveOrg=([^;]+)/);
      if (m) { _cachedOrgId = m[1]; return m[1]; }
    } catch (_) {}

    // Method 4: Extract from any visible API link on the page
    try {
      const links = document.querySelectorAll('a[href*="/organizations/"]');
      for (const link of links) {
        const m = link.href.match(/\/organizations\/([a-f0-9-]+)/);
        if (m) { _cachedOrgId = m[1]; return m[1]; }
      }
    } catch (_) {}

    return null;
  }

  /**
   * Recursively search an object tree for a node with chat_messages array.
   */
  function findConversationData(obj, depth) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.chat_messages)) return obj;
    for (const key of Object.keys(obj)) {
      const result = findConversationData(obj[key], depth + 1);
      if (result) return result;
    }
    return null;
  }

  /**
   * Attempt to capture conversation data from SSR-embedded sources.
   * Falls back to self-fetching the conversation via API.
   */
  function attemptSSRCapture() {
    const conversationMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
    if (!conversationMatch) return;
    const conversationId = conversationMatch[1];

    console.log('🔍 KYT Claude: Conversation page detected, checking for SSR data...');

    // Method 1: __NEXT_DATA__ global (Next.js SSR)
    try {
      const nextData = window.__NEXT_DATA__;
      if (nextData) {
        const conversation = findConversationData(nextData, 0);
        if (conversation) {
          console.log('🎯 KYT Claude: Found conversation in __NEXT_DATA__');
          processClaudeConversation(conversation);
          return;
        }
      }
    } catch (e) {
      console.warn('⚠️ KYT Claude: __NEXT_DATA__ parse error:', e.message);
    }

    // Method 2: Scan <script type="application/json"> tags
    try {
      const jsonScripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of jsonScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const conversation = findConversationData(data, 0);
          if (conversation) {
            console.log('🎯 KYT Claude: Found conversation in embedded JSON script');
            processClaudeConversation(conversation);
            return;
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Method 3: Scan all <script> tags for inline chat_messages data
    try {
      const allScripts = document.querySelectorAll('script:not([src])');
      for (const script of allScripts) {
        const text = script.textContent || '';
        if (!text.includes('chat_messages')) continue;
        // Try to extract JSON from script content (e.g., self.__next_f.push payloads)
        const jsonMatches = text.match(/\{[^{}]*"chat_messages"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/g);
        if (jsonMatches) {
          for (const jsonStr of jsonMatches) {
            try {
              const data = JSON.parse(jsonStr);
              if (data.chat_messages) {
                console.log('🎯 KYT Claude: Found conversation in inline script');
                processClaudeConversation(data);
                return;
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Method 4: Self-fetch the conversation via API
    // Our fetch wrapper will intercept the response and process it automatically
    const orgId = discoverOrgId();
    if (orgId) {
      console.log('🔍 KYT Claude: Self-fetching conversation via API...');
      originalFetch(`/api/organizations/${orgId}/chat_conversations/${conversationId}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.clone().json();
        })
        .then(json => {
          if (json?.chat_messages) {
            console.log('🎯 KYT Claude: Self-fetch successful, processing conversation');
            processClaudeConversation(json);
          }
        })
        .catch(e => console.warn('⚠️ KYT Claude: Self-fetch failed:', e.message));
    } else {
      console.log('⚠️ KYT Claude: No org_id found — cannot self-fetch conversation');
      console.log('   Checked: __NEXT_DATA__, meta tags, cookies, page links');
    }
  }

  // Only run SSR capture on genuine page navigation, NOT on re-injection.
  // Re-injection (extension reload) sets KYT_CLAUDE_INJECTED=false then re-runs this script.
  // We detect re-injection by checking if a previous generation already ran SSR capture.
  // This prevents 350+ SAVE_MESSAGE calls from flooding the service worker.
  if (!window._kytSSRCaptureRan) {
    window._kytSSRCaptureRan = true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(attemptSSRCapture, 500));
    } else {
      setTimeout(attemptSSRCapture, 500);
    }
  }

  // SPA navigation always triggers SSR capture (user switched conversations)
  const _origPushState = history.pushState;
  history.pushState = function(...args) {
    _origPushState.apply(this, args);
    setTimeout(attemptSSRCapture, 1000);
  };
  window.addEventListener('popstate', () => setTimeout(attemptSSRCapture, 1000));

  console.log('🟢 KYT Claude: SSR capture + SPA navigation listener installed');
}

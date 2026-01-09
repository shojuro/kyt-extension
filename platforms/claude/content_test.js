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
   * Persistent listener for context responses
   * Lives at module level - never garbage collected
   */
  window.addEventListener('KYT_CONTEXT_RESPONSE', (event) => {
    const { requestId } = event.detail;
    const pending = pendingContextRequests.get(requestId);

    if (pending) {
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

      // Generate unique request ID
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // VALIDATION FIX: Create promise and track for deduplication
      const promise = new Promise((resolve) => {
        // PHASE 1 FIX #5: Increase timeout to 10s with better error logging
        const timeout = setTimeout(() => {
          pendingContextRequests.delete(requestId);
          inflightContextByHash.delete(messageHash); // VALIDATION FIX: Cleanup dedup map
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
          originalBody: bodyString,
          messageHash: messageHash // VALIDATION FIX: Store for dedup cleanup
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
  // SAFER: Only strip if K.Y.T. markers are actually present
  const hasKYTMarkers = content.includes('[SESSION_CONTEXT]') ||
                        content.includes('[RETRIEVAL_CONTEXT]') ||
                        content.includes('[DATA_PROVENANCE]') ||
                        content.includes('[Retrieved Items]') ||
                        content.includes('K.Y.T.');

  if (!hasKYTMarkers) {
    return content; // Fast path: nothing to strip
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
  // DIAGNOSTIC: Log the response structure comprehensively
  const firstMsg = response?.chat_messages?.[0];
  console.log('🔍 KYT DIAG processClaudeConversation called with:', {
    hasResponse: !!response,
    responseKeys: response ? Object.keys(response).slice(0, 15) : [],
    hasChatMessages: !!response?.chat_messages,
    chatMessagesLength: response?.chat_messages?.length || 0,
    firstMessage: firstMsg ? {
      allKeys: Object.keys(firstMsg),
      sender: firstMsg.sender,
      // Check all possible text field names
      hasText: !!firstMsg.text,
      hasContent: !!firstMsg.content,
      hasMessage: !!firstMsg.message,
      hasBody: !!firstMsg.body,
      // Show actual values
      textValue: firstMsg.text?.substring?.(0, 80) || firstMsg.text,
      contentValue: firstMsg.content?.substring?.(0, 80) || firstMsg.content,
      messageValue: firstMsg.message?.substring?.(0, 80) || firstMsg.message,
      // Check if text is nested
      textContent: firstMsg.text?.content?.substring?.(0, 80),
      contentText: firstMsg.content?.text?.substring?.(0, 80)
    } : 'NO_MESSAGES'
  });

  if (!response || !response.chat_messages || !Array.isArray(response.chat_messages)) {
    console.log('⚠️ KYT DIAG: No chat_messages array found');
    return;
  }

  try {
    const conversationId = response.uuid || 'unknown';

    // Sort by created_at timestamp
    const messages = [...response.chat_messages].sort((a, b) => {
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    console.log(`🔍 KYT DIAG: Processing ${messages.length} messages for conversation ${conversationId}`);

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

      // Log extraction result for debugging
      console.log(`📝 KYT Content Extraction [${idx}]: extractedFrom=${extractedFrom}, length=${content.length}, sender=${msg.sender}`);

      if (!content) {
        // CRITICAL: Full message dump for failed extractions
        console.error(`❌ KYT: NO CONTENT EXTRACTED [${idx}]`);
        console.error(`   Keys available: ${Object.keys(msg).join(', ')}`);
        console.error(`   FULL MSG DUMP:`, JSON.stringify(msg, null, 2));
        skippedNoContent++;
        continue;
      }

      // Map Claude's sender to role - CASE INSENSITIVE
      const senderLower = (msg.sender || '').toLowerCase();
      const role = senderLower === 'human' ? 'user' : 'assistant';

      // Strip injection blocks from content
      const cleanedContent = stripInjectionBlock(content);

      // CRITICAL: Validate content wasn't stripped to nothing
      if (!cleanedContent || cleanedContent.length < 2) {
        console.error(`❌ KYT: Content stripped to empty! [${idx}]`);
        console.error(`   Original (${content.length} chars):`, content.substring(0, 200));
        console.error(`   Cleaned (${cleanedContent?.length || 0} chars):`, cleanedContent);
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
        // DIAGNOSTIC: Log role assignment for each message
        console.log(`🎙️ KYT Claude (Mobile Sync): sender="${msg.sender}" → role="${role}"`);
        console.log(`   Content: ${messageData.content.substring(0, 50)}...`);

        window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
          detail: messageData
        }));
        processedCount++;
      } else {
        console.log('⏭️ KYT Claude: Duplicate skipped');
        skippedDuplicate++;
      }
    }

    // DIAGNOSTIC: Summary
    console.log('🔍 KYT DIAG Summary:', {
      totalMessages: messages.length,
      captured: processedCount,
      skippedNoContent: skippedNoContent,
      skippedDuplicate: skippedDuplicate
    });

  } catch (error) {
    console.error('❌ KYT Claude: Error processing conversation:', error);
  }
}

// Conversation-level dedup to prevent 10x parallel processing
const recentConversationFetches = new Map();
const CONVERSATION_DEDUP_WINDOW = 2000; // 2 seconds

// Wrap window.fetch to intercept Claude API calls
const originalFetch = window.fetch;
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

      console.log('🔍 KYT DIAG Response (GET):', {
        url: urlString.substring(0, 100),
        status: response.status,
        contentType: contentType,
        conversationId: conversationId
      });

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
  console.log('ℹ️ Use window.KYT_Deduplicator.getStats() to check deduplication stats');
  console.log('ℹ️ Use window.KYT_Claude_Health.getStats() for full health check');
}

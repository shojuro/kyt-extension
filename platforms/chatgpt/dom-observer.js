/**
 * DOM MutationObserver for capturing mobile-synced ChatGPT messages
 *
 * This module captures messages that originate from mobile voice conversations
 * and sync to the desktop web interface. Mobile messages appear directly in the
 * DOM without triggering fetch/XHR events, so DOM observation is the only
 * reliable interception point.
 *
 * Architecture:
 * - MutationObserver watches conversation container for new message nodes
 * - Multi-tier selector fallback for robustness against UI changes
 * - Throttled mutation handling for performance
 * - Auto-restart on failure with exponential backoff
 * - Strict filtering to capture user messages only (not assistant responses)
 *
 * @module dom-observer
 */

(function () {
  'use strict';

  // Configuration
  const CONFIG = {
    // Selector tiers (fallback from most stable to least)
    SELECTOR_TIERS: [
      // Tier 1: Data attributes (most stable)
      '[data-testid="conversation"]',

      // Tier 2: Role-based (semantic)
      '[role="presentation"]',

      // Tier 3: Class patterns (more fragile)
      'main .flex.flex-col',

      // Tier 4: Structural fallback
      'main > div > div'
    ],

    // Message node selectors
    MESSAGE_SELECTORS: {
      userMessage: '[data-message-author-role="user"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      messageFallback: '.group.w-full, [data-testid*="conversation-turn"], article'
    },

    // Performance tuning
    THROTTLE_MS: 100,          // Max 10 mutations/second
    DEBOUNCE_MS: 50,           // Wait 50ms after last mutation
    MAX_RESTART_ATTEMPTS: 5,
    RESTART_BACKOFF_MS: 1000,  // Exponential backoff base

    // Placeholder patterns to skip
    PLACEHOLDERS: ['...', '•••', 'Thinking...', 'Loading', '　', 'Transcript Unavailable...'],
  };

  // State
  let observer = null;
  let restartAttempts = 0;
  let throttleTimer = null;
  let debounceTimer = null;
  let pendingMutations = [];
  let isProcessing = false;
  let debugMode = false;

  // STREAMING STATE: Track when SSE stream is active to prevent capturing partial messages
  let isStreaming = false;
  let streamingTimeout = null;

  // Cache to prevent spamming the same message during polling
  const sentMessages = new Set();

  // Initialization state (to prevent sending history on reload)
  let isInitializing = false;

  // Buffering for split user messages (Voice Mode chunks)
  let userMessageBuffer = {
    content: '',
    timestamp: 0,
    timer: null,
    conversationId: null
  };
  const BUFFER_DELAY = 1500; // Wait 1.5s for more chunks

  /**
   * Initialize the DOM observer
   */
  function init() {
    try {
      log('Initializing DOM observer for mobile message capture...');

      // Listen for streaming state from inject.js (prevents capturing partial messages)
      window.addEventListener('KYT_STREAM_STATE', (event) => {
        isStreaming = event.detail?.streaming || false;
        log(`Streaming state: ${isStreaming ? 'ACTIVE' : 'IDLE'}`);

        // Safety: Auto-clear streaming flag after 60s in case event is missed
        if (isStreaming) {
          if (streamingTimeout) clearTimeout(streamingTimeout);
          streamingTimeout = setTimeout(() => {
            isStreaming = false;
            log('Streaming state auto-cleared (timeout)');
          }, 60000);
        }
      });

      startObserver();
    } catch (error) {
      logError('Failed to initialize observer:', error);
      scheduleRestart();
    }
  }

  /**
   * Start the MutationObserver
   */
  function startObserver() {
    // Find conversation container - prefer specific container over body
    const container = findConversationContainer();

    // Use container if found, otherwise fall back to main element (NOT body)
    // This dramatically reduces mutation noise from unrelated UI updates
    let targetNode = container;
    if (!targetNode) {
      targetNode = document.querySelector('main') || document.querySelector('[role="main"]');
    }
    if (!targetNode) {
      // Last resort: body, but log a warning
      targetNode = document.body;
      log('WARNING: Using document.body as observer target (high noise)');
    }

    log('Starting observer on:', targetNode.tagName, '(Container:', container ? 'found' : 'NOT FOUND', ')');

    // Create observer
    observer = new MutationObserver(handleMutations);

    // Start observing - reduced scope for attributes/characterData
    // Only watch childList broadly, attributes only on message nodes
    observer.observe(targetNode, {
      childList: true,   // Watch for added/removed nodes
      subtree: true,     // Watch entire subtree
      attributes: false, // DISABLED: Too noisy, causes cascade failures
      characterData: false // DISABLED: Too noisy for streaming content
    });

    // Set initialization flag to ignore existing history
    isInitializing = true;
    log('Initialization phase started (ignoring history for 3s)...');
    setTimeout(() => {
      isInitializing = false;
      log('Initialization phase complete - ready to capture new messages');
    }, 3000);

    // Hydrate cache with existing messages (still useful for immediate cache population)
    hydrateCache();

    restartAttempts = 0; // Reset on success
    log('DOM observer started successfully (watching:', targetNode.tagName, ')');

    // Notify background of observer status
    notifyBackgroundObserverStatus('running');
  }

  /**
   * Hydrate cache with existing messages (prevent re-sending history)
   */
  function hydrateCache() {
    const container = findConversationContainer() || document.querySelector('main');
    const groups = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.messageFallback);
    const allNodes = Array.from(groups).filter(node => isMessageNode(node));

    // Scan last 20 messages
    const recentNodes = allNodes.slice(-20);
    let count = 0;

    recentNodes.forEach(node => {
      try {
        const message = extractMessage(node);
        if (message) {
          const signature = `${message.role}:${message.content.trim()}`;
          if (!sentMessages.has(signature)) {
            sentMessages.add(signature);
            count++;
          }
        }
      } catch (e) {
        // Ignore errors during hydration
      }
    });

    if (count > 0) {
      log(`Hydrated cache with ${count} existing messages`);
    }
  }

  /**
   * Find conversation container using tiered selector fallback
   */
  function findConversationContainer() {
    for (let i = 0; i < CONFIG.SELECTOR_TIERS.length; i++) {
      const selector = CONFIG.SELECTOR_TIERS[i];
      const container = document.querySelector(selector);

      if (container) {
        log(`Using selector tier ${i + 1}: ${selector}`);
        return container;
      }
    }

    logError('No conversation container found with any selector tier');
    return null;
  }

  /**
   * Handle mutation events (throttled and debounced)
   */
  function handleMutations(mutations) {
    // Add to pending queue
    pendingMutations.push(...mutations);

    // Clear existing debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    // Debounce: Wait for mutations to settle
    debounceTimer = setTimeout(() => {
      // Throttle: Limit processing rate
      if (!throttleTimer) {
        processMutations();
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
        }, CONFIG.THROTTLE_MS);
      }
    }, CONFIG.DEBOUNCE_MS);
  }

  /**
   * Process accumulated mutations
   */
  function processMutations() {
    if (isProcessing || pendingMutations.length === 0) {
      return;
    }

    isProcessing = true;
    const mutationsToProcess = [...pendingMutations];
    pendingMutations = [];

    try {
      log(`Processing ${mutationsToProcess.length} mutations...`);

      for (const mutation of mutationsToProcess) {
        let targetNode = null;

        if (mutation.type === 'childList') {
          // Aggressive Debug Logging
          if (debugMode) {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1) { // Element
                console.log('DOM DEBUG: Added node:', node.tagName, node.className, node.outerHTML.substring(0, 100));
              }
            });
          }

          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) { // Element
              // Check if the node itself is a message
              if (isMessageNode(node)) {
                processMessageNode(node);
              }
              // Also check children (sometimes messages are wrapped)
              else {
                const messages = node.querySelectorAll(CONFIG.MESSAGE_SELECTORS.messageFallback);
                messages.forEach(msg => {
                  if (isMessageNode(msg)) {
                    processMessageNode(msg);
                  }
                });
              }
            }
          });
        }
        else if (mutation.type === 'characterData') {
          // Text changed - check ancestors
          targetNode = mutation.target.parentElement;
          const messageNode = findClosestMessageNode(targetNode);
          if (messageNode) {
            log('DOM Mutation: Text update in message node');
            processMessageNode(messageNode);
          }
        }
        else if (mutation.type === 'attributes') {
          // Attribute changed - check ancestors
          targetNode = mutation.target;
          const messageNode = findClosestMessageNode(targetNode);
          if (messageNode) {
            log('DOM Mutation: Attribute update in message node');
            processMessageNode(messageNode);
          }
        }

      }
    } catch (error) {
      logError('Error processing mutations:', error);
      stopObserver();
      scheduleRestart();
    } finally {
      isProcessing = false;

      // HYBRID FALLBACK: Always scan recent messages after any mutation batch
      // This catches messages that were missed by specific node logic (e.g. deep nesting)
      // or that weren't ready during the initial mutation event.
      setTimeout(checkRecentMessages, 500);
    }
  }

  /**
   * Scan the last few messages to ensure we didn't miss anything
   * (Active Polling on Mutation)
   */
  function checkRecentMessages() {
    // SKIP DURING STREAMING: Prevents capturing partial messages as they render
    // SSE capture in inject.js will get the complete message when stream finishes
    if (isStreaming) {
      log('Skipping poll - SSE stream active');
      return;
    }

    // Use container if found, otherwise fallback to main (not body - too noisy)
    const container = findConversationContainer() || document.querySelector('main');
    if (!container) return; // No container = can't scan

    // Get all message nodes using the broad fallback selector
    const groups = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.messageFallback);
    const allNodes = Array.from(groups).filter(node => isMessageNode(node));

    if (allNodes.length === 0) return;

    // Sort by position
    allNodes.sort((a, b) => {
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });

    // Check only the last 5 messages (most recent)
    const recentNodes = allNodes.slice(-5);

    recentNodes.forEach(node => {
      try {
        const message = extractMessage(node);
        if (message) {
          // Generate a simple signature for the cache
          const signature = `${message.role}:${message.content.trim()}`;

          if (!sentMessages.has(signature)) {
            log('Active Poll: Found new/updated message:', message.content.substring(0, 30) + '...');

            // Mark as 'dom' source (standard capture)
            message.source = 'dom';
            sendToBackground(message);

            sentMessages.add(signature);

            // Limit cache size
            if (sentMessages.size > 100) {
              const first = sentMessages.values().next().value;
              sentMessages.delete(first);
            }
          }
        }
      } catch (error) {
        // Ignore errors in polling
      }
    });
  }

  /**
   * Find the closest message node ancestor
   */
  function findClosestMessageNode(element) {
    let current = element;
    let depth = 0;
    const MAX_DEPTH = 10; // Prevent infinite loops

    while (current && depth < MAX_DEPTH && current !== document.body) {
      if (isMessageNode(current)) {
        return current;
      }
      current = current.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * Check if node is a message node
   */
  function isMessageNode(node) {
    if (!(node instanceof HTMLElement)) return false;

    // Check for user message role
    const hasUserRole = node.matches(CONFIG.MESSAGE_SELECTORS.userMessage);
    if (hasUserRole) return true;

    // Check for assistant message role (now supported)
    const hasAssistantRole = node.matches(CONFIG.MESSAGE_SELECTORS.assistantMessage);
    if (hasAssistantRole) return true;

    // Fallback: Check for message-like structure
    const hasFallbackClass = node.matches(CONFIG.MESSAGE_SELECTORS.messageFallback);
    if (hasFallbackClass) {
      // Additional validation: must have text content
      const text = node.innerText?.trim();
      return text && text.length > 0;
    }

    return false;
  }

  /**
   * Process a single message node
   */
  function processMessageNode(node) {
    try {
      const message = extractMessage(node);

      if (message) {
        // SKIP ASSISTANT MESSAGES DURING STREAMING: Prevents capturing partial messages
        // SSE capture in inject.js will get the complete assistant message
        if (message.role === 'assistant' && isStreaming) {
          log('Skipping assistant message during stream');
          return;
        }

        // Deduplication: Check cache
        const signature = `${message.role}:${message.content.trim()}`;

        // Always update cache, even if initializing
        if (sentMessages.has(signature)) {
          return; // Skip duplicate
        }
        sentMessages.add(signature);
        if (sentMessages.size > 100) {
          const first = sentMessages.values().next().value;
          sentMessages.delete(first);
        }

        // If initializing, DO NOT send (it's history)
        if (isInitializing) {
          log('Skipping history message during init:', message.content.substring(0, 30) + '...');
          return;
        }

        log('Extracted message:', message.content.substring(0, 50) + '...');

        // User Message Buffering (Merge split paragraphs)
        if (message.role === 'user') {
          handleUserMessageBuffering(message);
        } else {
          // Assistant/System message: Flush any pending user buffer first
          flushUserBuffer();
          sendToBackground(message);
        }
      }

    } catch (error) {
      logError('Error processing message node:', error);
    }
  }

  /**
   * Handle buffering of user messages to merge chunks
   */
  function handleUserMessageBuffering(message) {
    // If buffer is empty, start new
    if (!userMessageBuffer.content) {
      userMessageBuffer.content = message.content;
      userMessageBuffer.timestamp = message.timestamp;
      userMessageBuffer.conversationId = message.conversationId;
    } else {
      // Append to existing (space separated)
      userMessageBuffer.content += ' ' + message.content;
    }

    // Reset timer
    if (userMessageBuffer.timer) clearTimeout(userMessageBuffer.timer);

    userMessageBuffer.timer = setTimeout(() => {
      flushUserBuffer();
    }, BUFFER_DELAY);
  }

  /**
   * Flush the user message buffer to background
   */
  function flushUserBuffer() {
    if (!userMessageBuffer.content) return;

    const combinedMessage = {
      role: 'user',
      content: userMessageBuffer.content,
      timestamp: userMessageBuffer.timestamp,
      conversationId: userMessageBuffer.conversationId,
      messageId: generateMessageId(), // Generate ID at flush time
      source: 'dom'
    };

    log('Flushing buffered user message:', combinedMessage.content.substring(0, 50) + '...');
    sendToBackground(combinedMessage);

    // Reset buffer
    userMessageBuffer.content = '';
    userMessageBuffer.timestamp = 0;
    userMessageBuffer.conversationId = null;
    userMessageBuffer.timer = null;
  }

  /**
   * Extract message data from DOM node
   */
  function extractMessage(node) {
    // Determine role
    const role = determineRole(node);

    // NOTE: We now allow assistant messages for DOM capture (needed for mobile voice sync)
    // Deduplication layer in background will prevent duplicates if API capture also succeeds


    // Extract text content (safe, no innerHTML)
    let content = node.innerText?.trim();

    // Strip "You said:" / "ChatGPT said:" prefixes if present
    // This handles the mobile voice view specific format
    if (content) {
      if (content.startsWith('You said:')) {
        content = content.substring('You said:'.length).trim();
      } else if (content.startsWith('ChatGPT said:')) {
        content = content.substring('ChatGPT said:'.length).trim();
      }
    }

    if (!content || content.length === 0) {
      return null;
    }

    // Detect placeholder/incomplete messages
    if (isPlaceholder(content)) {
      log('Skipping placeholder:', content);
      return null;
    }

    // Extract conversation ID from DOM context
    const conversationId = extractConversationId(node);

    // Sanitize text
    const sanitizedContent = sanitizeText(content);

    return {
      content: sanitizedContent,
      role,
      conversationId,
      timestamp: Date.now(),
      messageId: generateMessageId(),
      source: 'dom'
    };
  }

  /**
   * Determine message role (user vs assistant)
   */


  /**
   * Check if content is a placeholder
   */
  function isPlaceholder(text) {
    return CONFIG.PLACEHOLDERS.some(p =>
      text === p || text.startsWith(p) || text.endsWith(p)
    );
  }

  /**
   * Extract conversation ID from URL or DOM
   */
  function extractConversationId(node) {
    // Try URL first
    const urlMatch = window.location.pathname.match(/\/c\/([a-f0-9-]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }

    // Try to find in parent elements
    let current = node;
    while (current && current !== document.body) {
      const id = current.getAttribute('data-conversation-id');
      if (id) {
        return id;
      }
      current = current.parentElement;
    }

    // Fallback: generate from URL
    return `conv-${window.location.pathname.split('/').pop() || 'unknown'}`;
  }

  /**
   * Sanitize text content
   */
  function sanitizeText(text) {
    // Unicode normalization
    let sanitized = text.normalize('NFC');

    // Remove zero-width characters
    sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }

  /**
   * Generate unique message ID
   */
  function generateMessageId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return `msg_${timestamp}_${random}`;
  }

  /**
   * Send message to background script
   */
  function sendToBackground(message) {
    window.dispatchEvent(new CustomEvent('KYT_DOM_MESSAGE_CAPTURED', {
      detail: message
    }));

    log('Sent message to content script:', message.messageId);
  }

  /**
   * Stop the observer
   */
  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
      log('Observer stopped');
    }
  }

  /**
   * Schedule observer restart with exponential backoff
   */
  function scheduleRestart() {
    if (restartAttempts >= CONFIG.MAX_RESTART_ATTEMPTS) {
      logError('Max restart attempts reached, giving up');
      notifyBackgroundObserverStatus('failed');
      return;
    }

    restartAttempts++;
    const delay = CONFIG.RESTART_BACKOFF_MS * Math.pow(2, restartAttempts - 1);

    log(`Scheduling restart #${restartAttempts} in ${delay}ms`);
    notifyBackgroundObserverStatus('restarting');

    setTimeout(() => {
      try {
        startObserver();
      } catch (error) {
        logError('Restart failed:', error);
        scheduleRestart();
      }
    }, delay);
  }

  /**
   * Notify background of observer status
   */
  function notifyBackgroundObserverStatus(status) {
    window.dispatchEvent(new CustomEvent('KYT_DOM_OBSERVER_STATUS', {
      detail: { status, restartAttempts }
    }));
  }

  /**
   * Logging utilities
   */
  function log(...args) {
    if (debugMode) {
      console.log('[KYT DOM]', ...args);
    }
  }

  function logError(...args) {
    console.error('[KYT DOM]', ...args);
  }

  /**
   * Enable debug mode
   */
  function enableDebug() {
    debugMode = true;
    log('Debug mode enabled');
  }

  /**
   * Get observer health status
   */
  function getHealth() {
    return {
      running: observer !== null,
      restartAttempts,
      pendingMutations: pendingMutations.length
    };
  }

  // Listen for commands from content script (CustomEvent)
  window.addEventListener('KYT_DOM_COMMAND', function (event) {
    const { command } = event.detail;
    handleCommand(command);
  });

  // Listen for commands from content script (postMessage - fallback)
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'KYT_DOM_COMMAND') {
      handleCommand(event.data.command);
    }
  });

  function handleCommand(command) {
    log('Received command:', command);
    switch (command) {
      case 'start':
        startObserver();
        break;
      case 'stop':
        stopObserver();
        break;
      case 'restart':
        stopObserver();
        scheduleRestart();
        break;
      case 'scan':
        scanExistingMessages();
        break;
      case 'enableDebug':
        enableDebug();
        break;
      case 'getHealth':
        window.dispatchEvent(new CustomEvent('KYT_DOM_HEALTH', {
          detail: getHealth()
        }));
        break;
    }
  }

  /**
   * Scan existing messages in the DOM (Recovery Mode)
   */
  function scanExistingMessages() {
    log('Scanning existing messages (Recovery Mode)...');
    const container = findConversationContainer();
    if (!container) {
      logError('Cannot scan: Conversation container not found');
      return;
    }

    // Find all message nodes using the broad fallback selector
    // This ensures we capture nodes even if they lack specific role attributes
    const groups = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.messageFallback);
    const messageNodes = Array.from(groups).filter(node => isMessageNode(node));

    // Sort by position in DOM to maintain order
    messageNodes.sort((a, b) => {
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });

    log(`Found ${messageNodes.length} existing message nodes`);

    if (debugMode) {
      logStructure(container);
    }

    let capturedCount = 0;
    messageNodes.forEach(node => {
      try {
        const message = extractMessage(node);
        if (message) {
          // Mark as rescan to trigger aggressive deduplication in background
          message.source = 'dom_rescan';

          log('Rescanning message:', message.content.substring(0, 30) + '...');
          sendToBackground(message);
          capturedCount++;
        }
      } catch (error) {
        logError('Error rescanning node:', error);
      }
    });

    log(`Rescan complete: Sent ${capturedCount} messages`);
  }

  /**
   * Log DOM structure for debugging
   */
  function logStructure(container) {
    try {
      log('--- DOM STRUCTURE DUMP ---');
      const children = container.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        log(`Node ${i}: Tag=${child.tagName}, Class="${child.className}", Role=${child.getAttribute('data-message-author-role')}`);
      }
      log('--------------------------');
    } catch (e) {
      logError('Failed to log structure:', e);
    }
  }

  // ... (rest of file)

  /**
   * Determine message role (user vs assistant)
   */
  function determineRole(node) {
    // Check data attribute (most reliable)
    const roleAttr = node.getAttribute('data-message-author-role');
    if (roleAttr) {
      return roleAttr;
    }

    // Check for class patterns
    if (node.matches('[class*="user"]')) {
      return 'user';
    }
    if (node.matches('[class*="assistant"]')) {
      return 'assistant';
    }

    // Check for user-specific elements (avatar, etc)
    if (node.querySelector('[alt="User"]')) {
      return 'user';
    }

    // Check text content for explicit prefixes (Mobile Voice View)
    const text = node.innerText?.trim();
    if (text) {
      if (text.startsWith('You said:')) {
        return 'user';
      }
      if (text.startsWith('ChatGPT said:')) {
        return 'assistant';
      }
    }

    // Default to assistant if it's a message node but not explicitly user
    // This is crucial for mobile voice where assistant attributes might be missing/different
    return 'assistant';
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded
    init();
  }

  // Re-initialize on navigation (SPA)
  let lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      log('Navigation detected, reinitializing observer...');
      stopObserver();
      setTimeout(init, 1000); // Wait for new page to render
    }
  }, 1000);

  log('DOM observer module loaded');

})();

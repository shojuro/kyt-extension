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

(function() {
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
      messageFallback: '.group.w-full'
    },

    // Performance tuning
    THROTTLE_MS: 100,          // Max 10 mutations/second
    DEBOUNCE_MS: 50,           // Wait 50ms after last mutation
    MAX_RESTART_ATTEMPTS: 5,
    RESTART_BACKOFF_MS: 1000,  // Exponential backoff base

    // Placeholder patterns to skip
    PLACEHOLDERS: ['...', '•••', 'Thinking...', 'Loading', '　']
  };

  // State
  let observer = null;
  let restartAttempts = 0;
  let throttleTimer = null;
  let debounceTimer = null;
  let pendingMutations = [];
  let isProcessing = false;
  let debugMode = false;

  /**
   * Initialize the DOM observer
   */
  function init() {
    log('Initializing DOM observer for mobile message capture...');

    // Check if already initialized
    if (observer) {
      log('Observer already running, skipping init');
      return;
    }

    try {
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
    // Find conversation container
    const container = findConversationContainer();
    if (!container) {
      throw new Error('Conversation container not found');
    }

    log('Found conversation container:', container.tagName);

    // Create observer
    observer = new MutationObserver(handleMutations);

    // Start observing
    observer.observe(container, {
      childList: true,   // Watch for added/removed nodes
      subtree: true,     // Watch entire subtree
      attributes: false, // Don't watch attribute changes (performance)
      characterData: false // Don't watch text changes (performance)
    });

    restartAttempts = 0; // Reset on success
    log('DOM observer started successfully');

    // Notify background of observer status
    notifyBackgroundObserverStatus('running');
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
        // Only process added nodes
        if (mutation.type !== 'childList') continue;

        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          // Check if this is a message node
          if (isMessageNode(node)) {
            processMessageNode(node);
          } else {
            // Check children (for nested structures)
            const messageNodes = node.querySelectorAll(CONFIG.MESSAGE_SELECTORS.userMessage);
            messageNodes.forEach(processMessageNode);
          }
        }
      }

    } catch (error) {
      logError('Error processing mutations:', error);
      stopObserver();
      scheduleRestart();
    } finally {
      isProcessing = false;
    }
  }

  /**
   * Check if node is a message node
   */
  function isMessageNode(node) {
    // Check for user message role (CRITICAL: only capture user messages)
    const hasUserRole = node.matches(CONFIG.MESSAGE_SELECTORS.userMessage);

    if (hasUserRole) {
      return true;
    }

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
        log('Extracted message:', message.content.substring(0, 50) + '...');
        sendToBackground(message);
      }

    } catch (error) {
      logError('Error processing message node:', error);
    }
  }

  /**
   * Extract message data from DOM node
   */
  function extractMessage(node) {
    // Determine role
    const role = determineRole(node);

    // CRITICAL: Only capture user messages from DOM
    // Assistant messages are already captured via API interception
    if (role !== 'user') {
      log('Skipping non-user message (role:', role, ')');
      return null;
    }

    // Extract text content (safe, no innerHTML)
    const content = node.innerText?.trim();

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

    // Default to user (safer for DOM capture)
    // API interception already handles assistant messages
    return 'user';
  }

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

  // Listen for page-level commands
  window.addEventListener('KYT_DOM_COMMAND', (event) => {
    const { command } = event.detail;

    switch (command) {
      case 'start':
        init();
        break;
      case 'stop':
        stopObserver();
        break;
      case 'restart':
        stopObserver();
        scheduleRestart();
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
  });

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

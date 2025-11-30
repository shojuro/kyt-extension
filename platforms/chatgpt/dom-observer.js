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
      messageFallback: '.group.w-full'
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

    log('Found conversation container:', container.tagName, container.className);

    // Create observer
    observer = new MutationObserver(handleMutations);

    // Start observing
    observer.observe(container, {
      childList: true,   // Watch for added/removed nodes
      subtree: true,     // Watch entire subtree
      attributes: true,  // Watch attribute changes (for role updates)
      characterData: true // Watch text changes (for streaming content)
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
        let targetNode = null;

        if (mutation.type === 'childList') {
          // For added nodes, we check the node itself, its children, AND its ancestors
          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;

            // 1. Check if the node itself is a message
            if (isMessageNode(node)) {
              processMessageNode(node);
              continue;
            }

            // 2. Check if it contains message nodes
            const messageNodes = node.querySelectorAll(CONFIG.MESSAGE_SELECTORS.userMessage);
            messageNodes.forEach(processMessageNode);

            // 3. Check if it's INSIDE a message node (e.g. a new paragraph added to existing message)
            const parentMessage = findClosestMessageNode(node);
            if (parentMessage) {
              processMessageNode(parentMessage);
            }
          }
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

  // Cache to prevent spamming the same message during polling
  const sentMessages = new Set();

  /**
   * Scan the last few messages to ensure we didn't miss anything
   * (Active Polling on Mutation)
   */
  function checkRecentMessages() {
    const container = findConversationContainer();
    if (!container) return;

    // Get all message nodes
    let allNodes = [];
    const userNodes = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.userMessage);
    const assistantNodes = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.assistantMessage);
    allNodes = [...Array.from(userNodes), ...Array.from(assistantNodes)];

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

    // NOTE: We now allow assistant messages for DOM capture (needed for mobile voice sync)
    // Deduplication layer in background will prevent duplicates if API capture also succeeds


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
  });

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

    // Find all message nodes (user AND assistant)
    let messageNodes = [];

    // Try explicit selectors first
    const userNodes = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.userMessage);
    const assistantNodes = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.assistantMessage);

    messageNodes = [...Array.from(userNodes), ...Array.from(assistantNodes)];

    if (messageNodes.length === 0) {
      // Fallback: try finding all groups and filtering
      const groups = container.querySelectorAll(CONFIG.MESSAGE_SELECTORS.messageFallback);
      messageNodes = Array.from(groups).filter(node => isMessageNode(node));
    }

    // Sort by position in DOM to maintain order
    messageNodes.sort((a, b) => {
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });

    log(`Found ${messageNodes.length} existing message nodes`);

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

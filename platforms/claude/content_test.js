/**
 * KYT Memory Extension - Claude Content Script (MAIN World)
 *
 * Runs in page context (world: MAIN) to intercept fetch calls
 * and capture Claude message submissions.
 *
 * Architecture:
 * MAIN world (this file) → CustomEvent → ISOLATED world (content_bridge.js) → chrome.runtime → background.js
 */

console.log('🟢 KYT Claude: Content script loaded in MAIN world at:', new Date().toISOString());

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

    // Request context from bridge
    const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⏱️ KYT Claude: Context request timeout');
        resolve(bodyString); // Timeout - proceed without context
      }, 5000); // 5 seconds for embedding + search

      const responseHandler = (event) => {
        if (event.detail.requestId === requestId) {
          clearTimeout(timeout);
          window.removeEventListener('KYT_CONTEXT_RESPONSE', responseHandler);

          if (event.detail.success && event.detail.formattedContext) {
            console.log('✅ KYT Claude: Context received, injecting...');

            // Prepend context to prompt
            body.prompt = `${event.detail.formattedContext}\n\n---\n\n${body.prompt}`;
            resolve(JSON.stringify(body));
          } else {
            console.log('ℹ️ KYT Claude: No context found or error');
            resolve(bodyString); // No context - proceed with original
          }
        }
      };

      window.addEventListener('KYT_CONTEXT_RESPONSE', responseHandler);

      // Dispatch context request
      window.dispatchEvent(new CustomEvent('KYT_CONTEXT_REQUEST', {
        detail: {
          requestId: requestId,
          userMessage: body.prompt,
          config: {
            threshold: 0.4, // Lowered from 0.5 for better cross-platform matching
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

      // PHASE 1: Get context and inject BEFORE sending
      if (options && options.body) {
        try {
          options.body = await getAndInjectContext(options.body);
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
              model: body.model || 'claude-unknown',
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

            // Send to bridge via CustomEvent
            window.dispatchEvent(new CustomEvent('KYT_MESSAGE_CAPTURED', {
              detail: messageData
            }));

            console.log('🟢 KYT Claude: Event dispatched to bridge');
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
  return originalFetch.apply(this, args);
};

console.log('🟢 KYT Claude: Fetch wrapper installed - ready to capture messages');

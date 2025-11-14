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
  const response = await originalFetch.apply(this, args);

  // PHASE 1.5: Capture assistant response
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion') && response.ok) {
    // Clone response to avoid consuming the original stream
    const clonedResponse = response.clone();

    // Extract conversation ID from URL
    const conversationIdMatch = url.match(/chat_conversations\/([^\/]+)\/completion/);
    const conversationId = conversationIdMatch ? conversationIdMatch[1] : 'unknown';

    // Extract model from request body
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
    captureClaudeAssistantResponse(clonedResponse, {
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
    const reader = response.body.getReader();
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
    }
  } catch (error) {
    console.error('❌ KYT Claude: Error capturing assistant response:', error);
    throw error;
  }
}

console.log('🟢 KYT Claude: Fetch wrapper installed - ready to capture messages');
}

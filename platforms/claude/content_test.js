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

// Wrap window.fetch to intercept Claude API calls
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const [url, options] = args;

  // Check if this is a Claude message completion request
  if (typeof url === 'string' && url.includes('/chat_conversations/') && url.includes('/completion')) {
    console.log('🟢 KYT Claude: Intercepted completion request:', url);

    try {
      // Extract conversation ID from URL
      // URL format: https://claude.ai/api/organizations/{org_id}/chat_conversations/{conv_id}/completion
      const conversationIdMatch = url.match(/chat_conversations\/([^\/]+)\/completion/);
      const conversationId = conversationIdMatch ? conversationIdMatch[1] : null;

      // Parse request body to get the message
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

  // Always call the original fetch
  return originalFetch.apply(this, args);
};

console.log('🟢 KYT Claude: Fetch wrapper installed - ready to capture messages');

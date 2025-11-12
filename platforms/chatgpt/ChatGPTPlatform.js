/**
 * KYT Memory Extension - ChatGPT Platform Implementation
 *
 * Platform-specific logic for capturing ChatGPT conversations.
 * Handles ChatGPT's backend-api/conversation endpoint and message structure.
 */

import { Platform } from '../base/Platform.js';

export class ChatGPTPlatform extends Platform {
  getName() {
    return 'chatgpt';
  }

  getUrlPatterns() {
    return [
      'chatgpt.com',
      'chat.openai.com'
    ];
  }

  /**
   * Detect ChatGPT API calls
   * ChatGPT uses /backend-api/conversation or /backend-api/f/conversation
   */
  detectAPICall(url, options) {
    if (typeof url !== 'string') {
      return false;
    }

    const isChatGPTAPI = (
      url.includes('/backend-api/conversation') ||
      url.includes('/backend-api/f/conversation')
    );

    const isPostRequest = options?.method === 'POST' || options?.body;

    return isChatGPTAPI && isPostRequest;
  }

  /**
   * Extract message from ChatGPT API request body
   * ChatGPT structure: { messages: [...], conversation_id: "...", model: "..." }
   */
  extractMessage(bodyString) {
    try {
      const body = JSON.parse(bodyString);

      // Validate message structure
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        console.warn('ChatGPT: Invalid message structure - no messages array');
        return null;
      }

      // Get the last message (user's latest message)
      const lastMessage = body.messages[body.messages.length - 1];
      let content = null;
      let role = lastMessage?.author?.role || lastMessage?.role || 'unknown';

      // Extract content (ChatGPT has multiple content formats)
      if (lastMessage?.content?.parts && Array.isArray(lastMessage.content.parts)) {
        // Format 1: { content: { parts: ["message text"] } }
        content = lastMessage.content.parts[0];
      } else if (typeof lastMessage?.content === 'string') {
        // Format 2: { content: "message text" }
        content = lastMessage.content;
      }

      if (!content || typeof content !== 'string') {
        console.warn('ChatGPT: No valid content found in message');
        return null;
      }

      // Return standardized message format
      return {
        content: content.trim(),
        role: role,
        conversationId: body.conversation_id || 'unknown',
        model: body.model || 'unknown',
        timestamp: Date.now(),
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: 'chatgpt'
      };

    } catch (error) {
      console.error('ChatGPT extraction error:', error.message);
      return null;
    }
  }

  /**
   * ChatGPT-specific manifest overrides
   */
  getManifestOverrides() {
    return {
      name: "KYT Memory - ChatGPT",
      description: "Capture and search ChatGPT conversations with long-term memory",
      host_permissions: [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*"
      ]
    };
  }

  /**
   * ChatGPT supports context injection via message prepending
   */
  supportsContextInjection() {
    return true;
  }

  getContextInjectionStrategy() {
    return 'prepend'; // Prepend context to user message
  }
}

/**
 * KYT Memory Extension - Claude Platform Implementation
 *
 * Platform-specific logic for capturing Claude.ai conversations.
 * Handles Claude's API endpoint and message structure.
 *
 * Note: Claude API structure determined from user reconnaissance
 */

import { Platform } from '../base/Platform.js';

export class ClaudePlatform extends Platform {
  getName() {
    return 'claude';
  }

  getUrlPatterns() {
    return [
      'claude.ai'
    ];
  }

  /**
   * Detect Claude API calls
   * Claude uses /api/organizations/{org_id}/chat_conversations/{conv_id}/completion
   */
  detectAPICall(url, options) {
    if (typeof url !== 'string') {
      return false;
    }

    const isClaudeAPI = (
      url.includes('claude.ai/api/') &&
      url.includes('/chat_conversations/') &&
      url.includes('/completion')
    );

    const isPostRequest = options?.method === 'POST' || options?.body;

    return isClaudeAPI && isPostRequest;
  }

  /**
   * Extract message from Claude API request body
   * Claude structure: { prompt: "user message", timezone: "...", ... }
   */
  extractMessage(bodyString) {
    try {
      const body = JSON.parse(bodyString);

      // Validate prompt exists
      if (!body.prompt || typeof body.prompt !== 'string') {
        console.warn('Claude: No prompt found in request body');
        return null;
      }

      // Extract conversation ID from body or generate
      const conversationId = this.extractConversationId(body);

      // Extract model info (Claude 3 variants)
      const model = body.model || 'claude-3-opus';

      // Return standardized message format
      return {
        content: body.prompt.trim(),
        role: 'user',
        conversationId: conversationId,
        model: model,
        timestamp: Date.now(),
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: 'claude'
      };

    } catch (error) {
      console.error('Claude extraction error:', error.message);
      return null;
    }
  }

  /**
   * Extract conversation ID from request body or URL
   */
  extractConversationId(body) {
    // Try body.uuid first (if present)
    if (body.uuid && typeof body.uuid === 'string') {
      return body.uuid;
    }

    // Try body.conversation_uuid
    if (body.conversation_uuid && typeof body.conversation_uuid === 'string') {
      return body.conversation_uuid;
    }

    // Fallback to unknown (will be extracted from URL in inject.js)
    return 'unknown';
  }

  /**
   * Claude-specific manifest overrides
   */
  getManifestOverrides() {
    return {
      name: "KYT Memory - Claude",
      description: "Capture and search Claude conversations with long-term memory",
      host_permissions: [
        "https://claude.ai/*"
      ]
    };
  }

  /**
   * Claude supports context injection
   */
  supportsContextInjection() {
    return true;
  }

  getContextInjectionStrategy() {
    return 'prepend'; // Prepend context to user message
  }
}

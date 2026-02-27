/**
 * KYT Memory Extension - Gemini Platform Implementation
 *
 * Platform-specific logic for capturing Google Gemini conversations.
 * Handles Gemini's batchexecute RPC protocol — URL-encoded form data
 * with double-encoded nested JSON arrays (NOT clean REST JSON).
 */

import { Platform } from '../base/Platform.js';

// The batchexecute endpoint used by Gemini's web app
const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

export class GeminiPlatform extends Platform {
  getName() {
    return 'gemini';
  }

  getUrlPatterns() {
    return ['gemini.google.com'];
  }

  /**
   * Detect Gemini batchexecute API calls.
   * Gemini POSTs to a StreamGenerate endpoint with URL-encoded form data.
   */
  detectAPICall(url, options) {
    if (typeof url !== 'string') return false;

    // Broad match: any POST to gemini.google.com with a body
    // The content script does the fine-grained f.req check
    const isGeminiAPI = url.includes('gemini.google.com') && (
      url.includes(STREAM_GENERATE_PATH) ||
      url.includes('/data/batchexecute') ||
      url.includes('/data/assistant.')
    );
    const isPost = options?.method === 'POST' || !!options?.body;

    return !!(isGeminiAPI && isPost);
  }

  /**
   * Extract message data from Gemini batchexecute request body.
   *
   * The body is URL-encoded form data. The key payload field is `f.req`,
   * which contains a JSON array (sometimes double-encoded as a string).
   *
   * Array structure (reverse-engineered, positions may shift):
   *   outer[0] → inner array
   *   inner[0] → user message text
   *   inner[2][0] → conversation ID (cid)
   *
   * @param {string} bodyString - URL-encoded form data string
   * @returns {Object|null} Standardized message data or null
   */
  extractMessage(bodyString) {
    try {
      const params = new URLSearchParams(bodyString);
      const fReq = params.get('f.req');

      if (!fReq) {
        console.warn('Gemini: No f.req parameter found');
        return null;
      }

      const parsed = this._parseFReq(fReq);
      if (!parsed) return null;

      const { userMessage, conversationId } = parsed;

      if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
        console.warn('Gemini: Empty user message extracted');
        return null;
      }

      return {
        content: userMessage.trim(),
        role: 'user',
        conversationId: conversationId || 'unknown',
        model: 'gemini',
        timestamp: Date.now(),
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        platform: 'gemini'
      };
    } catch (error) {
      console.error('Gemini extraction error:', error.message);
      return null;
    }
  }

  /**
   * Parse the f.req JSON payload. Handles both single and double encoding.
   * @param {string} fReq - Raw f.req value
   * @returns {{ userMessage: string, conversationId: string|null, inner: Array }|null}
   */
  _parseFReq(fReq) {
    let outer;

    try {
      outer = JSON.parse(fReq);
    } catch (_) {
      console.warn('Gemini: Failed to parse f.req');
      return null;
    }

    // Handle double encoding: first parse yields a string, parse again
    if (typeof outer === 'string') {
      try {
        outer = JSON.parse(outer);
      } catch (_) {
        console.warn('Gemini: Failed to double-decode f.req');
        return null;
      }
    }

    if (!Array.isArray(outer)) {
      console.warn('Gemini: f.req is not an array');
      return null;
    }

    // Navigate to the inner array — outer[0] in most observed payloads
    // Some payloads wrap in an extra layer: outer[0][0]
    let inner = outer[0];
    if (Array.isArray(inner) && Array.isArray(inner[0]) && typeof inner[0][0] === 'string') {
      // inner[0] looks like the actual payload array
      // keep inner as-is
    } else if (Array.isArray(inner) && Array.isArray(inner[0])) {
      inner = inner[0];
    }

    if (!Array.isArray(inner)) {
      console.warn('Gemini: Could not navigate to inner array');
      return null;
    }

    // Extract user message text — position [0] in the inner array
    const userMessage = typeof inner[0] === 'string' ? inner[0] : null;

    // Extract conversation ID (cid) — position [2][0]
    let conversationId = null;
    try {
      if (Array.isArray(inner[2]) && typeof inner[2][0] === 'string') {
        conversationId = inner[2][0];
      }
    } catch (_) {
      // Optional field — okay to miss
    }

    return { userMessage, conversationId, inner };
  }

  /**
   * Re-encode a modified inner array back to URL-encoded form data.
   * Used by context injection to prepend K.Y.T. context to the user message.
   *
   * @param {string} originalBody - Original URL-encoded form data
   * @param {Array} modifiedInner - Inner array with modified user message
   * @returns {string} Re-encoded URL form data
   */
  reEncodeBody(originalBody, modifiedInner) {
    const params = new URLSearchParams(originalBody);
    const fReq = params.get('f.req');

    let outer;
    let isDoubleEncoded = false;

    try {
      outer = JSON.parse(fReq);
    } catch (_) {
      throw new Error('Cannot re-parse f.req for re-encoding');
    }

    if (typeof outer === 'string') {
      isDoubleEncoded = true;
      outer = JSON.parse(outer);
    }

    // Replace inner array at same position
    if (Array.isArray(outer[0]) && Array.isArray(outer[0][0])) {
      outer[0][0] = modifiedInner;
    } else {
      outer[0] = modifiedInner;
    }

    let encoded = JSON.stringify(outer);
    if (isDoubleEncoded) {
      encoded = JSON.stringify(encoded);
    }

    params.set('f.req', encoded);
    return params.toString();
  }

  supportsContextInjection() {
    return true;
  }

  getContextInjectionStrategy() {
    return 'prepend';
  }
}

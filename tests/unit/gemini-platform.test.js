/**
 * Gemini Platform Unit Tests
 *
 * Tests GeminiPlatform class (detection, extraction, re-encoding)
 * and platform normalization for Gemini aliases.
 */

import { describe, it, expect } from 'vitest';
import { GeminiPlatform } from '../../platforms/gemini/GeminiPlatform.js';
import { normalizePlatform } from '../../src/utils/normalize-platform.js';

const platform = new GeminiPlatform();

// ===== Helper: build a batchexecute body =====
function makeBatchBody(userMessage, conversationId = null) {
  const inner = [userMessage, null, conversationId ? [conversationId] : null];
  const outer = [inner];
  const fReq = JSON.stringify(outer);
  const params = new URLSearchParams();
  params.set('f.req', fReq);
  params.set('at', 'some-xsrf-token');
  return params.toString();
}

function makeBatchBodyDoubleEncoded(userMessage, conversationId = null) {
  const inner = [userMessage, null, conversationId ? [conversationId] : null];
  const outer = [inner];
  // Double-encode: JSON string of JSON string
  const fReq = JSON.stringify(JSON.stringify(outer));
  const params = new URLSearchParams();
  params.set('f.req', fReq);
  return params.toString();
}

// ==========================================================================
// 1. Platform metadata
// ==========================================================================
describe('GeminiPlatform metadata', () => {
  it('getName returns "gemini"', () => {
    expect(platform.getName()).toBe('gemini');
  });

  it('getUrlPatterns includes gemini.google.com', () => {
    expect(platform.getUrlPatterns()).toContain('gemini.google.com');
  });

  it('supports context injection', () => {
    expect(platform.supportsContextInjection()).toBe(true);
  });

  it('uses prepend injection strategy', () => {
    expect(platform.getContextInjectionStrategy()).toBe('prepend');
  });

  it('validates successfully', () => {
    expect(platform.validate()).toBe(true);
  });
});

// ==========================================================================
// 2. detectAPICall
// ==========================================================================
describe('detectAPICall', () => {
  const streamUrl = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

  it('detects POST to StreamGenerate endpoint', () => {
    expect(platform.detectAPICall(streamUrl, { method: 'POST', body: 'data' })).toBe(true);
  });

  it('detects request with body (implicit POST)', () => {
    expect(platform.detectAPICall(streamUrl, { body: 'data' })).toBe(true);
  });

  it('rejects GET requests', () => {
    expect(platform.detectAPICall(streamUrl, { method: 'GET' })).toBe(false);
  });

  it('rejects non-Gemini URLs', () => {
    expect(platform.detectAPICall('https://claude.ai/api/completion', { method: 'POST', body: 'x' })).toBe(false);
  });

  it('rejects non-string URLs', () => {
    expect(platform.detectAPICall(42, { method: 'POST' })).toBe(false);
    expect(platform.detectAPICall(null, { method: 'POST' })).toBe(false);
  });

  it('rejects Gemini URLs without StreamGenerate path', () => {
    expect(platform.detectAPICall('https://gemini.google.com/share/abc', { method: 'POST', body: 'x' })).toBe(false);
  });
});

// ==========================================================================
// 3. extractMessage — single-encoded f.req
// ==========================================================================
describe('extractMessage (single-encoded)', () => {
  it('extracts user message from valid body', () => {
    const body = makeBatchBody('Hello Gemini');
    const result = platform.extractMessage(body);

    expect(result).not.toBeNull();
    expect(result.content).toBe('Hello Gemini');
    expect(result.role).toBe('user');
    expect(result.platform).toBe('gemini');
    expect(result.model).toBe('gemini');
  });

  it('extracts conversation ID when present', () => {
    const body = makeBatchBody('Hello', 'c_abc123');
    const result = platform.extractMessage(body);

    expect(result).not.toBeNull();
    expect(result.conversationId).toBe('c_abc123');
  });

  it('defaults conversationId to "unknown" when missing', () => {
    const body = makeBatchBody('Hello');
    const result = platform.extractMessage(body);

    expect(result).not.toBeNull();
    expect(result.conversationId).toBe('unknown');
  });

  it('generates a messageId', () => {
    const body = makeBatchBody('Hello');
    const result = platform.extractMessage(body);
    expect(result.messageId).toMatch(/^msg_/);
  });

  it('trims whitespace from message', () => {
    const body = makeBatchBody('  Hello Gemini  ');
    const result = platform.extractMessage(body);
    expect(result.content).toBe('Hello Gemini');
  });
});

// ==========================================================================
// 4. extractMessage — double-encoded f.req
// ==========================================================================
describe('extractMessage (double-encoded)', () => {
  it('handles double-encoded f.req', () => {
    const body = makeBatchBodyDoubleEncoded('Double encoded message', 'conv_456');
    const result = platform.extractMessage(body);

    expect(result).not.toBeNull();
    expect(result.content).toBe('Double encoded message');
    expect(result.conversationId).toBe('conv_456');
  });
});

// ==========================================================================
// 5. extractMessage — error cases
// ==========================================================================
describe('extractMessage (error cases)', () => {
  it('returns null for missing f.req', () => {
    const params = new URLSearchParams();
    params.set('other', 'value');
    expect(platform.extractMessage(params.toString())).toBeNull();
  });

  it('returns null for invalid JSON in f.req', () => {
    const params = new URLSearchParams();
    params.set('f.req', 'not-json');
    expect(platform.extractMessage(params.toString())).toBeNull();
  });

  it('returns null for empty message', () => {
    const body = makeBatchBody('');
    expect(platform.extractMessage(body)).toBeNull();
  });

  it('returns null for whitespace-only message', () => {
    const body = makeBatchBody('   ');
    expect(platform.extractMessage(body)).toBeNull();
  });

  it('returns null for non-string message at position 0', () => {
    const inner = [42, null, null];
    const outer = [inner];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(outer));
    expect(platform.extractMessage(params.toString())).toBeNull();
  });
});

// ==========================================================================
// 6. reEncodeBody round-trip
// ==========================================================================
describe('reEncodeBody round-trip', () => {
  it('modified message survives encode→decode round-trip', () => {
    const original = makeBatchBody('Original message', 'conv_rt');
    const parsed = platform.extractMessage(original);
    expect(parsed.content).toBe('Original message');

    // Modify the inner array (simulate context injection)
    const parsedInner = platform._parseFReq(new URLSearchParams(original).get('f.req'));
    const modified = [...parsedInner.inner];
    modified[0] = 'CONTEXT\n\n---\n\nOriginal message';

    const reEncoded = platform.reEncodeBody(original, modified);
    const result = platform.extractMessage(reEncoded);

    expect(result).not.toBeNull();
    expect(result.content).toBe('CONTEXT\n\n---\n\nOriginal message');
    expect(result.conversationId).toBe('conv_rt');
  });

  it('preserves other URL params after re-encoding', () => {
    const original = makeBatchBody('Test');
    // The helper sets 'at' param too
    const reEncoded = platform.reEncodeBody(original, ['Modified', null, null]);
    const params = new URLSearchParams(reEncoded);
    expect(params.get('at')).toBe('some-xsrf-token');
  });
});

// ==========================================================================
// 7. Platform normalization
// ==========================================================================
describe('normalizePlatform for Gemini', () => {
  it('"gemini" passes through', () => {
    expect(normalizePlatform('gemini')).toBe('gemini');
  });

  it('"bard" normalizes to "gemini"', () => {
    expect(normalizePlatform('bard')).toBe('gemini');
  });

  it('"google" normalizes to "gemini"', () => {
    expect(normalizePlatform('google')).toBe('gemini');
  });

  it('"google-gemini" normalizes to "gemini"', () => {
    expect(normalizePlatform('google-gemini')).toBe('gemini');
  });

  it('"Gemini" (capitalized) normalizes to "gemini"', () => {
    expect(normalizePlatform('Gemini')).toBe('gemini');
  });

  it('"BARD" (uppercase) normalizes to "gemini"', () => {
    expect(normalizePlatform('BARD')).toBe('gemini');
  });
});

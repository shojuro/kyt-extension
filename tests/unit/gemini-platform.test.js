/**
 * Gemini Platform Unit Tests
 *
 * Tests GeminiPlatform class (detection, extraction, re-encoding),
 * platform normalization for Gemini aliases,
 * and conversation history capture functions.
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
  const batchUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
  const assistantUrl = 'https://gemini.google.com/_/BardChatUi/data/assistant.foo/Bar';

  it('detects POST to StreamGenerate endpoint', () => {
    expect(platform.detectAPICall(streamUrl, { method: 'POST', body: 'data' })).toBe(true);
  });

  it('detects POST to batchexecute endpoint', () => {
    expect(platform.detectAPICall(batchUrl, { method: 'POST', body: 'data' })).toBe(true);
  });

  it('detects POST to assistant.* endpoint', () => {
    expect(platform.detectAPICall(assistantUrl, { method: 'POST', body: 'data' })).toBe(true);
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

  it('rejects Gemini URLs without known API path', () => {
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

// ==========================================================================
// 8. isGeminiHistoryLoad (logic extracted from content_test.js)
// ==========================================================================

// Re-implement the history-load detection logic for unit testing
// (Original lives inside content_test.js IIFE, not importable)
function isGeminiHistoryLoad(urlString, bodyString) {
  const GOOGLE_DOMAINS = ['gemini.google.com', '.google.com', '.googleapis.com'];
  const isGoogleDomain = (url) => GOOGLE_DOMAINS.some(d => url.includes(d));

  if (!isGoogleDomain(urlString)) return false;
  if (!bodyString || typeof bodyString !== 'string') return false;
  if (!bodyString.includes('f.req=') && !bodyString.includes('f.req%')) return false;

  try {
    const params = new URLSearchParams(bodyString);
    const fReq = params.get('f.req');
    if (!fReq) return false;

    let outer;
    try { outer = JSON.parse(fReq); } catch (_) { return false; }
    if (typeof outer === 'string') {
      try { outer = JSON.parse(outer); } catch (_) { return false; }
    }
    if (!Array.isArray(outer)) return false;

    // StreamGenerate with user message = message-send, not history
    if (outer[0] === null && typeof outer[1] === 'string') {
      try {
        const payload = JSON.parse(outer[1]);
        if (Array.isArray(payload) && Array.isArray(payload[0]) &&
            typeof payload[0][0] === 'string' && payload[0][0].trim().length > 0) {
          return false;
        }
      } catch (_) {}
    }

    // batchexecute RPC format
    if (!Array.isArray(outer[0])) return false;
    const rpcs = outer[0];
    for (let i = 0; i < rpcs.length; i++) {
      if (!Array.isArray(rpcs[i])) continue;
      const rpcId = rpcs[i][0];
      const rpcArgs = rpcs[i][1];
      if (typeof rpcArgs !== 'string') continue;
      if (rpcArgs.includes('"c_') || rpcArgs.includes("'c_")) {
        const systemRpcIds = ['L5adhe', 'GPRiHf', 'bYBfhb', 'aKUX7e', 'LCWRX'];
        if (systemRpcIds.includes(rpcId)) continue;
        return {
          rpcId, rpcIndex: i,
          conversationIdHint: (rpcArgs.match(/"(c_[^"]+)"/) || [])[1] || null
        };
      }
    }

    if (urlString.includes('/conversation') || urlString.includes('GetConversation')) {
      return { rpcId: 'url-match', conversationIdHint: null };
    }
  } catch (_) {}
  return false;
}

// Helper: build a batchexecute body with RPC calls (not user messages)
function makeRpcBody(rpcId, argsString) {
  const rpcs = [[rpcId, argsString, null, 'generic']];
  const outer = [rpcs];
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify(outer));
  return params.toString();
}

describe('isGeminiHistoryLoad', () => {
  const geminiUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

  it('detects RPC with conversation ID', () => {
    const body = makeRpcBody('SomeRpc', '["c_abc123","param2"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeTruthy();
    expect(result.rpcId).toBe('SomeRpc');
    expect(result.conversationIdHint).toBe('c_abc123');
  });

  it('extracts conversation ID from nested args', () => {
    const body = makeRpcBody('LoadConv', '[null,null,"c_xyz789_def"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('c_xyz789_def');
  });

  it('rejects known system RPCs even with c_ in args', () => {
    const body = makeRpcBody('L5adhe', '["c_something"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });

  it('rejects StreamGenerate with user message (message-send)', () => {
    // StreamGenerate format: [null, "json_payload"]
    const payload = [['Hello Gemini', 0, null], ['en'], []];
    const outer = [null, JSON.stringify(payload)];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(outer));
    const result = isGeminiHistoryLoad(geminiUrl, params.toString());
    expect(result).toBeFalsy();
  });

  it('rejects non-Google domains', () => {
    const body = makeRpcBody('SomeRpc', '["c_abc"]');
    const result = isGeminiHistoryLoad('https://example.com/api', body);
    expect(result).toBeFalsy();
  });

  it('rejects body without f.req', () => {
    const params = new URLSearchParams();
    params.set('other', 'value');
    const result = isGeminiHistoryLoad(geminiUrl, params.toString());
    expect(result).toBeFalsy();
  });

  it('rejects RPC args without conversation ID', () => {
    const body = makeRpcBody('SomeRpc', '["no_conv_id","param2"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });

  it('rejects empty/null body', () => {
    expect(isGeminiHistoryLoad(geminiUrl, null)).toBeFalsy();
    expect(isGeminiHistoryLoad(geminiUrl, '')).toBeFalsy();
  });

  it('matches URL-based detection for /conversation paths', () => {
    // RPC without c_ in args but URL contains /conversation
    const body = makeRpcBody('SomeRpc', '["no_cid"]');
    const result = isGeminiHistoryLoad('https://gemini.google.com/conversation/load', body);
    expect(result).toBeTruthy();
    expect(result.rpcId).toBe('url-match');
  });

  it('handles double-encoded f.req', () => {
    const rpcs = [['LoadConv', '["c_double_enc"]', null, 'generic']];
    const outer = [rpcs];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(JSON.stringify(outer)));
    const result = isGeminiHistoryLoad(geminiUrl, params.toString());
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('c_double_enc');
  });
});

// ==========================================================================
// 9. extractConversationMessages (logic extracted from content_test.js)
// ==========================================================================

// Re-implement for unit testing
function findAllStrings(obj, maxDepth = 10) {
  const strings = [];
  function walk(val, depth) {
    if (depth > maxDepth) return;
    if (typeof val === 'string' && val.length > 3) {
      strings.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) walk(item, depth + 1);
    } else if (val && typeof val === 'object') {
      for (const v of Object.values(val)) walk(v, depth + 1);
    }
  }
  walk(obj, 0);
  return strings.sort((a, b) => b.length - a.length);
}

function extractConversationMessages(responseText) {
  const messages = [];
  let cleaned = responseText;
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.substring(cleaned.indexOf('\n') + 1);
  }

  const lines = cleaned.split('\n');
  const allStringsFound = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const strings = findAllStrings(parsed, 15);
      for (const s of strings) {
        if (s.length > 20) {
          allStringsFound.push(s);
        }
      }
    } catch (_) {}
  }

  const isSystemString = (s) => {
    if (s.startsWith('r_') || s.startsWith('!')) return true;
    if (/^[0-9a-f]{32,}$/i.test(s)) return true;
    if (s.startsWith('http://') || s.startsWith('https://')) return true;
    if (s.startsWith('{') || s.startsWith('[')) return true;
    if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return true;
    if (s.split('\n').length < 2 && /^[a-zA-Z0-9_.-]+$/.test(s)) return true;
    return false;
  };

  const contentStrings = allStringsFound.filter(s => !isSystemString(s));
  const seen = new Set();
  const unique = [];
  for (const s of contentStrings) {
    const normalized = s.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  for (let i = 0; i < unique.length; i++) {
    messages.push({
      content: unique[i],
      role: i % 2 === 0 ? 'user' : 'assistant'
    });
  }
  return messages;
}

describe('extractConversationMessages', () => {
  it('extracts messages from Gemini-style response with anti-XSSI prefix', () => {
    // Simulate Gemini response format: anti-XSSI + length-prefixed frames
    const frame1 = JSON.stringify([
      [null, null, 'How do I set up row-level security in Supabase?']
    ]);
    const frame2 = JSON.stringify([
      [null, null, 'To set up RLS in Supabase, first go to the Authentication settings and enable RLS on your table.']
    ]);
    const response = `)]}'\n${frame1.length}\n${frame1}\n${frame2.length}\n${frame2}`;

    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('row-level security');
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toContain('enable RLS');
    expect(messages[1].role).toBe('assistant');
  });

  it('filters out system strings (URLs, hex, auth tokens)', () => {
    const frame = JSON.stringify([
      'https://gemini.google.com/share/abc',
      'r_request_12345678901234567890',
      '!auth_token_that_is_very_long_here',
      'abcdef0123456789abcdef0123456789',  // 32-char hex
      'This is a real conversation message that should be kept'
    ]);
    const response = `${frame.length}\n${frame}`;

    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('real conversation message');
  });

  it('deduplicates identical strings', () => {
    const msg = 'This is a duplicate message that appears multiple times';
    const frame = JSON.stringify([msg, msg, msg]);
    const response = `${frame.length}\n${frame}`;

    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(1);
  });

  it('returns empty array for non-parseable response', () => {
    const messages = extractConversationMessages('not valid response data');
    expect(messages).toEqual([]);
  });

  it('returns empty array for response with only short strings', () => {
    const frame = JSON.stringify(['hi', 'ok', 'yes']);
    const response = `${frame.length}\n${frame}`;
    const messages = extractConversationMessages(response);
    expect(messages).toEqual([]);
  });

  it('strips anti-XSSI prefix correctly', () => {
    const content = 'This is a message about Kubernetes deployment strategies';
    const frame = JSON.stringify([content]);
    // Various anti-XSSI prefix forms
    const response = `)]}'\n${frame.length}\n${frame}`;
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe(content);
  });

  it('handles multiple frames with conversation turns', () => {
    const userMsg = 'What is the best way to handle authentication in React?';
    const assistantMsg = 'There are several approaches to authentication in React. The most common are JWT tokens stored in httpOnly cookies, session-based auth, and OAuth with providers like Google.';
    const followupMsg = 'Can you show me an example with JWT tokens?';

    const frame1 = JSON.stringify([[userMsg]]);
    const frame2 = JSON.stringify([[assistantMsg]]);
    const frame3 = JSON.stringify([[followupMsg]]);
    const response = `)]}'\n${frame1.length}\n${frame1}\n${frame2.length}\n${frame2}\n${frame3.length}\n${frame3}`;

    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
  });
});

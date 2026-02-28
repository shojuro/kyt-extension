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
// MUST stay in sync with content_test.js isGeminiHistoryLoad()
const SYSTEM_ONLY_RPCS = new Set([
  'L5adhe', 'GPRiHf', 'bYBfhb', 'aKUX7e', 'LCWRX',
  'jQ1olc', 'MkEWBc',
  'ESY5D', 'otAQ7b', 'MaZiqc', 'aPya6c', 'cYRIkd',
  'maGuAc', 'K4WWud', 'ozz5Z', 'CNgdBe', 'qpEbW',
  'o30O0e', 'ku4Jyf', 'DYBcR',
]);

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

      if (SYSTEM_ONLY_RPCS.has(rpcId)) continue;

      // Match conversation-ID-like patterns
      const convIdMatch = rpcArgs.match(/"(c_[0-9a-f]{8,})"/) ||
                          rpcArgs.match(/"([0-9a-f]{20,})"/);

      if (convIdMatch) {
        if (rpcArgs.length > 2000) continue;
        return {
          rpcId, rpcIndex: i,
          conversationIdHint: convIdMatch[1] || null
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

  it('detects RPC with c_ hex conversation ID (real Gemini format)', () => {
    const body = makeRpcBody('hNvQHb', '["c_d256defe4aabd853",10,null,1,[1],[4],null,1]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeTruthy();
    expect(result.rpcId).toBe('hNvQHb');
    expect(result.conversationIdHint).toBe('c_d256defe4aabd853');
  });

  it('extracts conversation ID from nested args', () => {
    const body = makeRpcBody('LoadConv', '[null,null,"c_a1b2c3d4e5f6a7b8"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('c_a1b2c3d4e5f6a7b8');
  });

  it('rejects known system RPCs even with c_ hex in args', () => {
    const body = makeRpcBody('L5adhe', '["c_abcdef0123456789"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });

  it('rejects known system RPCs (jQ1olc, MkEWBc, ESY5D)', () => {
    expect(isGeminiHistoryLoad(geminiUrl, makeRpcBody('jQ1olc', '["c_abcdef12"]'))).toBeFalsy();
    expect(isGeminiHistoryLoad(geminiUrl, makeRpcBody('MkEWBc', '["c_abcdef12"]'))).toBeFalsy();
    expect(isGeminiHistoryLoad(geminiUrl, makeRpcBody('ESY5D', '[[["bard_activity_enabled"]]]'))).toBeFalsy();
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

  it('rejects RPC args without conversation ID (short strings)', () => {
    const body = makeRpcBody('SomeRpc', '["hi","x"]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });

  it('rejects empty/null body', () => {
    expect(isGeminiHistoryLoad(geminiUrl, null)).toBeFalsy();
    expect(isGeminiHistoryLoad(geminiUrl, '')).toBeFalsy();
  });

  it('matches URL-based detection for /conversation paths', () => {
    // RPC without matching ID in args but URL contains /conversation
    const body = makeRpcBody('SomeRpc', '["short"]');
    const result = isGeminiHistoryLoad('https://gemini.google.com/conversation/load', body);
    expect(result).toBeTruthy();
    expect(result.rpcId).toBe('url-match');
  });

  it('handles double-encoded f.req', () => {
    const rpcs = [['LoadConv', '["c_abcdef0123456789"]', null, 'generic']];
    const outer = [rpcs];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(JSON.stringify(outer)));
    const result = isGeminiHistoryLoad(geminiUrl, params.toString());
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('c_abcdef0123456789');
  });

  it('detects hex conversation IDs (non c_ prefix)', () => {
    // Gemini may use hex/UUID-style conversation IDs
    const hexId = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    const body = makeRpcBody('GetConv', `["${hexId}"]`);
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe(hexId);
  });

  it('rejects short non-hex alphanumeric strings (settings, not conv IDs)', () => {
    // "bard_activity_enabled" is 21 chars but alphanumeric with underscores, not hex
    const body = makeRpcBody('SomeRpc', '[[["bard_activity_enabled"]]]');
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });

  it('rejects RPCs with very long args (likely message-send)', () => {
    // A message-send would have long text content in the args
    const longMessage = 'a'.repeat(3000);
    const body = makeRpcBody('SomeRpc', `["c_abcdef0123456789","${longMessage}"]`);
    const result = isGeminiHistoryLoad(geminiUrl, body);
    expect(result).toBeFalsy();
  });
});

// ==========================================================================
// 9. extractConversationMessages (logic extracted from content_test.js)
// ==========================================================================

// Re-implement for unit testing (must stay in sync with content_test.js)
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
  let innerConversationData = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (!Array.isArray(entry)) continue;
        if (entry[0] !== 'wrb.fr') continue;
        if (typeof entry[2] !== 'string') continue;
        try { innerConversationData = JSON.parse(entry[2]); } catch (_) {}
      }
    } catch (_) {}
  }

  if (!innerConversationData || !Array.isArray(innerConversationData)) {
    return extractConversationMessagesFallback(responseText);
  }

  let turns = innerConversationData;
  if (Array.isArray(turns[0]) && Array.isArray(turns[0][0]) && Array.isArray(turns[0][0][0])) {
    turns = turns[0];
  }

  for (const turn of turns) {
    if (!Array.isArray(turn)) continue;
    try {
      const userMsgArr = turn[2];
      if (Array.isArray(userMsgArr) && Array.isArray(userMsgArr[0])) {
        const userText = userMsgArr[0][0];
        if (typeof userText === 'string' && userText.trim().length > 0) {
          messages.push({ content: userText.trim(), role: 'user' });
        }
      }
    } catch (_) {}
    try {
      const respArr = turn[3];
      if (Array.isArray(respArr) && Array.isArray(respArr[0])) {
        const candidate = respArr[0];
        if (Array.isArray(candidate) && Array.isArray(candidate[0])) {
          const textArr = candidate[0][1];
          if (Array.isArray(textArr) && typeof textArr[0] === 'string') {
            if (textArr[0].trim().length > 0) {
              messages.push({ content: textArr[0].trim(), role: 'assistant' });
            }
          }
        }
      }
    } catch (_) {}
  }

  if (messages.length === 0 && innerConversationData) {
    const allStrs = findAllStrings(innerConversationData, 20);
    const contentStrs = allStrs.filter(s => {
      if (s.length < 20) return false;
      if (s.startsWith('r_') || s.startsWith('rc_') || s.startsWith('c_')) return false;
      if (/^[0-9a-f]{16,}$/i.test(s)) return false;
      if (s.startsWith('http')) return false;
      return true;
    });
    const seen = new Set();
    for (let i = 0; i < contentStrs.length; i++) {
      const t = contentStrs[i].trim();
      if (seen.has(t)) continue;
      seen.add(t);
      messages.push({ content: t, role: i % 2 === 0 ? 'user' : 'assistant' });
    }
  }

  return messages;
}

function extractConversationMessagesFallback(responseText) {
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
      for (const s of strings) { if (s.length > 10) allStringsFound.push(s); }
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
  for (let i = 0; i < contentStrings.length; i++) {
    const t = contentStrings[i].trim();
    if (seen.has(t)) continue;
    seen.add(t);
    messages.push({ content: t, role: i % 2 === 0 ? 'user' : 'assistant' });
  }
  return messages;
}

// Helper: build a real batchexecute wrb.fr response (matching Gemini's actual format)
function makeBatchexecuteHistoryResponse(turns) {
  // turns: [{user: "text", assistant: "text", convId: "c_...", turnId: "r_..."}, ...]
  const innerTurns = turns.map((t, i) => {
    const rId = t.turnId || `r_${i}`;
    const rcId = `rc_${i}`;
    return [
      [t.convId || 'c_test', rId],
      [t.convId || 'c_test', `r_resp_${i}`, rcId],
      [[t.user], 2, null, 0, `hash_${i}`, 0, null, null, false, null, []],
      [[[rcId, [t.assistant]]]]
    ];
  });
  const innerJson = JSON.stringify([innerTurns]);
  const frame = JSON.stringify([['wrb.fr', 'hNvQHb', innerJson, null, null, null, 'generic']]);
  return `)]}'\n${frame.length}\n${frame}`;
}

describe('extractConversationMessages', () => {
  it('extracts user and assistant messages from real batchexecute wrb.fr format', () => {
    const response = makeBatchexecuteHistoryResponse([
      { user: 'How do I set up RLS in Supabase?', assistant: 'To set up RLS, go to Authentication settings and enable it on your table.' },
    ]);
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toContain('RLS in Supabase');
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toContain('enable it on your table');
    expect(messages[1].role).toBe('assistant');
  });

  it('extracts multiple conversation turns', () => {
    const response = makeBatchexecuteHistoryResponse([
      { user: 'What is React?', assistant: 'React is a JavaScript library for building UIs.' },
      { user: 'How do I use hooks?', assistant: 'Hooks let you use state and lifecycle features in function components.' },
    ]);
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(4);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('What is React?');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('How do I use hooks?');
    expect(messages[3].role).toBe('assistant');
  });

  it('handles anti-XSSI prefix correctly', () => {
    const response = makeBatchexecuteHistoryResponse([
      { user: 'Test message', assistant: 'Test response with enough content to matter' }
    ]);
    expect(response.startsWith(")]}'\n")).toBe(true);
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(2);
  });

  it('preserves conversation IDs from turn data', () => {
    const response = makeBatchexecuteHistoryResponse([
      { user: 'Hello from mobile', assistant: 'Hi there!', convId: 'c_d256defe4aabd853' }
    ]);
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe('Hello from mobile');
  });

  it('falls back to heuristic extraction for non-wrb.fr responses', () => {
    // Non-batchexecute format: raw frames with strings
    const frame = JSON.stringify([
      'This is a real conversation message that should be extracted from the response'
    ]);
    const response = `${frame.length}\n${frame}`;
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('real conversation message');
  });

  it('fallback filters out system strings (URLs, hex, auth tokens)', () => {
    const frame = JSON.stringify([
      'https://gemini.google.com/share/abc',
      'r_request_12345678901234567890',
      'abcdef0123456789abcdef0123456789',
      'This is a real conversation message that should be kept'
    ]);
    const response = `${frame.length}\n${frame}`;
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('real conversation message');
  });

  it('returns empty array for non-parseable response', () => {
    expect(extractConversationMessages('not valid response data')).toEqual([]);
  });

  it('returns empty array for response with only short strings', () => {
    const frame = JSON.stringify(['hi', 'ok', 'yes']);
    const response = `${frame.length}\n${frame}`;
    expect(extractConversationMessages(response)).toEqual([]);
  });

  it('trims whitespace from extracted messages', () => {
    const response = makeBatchexecuteHistoryResponse([
      { user: '  Hello Gemini  ', assistant: '  Hi there!  ' }
    ]);
    const messages = extractConversationMessages(response);
    expect(messages[0].content).toBe('Hello Gemini');
    expect(messages[1].content).toBe('Hi there!');
  });
});

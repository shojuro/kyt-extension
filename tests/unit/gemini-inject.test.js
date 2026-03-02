/**
 * Gemini Inject.js Unit Tests
 *
 * Tests the pure functions from platforms/gemini/inject.js.
 * Since inject.js is an IIFE in MAIN world (no exports), we recreate the
 * core functions here for testing. These are exact copies — any drift is
 * a bug to fix.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════
// EXTRACTED FUNCTIONS (copied from inject.js for testability)
// ═══════════════════════════════════════════════════════════════════════

function resolveUrl(url) {
  try {
    return new URL(url, 'https://gemini.google.com').href;
  } catch (_) {
    return url;
  }
}

function isGeminiDomain(url) {
  try {
    const parsed = new URL(resolveUrl(url));
    return parsed.hostname === 'gemini.google.com';
  } catch (_) {
    return false;
  }
}

function isStreamGenerate(url) {
  const resolved = resolveUrl(url);
  return resolved.includes('/StreamGenerate') ||
         resolved.includes('assistant.lamda.BardFrontendService');
}

function parseFReq(bodyStr) {
  if (!bodyStr) return null;

  let params;
  try {
    params = new URLSearchParams(bodyStr);
  } catch (_) {
    return null;
  }

  const fReq = params.get('f.req');
  if (!fReq) return null;

  let outer;
  try {
    outer = JSON.parse(fReq);
  } catch (_) {
    return null;
  }

  if (typeof outer === 'string') {
    try { outer = JSON.parse(outer); } catch (_) { return null; }
  }

  if (!Array.isArray(outer)) return null;

  if (outer[0] !== null || typeof outer[1] !== 'string') return null;

  try {
    const payload = JSON.parse(outer[1]);
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;

    const userMessage = typeof payload[0][0] === 'string' ? payload[0][0] : null;
    if (!userMessage || !userMessage.trim()) return null;

    let conversationId = null;
    const scan = function walk(val, depth) {
      if (depth > 8) return;
      if (typeof val === 'string' && val !== userMessage && /^c_[0-9a-f]{8,}$/.test(val)) {
        conversationId = val;
        return;
      }
      if (Array.isArray(val)) {
        for (const item of val) {
          if (conversationId) return;
          walk(item, depth + 1);
        }
      }
    };
    scan(payload, 0);

    return { userMessage: userMessage.trim(), conversationId };
  } catch (_) {
    return null;
  }
}

function extractAssistantResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') return null;

  let cleaned = responseText;
  if (cleaned.startsWith(")]}'")) {
    const nlIdx = cleaned.indexOf('\n');
    if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
  }

  let longest = '';

  const lines = cleaned.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;

    try {
      const parsed = JSON.parse(trimmed);
      const found = findLongestString(parsed);
      if (found.length > longest.length) longest = found;
    } catch (_) {
      // Not valid JSON — skip
    }
  }

  if (longest.length < 2) return null;

  const stripped = stripInjectionBlock(longest);
  return stripped && stripped.length >= 2 ? stripped : null;
}

function findLongestString(val) {
  if (typeof val === 'string') return val;
  if (!Array.isArray(val)) return '';
  let longest = '';
  for (const item of val) {
    const found = findLongestString(item);
    if (found.length > longest.length) longest = found;
  }
  return longest;
}

function stripInjectionBlock(content) {
  if (!content) return content;
  const hasMarkers = content.includes('[SESSION_CONTEXT]') ||
                     content.includes('[RETRIEVAL_CONTEXT]') ||
                     content.includes('[DATA_PROVENANCE]') ||
                     content.includes('[Retrieved Items]') ||
                     content.includes('K.Y.T.');
  if (!hasMarkers) return content;

  const lines = content.split('\n');
  const result = [];
  let inBlock = false;
  let blockDepth = 0;

  for (const line of lines) {
    if (line.match(/^\[(SESSION_CONTEXT|RETRIEVAL_CONTEXT|DATA_PROVENANCE|Retrieved Items)\]/) ||
        line.match(/^={3,}.*K\.Y\.T\./)) {
      inBlock = true;
      blockDepth++;
      continue;
    }
    if (inBlock && (line.match(/^={3,}$/) || line.trim() === '')) {
      blockDepth--;
      if (blockDepth <= 0) { inBlock = false; blockDepth = 0; }
      continue;
    }
    if (line.match(/^\[(?:Memory Context|Query Optimized|End of (?:Memory|Knowledge Base) Context)\]/)) continue;
    if (line.match(/^={80,}$/)) continue;
    if (!inBlock) result.push(line);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function reEncodeFReq(bodyStr, contextPrefix, parseResult) {
  try {
    const params = new URLSearchParams(bodyStr);
    const fReq = params.get('f.req');
    if (!fReq) return null;

    let outer = JSON.parse(fReq);
    let isDoubleEncoded = false;
    if (typeof outer === 'string') {
      isDoubleEncoded = true;
      outer = JSON.parse(outer);
    }

    const payload = JSON.parse(outer[1]);
    payload[0][0] = contextPrefix + '\n\n' + parseResult.userMessage;
    outer[1] = JSON.stringify(payload);

    let encoded = JSON.stringify(outer);
    if (isDoubleEncoded) encoded = JSON.stringify(encoded);
    params.set('f.req', encoded);
    return params.toString();
  } catch (error) {
    return null;
  }
}

function bodyToString(body) {
  if (typeof body === 'string') return body;
  return null;
}

// FNV-1a hash (from MessageDeduplicator)
function fnvHash(content) {
  const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
  const FNV_PRIME = 0x01000193;
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16);
}

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

function makeStreamGenerateBody(userMessage, conversationId = null) {
  const payload = [[userMessage, 0, null], ['en'], conversationId ? [conversationId] : []];
  const outer = [null, JSON.stringify(payload)];
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify(outer));
  params.set('at', 'xsrf-token');
  return params.toString();
}

function makeStreamGenerateBodyDoubleEncoded(userMessage) {
  const payload = [[userMessage, 0, null], ['en'], []];
  const outer = [null, JSON.stringify(payload)];
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify(JSON.stringify(outer)));
  return params.toString();
}

function makeBatchexecuteBody(rpcId, argsObj) {
  const rpc = [[rpcId, JSON.stringify(argsObj), null, 'generic']];
  const outer = [rpc];
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify(outer));
  return params.toString();
}

function makeGeminiResponse(assistantText) {
  // Simulates Gemini's response format: anti-XSSI prefix + length-prefixed JSON
  const frame = JSON.stringify([['wrb.fr', 'rpcId', assistantText]]);
  return ")]}'\\n\n" + frame.length + '\n' + frame + '\n';
}

function makeNestedGeminiResponse(texts) {
  // Multiple nested strings — longest should win
  const nested = texts.map(t => [t]);
  const frame = JSON.stringify(nested);
  return ")]}'\n" + frame.length + '\n' + frame + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('isGeminiDomain', () => {
  it('matches gemini.google.com', () => {
    expect(isGeminiDomain('https://gemini.google.com/app')).toBe(true);
  });

  it('matches relative URLs (resolved against gemini.google.com)', () => {
    expect(isGeminiDomain('/_/BardChatUi/data/StreamGenerate')).toBe(true);
  });

  it('rejects other Google domains', () => {
    expect(isGeminiDomain('https://www.google.com/search')).toBe(false);
    expect(isGeminiDomain('https://mail.google.com')).toBe(false);
  });

  it('rejects non-Google domains', () => {
    expect(isGeminiDomain('https://chatgpt.com/api')).toBe(false);
    expect(isGeminiDomain('https://claude.ai')).toBe(false);
  });
});

describe('isStreamGenerate', () => {
  it('matches StreamGenerate URL', () => {
    expect(isStreamGenerate('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')).toBe(true);
  });

  it('matches partial StreamGenerate path', () => {
    expect(isStreamGenerate('https://gemini.google.com/_/BardChatUi/data/StreamGenerate?rpcids=foo')).toBe(true);
  });

  it('matches BardFrontendService path', () => {
    expect(isStreamGenerate('/data/assistant.lamda.BardFrontendService/other')).toBe(true);
  });

  it('rejects batchexecute URLs', () => {
    expect(isStreamGenerate('/_/BardChatUi/data/batchexecute')).toBe(false);
  });

  it('rejects unrelated URLs', () => {
    expect(isStreamGenerate('https://gemini.google.com/app')).toBe(false);
  });
});

describe('parseFReq — StreamGenerate format', () => {
  it('extracts user message from StreamGenerate format', () => {
    const body = makeStreamGenerateBody('Hello, how are you?');
    const result = parseFReq(body);
    expect(result).not.toBeNull();
    expect(result.userMessage).toBe('Hello, how are you?');
  });

  it('extracts conversation ID (c_ prefix)', () => {
    const body = makeStreamGenerateBody('Hello', 'c_abc123def456');
    const result = parseFReq(body);
    expect(result).not.toBeNull();
    expect(result.userMessage).toBe('Hello');
    expect(result.conversationId).toBe('c_abc123def456');
  });

  it('handles double-encoded f.req', () => {
    const body = makeStreamGenerateBodyDoubleEncoded('Double encoded message');
    const result = parseFReq(body);
    expect(result).not.toBeNull();
    expect(result.userMessage).toBe('Double encoded message');
  });

  it('trims whitespace from user message', () => {
    const body = makeStreamGenerateBody('  spaces around  ');
    const result = parseFReq(body);
    expect(result).not.toBeNull();
    expect(result.userMessage).toBe('spaces around');
  });

  it('returns null for empty message', () => {
    const body = makeStreamGenerateBody('');
    const result = parseFReq(body);
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only message', () => {
    const body = makeStreamGenerateBody('   ');
    const result = parseFReq(body);
    expect(result).toBeNull();
  });
});

describe('parseFReq — batchexecute format (should return null)', () => {
  it('returns null for batchexecute RPCs', () => {
    const body = makeBatchexecuteBody('GPRiHf', { query: 'some text' });
    const result = parseFReq(body);
    expect(result).toBeNull();
  });

  it('returns null for any batchexecute format (outer[0] is array)', () => {
    const body = makeBatchexecuteBody('unknownRpc', ['some', 'args']);
    const result = parseFReq(body);
    expect(result).toBeNull();
  });
});

describe('parseFReq — edge cases', () => {
  it('returns null for null/undefined input', () => {
    expect(parseFReq(null)).toBeNull();
    expect(parseFReq(undefined)).toBeNull();
    expect(parseFReq('')).toBeNull();
  });

  it('returns null for body without f.req', () => {
    const params = new URLSearchParams();
    params.set('other', 'value');
    expect(parseFReq(params.toString())).toBeNull();
  });

  it('returns null for invalid JSON in f.req', () => {
    const params = new URLSearchParams();
    params.set('f.req', '{not valid json');
    expect(parseFReq(params.toString())).toBeNull();
  });

  it('returns null for non-array f.req', () => {
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify({ key: 'value' }));
    expect(parseFReq(params.toString())).toBeNull();
  });
});

describe('extractAssistantResponse', () => {
  it('extracts longest string from response frames', () => {
    const response = makeGeminiResponse('This is the assistant reply');
    const result = extractAssistantResponse(response);
    expect(result).toBe('This is the assistant reply');
  });

  it('extracts longest from nested arrays', () => {
    const response = makeNestedGeminiResponse(['short', 'This is a longer response text']);
    const result = extractAssistantResponse(response);
    expect(result).toBe('This is a longer response text');
  });

  it('strips anti-XSSI prefix', () => {
    const frame = JSON.stringify(['Hello from Gemini!']);
    const response = ")]}'\n" + frame.length + '\n' + frame;
    const result = extractAssistantResponse(response);
    expect(result).toBe('Hello from Gemini!');
  });

  it('returns null for empty/short responses', () => {
    expect(extractAssistantResponse('')).toBeNull();
    expect(extractAssistantResponse(null)).toBeNull();
    expect(extractAssistantResponse('x')).toBeNull();
  });

  it('returns null for responses with only length prefixes', () => {
    const result = extractAssistantResponse(")]}'\n42\n");
    expect(result).toBeNull();
  });

  it('strips KYT injection blocks from response', () => {
    const text = '[SESSION_CONTEXT]\nSome injected context\n===\nActual assistant response here';
    const frame = JSON.stringify([text]);
    const response = ")]}'\n" + frame.length + '\n' + frame;
    const result = extractAssistantResponse(response);
    expect(result).toBe('Actual assistant response here');
  });
});

describe('stripInjectionBlock', () => {
  it('returns content unchanged when no markers present', () => {
    expect(stripInjectionBlock('Normal text')).toBe('Normal text');
  });

  it('strips SESSION_CONTEXT block', () => {
    const input = '[SESSION_CONTEXT]\nSome context data\n===\nReal content';
    const result = stripInjectionBlock(input);
    expect(result).toBe('Real content');
  });

  it('strips RETRIEVAL_CONTEXT block', () => {
    const input = '[RETRIEVAL_CONTEXT]\nRetrieved items\n===\nActual response';
    const result = stripInjectionBlock(input);
    expect(result).toBe('Actual response');
  });

  it('strips K.Y.T. separator lines', () => {
    const input = '=' .repeat(80) + ' K.Y.T. Memory\nContext info\n===\nReal answer';
    const result = stripInjectionBlock(input);
    expect(result).toBe('Real answer');
  });

  it('strips Memory Context marker when K.Y.T. gate string present', () => {
    // [Memory Context] is only stripped when hasMarkers gate passes (needs K.Y.T. in content)
    const input = '=== K.Y.T. Memory ===\nContext data\n===\n[Memory Context]\nActual text';
    const result = stripInjectionBlock(input);
    expect(result).toBe('Actual text');
  });

  it('handles null/empty input', () => {
    expect(stripInjectionBlock(null)).toBeNull();
    expect(stripInjectionBlock('')).toBe('');
  });
});

describe('reEncodeFReq', () => {
  it('injects context into StreamGenerate f.req', () => {
    const body = makeStreamGenerateBody('What is AI?');
    const parseResult = parseFReq(body);
    expect(parseResult).not.toBeNull();

    const modified = reEncodeFReq(body, '[K.Y.T. Context]\nSome memory', parseResult);
    expect(modified).not.toBeNull();

    // Verify the modified body contains the context
    const modifiedResult = parseFReq(modified);
    expect(modifiedResult).not.toBeNull();
    expect(modifiedResult.userMessage).toContain('[K.Y.T. Context]');
    expect(modifiedResult.userMessage).toContain('What is AI?');
  });

  it('preserves other URL params', () => {
    const body = makeStreamGenerateBody('Test');
    const parseResult = parseFReq(body);
    const modified = reEncodeFReq(body, 'context', parseResult);

    const params = new URLSearchParams(modified);
    expect(params.get('at')).toBe('xsrf-token');
  });

  it('handles double-encoded f.req', () => {
    const body = makeStreamGenerateBodyDoubleEncoded('Test msg');
    // parseFReq won't have format info but reEncodeFReq handles it
    const parseResult = parseFReq(body);
    expect(parseResult).not.toBeNull();

    const modified = reEncodeFReq(body, 'injected', parseResult);
    expect(modified).not.toBeNull();
  });

  it('returns null for invalid body', () => {
    expect(reEncodeFReq('invalid', 'ctx', { userMessage: 'test' })).toBeNull();
  });
});

describe('MessageDeduplicator (FNV-1a hash)', () => {
  it('produces consistent hashes', () => {
    expect(fnvHash('hello world')).toBe(fnvHash('hello world'));
  });

  it('produces different hashes for different content', () => {
    expect(fnvHash('hello')).not.toBe(fnvHash('world'));
  });

  it('normalizes whitespace before hashing', () => {
    expect(fnvHash('hello   world')).toBe(fnvHash('hello world'));
  });

  it('normalizes case before hashing', () => {
    expect(fnvHash('Hello World')).toBe(fnvHash('hello world'));
  });

  it('trims before hashing', () => {
    expect(fnvHash('  hello  ')).toBe(fnvHash('hello'));
  });
});

describe('bodyToString', () => {
  it('returns string as-is', () => {
    expect(bodyToString('hello')).toBe('hello');
  });

  it('returns null for non-string/non-supported types', () => {
    expect(bodyToString(null)).toBeNull();
    expect(bodyToString(undefined)).toBeNull();
    expect(bodyToString(42)).toBeNull();
  });
});

describe('resolveUrl', () => {
  it('resolves relative URLs against gemini.google.com', () => {
    const result = resolveUrl('/_/BardChatUi/data/StreamGenerate');
    expect(result).toBe('https://gemini.google.com/_/BardChatUi/data/StreamGenerate');
  });

  it('passes through absolute URLs', () => {
    const result = resolveUrl('https://example.com/path');
    expect(result).toBe('https://example.com/path');
  });
});

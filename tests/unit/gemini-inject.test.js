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

function parseLengthPrefixedFrames(text) {
  const frames = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sourceBytes = encoder.encode(text);
  let pos = 0;

  while (pos < sourceBytes.length) {
    while (pos < sourceBytes.length && (sourceBytes[pos] === 0x0A || sourceBytes[pos] === 0x0D)) pos++;
    if (pos >= sourceBytes.length) break;

    let numStr = '';
    while (pos < sourceBytes.length && sourceBytes[pos] >= 0x30 && sourceBytes[pos] <= 0x39) {
      numStr += String.fromCharCode(sourceBytes[pos++]);
    }
    if (!numStr) { pos++; continue; }
    const len = parseInt(numStr, 10);
    if (isNaN(len) || len <= 0 || len > 500000) continue;

    // NOTE: Do NOT skip \n — it's included in Google's byte count

    if (pos + len > sourceBytes.length) break;
    const frameBytes = sourceBytes.slice(pos, pos + len);
    const frameStr = decoder.decode(frameBytes).trim();
    pos += len;

    try {
      frames.push(JSON.parse(frameStr));
    } catch (_) {}
  }
  return frames;
}

function isNaturalLanguage(str) {
  if (!str || str.length < 20) return false;
  const words = str.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 3) return false;
  if (!/[a-z]/.test(str)) return false;
  const trimmed = str.trimStart();
  if (/^[\[{]/.test(trimmed) || /^-?\d+$/.test(trimmed)) return false;
  if (/^(c_|r_|rc_|af\.)/.test(trimmed)) return false;
  const urlMatches = str.match(/https?:\/\/[^\s]+/g) || [];
  const totalUrlLength = urlMatches.reduce((sum, u) => sum + u.length, 0);
  if (totalUrlLength > str.length * 0.5) return false;
  if (/retrieve_personal_data|personalization in progress/i.test(str)) return false;
  const identifiers = words.filter(w => /^[a-z]+[A-Z]|_[a-z]/.test(w));
  if (identifiers.length > words.length * 0.5) return false;
  return true;
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
// MESSAGE DEDUPLICATOR (copied from inject.js for testability)
// ═══════════════════════════════════════════════════════════════════════

class MessageDeduplicator {
  constructor() {
    this.recentMessages = new Map();
    this.recentPrefixes = new Map();
    this.dedupeWindow = 5000;
    this.maxMapSize = 1000;
    this.prefixLength = 100;
    this.stats = { totalAttempts: 0, captured: 0, duplicatesSkipped: 0, upgradeCaptures: 0, prefixUpgrades: 0 };
  }
  shouldCapture(content, captureMethod) {
    if (!content || typeof content !== 'string') return true;
    this.stats.totalAttempts++;
    const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
    const hash = this._hash(normalized);
    const now = Date.now();
    const confidence = captureMethod === 'xhr' || captureMethod === 'xhr-response' || captureMethod === 'fetch' || captureMethod === 'fetch-response' ? 95 : 50;
    // Exact hash check (fast path)
    if (this.recentMessages.has(hash)) {
      const last = this.recentMessages.get(hash);
      if (now - last.timestamp < this.dedupeWindow) {
        if (confidence > last.confidence) {
          this.recentMessages.set(hash, { timestamp: now, confidence });
          this.stats.upgradeCaptures++;
          return true;
        }
        this.stats.duplicatesSkipped++;
        return false;
      }
    }
    // Prefix check: handles wire+DOM race (truncated vs complete)
    const prefixStr = normalized.slice(0, this.prefixLength);
    const prefixHash = this._hash(prefixStr);
    if (this.recentPrefixes.has(prefixHash)) {
      const prev = this.recentPrefixes.get(prefixHash);
      if (now - prev.timestamp < this.dedupeWindow) {
        if (normalized.length > prev.length) {
          this.recentMessages.delete(prev.contentHash);
          this.recentPrefixes.set(prefixHash, { contentHash: hash, length: normalized.length, timestamp: now });
          this._addToMessages(hash, now, confidence);
          this.stats.prefixUpgrades++;
          return true;
        } else {
          this.stats.duplicatesSkipped++;
          return false;
        }
      }
    }
    // New entry
    this.recentPrefixes.set(prefixHash, { contentHash: hash, length: normalized.length, timestamp: now });
    this._addToMessages(hash, now, confidence);
    this.stats.captured++;
    return true;
  }
  _addToMessages(hash, timestamp, confidence) {
    if (this.recentMessages.size >= this.maxMapSize) {
      const oldestKey = this.recentMessages.keys().next().value;
      this.recentMessages.delete(oldestKey);
    }
    this.recentMessages.set(hash, { timestamp, confidence });
  }
  _hash(content) {
    const FNV_PRIME = 0x01000193;
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME);
    }
    return (hash >>> 0).toString(16);
  }
}

// extractAssistantFromStreamGenerate (copied from inject.js for testability)
function extractAssistantFromStreamGenerate(responseText) {
  if (!responseText || responseText.length < 50) return null;
  let text = responseText;
  if (text.startsWith(')]}\'\n')) text = text.slice(5);
  else if (text.startsWith(')]}\'')) text = text.slice(4);
  const frames = parseLengthPrefixedFrames(text);
  if (frames.length === 0) return null;
  let longest = null;
  let longestLen = 0;
  for (const frame of frames) {
    const strings = findAllStrings(frame, 10);
    for (const s of strings) {
      if (s.length < 20) continue;
      if (s.length <= longestLen) continue;
      if (!isNaturalLanguage(s)) continue;
      if (/^(r_|rc_|c_|af\.)/.test(s)) continue;
      if (/^[0-9a-f]{16,}$/i.test(s)) continue;
      if (/^https?:\/\//.test(s)) continue;
      if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) continue;
      longest = s;
      longestLen = s.length;
    }
  }
  return longest && longestLen >= 20 ? longest : null;
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

// ═══════════════════════════════════════════════════════════════════════
// HISTORY-LOAD FUNCTIONS (copied from inject.js)
// ═══════════════════════════════════════════════════════════════════════

const SYSTEM_ONLY_RPCS = new Set([
  'L5adhe', 'GPRiHf', 'bYBfhb', 'aKUX7e', 'LCWRX',
  'jQ1olc', 'MkEWBc', 'ESY5D', 'otAQ7b', 'MaZiqc',
  'aPya6c', 'cYRIkd', 'maGuAc', 'K4WWud', 'ozz5Z',
  'CNgdBe', 'qpEbW', 'o30O0e', 'ku4Jyf', 'DYBcR',
]);

function isGeminiHistoryLoad(urlString, bodyString) {
  if (!isGeminiDomain(urlString)) return false;
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

    if (outer[0] === null && typeof outer[1] === 'string') return false;

    if (!Array.isArray(outer[0])) return false;

    for (const rpc of outer[0]) {
      if (!Array.isArray(rpc)) continue;
      const rpcId = rpc[0];
      const rpcArgs = rpc[1];
      if (typeof rpcArgs !== 'string') continue;
      if (SYSTEM_ONLY_RPCS.has(rpcId)) continue;

      const convIdMatch = rpcArgs.match(/"(c_[0-9a-f]{8,})"/) ||
                          rpcArgs.match(/"([0-9a-f]{20,})"/);
      if (convIdMatch && rpcArgs.length <= 2000) {
        return { rpcId, conversationIdHint: convIdMatch[1] };
      }
    }
  } catch (_) {}
  return false;
}

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
  if (!responseText || typeof responseText !== 'string') return [];

  let cleaned = responseText;
  if (cleaned.startsWith(")]}'")) {
    const nlIdx = cleaned.indexOf('\n');
    if (nlIdx >= 0) cleaned = cleaned.substring(nlIdx + 1);
  }

  const frames = parseLengthPrefixedFrames(cleaned);
  let innerConversationData = null;

  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    for (const entry of (Array.isArray(frame[0]) ? frame : [frame])) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      if (typeof entry[2] !== 'string') continue;
      try { innerConversationData = JSON.parse(entry[2]); } catch (_) {}
    }
  }

  if (!innerConversationData || !Array.isArray(innerConversationData)) {
    return extractConversationMessagesFallback(frames);
  }

  const messages = [];
  let turns = innerConversationData;
  if (Array.isArray(turns[0]) && Array.isArray(turns[0][0]) && Array.isArray(turns[0][0][0])) {
    turns = turns[0];
  }

  for (const turn of turns) {
    if (!Array.isArray(turn)) continue;

    try {
      if (Array.isArray(turn[2]) && Array.isArray(turn[2][0])) {
        const userText = turn[2][0][0];
        if (typeof userText === 'string' && userText.trim().length > 0) {
          messages.push({ content: userText.trim(), role: 'user' });
        }
      }
    } catch (_) {}

    try {
      if (Array.isArray(turn[3]) && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])) {
        const textArr = turn[3][0][0][1];
        if (Array.isArray(textArr) && typeof textArr[0] === 'string' && textArr[0].trim().length > 0) {
          messages.push({ content: textArr[0].trim(), role: 'assistant' });
        }
      }
    } catch (_) {}
  }

  if (messages.length === 0) {
    return extractConversationMessagesFallback(frames, innerConversationData);
  }

  return messages;
}

function extractConversationMessagesFallback(frames, innerData) {
  const allStrs = innerData
    ? findAllStrings(innerData, 20)
    : frames.flatMap(f => findAllStrings(f, 15));

  const contentStrs = allStrs.filter(s => {
    if (s.length < 20) return false;
    if (/^(r_|rc_|c_|af\.)/.test(s)) return false;
    if (/^[0-9a-f]{16,}$/i.test(s)) return false;
    if (/^https?:\/\//.test(s)) return false;
    if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return false;
    return isNaturalLanguage(s);
  });

  const messages = [];
  const seen = new Set();
  for (let i = 0; i < contentStrs.length; i++) {
    const t = contentStrs[i].trim();
    if (seen.has(t)) continue;
    seen.add(t);
    messages.push({ content: t, role: i % 2 === 0 ? 'user' : 'assistant' });
  }
  return messages;
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

describe('parseLengthPrefixedFrames', () => {
  // Helper: Google's length prefix includes the \n before the frame
  const byteLen = (frame) => new TextEncoder().encode('\n' + frame).length;

  it('parses single frame', () => {
    const frame = JSON.stringify([['wrb.fr', null, '"hello"']]);
    const input = byteLen(frame) + '\n' + frame + '\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(1);
    expect(result[0][0][0]).toBe('wrb.fr');
  });

  it('parses multiple frames', () => {
    const f1 = JSON.stringify([['wrb.fr', null, '"first"']]);
    const f2 = JSON.stringify([['wrb.fr', null, '"second"']]);
    const input = byteLen(f1) + '\n' + f1 + '\n' + byteLen(f2) + '\n' + f2 + '\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(2);
  });

  it('skips malformed frames', () => {
    const good = JSON.stringify([['wrb.fr', null, '"ok"']]);
    const input = byteLen(good) + '\n' + good + '\n6\n{bad}\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(parseLengthPrefixedFrames('')).toHaveLength(0);
  });

  it('skips frames with oversized length prefix', () => {
    const input = '999999\n' + 'x'.repeat(100) + '\n';
    const result = parseLengthPrefixedFrames(input);
    // Frame length 999999 > available bytes — parser breaks early
    expect(result).toHaveLength(0);
  });

  it('handles leading/trailing whitespace', () => {
    const frame = JSON.stringify(['data']);
    const input = '\n\n' + byteLen(frame) + '\n' + frame + '\n\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(1);
  });

  it('handles multi-byte characters (Thai/emoji) where byte count != char count', () => {
    const thaiText = 'สวัสดีครับ นี่คือข้อความทดสอบที่มีภาษาไทยหลายคำ';
    const innerPayload = JSON.stringify([[[thaiText]]]);
    const frame = JSON.stringify([['wrb.fr', null, innerPayload]]);
    const frameByteLenWithNewline = new TextEncoder().encode('\n' + frame).length;
    // Verify byte count differs from char count (the whole point of this test)
    expect(frameByteLenWithNewline).toBeGreaterThan(frame.length + 1);
    const input = frameByteLenWithNewline + '\n' + frame + '\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(1);
    const inner = JSON.parse(result[0][0][2]);
    expect(inner[0][0][0]).toBe(thaiText);
  });

  it('handles emoji in frames where byte count != char count', () => {
    const emojiText = 'Here are some emojis: 🎉🚀💻 and they work great in responses';
    const innerPayload = JSON.stringify([[[emojiText]]]);
    const frame = JSON.stringify([['wrb.fr', null, innerPayload]]);
    const frameByteLenWithNewline = new TextEncoder().encode('\n' + frame).length;
    expect(frameByteLenWithNewline).toBeGreaterThan(frame.length + 1);
    const input = frameByteLenWithNewline + '\n' + frame + '\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(1);
    const inner = JSON.parse(result[0][0][2]);
    expect(inner[0][0][0]).toBe(emojiText);
  });

  it('parses multiple frames with mixed ASCII and multi-byte content', () => {
    const f1Json = JSON.stringify([['wrb.fr', null, '"ascii only frame"']]);
    const f2Json = JSON.stringify([['wrb.fr', null, JSON.stringify([[['คำตอบจากผู้ช่วยที่มีข้อมูลเพียงพอสำหรับการทดสอบ']]]) ]]);
    const input = byteLen(f1Json) + '\n' + f1Json + '\n' +
                  byteLen(f2Json) + '\n' + f2Json + '\n';
    const result = parseLengthPrefixedFrames(input);
    expect(result).toHaveLength(2);
  });
});

describe('isNaturalLanguage', () => {
  it('accepts normal multi-word text', () => {
    expect(isNaturalLanguage('This is a normal assistant response about AI topics')).toBe(true);
    expect(isNaturalLanguage('Andrew Ng is influential in AI education worldwide')).toBe(true);
  });

  it('rejects short strings', () => {
    expect(isNaturalLanguage('hello')).toBe(false);
    expect(isNaturalLanguage('short text')).toBe(false);
  });

  it('rejects strings with fewer than 3 words', () => {
    expect(isNaturalLanguage('single-word-but-long-enough')).toBe(false);
  });

  it('rejects ALL-CAPS strings (likely IDs)', () => {
    expect(isNaturalLanguage('ABCDEF1234567890GHIJKLMNOP')).toBe(false);
  });

  it('rejects strings starting with [', () => {
    expect(isNaturalLanguage('[null,"c_abc123","r_def456",null,null]')).toBe(false);
  });

  it('rejects strings starting with {', () => {
    expect(isNaturalLanguage('{"key":"value","other":"data","more":"info"}')).toBe(false);
  });

  it('rejects conversation ID strings', () => {
    expect(isNaturalLanguage('c_d55a4bc9fb3d58b8 and some other text here')).toBe(false);
    expect(isNaturalLanguage('r_7d526c69f5982ee6 something else extra')).toBe(false);
    expect(isNaturalLanguage('rc_1900b53362295bfa with more text padding')).toBe(false);
  });

  it('rejects numeric strings', () => {
    expect(isNaturalLanguage('455561854643717217')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isNaturalLanguage(null)).toBe(false);
    expect(isNaturalLanguage(undefined)).toBe(false);
    expect(isNaturalLanguage('')).toBe(false);
  });

  it('rejects strings with embedded long URLs (UI metadata)', () => {
    expect(isNaturalLanguage('Personalization in progresshttps://www.gstatic.com/images/branding/productlogos/gemini_2025_blue/v1/192px.svgretrieve_personal_data')).toBe(false);
    // URL dominates (>50% of string length) — still rejected
    expect(isNaturalLanguage('Loading content from https://example.com/very/long/path/to/resource/here')).toBe(false);
  });

  it('rejects Gemini UI metadata patterns', () => {
    expect(isNaturalLanguage('retrieve_personal_data is being processed now')).toBe(false);
    expect(isNaturalLanguage('Personalization in progress please wait for loading')).toBe(false);
  });

  it('rejects identifier-heavy strings', () => {
    expect(isNaturalLanguage('processData handleRequest initWorker cleanUp')).toBe(false);
    expect(isNaturalLanguage('user_name api_key session_token refresh_id')).toBe(false);
  });

  it('accepts normal text that happens to contain short URLs', () => {
    expect(isNaturalLanguage('Check out http://ex.co for more details today')).toBe(true);
  });

  it('accepts text where URL is less than 50% of string length', () => {
    expect(isNaturalLanguage('For more information visit https://en.wikipedia.org/wiki/Walter_Payton and read the full article about his career')).toBe(true);
  });

  it('rejects text where URLs dominate the string', () => {
    expect(isNaturalLanguage('https://www.example.com/very/long/path/to/resource/here/with/many/segments')).toBe(false);
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

describe('MessageDeduplicator confidence and dedup logic', () => {
  it('xhr-response at confidence 95 deduplicates later dom-observer at 50', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.shouldCapture('assistant response long enough for testing', 'xhr-response')).toBe(true);
    expect(dedup.shouldCapture('assistant response long enough for testing', 'dom-observer')).toBe(false);
    expect(dedup.stats.duplicatesSkipped).toBe(1);
  });

  it('dom-observer at 50 is upgraded by later xhr-response at 95', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.shouldCapture('assistant response long enough for testing', 'dom-observer')).toBe(true);
    expect(dedup.shouldCapture('assistant response long enough for testing', 'xhr-response')).toBe(true);
    expect(dedup.stats.upgradeCaptures).toBe(1);
  });

  it('fetch-response at confidence 95 deduplicates later dom-observer', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.shouldCapture('assistant response long enough for testing', 'fetch-response')).toBe(true);
    expect(dedup.shouldCapture('assistant response long enough for testing', 'dom-observer')).toBe(false);
  });

  it('two xhr-response captures of same text are deduped', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.shouldCapture('same text here for both captures', 'xhr-response')).toBe(true);
    expect(dedup.shouldCapture('same text here for both captures', 'xhr-response')).toBe(false);
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

// ═══════════════════════════════════════════════════════════════════════
// HISTORY-LOAD TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('isGeminiHistoryLoad', () => {
  function makeHistoryBody(rpcId, convId) {
    // Args is a JSON-encoded string containing the conv ID in quotes
    const args = '["' + convId + '"]';
    const fReq = JSON.stringify([[[rpcId, args, null, 'generic']]]);
    return 'f.req=' + encodeURIComponent(fReq);
  }

  it('detects batchexecute with c_ conversation ID', () => {
    const body = makeHistoryBody('hNvQHb', 'c_d256defe4aabd853');
    const result = isGeminiHistoryLoad('https://gemini.google.com/_/BardChatUi/data/batchexecute', body);
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('c_d256defe4aabd853');
  });

  it('detects batchexecute with long hex conversation ID', () => {
    const body = makeHistoryBody('hNvQHb', 'abcdef0123456789abcdef01');
    const result = isGeminiHistoryLoad('https://gemini.google.com/_/BardChatUi/data/batchexecute', body);
    expect(result).toBeTruthy();
    expect(result.conversationIdHint).toBe('abcdef0123456789abcdef01');
  });

  it('returns false for StreamGenerate requests', () => {
    const payload = JSON.stringify([['hello'], ['en']]);
    const fReq = JSON.stringify([null, payload]);
    const body = 'f.req=' + encodeURIComponent(fReq);
    const result = isGeminiHistoryLoad('https://gemini.google.com/_/BardChatUi/data/StreamGenerate', body);
    expect(result).toBe(false);
  });

  it('returns false for system-only RPCs', () => {
    const args = JSON.stringify('"c_abcdef0123456789"');
    const fReq = JSON.stringify([[['ESY5D', args, null, 'generic']]]);
    const body = 'f.req=' + encodeURIComponent(fReq);
    const result = isGeminiHistoryLoad('https://gemini.google.com/_/BardChatUi/data/batchexecute', body);
    expect(result).toBe(false);
  });

  it('returns false for non-Gemini domain', () => {
    const body = makeHistoryBody('hNvQHb', 'c_d256defe4aabd853');
    const result = isGeminiHistoryLoad('https://example.com/batchexecute', body);
    expect(result).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(isGeminiHistoryLoad('https://gemini.google.com/batchexecute', '')).toBe(false);
    expect(isGeminiHistoryLoad('https://gemini.google.com/batchexecute', null)).toBe(false);
  });
});

describe('extractConversationMessages', () => {
  function makeHistoryResponse(turns) {
    // Build a wrb.fr frame with conversation turn data
    // Turn format: [ [userIds], [respIds], [[userText], ...], [[["rc_id", ["assistantText"]]]] ]
    // turn[2][0][0] = user text, turn[3][0][0][1][0] = assistant text
    const conversationData = [turns.map(t => [
      ['c_conv1', 'r_turn1'],
      ['c_conv1', 'r_turn1', 'rc_cand1'],
      [[t.user], 2, null, 0],
      [[['rc_cand1', [t.assistant]]]],
    ])];
    const innerJson = JSON.stringify(conversationData);
    const frame = [['wrb.fr', 'hNvQHb', innerJson]];
    const frameJson = JSON.stringify(frame);
    const encoder = new TextEncoder();
    const byteLen = encoder.encode('\n' + frameJson).length;
    return ")]}'\n" + byteLen + '\n' + frameJson + '\n';
  }

  it('extracts user and assistant messages from conversation turns', () => {
    const response = makeHistoryResponse([
      { user: 'What is the capital of France?', assistant: 'The capital of France is Paris, a city known for its rich history and culture.' },
      { user: 'Tell me more about its landmarks', assistant: 'Paris is home to many famous landmarks including the Eiffel Tower and the Louvre Museum.' },
    ]);
    const messages = extractConversationMessages(response);
    expect(messages.length).toBe(4);
    expect(messages[0]).toEqual({ content: 'What is the capital of France?', role: 'user' });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('Paris');
    expect(messages[2]).toEqual({ content: 'Tell me more about its landmarks', role: 'user' });
    expect(messages[3].content).toContain('Eiffel Tower');
  });

  it('returns empty array for non-conversation response', () => {
    const messages = extractConversationMessages(")]}'\n10\n[\"test\"]\n");
    expect(messages).toEqual([]);
  });

  it('returns empty array for null/empty input', () => {
    expect(extractConversationMessages(null)).toEqual([]);
    expect(extractConversationMessages('')).toEqual([]);
  });
});

describe('findAllStrings', () => {
  it('extracts all strings from nested structure', () => {
    const result = findAllStrings([['hello', 123, ['world', [true, 'foo bar baz']]]]);
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).toContain('foo bar baz');
    expect(result.length).toBe(3);
  });

  it('sorts by length descending', () => {
    const result = findAllStrings(['short', 'a much longer string here']);
    expect(result[0]).toBe('a much longer string here');
  });

  it('skips strings <= 3 chars', () => {
    const result = findAllStrings(['ab', 'abcd']);
    expect(result).toEqual(['abcd']);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// DOM OBSERVER TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('responseDOMObserver', () => {
  function createObserver() {
    const dispatched = [];
    const obs = {
      observer: null,
      pendingConvId: null,
      lastTextLength: 0,
      stableTimeoutId: null,
      STABLE_DELAY_MS: 2500,
      MAX_WAIT_MS: 120000,
      startTimeoutId: null,
      _baselineElement: null,
      dispatched,

      RESPONSE_SELECTORS: [
        'div[id^="model-response-message-content"]', // Primary: Angular ID prefix (model-response only)
      ],

      _findLastResponseElement() {
        // In test environment, return this._mockBaselineElement
        return this._mockBaselineElement || null;
      },

      start(conversationId) {
        this._flushPending();
        this.stop();
        this.pendingConvId = conversationId;
        this.lastTextLength = 0;
        this._baselineElement = this._findLastResponseElement();
        // Skip actual MutationObserver in tests — test _onMutation/_onStable/_getLastResponseText directly
        this.startTimeoutId = setTimeout(() => this.stop(), this.MAX_WAIT_MS);
      },

      _onMutation(mutations) {
        // Fast path: aria-busy="false" — 300ms confirmation delay
        if (mutations) {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'aria-busy') {
              if (m.target.getAttribute('aria-busy') === 'false' && m.target !== this._baselineElement) {
                if (this.lastTextLength === 0) this.lastTextLength = 1;
                if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
                this.stableTimeoutId = setTimeout(() => this._onStable(), 300);
                dispatched._ariaBusyTriggered = true;
                return;
              }
            }
          }
        }

        // Debounce path (fallback when aria-busy not available)
        const text = this._getLastResponseText();
        if (!text || text.length <= this.lastTextLength) return;

        this.lastTextLength = text.length;

        if (this.stableTimeoutId) clearTimeout(this.stableTimeoutId);
        this.stableTimeoutId = setTimeout(() => this._onStable(), this.STABLE_DELAY_MS);
      },

      _getLastResponseText() {
        // In test environment, use this._mockText instead of DOM queries
        // Simulate baseline element check: if _mockElement equals _baselineElement, return null
        if (this._mockElement && this._mockElement === this._baselineElement) return null;
        return this._mockText || null;
      },

      _onStable() {
        if (this.lastTextLength === 0) return; // already flushed
        const text = this._getLastResponseText();
        if (!text || text.length < 20) { this.stop(); return; }
        dispatched.push({ text, convId: this.pendingConvId });
        this.stop();
      },

      _flushPending() {
        if (!this.pendingConvId || this.lastTextLength === 0) return;
        const text = this._getLastResponseText();
        if (!text || text.length < 20) return;
        dispatched.push({ text, convId: this.pendingConvId, flushed: true });
      },

      stop() {
        if (this.observer) { this.observer.disconnect(); this.observer = null; }
        if (this.stableTimeoutId) { clearTimeout(this.stableTimeoutId); this.stableTimeoutId = null; }
        if (this.startTimeoutId) { clearTimeout(this.startTimeoutId); this.startTimeoutId = null; }
        this.pendingConvId = null;
        this.lastTextLength = 0;
        this._baselineElement = null;
      }
    };
    return obs;
  }

  it('_onStable dispatches text when response has stabilized', () => {
    const obs = createObserver();
    obs.start('c_abc123');
    obs._mockText = 'This is a complete assistant response with enough content for testing.';
    obs._onMutation(); // sets lastTextLength > 0 (required for _onStable dedup guard)
    obs._onStable();
    expect(obs.dispatched).toHaveLength(1);
    expect(obs.dispatched[0].text).toBe('This is a complete assistant response with enough content for testing.');
    expect(obs.dispatched[0].convId).toBe('c_abc123');
  });

  it('_onStable stops without dispatching when text is too short', () => {
    const obs = createObserver();
    obs.start('c_abc123');
    obs._mockText = 'Short.';
    obs.lastTextLength = 1; // simulate that _onMutation had tracked some growth
    obs._onStable();
    expect(obs.dispatched).toHaveLength(0);
    expect(obs.pendingConvId).toBeNull(); // stop() was called
  });

  it('_onMutation tracks growing text length', () => {
    const obs = createObserver();
    obs.start('c_abc123');
    obs._mockText = 'First part of the response that is long enough.';
    obs._onMutation();
    expect(obs.lastTextLength).toBe(obs._mockText.length);

    // Text grows
    obs._mockText = 'First part of the response that is long enough. And now it got even longer with more words.';
    obs._onMutation();
    expect(obs.lastTextLength).toBe(obs._mockText.length);
  });

  it('_onMutation ignores when text has not grown', () => {
    const obs = createObserver();
    obs.start('c_abc123');
    obs._mockText = 'Response text that does not change.';
    obs._onMutation();
    const len = obs.lastTextLength;

    // Same text, same length — should not update
    obs._onMutation();
    expect(obs.lastTextLength).toBe(len);
  });

  it('stop cleans up all state', () => {
    const obs = createObserver();
    obs.start('c_abc123');
    obs._mockText = 'Some text to make things active for testing.';
    obs._onMutation();
    expect(obs.pendingConvId).toBe('c_abc123');

    obs.stop();
    expect(obs.pendingConvId).toBeNull();
    expect(obs.lastTextLength).toBe(0);
    expect(obs.stableTimeoutId).toBeNull();
    expect(obs.startTimeoutId).toBeNull();
    expect(obs._baselineElement).toBeNull();
  });

  it('multiple start calls flush previous pending response', () => {
    const obs = createObserver();
    obs.start('c_first');
    obs._mockText = 'Text from first conversation that is long enough.';
    obs._onMutation();

    // Start again with new conversation — should flush c_first's response, then reset
    obs.start('c_second');
    expect(obs.pendingConvId).toBe('c_second');
    expect(obs.lastTextLength).toBe(0);
    expect(obs.dispatched).toHaveLength(1); // flushed from c_first
    expect(obs.dispatched[0].convId).toBe('c_first');
    expect(obs.dispatched[0].flushed).toBe(true);
  });

  it('_getLastResponseText returns null when no mock text set', () => {
    const obs = createObserver();
    expect(obs._getLastResponseText()).toBeNull();
  });

  it('_flushPending dispatches pending text', () => {
    const obs = createObserver();
    obs.start('c_flush');
    obs._mockText = 'A response that was being tracked and has enough content.';
    obs._onMutation(); // sets lastTextLength > 0
    expect(obs.lastTextLength).toBeGreaterThan(0);

    obs._flushPending();
    expect(obs.dispatched).toHaveLength(1);
    expect(obs.dispatched[0].text).toBe('A response that was being tracked and has enough content.');
    expect(obs.dispatched[0].convId).toBe('c_flush');
    expect(obs.dispatched[0].flushed).toBe(true);
  });

  it('_flushPending is no-op when no pending text', () => {
    const obs = createObserver();
    obs.start('c_empty');
    // lastTextLength is 0 — nothing tracked yet
    obs._flushPending();
    expect(obs.dispatched).toHaveLength(0);
  });

  it('_flushPending is no-op when no conversation', () => {
    const obs = createObserver();
    // Never started — pendingConvId is null
    obs._flushPending();
    expect(obs.dispatched).toHaveLength(0);
  });

  it('_onStable is no-op after flush (dedup guard)', () => {
    const obs = createObserver();
    obs.start('c_dedup');
    obs._mockText = 'Response text that gets flushed then onStable fires.';
    obs._onMutation();

    obs._flushPending();
    expect(obs.dispatched).toHaveLength(1);

    // Simulate stop() resetting state (as start() would call stop() after flush)
    obs.lastTextLength = 0;
    obs._onStable(); // should be no-op since lastTextLength === 0
    expect(obs.dispatched).toHaveLength(1); // no duplicate
  });

  it('baseline element prevents old response from being tracked', () => {
    const obs = createObserver();
    const oldElement = { id: 'old-response' };
    obs._mockBaselineElement = oldElement;
    obs.start('c_baseline');

    // Simulate DOM still showing old element (baseline)
    obs._mockElement = oldElement; // _getLastResponseText will check this against baseline
    obs._mockText = 'Old response text that should not be tracked as new content.';
    const text = obs._getLastResponseText();
    expect(text).toBeNull(); // blocked by baseline check
  });

  it('new element after baseline is tracked normally', () => {
    const obs = createObserver();
    const oldElement = { id: 'old-response' };
    obs._mockBaselineElement = oldElement;
    obs.start('c_baseline2');

    // New element appears — different from baseline
    const newElement = { id: 'new-response' };
    obs._mockElement = newElement;
    obs._mockText = 'Brand new response text that should be tracked normally.';
    const text = obs._getLastResponseText();
    expect(text).toBe('Brand new response text that should be tracked normally.');
  });

  it('aria-busy=false schedules 300ms confirmation (not instant capture)', () => {
    const obs = createObserver();
    obs.start('c_aria');
    obs._mockText = 'Complete assistant response captured via aria-busy signal with enough text.';

    const mockElement = {
      getAttribute: (attr) => attr === 'aria-busy' ? 'false' : null,
    };
    const mutations = [{
      type: 'attributes',
      attributeName: 'aria-busy',
      target: mockElement,
    }];

    obs._onMutation(mutations);
    // Should schedule _onStable via stableTimeoutId, NOT dispatch immediately
    expect(obs.stableTimeoutId).not.toBeNull();
    expect(obs.dispatched).toHaveLength(0); // not yet — waiting 300ms confirmation

    // Simulate 300ms passing by calling _onStable directly
    obs._onStable();
    expect(obs.dispatched).toHaveLength(1);
    expect(obs.dispatched[0].text).toBe('Complete assistant response captured via aria-busy signal with enough text.');
  });

  it('aria-busy=true does not trigger capture', () => {
    const obs = createObserver();
    obs.start('c_busy');
    obs._mockText = 'Partial response still streaming from the model right now.';

    const mockElement = {
      getAttribute: (attr) => attr === 'aria-busy' ? 'true' : null,
    };
    const mutations = [{
      type: 'attributes',
      attributeName: 'aria-busy',
      target: mockElement,
    }];

    obs._onMutation(mutations);
    expect(obs.dispatched).toHaveLength(0);
    expect(obs.pendingConvId).toBe('c_busy'); // still active
  });

  it('aria-busy=false on baseline element is ignored', () => {
    const obs = createObserver();
    const oldElement = {
      id: 'old-response',
      getAttribute: (attr) => attr === 'aria-busy' ? 'false' : null,
    };
    obs._mockBaselineElement = oldElement;
    obs.start('c_baseline_aria');
    obs._mockText = 'Some text that should not be captured from the old element.';

    const mutations = [{
      type: 'attributes',
      attributeName: 'aria-busy',
      target: oldElement, // same as baseline
    }];

    obs._onMutation(mutations);
    expect(obs.dispatched).toHaveLength(0); // ignored because target === baseline
  });

  it('non-aria-busy attribute mutations fall through to debounce', () => {
    const obs = createObserver();
    obs.start('c_other_attr');
    obs._mockText = 'Response text that should be tracked via debounce path for capture.';

    const mutations = [{
      type: 'attributes',
      attributeName: 'class',
      target: { getAttribute: () => 'some-class' },
    }];

    obs._onMutation(mutations);
    expect(obs.dispatched).toHaveLength(0); // not dispatched yet (in debounce)
    expect(obs.lastTextLength).toBe(obs._mockText.length); // but text was tracked
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DISPATCH CONTENT CLEANING TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('dispatchCapture content cleaning', () => {
  it('strips "Assistant:" role label from start of content', () => {
    const content = 'Assistant: This is the actual response text.';
    const cleaned = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(cleaned).toBe('This is the actual response text.');
  });

  it('strips "User:" role label from start of content', () => {
    const content = 'User: What is the meaning of life?';
    const cleaned = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(cleaned).toBe('What is the meaning of life?');
  });

  it('strips "You said" Gemini UI label', () => {
    const content = 'You said\nWhat is the meaning of life?';
    const cleaned = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(cleaned).toBe('What is the meaning of life?');
  });

  it('strips "Gemini said" UI label', () => {
    const content = 'Gemini said\nHere is the response.';
    const cleaned = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(cleaned).toBe('Here is the response.');
  });

  it('does not strip "Assistant" mid-sentence', () => {
    const content = 'The Assistant helped with the task.';
    const cleaned = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(cleaned).toBe('The Assistant helped with the task.');
  });

  it('rejects conversation dumps with both "You said" and "Gemini said"', () => {
    const content = 'You said\nHello\n\nGemini said\nHi there!';
    const isDump = /\bYou said\b/i.test(content) && /\bGemini said\b/i.test(content);
    expect(isDump).toBe(true);
  });

  it('does not reject content with only one label', () => {
    const content = 'Gemini said something interesting about physics.';
    const isDump = /\bYou said\b/i.test(content) && /\bGemini said\b/i.test(content);
    expect(isDump).toBe(false);
  });

  it('strips injection block before saving', () => {
    const content = '[SESSION_CONTEXT]\nK.Y.T. memory data\n===\nActual response about books.';
    const cleaned = stripInjectionBlock(content);
    expect(cleaned).toBe('Actual response about books.');
    expect(cleaned).not.toContain('SESSION_CONTEXT');
    expect(cleaned).not.toContain('K.Y.T.');
  });

  it('strips injection block AND role label together', () => {
    let content = '[RETRIEVAL_CONTEXT]\nK.Y.T. retrieved items\n===\nAssistant: The real answer is here.';
    content = stripInjectionBlock(content) || content;
    content = content.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(content).toBe('The real answer is here.');
  });

  it('preserves clean content unchanged', () => {
    const content = 'This transcript provides a structured curriculum consisting of 21 books.';
    const afterStrip = stripInjectionBlock(content);
    const afterLabel = afterStrip.replace(/^(?:You said|Gemini said|User|Assistant)\s*:?\s*/i, '').trim();
    expect(afterLabel).toBe(content);
  });

  it('strips "Export to Sheets" UI button text', () => {
    const content = 'Item    Price\nApples    $2.00\nExport to Sheets\nTotal: $2.00';
    const cleaned = content.replace(/\n?Export to Sheets\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    expect(cleaned).toBe('Item    Price\nApples    $2.00\nTotal: $2.00');
    expect(cleaned).not.toContain('Export to Sheets');
  });

  it('strips "Export to Sheets" at end of content', () => {
    const content = 'Some table data here.\nExport to Sheets';
    const cleaned = content.replace(/\n?Export to Sheets\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    expect(cleaned).toBe('Some table data here.');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WIRE EXTRACTION TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('extractAssistantFromStreamGenerate', () => {
  function buildLengthPrefixedFrame(jsonObj) {
    const jsonStr = JSON.stringify(jsonObj);
    const encoder = new TextEncoder();
    const frameStr = '\n' + jsonStr;
    const byteLen = encoder.encode(frameStr).length;
    return byteLen + frameStr;
  }

  it('extracts the longest natural-language string from frames', () => {
    const short = 'This is a short response to the user query here.';
    const long = 'This is a much longer complete response that contains the full assistant answer with lots of detail about the topic at hand and additional context.';
    const body = buildLengthPrefixedFrame([short, 'c_abc123def']) + buildLengthPrefixedFrame([long, 'r_token123']);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(long);
  });

  it('strips anti-XSSI prefix )]}\\\'\\n', () => {
    const text = 'Walter Payton was one of the greatest running backs in NFL history and he was truly legendary.';
    const body = ')]}\'\n' + buildLengthPrefixedFrame([text]);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(text);
  });

  it('strips anti-XSSI prefix without newline', () => {
    const text = 'Walter Payton was one of the greatest running backs in NFL history and he was truly legendary.';
    const body = ')]\}\'' + buildLengthPrefixedFrame([text]);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(text);
  });

  it('handles multi-byte UTF-8 characters', () => {
    const text = 'これは日本語のテストです。自然言語処理のために長い文章が必要です。The parser must handle multi-byte UTF-8 correctly.';
    const body = buildLengthPrefixedFrame([text]);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(text);
  });

  it('returns null for empty/short input', () => {
    expect(extractAssistantFromStreamGenerate(null)).toBeNull();
    expect(extractAssistantFromStreamGenerate('')).toBeNull();
    expect(extractAssistantFromStreamGenerate('short')).toBeNull();
  });

  it('returns null when no natural language found', () => {
    const body = buildLengthPrefixedFrame(['c_abc123def456', 'r_token_long_enough_to_test', 42]);
    expect(extractAssistantFromStreamGenerate(body)).toBeNull();
  });

  it('filters out system IDs, URLs, and base64', () => {
    const text = 'This is the real assistant response that should be captured by the extraction function.';
    const body = buildLengthPrefixedFrame([
      'c_abc123def456789',
      'https://lh3.googleusercontent.com/a/default-user=s64-c',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
      text
    ]);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(text);
  });

  it('picks longest when progressive frames have growing text', () => {
    const frame1Text = 'Walter Payton was a great football player in the NFL.';
    const frame2Text = 'Walter Payton was a great football player in the NFL. He played for the Chicago Bears and was nicknamed Sweetness.';
    const frame3Text = 'Walter Payton was a great football player in the NFL. He played for the Chicago Bears and was nicknamed Sweetness. He rushed for over sixteen thousand yards in his career.';
    const body = buildLengthPrefixedFrame([frame1Text]) + buildLengthPrefixedFrame([frame2Text]) + buildLengthPrefixedFrame([frame3Text]);
    const result = extractAssistantFromStreamGenerate(body);
    expect(result).toBe(frame3Text);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PREFIX-MATCHING DEDUP TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('MessageDeduplicator prefix matching', () => {
  it('allows upgrade from truncated to complete version', () => {
    const dedup = new MessageDeduplicator();
    const truncated = 'This is the beginning of a response that was captured by the DOM observer but unfortunately it got cut off before the full text could';
    const complete = 'This is the beginning of a response that was captured by the DOM observer but unfortunately it got cut off before the full text could be rendered. Now the wire extraction has the complete version with all the remaining details.';

    expect(dedup.shouldCapture(truncated, 'dom-observer')).toBe(true);
    expect(dedup.shouldCapture(complete, 'xhr-response')).toBe(true);
    expect(dedup.stats.prefixUpgrades).toBe(1);
  });

  it('rejects shorter duplicate after complete capture', () => {
    const dedup = new MessageDeduplicator();
    const complete = 'This is the complete wire-extracted response with full content that was captured first via the XHR load handler and has all the text.';
    const truncated = 'This is the complete wire-extracted response with full content that was captured first via the XHR load handler';

    expect(dedup.shouldCapture(complete, 'xhr-response')).toBe(true);
    expect(dedup.shouldCapture(truncated, 'dom-observer')).toBe(false);
    expect(dedup.stats.duplicatesSkipped).toBe(1);
  });

  it('passes through unrelated content', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.shouldCapture('First message about something entirely different and unrelated to everything else.', 'xhr')).toBe(true);
    expect(dedup.shouldCapture('Second message about another topic that has nothing to do with the first one at all.', 'xhr')).toBe(true);
    expect(dedup.stats.captured).toBe(2);
    expect(dedup.stats.prefixUpgrades).toBe(0);
    expect(dedup.stats.duplicatesSkipped).toBe(0);
  });

  it('exact duplicate still blocked (fast path)', () => {
    const dedup = new MessageDeduplicator();
    const msg = 'This exact message is sent twice with identical content and should be deduplicated on the fast path.';
    expect(dedup.shouldCapture(msg, 'xhr-response')).toBe(true);
    expect(dedup.shouldCapture(msg, 'xhr-response')).toBe(false);
    expect(dedup.stats.duplicatesSkipped).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EXPANDED CONTENT CLEANING TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('dispatchCapture expanded content cleaning', () => {
  function cleanContent(content) {
    content = content.replace(/\n?Export to Sheets\n?/g, '\n').trim();
    content = content.replace(/\n?(?:Sources|Related topics)\n.*$/s, '').trim();
    content = content.replace(/\n?(?:Show drafts|Draft \d+ of \d+)\n?/g, '\n').trim();
    content = content.replace(/(?:^|\n)(?:Share|Copy|Report|Like|Dislike)\s*$/gm, '').trim();
    content = content.replace(/\[Image of .*?\]/g, '').trim();
    content = content.replace(/\n{3,}/g, '\n\n').trim();
    return content;
  }

  it('strips Sources section at end', () => {
    const content = 'The answer is 42.\n\nSources\nhttps://example.com\nhttps://other.com';
    expect(cleanContent(content)).toBe('The answer is 42.');
  });

  it('strips Related topics section at end', () => {
    const content = 'Some response text here.\n\nRelated topics\nTopic 1\nTopic 2\nTopic 3';
    expect(cleanContent(content)).toBe('Some response text here.');
  });

  it('strips Draft indicators', () => {
    const content = 'Show drafts\nHere is my response about the topic.\nDraft 1 of 3';
    expect(cleanContent(content)).toBe('Here is my response about the topic.');
  });

  it('strips action button text at line end', () => {
    const content = 'A great response.\nShare\nCopy';
    expect(cleanContent(content)).toBe('A great response.');
  });

  it('strips [Image of ...] placeholders', () => {
    const content = 'Look at this: [Image of a cat sitting on a keyboard] Pretty cute right?';
    expect(cleanContent(content)).toBe('Look at this:  Pretty cute right?');
  });

  it('collapses excessive newlines', () => {
    const content = 'Paragraph one.\n\n\n\n\nParagraph two.';
    expect(cleanContent(content)).toBe('Paragraph one.\n\nParagraph two.');
  });

  it('preserves clean content', () => {
    const content = 'This is a perfectly clean response with no artifacts.';
    expect(cleanContent(content)).toBe(content);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RESOURCE LEAK FIX TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('capturedParams.rpcIds eviction', () => {
  // Recreate the eviction logic from sniffBatchExecuteParams for testing
  function evictRpcIds(rpcIds) {
    if (rpcIds.size > 200) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [id, entry] of rpcIds) {
        if (entry.lastSeen < cutoff) rpcIds.delete(id);
      }
      while (rpcIds.size > 200) {
        const oldest = rpcIds.keys().next().value;
        rpcIds.delete(oldest);
      }
    }
  }

  it('does not evict when under 200 entries', () => {
    const rpcIds = new Map();
    for (let i = 0; i < 150; i++) {
      rpcIds.set(`rpc_${i}`, { lastSeen: Date.now(), argsPreview: '' });
    }
    evictRpcIds(rpcIds);
    expect(rpcIds.size).toBe(150);
  });

  it('evicts stale entries (>30min) when over 200', () => {
    const rpcIds = new Map();
    const staleTime = Date.now() - 31 * 60 * 1000; // 31 min ago
    // Add 150 stale entries
    for (let i = 0; i < 150; i++) {
      rpcIds.set(`stale_${i}`, { lastSeen: staleTime, argsPreview: '' });
    }
    // Add 60 fresh entries
    for (let i = 0; i < 60; i++) {
      rpcIds.set(`fresh_${i}`, { lastSeen: Date.now(), argsPreview: '' });
    }
    expect(rpcIds.size).toBe(210);
    evictRpcIds(rpcIds);
    // Stale entries removed, fresh remain
    expect(rpcIds.size).toBe(60);
    expect(rpcIds.has('fresh_0')).toBe(true);
    expect(rpcIds.has('stale_0')).toBe(false);
  });

  it('hard-caps at 200 when all entries are fresh', () => {
    const rpcIds = new Map();
    for (let i = 0; i < 250; i++) {
      rpcIds.set(`rpc_${i}`, { lastSeen: Date.now(), argsPreview: '' });
    }
    evictRpcIds(rpcIds);
    expect(rpcIds.size).toBe(200);
    // Oldest (insertion-order) entries should be removed
    expect(rpcIds.has('rpc_0')).toBe(false);
    expect(rpcIds.has('rpc_49')).toBe(false);
    expect(rpcIds.has('rpc_50')).toBe(true);
    expect(rpcIds.has('rpc_249')).toBe(true);
  });
});

describe('_capturedConversationIds cap', () => {
  it('clears Set when reaching 500, then adds new entry', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) {
      ids.add(`conv_${i}`);
    }
    expect(ids.size).toBe(500);

    // Simulate the guard from captureConversationHistory
    const newId = 'conv_new';
    if (!ids.has(newId)) {
      if (ids.size >= 500) {
        ids.clear();
      }
      ids.add(newId);
    }

    expect(ids.size).toBe(1);
    expect(ids.has('conv_new')).toBe(true);
    expect(ids.has('conv_0')).toBe(false);
  });

  it('does not clear when under 500', () => {
    const ids = new Set();
    for (let i = 0; i < 499; i++) {
      ids.add(`conv_${i}`);
    }

    const newId = 'conv_new';
    if (!ids.has(newId)) {
      if (ids.size >= 500) {
        ids.clear();
      }
      ids.add(newId);
    }

    expect(ids.size).toBe(500);
    expect(ids.has('conv_0')).toBe(true);
    expect(ids.has('conv_new')).toBe(true);
  });
});

describe('pendingContextRequests max-size guard', () => {
  it('returns null immediately when 10+ requests pending', () => {
    const pending = new Map();
    for (let i = 0; i < 10; i++) {
      pending.set(`ctx_${i}`, { resolve: () => {}, timeoutId: null });
    }

    // Simulate the guard from requestContext()
    let result;
    if (pending.size >= 10) {
      result = null; // fail-open
    } else {
      result = 'would-create-promise';
    }

    expect(result).toBeNull();
  });

  it('allows request when under 10 pending', () => {
    const pending = new Map();
    for (let i = 0; i < 9; i++) {
      pending.set(`ctx_${i}`, { resolve: () => {}, timeoutId: null });
    }

    let result;
    if (pending.size >= 10) {
      result = null;
    } else {
      result = 'would-create-promise';
    }

    expect(result).toBe('would-create-promise');
  });

  it('allows request when map is empty', () => {
    const pending = new Map();

    let result;
    if (pending.size >= 10) {
      result = null;
    } else {
      result = 'would-create-promise';
    }

    expect(result).toBe('would-create-promise');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// REQUEST CONTEXT CANCELLATION (RC-4)
// Extracted cancellation logic from inject.js requestContext()
// ═══════════════════════════════════════════════════════════════════════

describe('requestContext cancellation', () => {
  it('cancels previous request when new one arrives', () => {
    const pendingContextRequests = new Map();
    let activeContextRequestId = null;

    // Simulate first request
    const resolve1 = { called: false, value: undefined };
    const timeout1 = 12345;
    activeContextRequestId = 'ctx_first';
    pendingContextRequests.set('ctx_first', {
      resolve: (v) => { resolve1.called = true; resolve1.value = v; },
      timeoutId: timeout1
    });

    // Simulate second request arriving — cancellation logic
    if (activeContextRequestId) {
      const prev = pendingContextRequests.get(activeContextRequestId);
      if (prev) {
        // clearTimeout(prev.timeoutId) would be called in real code
        pendingContextRequests.delete(activeContextRequestId);
        prev.resolve(null); // fail-open
      }
    }
    activeContextRequestId = 'ctx_second';
    pendingContextRequests.set('ctx_second', { resolve: () => {}, timeoutId: 99999 });

    // Verify: old request was resolved with null, removed from map
    expect(resolve1.called).toBe(true);
    expect(resolve1.value).toBeNull();
    expect(pendingContextRequests.has('ctx_first')).toBe(false);
    // New request is active
    expect(pendingContextRequests.has('ctx_second')).toBe(true);
    expect(activeContextRequestId).toBe('ctx_second');
  });

  it('clears activeContextRequestId on response', () => {
    const pendingContextRequests = new Map();
    let activeContextRequestId = 'ctx_active';

    const resolve1 = { called: false };
    pendingContextRequests.set('ctx_active', {
      resolve: (v) => { resolve1.called = true; },
      timeoutId: 11111
    });

    // Simulate KYT_CONTEXT_RESPONSE handler
    const detail = { requestId: 'ctx_active', formattedContext: 'some context' };
    const pending = pendingContextRequests.get(detail.requestId);
    if (pending) {
      // clearTimeout(pending.timeoutId);
      pendingContextRequests.delete(detail.requestId);
      if (activeContextRequestId === detail.requestId) activeContextRequestId = null;
      pending.resolve(detail.formattedContext || null);
    }

    expect(resolve1.called).toBe(true);
    expect(activeContextRequestId).toBeNull();
    expect(pendingContextRequests.size).toBe(0);
  });

  it('does not cancel when no active request exists', () => {
    const pendingContextRequests = new Map();
    let activeContextRequestId = null;

    // Cancellation logic should be a no-op
    if (activeContextRequestId) {
      const prev = pendingContextRequests.get(activeContextRequestId);
      if (prev) {
        pendingContextRequests.delete(activeContextRequestId);
        prev.resolve(null);
      }
    }

    expect(pendingContextRequests.size).toBe(0);
    expect(activeContextRequestId).toBeNull();
  });
});

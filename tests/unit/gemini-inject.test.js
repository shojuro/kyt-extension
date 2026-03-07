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

  const frames = parseLengthPrefixedFrames(cleaned);

  // Extract text from ALL wrb.fr frames and concatenate.
  // Gemini streaming splits the response across many frames, each with a small
  // text fragment. We must collect them all, not just pick the longest.
  const textParts = [];
  let longestSingle = '';
  for (const frame of frames) {
    const raw = extractTextFromFrame(frame);
    if (!raw || raw.length < 5) continue;

    // Strip injection blocks (response may echo injected context)
    const stripped = stripInjectionBlock(raw);
    const candidate = stripped && stripped.length >= 5 ? stripped : raw;

    // Strip leading base64-like tokens (auth/session tokens embedded in response)
    const cleanCandidate = candidate.replace(/^[A-Za-z0-9_\-+=\/]{20,}\s+/, '');
    const final = cleanCandidate.length >= 5 ? cleanCandidate : candidate;

    if (isNaturalLanguage(final)) {
      textParts.push(final);
    }
    if (final.length > longestSingle.length && isNaturalLanguage(final)) {
      longestSingle = final;
    }
  }

  // Deduplicate progressive streaming: Gemini may send cumulative frames where
  // each frame contains all previous text plus new text. Remove any part that
  // is a substring of a longer part (progressive overlap).
  if (textParts.length > 1) {
    const deduped = textParts.filter((part, i) =>
      !textParts.some((other, j) => j !== i && other.length > part.length && other.includes(part))
    );

    if (deduped.length === 1) {
      // All other frames were substrings of the longest — progressive streaming
      const result = stripInjectionBlock(deduped[0]);
      const final2 = result && result.length >= 20 ? result : deduped[0];
      if (final2.length >= 20 && isNaturalLanguage(final2)) return final2;
    } else if (deduped.length > 1) {
      // Multiple non-overlapping parts — true multi-frame (delta streaming)
      const combined = deduped.join(' ');
      const strippedCombined = stripInjectionBlock(combined);
      const result = strippedCombined && strippedCombined.length >= 20 ? strippedCombined : combined;
      if (result.length >= 20 && isNaturalLanguage(result)) return result;
    }
  }

  // Fallback: single best frame (non-streaming or single-frame response)
  if (longestSingle.length >= 10) return longestSingle;
  return null;
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

function extractTextFromFrame(frame) {
  if (!Array.isArray(frame) || !Array.isArray(frame[0])) return null;

  for (const entry of frame) {
    if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;

    const innerStr = entry[2];
    if (typeof innerStr !== 'string') continue;

    let inner;
    try { inner = JSON.parse(innerStr); } catch (_) { continue; }
    if (!Array.isArray(inner)) continue;

    // Strategy 1: Collect and concatenate text fragments from leaf arrays
    const collected = collectTextFragments(inner);
    if (collected) return collected;

    // Strategy 2: Find a single long natural-language string
    const natural = findLongestNaturalText(inner);
    if (natural) return natural;

    // Strategy 3: Fallback to raw longest
    const raw = findLongestRawText(inner);
    if (raw) return raw;
  }
  return null;
}

function findLongestRawText(val) {
  if (typeof val === 'string') {
    if (val.length < 20) return '';
    const trimmed = val.trimStart();
    if (/^-?\d+$/.test(trimmed)) return '';
    if (/^(c_|r_|rc_|af\.)[0-9a-f]{8,}/.test(trimmed)) return '';
    return val;
  }
  if (!Array.isArray(val)) return '';
  let longest = '';
  for (const item of val) {
    const found = findLongestRawText(item);
    if (found.length > longest.length) longest = found;
  }
  return longest;
}

function isNaturalLanguage(str) {
  if (!str || str.length < 20) return false;
  const words = str.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 3) return false;
  if (!/[a-z]/.test(str)) return false;
  const trimmed = str.trimStart();
  if (/^[\[{]/.test(trimmed) || /^-?\d+$/.test(trimmed)) return false;
  if (/^(c_|r_|rc_|af\.)/.test(trimmed)) return false;
  return true;
}

function findLongestNaturalText(val) {
  if (typeof val === 'string') {
    return isNaturalLanguage(val) ? val : '';
  }
  if (!Array.isArray(val)) return '';
  let longest = '';
  for (const item of val) {
    const found = findLongestNaturalText(item);
    if (found.length > longest.length) longest = found;
  }
  return longest;
}

function collectTextFragments(val, depth = 0) {
  if (depth > 15) return '';
  if (!Array.isArray(val)) return '';

  const allStrings = val.length > 0 && val.every(item => typeof item === 'string');
  if (allStrings) {
    const wordyFragments = val.filter(s => /\s/.test(s) || (s.length > 2 && /^[a-zA-Z]/.test(s) && !/^https?:\/\//.test(s)));
    if (wordyFragments.length < val.length * 0.5) return '';

    const joined = val.join('');
    if (/https?:\/\/(www\.)?(gstatic|googleapis|google)\.\w+/.test(joined)) return '';
    if (joined.length >= 20 && isNaturalLanguage(joined)) {
      return joined;
    }
  }

  let longest = '';
  for (const item of val) {
    const found = collectTextFragments(item, depth + 1);
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
  // Simulates Gemini's response: anti-XSSI prefix + length-prefixed wrb.fr frame
  // The assistant text is double-encoded inside the wrb.fr entry
  // Length prefix includes the \n before the frame (matching Google's byte-count format)
  const innerPayload = JSON.stringify([[[assistantText]]]);
  const frame = JSON.stringify([['wrb.fr', null, innerPayload]]);
  const byteLen = new TextEncoder().encode('\n' + frame).length;
  return ")]}'\n" + byteLen + '\n' + frame + '\n';
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
    return extractConversationMessagesFallback(cleaned, frames);
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
    return extractConversationMessagesFallback(cleaned, frames, innerConversationData);
  }

  return messages;
}

function extractConversationMessagesFallback(cleaned, frames, innerData) {
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

function makeNestedGeminiResponse(texts) {
  // Multiple texts in the inner payload — longest natural text should win
  const innerPayload = JSON.stringify(texts.map(t => [[t]]));
  const frame = JSON.stringify([['wrb.fr', null, innerPayload]]);
  const byteLen = new TextEncoder().encode('\n' + frame).length;
  return ")]}'\n" + byteLen + '\n' + frame + '\n';
}

function makeMultiFrameResponse(frames) {
  // Build a response with multiple length-prefixed frames
  // Length prefix includes the \n before each frame (Google's byte-count format)
  const encoder = new TextEncoder();
  let result = ")]}'\n";
  for (const frameData of frames) {
    const json = JSON.stringify(frameData);
    const byteLen = encoder.encode('\n' + json).length;
    result += byteLen + '\n' + json + '\n';
  }
  return result;
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

describe('extractTextFromFrame', () => {
  it('extracts text from wrb.fr frame with double-encoded inner JSON', () => {
    const innerPayload = JSON.stringify([['This is the assistant reply with enough words to pass']]);
    const frame = [['wrb.fr', null, innerPayload]];
    const result = extractTextFromFrame(frame);
    expect(result).toBe('This is the assistant reply with enough words to pass');
  });

  it('returns null for non-wrb.fr frames', () => {
    const frame = [['other.rpc', null, '"some data"']];
    expect(extractTextFromFrame(frame)).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(extractTextFromFrame('string')).toBeNull();
    expect(extractTextFromFrame(null)).toBeNull();
    expect(extractTextFromFrame(42)).toBeNull();
  });

  it('returns null when inner JSON is not a string', () => {
    const frame = [['wrb.fr', null, 42]];
    expect(extractTextFromFrame(frame)).toBeNull();
  });

  it('returns null when inner JSON is not parseable', () => {
    const frame = [['wrb.fr', null, '{invalid json}']];
    expect(extractTextFromFrame(frame)).toBeNull();
  });

  it('finds longest natural text in deeply nested inner structure', () => {
    const short = 'hi';
    const long = 'This is a much longer response text from the Gemini assistant model';
    const innerPayload = JSON.stringify([[short], [long], ['x']]);
    const frame = [['wrb.fr', null, innerPayload]];
    const result = extractTextFromFrame(frame);
    expect(result).toBe(long);
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
});

describe('findLongestNaturalText', () => {
  it('returns natural language string', () => {
    expect(findLongestNaturalText('This is a long enough natural text string')).toBe('This is a long enough natural text string');
  });

  it('returns empty for metadata string', () => {
    expect(findLongestNaturalText('c_d55a4bc9fb3d58b8abcd1234')).toBe('');
  });

  it('finds longest natural text in nested arrays', () => {
    const data = [
      'short',
      ['c_abc123def456_extra_padding_text_here'],
      ['This is the actual assistant response with many words in it'],
      [42, null, 'x']
    ];
    expect(findLongestNaturalText(data)).toBe('This is the actual assistant response with many words in it');
  });

  it('returns empty for non-string/non-array', () => {
    expect(findLongestNaturalText(42)).toBe('');
    expect(findLongestNaturalText(null)).toBe('');
    expect(findLongestNaturalText(true)).toBe('');
  });
});

describe('collectTextFragments', () => {
  it('concatenates short string fragments from a leaf array', () => {
    // Simulates Gemini's fragmented text storage
    const data = [null, null, null, null, [
      [['That is a huge part', ' of what makes him so great', ' as a player']]
    ]];
    const result = collectTextFragments(data);
    expect(result).toBe('That is a huge part of what makes him so great as a player');
  });

  it('handles single-element arrays with short text', () => {
    const data = [[['This short text alone would be filtered']]];
    const result = collectTextFragments(data);
    expect(result).toBe('This short text alone would be filtered');
  });

  it('returns longest concatenated fragment across branches', () => {
    const data = [
      [['short', ' text']],
      [['This is a much longer', ' concatenated text', ' that should win', ' the longest contest']]
    ];
    const result = collectTextFragments(data);
    expect(result).toBe('This is a much longer concatenated text that should win the longest contest');
  });

  it('returns empty for non-array input', () => {
    expect(collectTextFragments('string')).toBe('');
    expect(collectTextFragments(42)).toBe('');
    expect(collectTextFragments(null)).toBe('');
  });

  it('returns empty when concatenated result is too short', () => {
    const data = [[['hi', ' yo']]];
    expect(collectTextFragments(data)).toBe('');
  });

  it('skips arrays of non-text strings (IDs, numbers)', () => {
    const data = [[['c_abc123def456', 'r_789012345678']]];
    expect(collectTextFragments(data)).toBe('');
  });

  it('rejects arrays containing Google infrastructure URLs', () => {
    const data = [[['Personalization in progress', 'https://www.gstatic.com/some/resource.png']]];
    expect(collectTextFragments(data)).toBe('');
  });

  it('rejects arrays where most fragments are URLs', () => {
    const data = [[['https://example.com/foo', 'https://example.com/bar', 'click here']]];
    expect(collectTextFragments(data)).toBe('');
  });

  it('respects depth limit', () => {
    // 16 levels deep should return empty
    let nested = ['deep enough text to pass the threshold check'];
    for (let i = 0; i < 17; i++) nested = [nested];
    expect(collectTextFragments(nested)).toBe('');
  });
});

describe('extractTextFromFrame — fragment collection', () => {
  it('extracts text from wrb.fr frame with fragmented strings', () => {
    const innerPayload = JSON.stringify([null, null, null, null, [
      [['That is a huge part', ' of what makes him', ' truly legendary in NFL history']]
    ]]);
    const frame = [['wrb.fr', null, innerPayload]];
    const result = extractTextFromFrame(frame);
    expect(result).toBe('That is a huge part of what makes him truly legendary in NFL history');
  });

  it('prefers single long natural text over fragments', () => {
    const longText = 'This is a complete single string that is long enough to be natural language text';
    const innerPayload = JSON.stringify([[longText], [['short', ' fragments']]]);
    const frame = [['wrb.fr', null, innerPayload]];
    const result = extractTextFromFrame(frame);
    expect(result).toBe(longText);
  });
});

describe('extractAssistantResponse', () => {
  it('extracts text from wrb.fr frame in length-prefixed response', () => {
    const response = makeGeminiResponse('This is a detailed assistant reply with several words in it');
    const result = extractAssistantResponse(response);
    expect(result).toBe('This is a detailed assistant reply with several words in it');
  });

  it('extracts longest natural text from nested response', () => {
    const response = makeNestedGeminiResponse(['short text here', 'This is a longer and more detailed response text from Gemini']);
    const result = extractAssistantResponse(response);
    expect(result).toBe('This is a longer and more detailed response text from Gemini');
  });

  it('strips anti-XSSI prefix', () => {
    const response = makeGeminiResponse('Hello from Gemini with enough words to pass the filter');
    expect(response.startsWith(")]}'")).toBe(true);
    const result = extractAssistantResponse(response);
    expect(result).toBe('Hello from Gemini with enough words to pass the filter');
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
    const text = '[SESSION_CONTEXT]\nSome injected context\n===\nActual assistant response here that is long enough to pass natural language check';
    const response = makeGeminiResponse(text);
    const result = extractAssistantResponse(response);
    expect(result).toBe('Actual assistant response here that is long enough to pass natural language check');
  });

  it('handles multi-frame response picking best text', () => {
    // Frame 1: metadata-only wrb.fr
    const metaInner = JSON.stringify([['c_abc123def456_padding']]);
    const metaFrame = [['wrb.fr', 'meta', metaInner]];
    // Frame 2: actual content wrb.fr
    const contentInner = JSON.stringify([['The real Gemini assistant response with many natural language words']]);
    const contentFrame = [['wrb.fr', 'content', contentInner]];
    const response = makeMultiFrameResponse([metaFrame, contentFrame]);
    const result = extractAssistantResponse(response);
    expect(result).toBe('The real Gemini assistant response with many natural language words');
  });

  it('concatenates text from multiple streaming frames', () => {
    // Simulates Gemini streaming: response split across 3 wrb.fr frames
    const frame1Inner = JSON.stringify([['Walter Payton was a legendary running back who played for the Chicago Bears']]);
    const frame1 = [['wrb.fr', 'stream1', frame1Inner]];
    const frame2Inner = JSON.stringify([['He was known as Sweetness and held the all time rushing record for many years']]);
    const frame2 = [['wrb.fr', 'stream2', frame2Inner]];
    const frame3Inner = JSON.stringify([['Payton was inducted into the Pro Football Hall of Fame in nineteen ninety three']]);
    const frame3 = [['wrb.fr', 'stream3', frame3Inner]];
    const response = makeMultiFrameResponse([frame1, frame2, frame3]);
    const result = extractAssistantResponse(response);
    // Should concatenate all 3 frame texts, not just pick the longest one
    expect(result).toContain('Walter Payton was a legendary');
    expect(result).toContain('Sweetness');
    expect(result).toContain('Hall of Fame');
    expect(result.length).toBeGreaterThan(200);
  });

  it('deduplicates progressive streaming frames (cumulative text)', () => {
    // Gemini progressive streaming: each frame has ALL text so far
    const frame1Inner = JSON.stringify([['While your stored conversations contain some relevant context']]);
    const frame1 = [['wrb.fr', 'p1', frame1Inner]];
    const frame2Inner = JSON.stringify([['While your stored conversations contain some relevant context about this topic and more details here']]);
    const frame2 = [['wrb.fr', 'p2', frame2Inner]];
    const frame3Inner = JSON.stringify([['While your stored conversations contain some relevant context about this topic and more details here including additional information that makes this the longest frame']]);
    const frame3 = [['wrb.fr', 'p3', frame3Inner]];
    const response = makeMultiFrameResponse([frame1, frame2, frame3]);
    const result = extractAssistantResponse(response);
    // Should return the longest frame only (not duplicated concatenation)
    expect(result).toContain('While your stored conversations');
    expect(result).toContain('longest frame');
    // Should NOT have duplicated text
    const firstOccurrence = result.indexOf('While your stored');
    const secondOccurrence = result.indexOf('While your stored', firstOccurrence + 1);
    expect(secondOccurrence).toBe(-1);
  });

  it('concatenates fragment-array frames across streaming', () => {
    // Each frame has text stored as array of short string fragments
    const frame1Inner = JSON.stringify([[['The ', 'answer ', 'to your ', 'question is ', 'actually quite ', 'interesting and complex']]]);
    const frame1 = [['wrb.fr', 'a', frame1Inner]];
    const frame2Inner = JSON.stringify([[['because ', 'it involves ', 'many different ', 'factors that ', 'interact in ', 'surprising ways']]]);
    const frame2 = [['wrb.fr', 'b', frame2Inner]];
    const response = makeMultiFrameResponse([frame1, frame2]);
    const result = extractAssistantResponse(response);
    expect(result).toContain('answer');
    expect(result).toContain('surprising ways');
    expect(result.length).toBeGreaterThan(60);
  });
});

describe('extractAssistantResponse — base64 token stripping', () => {
  it('strips leading base64 tokens from frame text', () => {
    // Token like "ZU__qGt1-tnjG6mx7Bp7NVBB5xcF42qAqykMONoz8Ww" followed by actual text
    const innerPayload = JSON.stringify([
      'ZU__qGt1-tnjG6mx7Bp7NVBB5xcF42qAqykMONoz8Ww If you want the most expensive and effectual sniper rifle available to private citizens, here are the options'
    ]);
    const frame = [['wrb.fr', null, innerPayload]];
    const json = JSON.stringify(frame);
    const response = ")]}'\n" + (json.length + 1) + '\n' + json + '\n';
    const result = extractAssistantResponse(response);
    expect(result).not.toBeNull();
    expect(result).not.toContain('ZU__qGt1');
    expect(result).toContain('most expensive');
  });

  it('rejects frame with only base64 token (no natural text)', () => {
    const innerPayload = JSON.stringify([
      'ZU__qGt1-tnjG6mx7Bp7NVBB5xcF42qAqykMONoz8Ww'
    ]);
    const frame = [['wrb.fr', null, innerPayload]];
    const json = JSON.stringify(frame);
    const response = ")]}'\n" + (json.length + 1) + '\n' + json + '\n';
    const result = extractAssistantResponse(response);
    expect(result).toBeNull();
  });
});

describe('extractAssistantResponse — metadata filtering', () => {
  it('skips metadata and returns actual text from wrb.fr', () => {
    const innerPayload = JSON.stringify([
      'c_abc123def456',
      'The actual assistant response text that is long enough to pass'
    ]);
    const frame = [['wrb.fr', null, innerPayload]];
    const json = JSON.stringify(frame);
    const response = ")]}'\n" + (json.length + 1) + '\n' + json + '\n';
    const result = extractAssistantResponse(response);
    expect(result).toBe('The actual assistant response text that is long enough to pass');
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

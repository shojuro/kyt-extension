/**
 * "Nothing found" note for explicit memory questions.
 *
 * Covers: the pure emit decision, the note text, and every client-side
 * stripper that must remove the note so it is never stored as a memory.
 * The platform strippers live inside page-world IIFEs, so they are pulled
 * out of the real source files and evaluated here (no replicas).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNoMemoryNote,
  shouldEmitNoMemoryNote,
  NO_MEMORY_NOTE_PREFIX,
} from '../../kyt-memory-injection-builder.js';
import { stripInjectionPrefix } from '../../src/context-retrieval.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── fixtures ────────────────────────────────────────────────
const EXPLICIT = { intent: 'QUERY', reason: 'explicit_memory_query', confidenceThreshold: 0.4 };
const cleanDiagnostics = () => ({
  apiCircuitBreakerOpen: false,
  embeddingCircuitBreakerOpen: false,
  hydeCBOpen: false,
  searchFailed: false,
});
const emptyOk = (over = {}) => ({
  success: true,
  items: [],
  formattedContext: null,
  diagnostics: cleanDiagnostics(),
  ...over,
});

describe('shouldEmitNoMemoryNote', () => {
  it('emits for an explicit memory query whose clean search found nothing', () => {
    expect(shouldEmitNoMemoryNote({ classification: EXPLICIT, contextData: emptyOk() })).toBe(true);
  });

  it.each([
    ['PASSIVE intent', { intent: 'PASSIVE', reason: 'generic_question' }],
    ['SKIP intent', { intent: 'SKIP', reason: 'directive' }],
    ['PASSIVE carrying the explicit reason', { intent: 'PASSIVE', reason: 'explicit_memory_query' }],
    ['QUERY for another reason (personal_question)', { intent: 'QUERY', reason: 'personal_question' }],
    ['QUERY from layer 2 (haiku_memory_query)', { intent: 'QUERY', reason: 'haiku_memory_query', layer: 2 }],
    ['missing classification', null],
  ])('does not emit: %s', (_label, classification) => {
    expect(shouldEmitNoMemoryNote({ classification, contextData: emptyOk() })).toBe(false);
  });

  it.each([
    ['items were found', emptyOk({ items: [{ id: 'a', content: 'x' }] })],
    ['a context block already exists', emptyOk({ formattedContext: 'something' })],
    ['retrieval reported failure', emptyOk({ success: false, error: 'boom' })],
    ['success flag missing', emptyOk({ success: undefined })],
    ['an error message is present', emptyOk({ error: 'boom' })],
    ['pipeline timed out', { success: false, error: 'Pipeline timeout', items: [], formattedContext: null, diagnostics: { pipelineTimeout: true } }],
    ['timeout flag even if success were true', emptyOk({ diagnostics: { ...cleanDiagnostics(), pipelineTimeout: true } })],
    ['search step failed and was swallowed', emptyOk({ diagnostics: { ...cleanDiagnostics(), searchFailed: true } })],
    ['API circuit breaker open', emptyOk({ diagnostics: { ...cleanDiagnostics(), apiCircuitBreakerOpen: true } })],
    ['embedding circuit breaker open', emptyOk({ diagnostics: { ...cleanDiagnostics(), embeddingCircuitBreakerOpen: true } })],
    ['HyDE circuit breaker open', emptyOk({ diagnostics: { ...cleanDiagnostics(), hydeCBOpen: true } })],
    ['no diagnostics to prove the search ran', emptyOk({ diagnostics: null })],
    ['blocked by memory mode', emptyOk({ modeBlocked: true })],
    ['blocked by turn limit', emptyOk({ turnLimitReached: true })],
    ['intent skipped', emptyOk({ intentSkipped: true })],
    ['no retrieval result at all', null],
  ])('does not emit: %s', (_label, contextData) => {
    expect(shouldEmitNoMemoryNote({ classification: EXPLICIT, contextData })).toBe(false);
  });

  it('does not throw on missing input', () => {
    expect(shouldEmitNoMemoryNote()).toBe(false);
    expect(shouldEmitNoMemoryNote({})).toBe(false);
  });
});

describe('buildNoMemoryNote', () => {
  const note = buildNoMemoryNote();

  it('is one short parenthetical starting with the K.Y.T. marker', () => {
    expect(note.startsWith(NO_MEMORY_NOTE_PREFIX)).toBe(true);
    expect(NO_MEMORY_NOTE_PREFIX).toBe('(K.Y.T. memory check:');
    expect(note.endsWith(')')).toBe(true);
    expect(note.length).toBeLessThan(260);
    expect(note).not.toContain('\n');
  });

  it('has no inner closing parenthesis (the strippers stop at the first one)', () => {
    expect(note.slice(0, -1)).not.toContain(')');
  });

  it('says nothing was found and asks not to guess', () => {
    expect(note).toMatch(/found nothing relevant/);
    expect(note).toMatch(/instead of guessing/);
  });
});

// ── strippers ───────────────────────────────────────────────
const PROMPT = "What have I told you about my dog's name?";
const NOTE = buildNoMemoryNote();
// How each platform joins context and prompt in the outgoing request:
const LAYOUTS = {
  'claude (note, ---, prompt)': `${NOTE}\n\n---\n\n${PROMPT}`,
  'chatgpt (prompt, note)': `${PROMPT}\n\n${NOTE}`,
  'gemini (note, prompt)': `${NOTE}\n\n${PROMPT}`,
};

describe('stripInjectionPrefix (background capture + sync)', () => {
  it.each(Object.entries(LAYOUTS))('removes the note: %s', (_label, text) => {
    const r = stripInjectionPrefix(text);
    expect(r.content).toBe(PROMPT);
    expect(r.hadInjection).toBe(true);
  });

  it('leaves a message that merely mentions K.Y.T. alone', () => {
    const plain = 'Does the K.Y.T. memory check run on every prompt?';
    const r = stripInjectionPrefix(plain);
    expect(r.content).toBe(plain);
    expect(r.hadInjection).toBe(false);
  });
});

/** Pull `stripInjectionBlock` out of a page-world source file and return it as a callable. */
function loadStripper(relPath) {
  const src = readFileSync(resolve(ROOT, relPath), 'utf8');
  const m = /(?:function\s+stripInjectionBlock\s*\(content\)|stripInjectionBlock:\s*function\s*\(content\))\s*\{/.exec(src);
  if (!m) throw new Error('stripInjectionBlock not found in ' + relPath);
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('unbalanced braces in ' + relPath);
  return new Function('content', src.slice(open + 1, end));
}

describe.each([
  'platforms/chatgpt/inject.js',
  'platforms/claude/content_test.js',
  'platforms/gemini/inject.js',
])('stripInjectionBlock in %s', (relPath) => {
  const strip = loadStripper(relPath);

  it.each(Object.entries(LAYOUTS))('removes the note: %s', (_label, text) => {
    expect(strip(text)).toBe(PROMPT);
  });

  it('still leaves ordinary text alone', () => {
    expect(strip('Plain question about gardening')).toBe('Plain question about gardening');
  });

  it('keeps a message that merely mentions K.Y.T.', () => {
    const plain = 'Does the K.Y.T. memory check run on every prompt?';
    expect(strip(plain)).toBe(plain);
  });
});

describe('ChatGPT visible-message cleanup', () => {
  it('looks for the note marker when hiding injected text in the DOM', () => {
    const src = readFileSync(resolve(ROOT, 'platforms/chatgpt/inject.js'), 'utf8');
    const start = src.indexOf('scheduleInjectionCleanup: function');
    const body = src.slice(start, src.indexOf('getAndInjectContext', start));
    expect(body).toContain("indexOf('(K.Y.T. memory check:')");
  });
});

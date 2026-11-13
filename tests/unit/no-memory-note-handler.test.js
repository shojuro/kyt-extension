/**
 * GET_CONTEXT handler wiring for the "nothing found" note.
 * Drives the real port handler from src/message-handlers.js with its
 * collaborators mocked; the classifier and the note builder are real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks } from '../setup.js';

const statsStore = {};

vi.mock('../../src/browser-sync.js', () => ({ syncToSupabase: vi.fn() }));
vi.mock('../../src/browser-search.js', () => ({ searchMessages: vi.fn(), findSimilarMessages: vi.fn() }));
vi.mock('../../src/edge-sync.js', () => ({ syncViaEdgeFunction: vi.fn() }));
vi.mock('../../src/auth-config.js', () => ({ getApiConfig: vi.fn(), getRoutingMode: vi.fn() }));
vi.mock('../../src/history-import/index.js', () => ({ HistoryImporter: class {} }));
vi.mock('../../src/haiku-tiebreaker.js', () => ({
  classifyWithHaiku: vi.fn(),
  isHaikuEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/memory-mode.js', () => ({
  getMemoryMode: vi.fn().mockResolvedValue('full'),
  setMemoryMode: vi.fn(),
}));
vi.mock('../../src/turn-limiter.js', () => ({
  checkTurnLimit: vi.fn().mockResolvedValue({ allowed: true, used: 1, limit: 100, tier: 'free' }),
  incrementTurnCount: vi.fn(),
  getTurnUsage: vi.fn(),
}));
vi.mock('../../src/tier-sync.js', () => ({ startPostCheckoutPoll: vi.fn() }));
vi.mock('../../src/profile-manager.js', () => ({ getActiveProfileId: vi.fn() }));
vi.mock('../../src/project-manager.js', () => ({
  getActiveProject: vi.fn(), setActiveProject: vi.fn(), clearActiveProject: vi.fn(),
}));
vi.mock('../../src/notebooklm-sync.js', () => ({
  getSyncStatus: vi.fn(), enableSync: vi.fn(), disableSync: vi.fn(), checkGoogleSignIn: vi.fn(),
}));
vi.mock('../../src/supabase-config.js', () => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));
vi.mock('../../src/auth/auth-service.js', () => ({ AUTH_SESSION_KEY: 'auth_session', getSession: vi.fn() }));
vi.mock('../../src/utils/storage-mutex.js', () => ({
  withStorageMutex: vi.fn(async (key, mutator, defaultValue = {}) => {
    const updated = await mutator(statsStore[key] ?? structuredClone(defaultValue));
    if (updated !== undefined) statsStore[key] = updated;
  }),
}));

import { registerPortHandler } from '../../src/message-handlers.js';
import { buildNoMemoryNote } from '../../kyt-memory-injection-builder.js';
import { getMemoryMode } from '../../src/memory-mode.js';
import { checkTurnLimit } from '../../src/turn-limiter.js';

const cleanDiagnostics = () => ({
  apiCircuitBreakerOpen: false,
  embeddingCircuitBreakerOpen: false,
  hydeCBOpen: false,
  searchFailed: false,
});
const emptyOk = (over = {}) => ({
  success: true, items: [], formattedContext: null, diagnostics: cleanDiagnostics(), ...over,
});

const MEMORY_QUESTION = 'What have I told you about the Atlas project?';
const PASSIVE_QUESTION = 'How do volcanoes form under the ocean?';

/** Register the port handler, send one GET_CONTEXT message, return what it posts back. */
async function ask(userMessage, getContextForInjection) {
  let onConnect;
  chrome.runtime.onConnect = { addListener: (fn) => { onConnect = fn; } };
  registerPortHandler(getContextForInjection);

  let onMessage;
  const posted = [];
  onConnect({
    name: 'kyt-context',
    onDisconnect: { addListener: () => {} },
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    postMessage: (data) => posted.push(data),
  });
  await onMessage({ requestId: 'r1', userMessage, platform: 'claude' });
  // let fire-and-forget stats writes settle
  await new Promise((r) => setTimeout(r, 0));
  return posted[0];
}

beforeEach(() => {
  setupChromeMocks();
  chrome.tabs = { query: vi.fn(), sendMessage: vi.fn(() => Promise.resolve()) };
  for (const k of Object.keys(statsStore)) delete statsStore[k];
  vi.mocked(getMemoryMode).mockResolvedValue('full');
  vi.mocked(checkTurnLimit).mockResolvedValue({ allowed: true, used: 1, limit: 100, tier: 'free' });
});

describe('GET_CONTEXT: nothing-found note', () => {
  it('returns the note for an explicit memory question with a clean empty search', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue(emptyOk()));

    expect(res.success).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.formattedContext).toBe(buildNoMemoryNote());
    expect(res.noMemoryNote).toBe(true);

    const { kyt_context_diag: diag } = await chrome.storage.local.get(['kyt_context_diag']);
    expect(diag.steps).toContain('no_memory_note');
    expect(diag.noMemoryNote).toBe(true);
    expect(diag.hasContext).toBe(false);
  });

  it('counts the note as an empty result, not a successful injection', async () => {
    await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue(emptyOk()));
    const stats = statsStore.kyt_injection_stats;
    expect(stats.totalAttempts).toBe(1);
    expect(stats.empty).toBe(1);
    expect(stats.successful).toBe(0);
    expect(stats.recentResults[0]).toMatchObject({ success: false, empty: true, items: 0 });
  });

  it('PASSIVE question with an empty search: no injection', async () => {
    const res = await ask(PASSIVE_QUESTION, vi.fn().mockResolvedValue(emptyOk()));
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('SKIP: retrieval never runs and nothing is injected', async () => {
    const getContext = vi.fn().mockResolvedValue(emptyOk());
    const res = await ask('Thoughts?', getContext);
    expect(getContext).not.toHaveBeenCalled();
    expect(res.intentSkipped).toBe(true);
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('retrieval throws: error result, no note', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockRejectedValue(new Error('network down')));
    expect(res.success).toBe(false);
    expect(res.formattedContext).toBeUndefined();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('pipeline timeout result: no note', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue({
      success: false, error: 'Pipeline timeout', items: [], formattedContext: null,
      diagnostics: { pipelineTimeout: true },
    }));
    expect(res.success).toBe(false);
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('search failure swallowed by the pipeline: no note', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue(
      emptyOk({ diagnostics: { ...cleanDiagnostics(), searchFailed: true } })));
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('circuit breaker open: no note', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue(
      emptyOk({ diagnostics: { ...cleanDiagnostics(), apiCircuitBreakerOpen: true } })));
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('memory mode not full: blocked, no note', async () => {
    vi.mocked(getMemoryMode).mockResolvedValue('clean_room');
    const getContext = vi.fn().mockResolvedValue(emptyOk());
    const res = await ask(MEMORY_QUESTION, getContext);
    expect(getContext).not.toHaveBeenCalled();
    expect(res.modeBlocked).toBe(true);
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('turn limit reached: blocked, no note', async () => {
    vi.mocked(checkTurnLimit).mockResolvedValue({ allowed: false, used: 100, limit: 100, tier: 'free' });
    const getContext = vi.fn().mockResolvedValue(emptyOk());
    const res = await ask(MEMORY_QUESTION, getContext);
    expect(getContext).not.toHaveBeenCalled();
    expect(res.turnLimitReached).toBe(true);
    expect(res.formattedContext).toBeNull();
    expect(res.noMemoryNote).toBeUndefined();
  });

  it('memories found: the real context is passed through untouched', async () => {
    const res = await ask(MEMORY_QUESTION, vi.fn().mockResolvedValue(emptyOk({
      items: [{ id: 'm1', content: 'Atlas ships in spring', platform: 'claude', similarity: 0.8 }],
      formattedContext: '(For context: ...)',
    })));
    expect(res.formattedContext).toBe('(For context: ...)');
    expect(res.noMemoryNote).toBeUndefined();
    expect(statsStore.kyt_injection_stats.successful).toBe(1);
  });
});

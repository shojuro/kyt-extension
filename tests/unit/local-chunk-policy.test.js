/**
 * Local chunk policy (src/local-chunk-policy.js).
 * Regression for 2026-11-15: Claude was given fifteen "dom_capture" fragments
 * of a ChatGPT chat, with the user's words labelled as the assistant's, while
 * the clean re-imported copy of the same chat sat unused.
 */
import { describe, it, expect } from 'vitest';
import { reimportOwnsTurns, chunksToStoreLocally, POLLER_TRUST_MS } from '../../src/local-chunk-policy.js';

const NOW = 1_800_000_000_000;
const healthy = { chatgpt: { lastSuccessAt: NOW - 5 * 60 * 1000 }, gemini: { lastSuccessAt: NOW - 5 * 60 * 1000 } };

describe('reimportOwnsTurns', () => {
  it('leaves ChatGPT turns to the poller while it is succeeding', () => {
    expect(reimportOwnsTurns('chatgpt', healthy, NOW)).toBe(true);
  });

  it('keeps the page copy when the poller has not succeeded for a day, or never', () => {
    expect(reimportOwnsTurns('chatgpt', { chatgpt: { lastSuccessAt: NOW - POLLER_TRUST_MS - 1 } }, NOW)).toBe(false);
    expect(reimportOwnsTurns('chatgpt', { chatgpt: { lastSuccessAt: null } }, NOW)).toBe(false);
    expect(reimportOwnsTurns('chatgpt', {}, NOW)).toBe(false);
    expect(reimportOwnsTurns('chatgpt', undefined, NOW)).toBe(false);
    expect(reimportOwnsTurns('chatgpt', { chatgpt: { lastSuccessAt: NOW + 60_000 } }, NOW)).toBe(false);
  });

  it('does not apply to other platforms', () => {
    expect(reimportOwnsTurns('gemini', healthy, NOW)).toBe(false);
    expect(reimportOwnsTurns('claude', healthy, NOW)).toBe(false);
  });
});

describe('chunksToStoreLocally', () => {
  const chunks = [
    { platform: 'chatgpt', conversation_id: 'dom_capture', content: 'YouI just read a Harvard article' },
    { platform: 'chatgpt', conversation_id: 'unknown', content: 'fragment' },
    { platform: 'claude', conversation_id: 'c1', content: 'kept' },
    { platform: 'gemini', conversation_id: 'g1', content: 'kept too' },
  ];

  it('drops ChatGPT chunks while the poller is healthy and keeps the rest', () => {
    expect(chunksToStoreLocally(chunks, healthy, NOW).map((c) => c.platform)).toEqual(['claude', 'gemini']);
  });

  it('keeps everything when the poller is not healthy', () => {
    expect(chunksToStoreLocally(chunks, {}, NOW)).toHaveLength(4);
    expect(chunksToStoreLocally(null, healthy, NOW)).toEqual([]);
  });
});

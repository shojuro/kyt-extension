/**
 * When the server search answers "nothing relevant", that is the answer.
 *
 * Regression for 2026-11-14: "What is K.Y.T.?" got 0 results from the server
 * (nothing passed its quality bar). The extension then ran its old local
 * search, which has no quality filters and only sees the last few captured
 * messages, and injected 18 of them: assistants' "I can't find it" replies,
 * "This block is not supported" text, and an assistant's wrong guess about
 * Cleophis, all presented as things the user had said.
 */
import { describe, it, expect } from 'vitest';
import { shouldUseLegacySearch } from '../../src/legacy-search-policy.js';

describe('shouldUseLegacySearch', () => {
  it('signed-out routing always uses the local search', () => {
    expect(shouldUseLegacySearch({ routingMode: 'legacy', itemCount: 0, searchFailed: false })).toBe(true);
  });

  it('server answered with results: no local search', () => {
    expect(shouldUseLegacySearch({ routingMode: 'edge', itemCount: 3, searchFailed: false })).toBe(false);
  });

  it('server answered with nothing: no local search', () => {
    expect(shouldUseLegacySearch({ routingMode: 'edge', itemCount: 0, searchFailed: false })).toBe(false);
  });

  it('server search failed: local search stands in', () => {
    expect(shouldUseLegacySearch({ routingMode: 'edge', itemCount: 0, searchFailed: true })).toBe(true);
  });

  it('test mode never uses the local search', () => {
    expect(shouldUseLegacySearch({ routingMode: 'edge', itemCount: 0, searchFailed: true, testMode: true })).toBe(false);
  });
});

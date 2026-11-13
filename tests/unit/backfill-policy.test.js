/**
 * Entity backfill failure policy (supabase/functions/_shared/backfill-policy.ts).
 *
 * Regression for 2026-11-13: backfill_entities made 4,946 Anthropic calls in a
 * day for ~158 pending turns. The extension re-upserts every chunk of a
 * conversation on each sync with entities_extracted=false, so turns that were
 * already extracted kept coming back as pending and were paid for again; and a
 * turn that failed was left unmarked with no attempt count.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_EXTRACTION_ATTEMPTS,
  MAX_CONSECUTIVE_API_FAILURES,
  classifyExtractionError,
  readAttempts,
  withFailedAttempt,
  decideFailureAction,
  nextFetchSize,
  hasTimeBudget,
  shouldAbortRun,
  notInFilter,
  contentFingerprint,
  isSettled,
  withExtracted,
  withGivenUp,
  advanceCursor,
} from '../../supabase/functions/_shared/backfill-policy.ts';
import { AnthropicReplyError } from '../../supabase/functions/_shared/anthropic-model.ts';

describe('classifyExtractionError', () => {
  it('treats an unusable reply (billed, bad output) as reply_unusable', () => {
    expect(classifyExtractionError(new AnthropicReplyError('parse', 'x'))).toBe('reply_unusable');
    expect(classifyExtractionError(new AnthropicReplyError('truncated', 'x'))).toBe('reply_unusable');
    expect(classifyExtractionError(new AnthropicReplyError('refusal', 'x'))).toBe('reply_unusable');
  });
  it('treats an HTTP error from the API as api_status (account or request level, not the turn)', () => {
    expect(classifyExtractionError(new Error('Anthropic API Error: 400 - temperature is not supported'))).toBe('api_status');
    expect(classifyExtractionError(new Error('Anthropic API Error: 401 - bad key'))).toBe('api_status');
    expect(classifyExtractionError(new Error('Anthropic API Error: 529 - overloaded'))).toBe('api_status');
  });
  it('treats timeouts and anything else as transient', () => {
    expect(classifyExtractionError(new Error('Request timeout'))).toBe('transient');
    expect(classifyExtractionError(new TypeError('fetch failed'))).toBe('transient');
    expect(classifyExtractionError(undefined)).toBe('transient');
  });
});

describe('attempt bookkeeping in chat_turns.metadata', () => {
  it('reads 0 from missing or foreign metadata', () => {
    expect(readAttempts(null)).toBe(0);
    expect(readAttempts({})).toBe(0);
    expect(readAttempts({ notebook_title: 'x' })).toBe(0);
    expect(readAttempts({ entity_extraction: { attempts: 'two' } })).toBe(0);
  });
  it('increments attempts and keeps unrelated keys', () => {
    const one = withFailedAttempt({ notebook_title: 'x' }, 'transient', 'Request timeout', '2026-11-13T00:00:00Z', 'fp1');
    expect(one.notebook_title).toBe('x');
    expect(one.entity_extraction).toMatchObject({ attempts: 1, last_failure: 'transient', last_failed_at: '2026-11-13T00:00:00Z' });
    const two = withFailedAttempt(one, 'save_error', 'insert failed', '2026-11-13T00:05:00Z', 'fp1');
    expect(readAttempts(two)).toBe(2);
    expect(two.entity_extraction.last_failure).toBe('save_error');
  });
  it('does not mutate its input and truncates the stored error text', () => {
    const input = { entity_extraction: { attempts: 1, content_fp: 'fp1' } };
    const out = withFailedAttempt(input, 'transient', 'e'.repeat(1000), 'now', 'fp1');
    expect(input.entity_extraction.attempts).toBe(1);
    expect(out.entity_extraction.last_error.length).toBeLessThanOrEqual(200);
  });

  it('starts the count again when the content of the turn changed', () => {
    const old = withFailedAttempt(withFailedAttempt({}, 'transient', 'x', 't1', 'fp1'), 'transient', 'x', 't2', 'fp1');
    expect(readAttempts(old)).toBe(2);
    expect(readAttempts(withFailedAttempt(old, 'transient', 'x', 't3', 'fp2'))).toBe(1);
  });
});

describe('settled turns are not paid for twice', () => {
  const content = 'User: I moved to Lisbon.\nAssistant: Noted.';
  const fp = contentFingerprint(content);

  it('fingerprints content deterministically and differently for different text', () => {
    expect(contentFingerprint(content)).toBe(fp);
    expect(contentFingerprint(content + ' More.')).not.toBe(fp);
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('ba'));
    expect(typeof fp).toBe('string');
  });

  it('a turn with no record is not settled', () => {
    expect(isSettled(null, content)).toBe(false);
    expect(isSettled({}, content)).toBe(false);
    expect(isSettled({ entity_extraction: { attempts: 2, content_fp: fp } }, content)).toBe(false);
  });

  it('a turn extracted with the same content is settled, even if its flag was reset', () => {
    const meta = withExtracted({ notebook_title: 'x' }, fp, '2026-11-13T00:00:00Z');
    expect(meta.notebook_title).toBe('x');
    expect(meta.entity_extraction).toMatchObject({ status: 'done', content_fp: fp, attempts: 0 });
    expect(isSettled(meta, content)).toBe(true);
  });

  it('a turn whose content grew since extraction is not settled', () => {
    const meta = withExtracted({}, fp, 'now');
    expect(isSettled(meta, content + '\nUser: And I work at Acme.')).toBe(false);
  });

  it('a turn that was given up on stays settled until its content changes', () => {
    const failed = withGivenUp(withFailedAttempt({}, 'reply_unusable', 'cut off', 't1', fp), 't1');
    expect(failed.entity_extraction).toMatchObject({ status: 'failed', content_fp: fp, attempts: 1 });
    expect(isSettled(failed, content)).toBe(true);
    expect(isSettled(failed, content + ' changed')).toBe(false);
  });

  it('a later success clears the failure record', () => {
    const failed = withFailedAttempt({}, 'transient', 'timeout', 't1', fp);
    const done = withExtracted(failed, fp, 't2');
    expect(done.entity_extraction.attempts).toBe(0);
    expect(done.entity_extraction).not.toHaveProperty('last_error');
  });
});

describe('decideFailureAction', () => {
  it('gives up at once on an unusable reply: it was billed and would be billed again', () => {
    expect(decideFailureAction('reply_unusable', 1)).toBe('mark_failed');
  });
  it('never gives up on a turn because the API returned an HTTP error', () => {
    expect(decideFailureAction('api_status', 99)).toBe('retry_later');
  });
  it('caps transient and save failures', () => {
    expect(MAX_EXTRACTION_ATTEMPTS).toBe(3);
    for (const kind of ['transient', 'save_error']) {
      expect(decideFailureAction(kind, 1)).toBe('retry_later');
      expect(decideFailureAction(kind, 2)).toBe('retry_later');
      expect(decideFailureAction(kind, 3)).toBe('mark_failed');
      expect(decideFailureAction(kind, 4)).toBe('mark_failed');
    }
  });
  it('retries later when the attempt count could not be stored', () => {
    expect(decideFailureAction('transient', null)).toBe('retry_later');
    expect(decideFailureAction('reply_unusable', null)).toBe('mark_failed');
  });
});

describe('run limits', () => {
  it('fetches no more rows than the caller asked for', () => {
    expect(nextFetchSize(10, 0, 5)).toBe(5);
    expect(nextFetchSize(10, 5, 5)).toBe(5);
    expect(nextFetchSize(10, 10, 5)).toBe(0);
    expect(nextFetchSize(7, 5, 5)).toBe(2);
    expect(nextFetchSize(3, 0, 5)).toBe(3);
  });
  it('stops starting work when the time budget is spent', () => {
    expect(hasTimeBudget(1000, 1000 + 99_999, 100_000)).toBe(true);
    expect(hasTimeBudget(1000, 1000 + 100_000, 100_000)).toBe(false);
  });
  it('aborts the run after consecutive API failures', () => {
    expect(MAX_CONSECUTIVE_API_FAILURES).toBe(3);
    expect(shouldAbortRun(2)).toBe(false);
    expect(shouldAbortRun(3)).toBe(true);
  });
  it('builds a PostgREST not-in list from row ids, and rejects anything that is not a UUID', () => {
    const a = '0b0e7d3e-5b1f-4c59-9d6b-2f6d1c1f3a10';
    const b = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    expect(notInFilter([a, b])).toBe(`(${a},${b})`);
    expect(() => notInFilter([a, 'x); drop'])).toThrow(/uuid/i);
  });
});

describe('advanceCursor: a run never fetches the same row twice', () => {
  const A = '0b0e7d3e-5b1f-4c59-9d6b-2f6d1c1f3a10';
  const B = '0b0e7d3e-5b1f-4c59-9d6b-2f6d1c1f3a11';
  const C = '0b0e7d3e-5b1f-4c59-9d6b-2f6d1c1f3a12';
  const D = '0b0e7d3e-5b1f-4c59-9d6b-2f6d1c1f3a13';
  const start = { createdAt: null, idsAtCursor: [] };

  it('moves to the oldest created_at of the chunk and remembers the ids at that instant', () => {
    const next = advanceCursor(start, [
      { id: A, created_at: '2026-11-13T10:00:03+00:00' },
      { id: B, created_at: '2026-11-13T10:00:02+00:00' },
      { id: C, created_at: '2026-11-13T10:00:02+00:00' },
    ]);
    expect(next).toEqual({ createdAt: '2026-11-13T10:00:02+00:00', idsAtCursor: [B, C] });
  });

  it('keeps earlier ids when the next chunk is still at the same instant (bulk insert)', () => {
    const first = advanceCursor(start, [{ id: A, created_at: 't1' }, { id: B, created_at: 't1' }]);
    const second = advanceCursor(first, [{ id: C, created_at: 't1' }, { id: D, created_at: 't0' }]);
    expect(first.idsAtCursor).toEqual([A, B]);
    expect(second).toEqual({ createdAt: 't0', idsAtCursor: [D] });
    const same = advanceCursor(first, [{ id: C, created_at: 't1' }]);
    expect(same).toEqual({ createdAt: 't1', idsAtCursor: [A, B, C] });
  });

  it('does not move on an empty chunk and does not mutate its input', () => {
    const first = advanceCursor(start, [{ id: A, created_at: 't1' }]);
    expect(advanceCursor(first, [])).toEqual(first);
    expect(start).toEqual({ createdAt: null, idsAtCursor: [] });
  });
});

/**
 * The loop that drives backfill_sections (src/sections-runner.js). It must
 * finish the backlog and must never spin on a call that makes no progress.
 */
import { describe, it, expect } from 'vitest';
import { backfillSections } from '../../src/sections-runner.js';

const quiet = { log: () => {} };
const run = (r) => ({ success: true, processed: 0, sectioned: 0, sections_written: 0, failed: 0, remaining: 0, stopped: null, ...r });

function fakeCall(replies) {
  const calls = [];
  const call = async (name, body, opts) => {
    calls.push({ name, body, opts });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { call, calls };
}

describe('backfillSections', () => {
  it('repeats until nothing is left, through time-budget stops, and adds up the totals', async () => {
    const { call, calls } = fakeCall([
      run({ processed: 20, sectioned: 18, sections_written: 150, remaining: 40, stopped: 'time_budget' }),
      run({ processed: 20, sectioned: 20, sections_written: 170, remaining: 20 }),
      run({ processed: 20, sectioned: 19, sections_written: 160, failed: 1, remaining: 0 }),
    ]);
    const totals = await backfillSections(call, { limit: 20 }, quiet);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ name: 'backfill_sections', body: { limit: 20 }, opts: { timeoutMs: 140000 } });
    expect(totals).toMatchObject({ success: true, runs: 3, processed: 60, sectioned: 57, sections_written: 480, failed: 1, remaining: 0, stopped: null });
  });

  it('stops when the embedding provider is down', async () => {
    const { call, calls } = fakeCall([run({ processed: 2, remaining: 900, stopped: 'embedding_unavailable' })]);
    const totals = await backfillSections(call, {}, quiet);
    expect(calls).toHaveLength(1);
    expect(totals.stopped).toBe('embedding_unavailable');
  });

  it('stops when a call makes no progress', async () => {
    const { call, calls } = fakeCall([run({ processed: 0, failed: 3, remaining: 12 })]);
    const totals = await backfillSections(call, {}, quiet);
    expect(calls).toHaveLength(1);
    expect(totals.stopped).toBe('no_progress');
  });

  it('stops on an error reply or a thrown error, and never exceeds maxRuns', async () => {
    const a = fakeCall([{ success: false, error: 'boom' }]);
    expect(await backfillSections(a.call, {}, quiet)).toMatchObject({ success: false, error: 'boom' });
    const b = fakeCall([new Error('timeout')]);
    expect(await backfillSections(b.call, {}, quiet)).toMatchObject({ success: false, error: 'timeout' });
    const c = fakeCall([run({ processed: 5, remaining: 99 })]);
    const totals = await backfillSections(c.call, {}, { ...quiet, maxRuns: 4 });
    expect(c.calls).toHaveLength(4);
    expect(totals.stopped).toBe('max_runs');
  });

  it('does not start a second loop while one is running', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const call = async () => { calls.push(1); await gate; return run({ processed: 3, remaining: 0 }); };
    const first = backfillSections(call, {}, quiet);
    const second = backfillSections(call, {}, quiet);
    release();
    expect(await second).toEqual(await first);
    expect(calls).toHaveLength(1);
  });
});

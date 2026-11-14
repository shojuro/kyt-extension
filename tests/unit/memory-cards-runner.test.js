/**
 * The loop that drives build_memory_cards (src/memory-cards-runner.js).
 * It must finish the work and must never spin on a call that makes no
 * progress (the backfill loop of 2026-11-13 cost $17 in a day that way).
 */
import { describe, it, expect } from 'vitest';
import { buildMemoryCards } from '../../src/memory-cards-runner.js';

const quiet = { log: () => {}, now: () => new Date('2026-11-14T06:00:00Z') };
const run = (r) => ({ success: true, built: 0, insufficient: 0, unchanged: 0, failed: 0, model_calls: 0, remaining: 0, ...r });

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

describe('buildMemoryCards', () => {
  it('repeats until nothing is left and adds up the totals', async () => {
    const { call, calls } = fakeCall([
      run({ built: 6, insufficient: 2, model_calls: 8, remaining: 9 }),
      run({ built: 7, unchanged: 1, model_calls: 7, remaining: 1 }),
      run({ built: 1, model_calls: 1, remaining: 0 }),
    ]);
    const totals = await buildMemoryCards(call, {}, quiet);
    expect(calls).toHaveLength(3);
    expect(totals).toMatchObject({ success: true, runs: 3, built: 14, insufficient: 2, unchanged: 1, model_calls: 16, remaining: 0, stopped: null });
  });

  it('sends pins on every call so none are lost before their card is written', async () => {
    const pins = [{ name: 'K.Y.T.', aliases: ['KYT'], note: 'Keep Your Thoughts' }];
    const { call, calls } = fakeCall([run({ built: 1, remaining: 3 }), run({ built: 3, remaining: 0 })]);
    await buildMemoryCards(call, { pins }, quiet);
    expect(calls.map((c) => c.body.pins)).toEqual([pins, pins]);
  });

  it('stops when a call makes no progress', async () => {
    const { call, calls } = fakeCall([run({ failed: 4, remaining: 20, stopped: 'repeated_failures' })]);
    const totals = await buildMemoryCards(call, {}, quiet);
    expect(calls).toHaveLength(1);
    expect(totals).toMatchObject({ failed: 4, remaining: 20, stopped: 'repeated_failures' });
  });

  it('stops on an error reply or a thrown error', async () => {
    const a = fakeCall([{ success: false, error: 'boom' }]);
    expect(await buildMemoryCards(a.call, {}, quiet)).toMatchObject({ success: false, error: 'boom', runs: 0 });
    const b = fakeCall([new Error('timeout')]);
    expect(await buildMemoryCards(b.call, {}, quiet)).toMatchObject({ success: false, error: 'timeout' });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('never runs more than maxRuns calls', async () => {
    const { call, calls } = fakeCall([run({ built: 1, remaining: 99 })]);
    const totals = await buildMemoryCards(call, {}, { ...quiet, maxRuns: 3 });
    expect(calls).toHaveLength(3);
    expect(totals.stopped).toBe('max_runs');
  });

  it('sends "rewrite everything" as one fixed cut-off time, so rewritten cards are not rewritten again', async () => {
    const { call, calls } = fakeCall([run({ built: 8, remaining: 8 }), run({ built: 8, remaining: 0 })]);
    await buildMemoryCards(call, { force: true }, quiet);
    expect(calls.map((c) => c.body.rebuild_before)).toEqual(['2026-11-14T06:00:00.000Z', '2026-11-14T06:00:00.000Z']);
    expect(calls[0].body).not.toHaveProperty('force');
  });

  it('does not start a second build while one is running', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const call = async (name, body) => { calls.push(body); await gate; return run({ built: 2, remaining: 0 }); };
    const first = buildMemoryCards(call, {}, quiet);
    const second = buildMemoryCards(call, {}, quiet);
    release();
    expect(await second).toEqual(await first);
    expect(calls).toHaveLength(1);
    // and a new build can start once the first is done
    await buildMemoryCards(call, {}, quiet);
    expect(calls).toHaveLength(2);
  });

  it('a dry run makes one call and writes nothing', async () => {
    const { call, calls } = fakeCall([{ success: true, dry_run: true, planned: 12, stale: 12, names: [] }]);
    const out = await buildMemoryCards(call, { dryRun: true, maxAuto: 10 }, quiet);
    expect(calls).toEqual([{ name: 'build_memory_cards', body: { max_auto: 10, dry_run: true }, opts: { timeoutMs: 60000 } }]);
    expect(out.planned).toBe(12);
  });
});

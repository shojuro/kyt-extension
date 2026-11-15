/**
 * Recall test-set runner inside the extension (src/recall-eval-runner.js).
 */
import { describe, it, expect } from 'vitest';
import { runRecallSet, configFor } from '../../src/recall-eval-runner.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const set = {
  questions: [
    { id: 'hit', question: 'What did you tell me about possums?', kind: 'reply', expect: { any_turn_ids: [ID_A] } },
    { id: 'section', question: 'What did you tell me about gliders?', kind: 'reply', expect: { any_turn_ids: [ID_A] } },
    { id: 'skipped', question: 'ok thanks for that', kind: 'reply', expect: { any_turn_ids: [ID_A] } },
    { id: 'empty', question: 'What did you tell me about Arctic terns?', kind: 'none', expect: { none: true } },
    { id: 'boom', question: 'What did you tell me about errors?', kind: 'reply', expect: { any_turn_ids: [ID_A] } },
  ],
};

const deps = {
  classify: (text) => (text.startsWith('ok') ? { intent: 'SKIP', reason: 'low_density' }
    : text.includes('gliders') ? { intent: 'PASSIVE', confidenceThreshold: 0.6, reason: 'generic_question' }
    : { intent: 'QUERY', confidenceThreshold: 0.45, reason: 'personal_question' }),
  escalate: async (_text, c) => ({ ...c, intent: 'QUERY', confidenceThreshold: 0.5, reason: 'layer2_memory' }),
  getContext: async (text, config) => {
    if (text.includes('errors')) throw new Error('search exploded');
    if (text.includes('possums')) return { items: [{ id: 'other' }, { id: ID_A }], config };
    if (text.includes('gliders')) return { items: [{ id: 'sec-1', turn_id: ID_A, section: true }] };
    return { items: [] };
  },
};

describe('runRecallSet', () => {
  it('runs each question the way a real message is handled and scores it', async () => {
    const seen = [];
    const out = await runRecallSet(set, deps, { onProgress: (row) => seen.push(row.id) });
    expect(out.ok).toBe(true);
    expect(seen).toEqual(['hit', 'section', 'skipped', 'empty', 'boom']);
    const byId = Object.fromEntries(out.scores.map((s) => [s.id, s]));
    expect(byId.hit).toMatchObject({ pass: true, rank: 2 });
    expect(byId.hit.returned_ids).toEqual(['other', ID_A]);
    expect(byId.section.returned_ids).toEqual([ID_A]);
    expect(byId.section).toMatchObject({ pass: true, rank: 1, intent: 'layer2_memory' });
    expect(byId.skipped).toMatchObject({ pass: false, skipped: true });
    expect(byId.empty).toMatchObject({ pass: true });
    expect(byId.boom).toMatchObject({ pass: false, error: 'search exploded' });
    expect(out.summary.overall).toMatchObject({ questions: 5, passed: 3, not_searched: 1 });
  });

  it('refuses a malformed set and reports what a change fixed or broke', async () => {
    expect(await runRecallSet({ questions: [{ id: 'x' }] }, deps)).toMatchObject({ ok: false });
    const previous = { scores: [{ id: 'hit', pass: false }, { id: 'empty', pass: true }] };
    const out = await runRecallSet(set, deps, { previous, limit: 4 });
    expect(out.scores).toHaveLength(4);
    expect(out.against_previous).toEqual({ fixed: ['hit'], broken: [] });
  });
});

describe('configFor', () => {
  it('carries the threshold, platform and technical flag', () => {
    expect(configFor({ confidenceThreshold: 0.45, reason: 'personal_question' }, 'claude')).toEqual({ platform: 'claude', confidenceThreshold: 0.45 });
    expect(configFor({ confidenceThreshold: null, reason: 'technical_code', scores: {} }, 'chatgpt')).toEqual({ platform: 'chatgpt', queryType: 'technical' });
  });
});

/**
 * Recall test set scoring (src/recall-eval-lib.js).
 */
import { describe, it, expect } from 'vitest';
import { validateSet, scoreQuestion, summarise, compareRuns } from '../../src/recall-eval-lib.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const q = (over = {}) => ({ id: 'q1', question: 'What did you tell me about X?', kind: 'reply', expect: { any_turn_ids: [ID_A] }, ...over });

describe('validateSet', () => {
  it('accepts a well-formed set', () => {
    expect(validateSet({ questions: [q(), q({ id: 'q2', kind: 'none', expect: { none: true } }), q({ id: 'q3', kind: 'definition', expect: { any_card_keys: ['kyt'] } })] })).toEqual([]);
  });

  it('names what is wrong', () => {
    const problems = validateSet({ questions: [
      q({ id: '' }), q(), q(),
      q({ id: 'k', kind: 'banana' }),
      q({ id: 'e', expect: {} }),
      q({ id: 'u', expect: { any_turn_ids: ['not-a-uuid'] } }),
      q({ id: 'n', kind: 'reply', expect: { none: true } }),
      q({ id: 'b', kind: 'none', expect: { none: true, any_turn_ids: [ID_A] } }),
    ] });
    expect(problems.join('\n')).toMatch(/missing id/);
    expect(problems.join('\n')).toMatch(/duplicate id/);
    expect(problems.join('\n')).toMatch(/kind must be one of/);
    expect(problems.join('\n')).toMatch(/no expected turn ids/);
    expect(problems.join('\n')).toMatch(/must be UUIDs/);
    expect(problems.join('\n')).toMatch(/must go together/);
    expect(problems.join('\n')).toMatch(/nothing and something at once/);
    expect(validateSet(null)).toEqual(['set has no "questions" list']);
  });
});

describe('scoreQuestion', () => {
  it('passes when an expected turn is returned, and reports where', () => {
    expect(scoreQuestion(q(), [{ id: ID_B }, { id: ID_A }])).toMatchObject({ pass: true, rank: 2, returned: 2 });
  });

  it('counts a section of the expected turn', () => {
    expect(scoreQuestion(q(), [{ id: 'section-1', turn_id: ID_A, section: true }])).toMatchObject({ pass: true, rank: 1 });
  });

  it('counts an expected memory card', () => {
    const question = q({ kind: 'definition', expect: { any_card_keys: ['kyt'] } });
    expect(scoreQuestion(question, [{ id: 'x', source: 'memory_card', card_key: 'kyt' }])).toMatchObject({ pass: true, rank: 1 });
    expect(scoreQuestion(question, [{ id: 'x', source: 'memory_card', card_key: 'cleophis' }])).toMatchObject({ pass: false });
  });

  it('fails when only other turns come back, or nothing does', () => {
    expect(scoreQuestion(q(), [{ id: ID_B }])).toMatchObject({ pass: false, rank: null, returned: 1 });
    expect(scoreQuestion(q(), [], { skipped: true })).toMatchObject({ pass: false, skipped: true });
  });

  it('a question with nothing stored passes only on an empty result', () => {
    const none = q({ kind: 'none', expect: { none: true } });
    expect(scoreQuestion(none, [])).toMatchObject({ pass: true, wanted: 'nothing' });
    expect(scoreQuestion(none, [{ id: ID_B }])).toMatchObject({ pass: false });
  });
});

describe('summarise and compareRuns', () => {
  const scores = [
    { id: 'a', kind: 'reply', pass: true, rank: 1, returned: 3, wanted: 'answer', skipped: false },
    { id: 'b', kind: 'reply', pass: true, rank: 5, returned: 6, wanted: 'answer', skipped: false },
    { id: 'c', kind: 'reply', pass: false, rank: null, returned: 0, wanted: 'answer', skipped: true },
    { id: 'd', kind: 'none', pass: true, rank: null, returned: 0, wanted: 'nothing', skipped: false },
  ];

  it('totals overall and by kind', () => {
    const s = summarise(scores);
    expect(s.overall).toMatchObject({ questions: 4, passed: 3, answer_found: '2/3', found_in_top_3: '1/3', correctly_empty: '1/1', not_searched: 1 });
    expect(s.by_kind.reply.passed).toBe(2);
    expect(s.by_kind.none.passed).toBe(1);
  });

  it('lists what a change fixed and what it broke', () => {
    const after = scores.map((s) => (s.id === 'c' ? { ...s, pass: true, rank: 2 } : s.id === 'a' ? { ...s, pass: false, rank: null } : s));
    expect(compareRuns(scores, after)).toEqual({ fixed: ['c'], broken: ['a'] });
  });
});

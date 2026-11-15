/**
 * Keyword lane for the judge (supabase/functions/_shared/keyword-lane.ts).
 * Regression for the 2026-11-15 recall set, run four: the message that says
 * "running around the city, the Beverly Center, Venice beach" was never a
 * candidate for the question that asks about exactly that.
 */
import { describe, it, expect } from 'vitest';
import { keywordTerms, keywordPassages, KEYWORD_LANE, MAX_KEYWORD_TERMS } from '../../supabase/functions/_shared/keyword-lane.ts';
import { JUDGE_KEYWORD_PASSAGES, JUDGE_MAX_PASSAGES, JUDGE_TURN_PASSAGES, JUDGE_SECTION_PASSAGES, TURN_KIND, buildJudgePrompt } from '../../supabase/functions/_shared/section-judge.ts';

describe('keywordTerms', () => {
  it('keeps topic words and drops the wording of a recall question', () => {
    expect(keywordTerms('What did I say about running around the Beverly Center and Venice Beach?'))
      .toEqual(['running', 'around', 'beverly', 'center', 'venice', 'beach']);
    expect(keywordTerms('What is Isaribi Kochu? You explained it once.')).toEqual(['isaribi', 'kochu']);
    expect(keywordTerms('what did you tell me about jericho and nar?')).toEqual(['jericho', 'nar']);
  });

  it('removes repeats, caps the count and survives bad input', () => {
    expect(keywordTerms('Cyrus cyrus CYRUS persian')).toEqual(['cyrus', 'persian']);
    const many = keywordTerms('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    expect(many).toHaveLength(MAX_KEYWORD_TERMS);
    expect(many[0]).toBe('alpha');
    expect(keywordTerms('what did you tell me?')).toEqual([]);
    expect(keywordTerms(null)).toEqual([]);
  });

  it('keeps non-English letters together', () => {
    expect(keywordTerms('the café in Zürich')).toEqual(['café', 'zürich']);
  });
});

describe('keywordPassages', () => {
  const rows = [
    { id: 'a', content: 'already found by meaning', speakers: ['user'] },
    { id: 'b', content: 'Beverly Center, Venice beach', speakers: ['user'], platform: 'chatgpt', created_at: '2026-02-16T00:00:00Z' },
    { id: 'b', content: 'duplicate row' },
    { id: 'c', content: '   ' },
    { id: 'd', content: 'third' },
  ];

  it('skips what the meaning search already supplied, repeats and empty rows', () => {
    const out = keywordPassages(rows, ['a']);
    expect(out.map((p) => p.id)).toEqual(['b', 'd']);
    expect(out[0]).toMatchObject({ kind: TURN_KIND, turn_id: 'b', similarity: 0, lane: KEYWORD_LANE, platform: 'chatgpt' });
  });

  it('respects the cap, which the judge prompt has room for', () => {
    const lots = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, content: `text ${i}` }));
    expect(keywordPassages(lots, [])).toHaveLength(JUDGE_KEYWORD_PASSAGES);
    expect(JUDGE_MAX_PASSAGES).toBe(JUDGE_TURN_PASSAGES + JUDGE_KEYWORD_PASSAGES + JUDGE_SECTION_PASSAGES);
    const prompt = buildJudgePrompt('q', Array.from({ length: JUDGE_MAX_PASSAGES }, (_, i) => ({ id: `p${i}`, kind: TURN_KIND, content: `passage ${i}`, speakers: ['user'] })));
    expect(prompt).toContain(`[${JUDGE_MAX_PASSAGES}]`);
  });
});

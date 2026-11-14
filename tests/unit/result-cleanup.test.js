/**
 * Search result clean-up (supabase/functions/_shared/result-cleanup.ts).
 * Regression for 2026-11-14: injected "memories" began with
 * "``` This block is not supported on your current device yet. ```" three
 * times over, a claude.ai placeholder captured with assistant replies.
 */
import { describe, it, expect } from 'vitest';
import { cleanResultContent, cleanResults } from '../../supabase/functions/_shared/result-cleanup.ts';

const BLOCK = '``` This block is not supported on your current device yet. ```';

describe('cleanResultContent', () => {
  it('removes the placeholder, however many times it appears', () => {
    expect(cleanResultContent(`${BLOCK} ${BLOCK} ${BLOCK} Noted, and it fits what is in your past chats.`))
      .toBe('Noted, and it fits what is in your past chats.');
  });

  it('removes the bare sentence too and leaves normal text alone', () => {
    expect(cleanResultContent('Before. This block is not supported on your current device yet. After.')).toBe('Before. After.');
    expect(cleanResultContent('K.Y.T. is my memory layer.\n\nIt uses ```code``` too.')).toBe('K.Y.T. is my memory layer.\n\nIt uses ```code``` too.');
    expect(cleanResultContent(null)).toBe('');
  });
});

describe('cleanResults', () => {
  it('drops results that were only placeholders and keeps the rest in order', () => {
    const untouched = { id: 'b', content: 'I am working on K.Y.T. right now.' };
    const out = cleanResults([
      { id: 'a', content: `${BLOCK}\n${BLOCK}` },
      untouched,
      { id: 'c', content: `${BLOCK} The codeword you gave me is falcon-88.`, platform: 'claude' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['b', 'c']);
    expect(out[0]).toBe(untouched);
    expect(out[1]).toEqual({ id: 'c', content: 'The codeword you gave me is falcon-88.', platform: 'claude' });
  });

  it('handles an empty list', () => {
    expect(cleanResults([])).toEqual([]);
  });
});

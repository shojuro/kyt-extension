import { describe, it, expect } from 'vitest';

// Test the MULTI_HOP_SIGNALS regex (extracted from get_relevant_memories.ts)
const MULTI_HOP_SIGNALS = /\b(compare|contrast|relate|connect|bridge|cross.?reference|vs\.?|versus)\b|\b(what|who|where).*\b(and|then|also)\b.*\b(what|who|where)\b|\b(from|on|in)\s+(gemini|chatgpt|claude)\b.*\b(from|on|in)\s+(gemini|chatgpt|claude)\b/i;

describe('Multi-hop signal detection', () => {
  it('detects comparison queries', () => {
    expect(MULTI_HOP_SIGNALS.test('Compare what I said about Python on Claude with JavaScript on Gemini')).toBe(true);
    expect(MULTI_HOP_SIGNALS.test('contrast my views on React vs Angular')).toBe(true);
    expect(MULTI_HOP_SIGNALS.test('Python vs JavaScript')).toBe(true);
  });

  it('detects cross-platform queries', () => {
    expect(MULTI_HOP_SIGNALS.test('What did I say on Gemini about fitness from Claude')).toBe(true);
    expect(MULTI_HOP_SIGNALS.test('on Claude versus on Gemini')).toBe(true);
  });

  it('detects compound what/who/where queries', () => {
    expect(MULTI_HOP_SIGNALS.test('what restaurant did Sarah recommend and where is it')).toBe(true);
  });

  it('does NOT trigger on simple queries', () => {
    expect(MULTI_HOP_SIGNALS.test('What is my favorite car?')).toBe(false);
    expect(MULTI_HOP_SIGNALS.test('Tell me about Walter Payton')).toBe(false);
    expect(MULTI_HOP_SIGNALS.test('How do I use Python decorators?')).toBe(false);
  });
});

// Test extractMultiplePlatforms
function extractMultiplePlatforms(message) {
  const regex = /\b(gemini|chatgpt|claude[- ]code|claude)\b/gi;
  const platforms = new Set();
  let match;
  while ((match = regex.exec(message)) !== null) {
    platforms.add(match[1].toLowerCase().replace(/\s+/g, '-'));
  }
  return platforms.size >= 2 ? Array.from(platforms) : [];
}

describe('extractMultiplePlatforms', () => {
  it('extracts 2+ platforms', () => {
    const result = extractMultiplePlatforms('Compare what I said on Claude with what I said on Gemini');
    expect(result).toContain('claude');
    expect(result).toContain('gemini');
    expect(result.length).toBe(2);
  });

  it('returns empty for single platform', () => {
    expect(extractMultiplePlatforms('What did I say on Claude?')).toEqual([]);
  });

  it('returns empty for no platform', () => {
    expect(extractMultiplePlatforms('What is my favorite movie?')).toEqual([]);
  });

  it('deduplicates repeated mentions', () => {
    const result = extractMultiplePlatforms('I said it on Claude then also on Claude and Gemini');
    expect(result.length).toBe(2);
  });
});

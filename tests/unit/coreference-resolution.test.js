import { describe, it, expect } from 'vitest';

// Test the implicit signal detection regex (extracted from get_relevant_memories.ts)
const IMPLICIT_SIGNALS = /\b(it|that|this|those|these|them|the other|above|below|same|previous|earlier|last one|the one)\b/i;
// Must match the server-side version exactly — two-part check
const HAS_NAMED_ENTITY = /(?<=[.!?\s]|^)[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)+|"[^"]+"|'[^']+'/;
const HAS_TECH_KEYWORD = /\b(?:python|javascript|typescript|rust|react|docker|gemini|chatgpt|claude)\b/i;
const HAS_ENTITIES = { test: (s) => HAS_NAMED_ENTITY.test(s) || HAS_TECH_KEYWORD.test(s) };

describe('Implicit signal detection', () => {
  it('detects pronoun references', () => {
    expect(IMPLICIT_SIGNALS.test('Can you elaborate on that?')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('Tell me more about it')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('What about the other one?')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('Expand on this')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('Continue with those ideas')).toBe(true);
  });

  it('detects temporal references', () => {
    expect(IMPLICIT_SIGNALS.test('What did we discuss earlier?')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('The previous topic was interesting')).toBe(true);
    expect(IMPLICIT_SIGNALS.test('The last one was better')).toBe(true);
  });

  it('does NOT trigger on explicit queries', () => {
    expect(IMPLICIT_SIGNALS.test('What is Python?')).toBe(false);
    expect(IMPLICIT_SIGNALS.test('How do decorators work?')).toBe(false);
  });
});

describe('Entity presence detection', () => {
  it('detects capitalized entities', () => {
    expect(HAS_ENTITIES.test('Tell me about Walter Payton')).toBe(true);
    expect(HAS_ENTITIES.test('What is Python?')).toBe(true);
  });

  it('detects quoted strings', () => {
    expect(HAS_ENTITIES.test('What about "the sound of music"?')).toBe(true);
  });

  it('returns false for vague queries', () => {
    expect(HAS_ENTITIES.test('can you elaborate on that?')).toBe(false);
    expect(HAS_ENTITIES.test('tell me more about it')).toBe(false);
  });
});

describe('Coreference trigger logic', () => {
  it('triggers when implicit signals present AND no entities', () => {
    const query = 'can you elaborate on that?';
    const shouldResolve = IMPLICIT_SIGNALS.test(query) && !HAS_ENTITIES.test(query);
    expect(shouldResolve).toBe(true);
  });

  it('does NOT trigger when entities are present', () => {
    const query = 'Tell me more about that Python framework';
    const shouldResolve = IMPLICIT_SIGNALS.test(query) && !HAS_ENTITIES.test(query);
    expect(shouldResolve).toBe(false);
  });

  it('does NOT trigger for explicit queries without implicit signals', () => {
    const query = 'How do decorators work?';
    const shouldResolve = IMPLICIT_SIGNALS.test(query) && !HAS_ENTITIES.test(query);
    expect(shouldResolve).toBe(false);
  });
});

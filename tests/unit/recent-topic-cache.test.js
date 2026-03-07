import { describe, it, expect } from 'vitest';
import { extractTopicWords } from '../../src/recent-topic-cache.js';

describe('extractTopicWords', () => {
  it('extracts significant words from user messages', () => {
    const topics = extractTopicWords('What is the best Python framework for web development?', 'user');
    expect(topics).toContain('python');
    expect(topics).toContain('framework');
    expect(topics.length).toBeLessThanOrEqual(3);
  });

  it('returns empty for assistant messages', () => {
    expect(extractTopicWords('Python is great for web development', 'assistant')).toEqual([]);
  });

  it('returns empty for null/empty content', () => {
    expect(extractTopicWords(null, 'user')).toEqual([]);
    expect(extractTopicWords('', 'user')).toEqual([]);
  });

  it('filters out stop words', () => {
    const topics = extractTopicWords('what is the thing about this', 'user');
    expect(topics).not.toContain('what');
    expect(topics).not.toContain('the');
    expect(topics).not.toContain('this');
  });

  it('deduplicates words', () => {
    const topics = extractTopicWords('python python python framework framework', 'user');
    expect(topics.filter(t => t === 'python').length).toBe(1);
  });

  it('limits to 3 topics', () => {
    const topics = extractTopicWords('walter payton football chicago bears sweetness rushing', 'user');
    expect(topics.length).toBeLessThanOrEqual(3);
  });

  it('handles short words (<=2 chars) by filtering them', () => {
    const topics = extractTopicWords('I am ok no go', 'user');
    expect(topics).toEqual([]);
  });
});

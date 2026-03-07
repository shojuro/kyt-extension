import { describe, it, expect } from 'vitest';
import { buildMemoryInjection } from '../../kyt-memory-injection-builder.js';

describe('Faceted grouping in injection builder', () => {
  const makeItem = (platform, content, timestamp) => ({
    id: `id-${platform}-${Date.now()}`,
    content,
    platform,
    timestamp: timestamp || new Date().toISOString(),
    similarity: 0.75,
  });

  it('groups by platform when queryType is SYNTHESIS and multiple platforms present', () => {
    const result = {
      state: 'FOUND',
      items: [
        makeItem('chatgpt', 'I prefer Python for web dev', '2026-03-01'),
        makeItem('gemini', 'JavaScript is better for frontend', '2026-03-02'),
        makeItem('chatgpt', 'Django is my framework of choice', '2026-03-01'),
      ],
      latencyMs: 500,
      queryType: 'SYNTHESIS',
      queryOriginal: 'Compare what I said about web frameworks on ChatGPT vs Gemini',
    };

    const injection = buildMemoryInjection(result);
    expect(injection).toContain('CHATGPT');
    expect(injection).toContain('GEMINI');
  });

  it('does NOT group when queryType is SEMANTIC (not synthesis)', () => {
    const result = {
      state: 'FOUND',
      items: [
        makeItem('chatgpt', 'I prefer Python for web dev', '2026-03-01'),
        makeItem('gemini', 'JavaScript is better for frontend', '2026-03-02'),
      ],
      latencyMs: 500,
      queryType: 'SEMANTIC',
      queryOriginal: 'What programming languages do I like?',
    };

    const injection = buildMemoryInjection(result);
    // Should NOT have platform group headers
    expect(injection).not.toMatch(/── CHATGPT ──/);
    expect(injection).not.toMatch(/── GEMINI ──/);
  });

  it('does NOT group when all items are from same platform', () => {
    const result = {
      state: 'FOUND',
      items: [
        makeItem('chatgpt', 'I prefer Python', '2026-03-01'),
        makeItem('chatgpt', 'Django is great', '2026-03-02'),
      ],
      latencyMs: 500,
      queryType: 'SYNTHESIS',
      queryOriginal: 'Compare my Python discussions',
    };

    const injection = buildMemoryInjection(result);
    // Single platform — no grouping even with SYNTHESIS type
    expect(injection).not.toMatch(/── CHATGPT ──/);
  });

  it('preserves all items when grouped', () => {
    const result = {
      state: 'FOUND',
      items: [
        makeItem('chatgpt', 'Python on ChatGPT', '2026-03-01'),
        makeItem('gemini', 'Python on Gemini', '2026-03-02'),
        makeItem('claude', 'Python on Claude', '2026-03-03'),
      ],
      latencyMs: 500,
      queryType: 'SYNTHESIS',
      queryOriginal: 'Compare across platforms',
    };

    const injection = buildMemoryInjection(result);
    expect(injection).toContain('Python on ChatGPT');
    expect(injection).toContain('Python on Gemini');
    expect(injection).toContain('Python on Claude');
    // All 3 platform headers
    expect(injection).toContain('CHATGPT');
    expect(injection).toContain('GEMINI');
    expect(injection).toContain('CLAUDE');
  });
});

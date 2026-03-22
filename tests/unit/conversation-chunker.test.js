/**
 * Unit tests for src/conversation-chunker.js
 *
 * Tests the two exported functions:
 *   - messagesToTurnChunks(messages, userId)
 *   - getChunkingStats(chunks)
 */

import { describe, it, expect } from 'vitest';
import { messagesToTurnChunks, getChunkingStats } from '../../src/conversation-chunker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides = {}) {
  return {
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello world',
    platform: 'chatgpt',
    timestamp: Date.now(),
    ...overrides,
  };
}

const USER_ID = 'user-abc';

// ---------------------------------------------------------------------------
// messagesToTurnChunks
// ---------------------------------------------------------------------------

describe('messagesToTurnChunks', () => {
  // Test 1: Single user+assistant pair → one turn chunk with both speakers
  it('single user+assistant pair produces one chunk with both speakers', () => {
    const msgs = [
      makeMsg({ role: 'user', content: 'What is AI?', timestamp: 1000 }),
      makeMsg({ role: 'assistant', content: 'AI stands for Artificial Intelligence.', timestamp: 2000 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].speakers).toContain('user');
    expect(chunks[0].speakers).toContain('assistant');
    expect(chunks[0].turn_count).toBe(1);
  });

  // Test 2: Multiple turns → correct chunk count (sliding window 5 turns, step 3)
  it('multiple turns produce correct number of chunks via sliding window', () => {
    // 9 user+assistant pairs → 3 turns → step=3 → ceil(3/3)=1 chunk
    // Use 6 pairs (6 turns) → step=3 → 2 chunks
    const msgs = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(makeMsg({ role: 'user', content: `Question ${i}`, timestamp: i * 100 }));
      msgs.push(makeMsg({ role: 'assistant', content: `Answer ${i}`, timestamp: i * 100 + 50 }));
    }

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    // 6 turns, windowSize=5, step=3 → positions 0, 3 → 2 chunks
    expect(chunks.length).toBe(2);
  });

  // Test 3: Messages grouped by conversation_id
  it('messages are grouped by conversation_id into separate chunk sets', () => {
    const msgs = [
      makeMsg({ conversationId: 'conv-A', role: 'user', content: 'Hello A', timestamp: 1 }),
      makeMsg({ conversationId: 'conv-A', role: 'assistant', content: 'Hi A', timestamp: 2 }),
      makeMsg({ conversationId: 'conv-B', role: 'user', content: 'Hello B', timestamp: 3 }),
      makeMsg({ conversationId: 'conv-B', role: 'assistant', content: 'Hi B', timestamp: 4 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    const convIds = chunks.map(c => c.conversation_id);
    expect(convIds).toContain('conv-A');
    expect(convIds).toContain('conv-B');
  });

  // Test 4: Messages sorted by timestamp within conversation
  it('messages are sorted by timestamp so earlier turns appear first in content', () => {
    const msgs = [
      makeMsg({ role: 'assistant', content: 'I am the second message', timestamp: 2000 }),
      makeMsg({ role: 'user', content: 'I am the first message', timestamp: 1000 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    // After sorting, user (ts=1000) pairs with assistant (ts=2000) into one turn
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('User: I am the first message');
    expect(chunks[0].content).toContain('Assistant: I am the second message');
    // User should appear before assistant in the content string
    const userIdx = chunks[0].content.indexOf('User:');
    const asstIdx = chunks[0].content.indexOf('Assistant:');
    expect(userIdx).toBeLessThan(asstIdx);
  });

  // Test 5: Missing conversation_id → grouped under 'unknown'
  it('messages without conversationId are grouped under "unknown"', () => {
    const msgs = [
      { role: 'user', content: 'No conv id', platform: 'chatgpt', timestamp: 1 },
      { role: 'assistant', content: 'Still no conv id', platform: 'chatgpt', timestamp: 2 },
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].conversation_id).toBe('unknown');
  });

  // Test 6: User-only message (no assistant) creates an incomplete turn
  it('user-only message (no assistant response) is handled as incomplete turn', () => {
    const msgs = [
      makeMsg({ role: 'user', content: 'Anyone there?', timestamp: 1000 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].speakers).toContain('user');
    expect(chunks[0].speakers).not.toContain('assistant');
    // Single-speaker chunk: no "User:" prefix (speakers[] carries the role)
    expect(chunks[0].content).toContain('Anyone there?');
    expect(chunks[0].content).not.toMatch(/^User:/m);
  });

  // Test 7: Empty input → empty output
  it('empty messages array returns empty chunks array', () => {
    const chunks = messagesToTurnChunks([], USER_ID);
    expect(chunks).toEqual([]);
  });

  // Test 10: Platform normalization applied (e.g. 'gpt' → 'chatgpt')
  it('platform alias "gpt" is normalized to "chatgpt"', () => {
    const msgs = [
      makeMsg({ role: 'user', content: 'Test', platform: 'gpt', timestamp: 1 }),
      makeMsg({ role: 'assistant', content: 'Response', platform: 'gpt', timestamp: 2 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].platform).toBe('chatgpt');
  });

  // Test 11: Very long messages handled (no overflow or crash)
  it('very long messages are handled without error', () => {
    const longContent = 'x'.repeat(100_000);
    const msgs = [
      makeMsg({ role: 'user', content: longContent, timestamp: 1 }),
      makeMsg({ role: 'assistant', content: longContent, timestamp: 2 }),
    ];

    expect(() => messagesToTurnChunks(msgs, USER_ID)).not.toThrow();

    const chunks = messagesToTurnChunks(msgs, USER_ID);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content.length).toBeGreaterThan(100_000);
  });

  // Test 12: Multiple conversations → separate chunk sets with correct conversation_ids
  it('multiple conversations each get their own chunks with correct conversation_ids', () => {
    const msgs = [];
    const convCount = 3;
    for (let c = 0; c < convCount; c++) {
      for (let i = 0; i < 2; i++) {
        msgs.push(makeMsg({ conversationId: `conv-${c}`, role: 'user', content: `Q${i}`, timestamp: c * 1000 + i * 10 }));
        msgs.push(makeMsg({ conversationId: `conv-${c}`, role: 'assistant', content: `A${i}`, timestamp: c * 1000 + i * 10 + 5 }));
      }
    }

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    for (let c = 0; c < convCount; c++) {
      const convChunks = chunks.filter(ch => ch.conversation_id === `conv-${c}`);
      expect(convChunks.length).toBeGreaterThan(0);
    }
  });

  // Bonus: user_id is set on each chunk
  it('user_id is propagated to every chunk', () => {
    const msgs = [
      makeMsg({ role: 'user', content: 'Hello', timestamp: 1 }),
      makeMsg({ role: 'assistant', content: 'Hi', timestamp: 2 }),
    ];

    const chunks = messagesToTurnChunks(msgs, USER_ID);

    for (const chunk of chunks) {
      expect(chunk.user_id).toBe(USER_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// getChunkingStats
// ---------------------------------------------------------------------------

describe('getChunkingStats', () => {
  // Test 8: Returns correct counts for non-empty chunks
  it('returns correct stats for non-empty chunks', () => {
    const msgs = [
      makeMsg({ role: 'user', content: 'Tell me about python and api', platform: 'claude', timestamp: 1 }),
      makeMsg({ role: 'assistant', content: 'Python is a language, api is an interface', platform: 'claude', timestamp: 2 }),
    ];
    const chunks = messagesToTurnChunks(msgs, USER_ID);

    const stats = getChunkingStats(chunks);

    expect(stats.totalChunks).toBe(chunks.length);
    expect(Number(stats.avgTurnsPerChunk)).toBeGreaterThan(0);
    expect(stats.avgContentLength).toBeGreaterThan(0);
    // 'claude' platform should be counted
    expect(stats.platformCounts['claude']).toBe(chunks.length);
    // Topics extracted from content containing 'python' and 'api'
    expect(stats.topicCounts['python']).toBeGreaterThan(0);
    expect(stats.topicCounts['api']).toBeGreaterThan(0);
  });

  // Test 9: Returns zero stats for empty input
  it('returns zero/empty stats for empty chunks array', () => {
    const stats = getChunkingStats([]);

    expect(stats.totalChunks).toBe(0);
    expect(stats.avgTurnsPerChunk).toBe(0);
    expect(stats.avgContentLength).toBe(0);
    expect(stats.platformCounts).toEqual({});
    expect(stats.topicCounts).toEqual({});
  });
});

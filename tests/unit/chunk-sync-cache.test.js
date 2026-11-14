/**
 * Synced-chunk memory (src/chunk-sync-cache.js).
 * Regression for 2026-11-14: every sync regenerated questions and embeddings
 * for every chunk of the conversation, 535 model calls in 30 minutes.
 */
import { describe, it, expect } from 'vitest';
import {
  chunkFingerprint, filterNewChunks, rememberChunks,
  chunkSyncPaused, nextChunkSyncRetry, withProjectDefaults, CHUNK_SYNC_RETRY_MS, SYNC_QUESTIONS_ENABLED,
} from '../../src/chunk-sync-cache.js';

const chunk = (start, content, conv = 'c1') => ({ platform: 'chatgpt', conversation_id: conv, start_timestamp: start, content });

describe('chunk sync cache', () => {
  it('skips chunks already synced with the same text', () => {
    const first = [chunk(1, 'alpha'), chunk(2, 'beta')];
    const known = rememberChunks([], first);
    expect(filterNewChunks([chunk(1, 'alpha'), chunk(2, 'beta'), chunk(3, 'gamma')], known).map((c) => c.content)).toEqual(['gamma']);
  });

  it('syncs a chunk again when its text changed (a reply arrived)', () => {
    const known = rememberChunks([], [chunk(1, 'question')]);
    expect(filterNewChunks([chunk(1, 'question\n\nAssistant: answer')], known)).toHaveLength(1);
  });

  it('tells conversations and platforms apart', () => {
    const known = rememberChunks([], [chunk(1, 'alpha')]);
    expect(filterNewChunks([chunk(1, 'alpha', 'c2')], known)).toHaveLength(1);
    expect(chunkFingerprint(chunk(1, 'alpha'))).not.toBe(chunkFingerprint({ ...chunk(1, 'alpha'), platform: 'claude' }));
  });

  it('treats everything as new when nothing is remembered', () => {
    expect(filterNewChunks([chunk(1, 'a')], undefined)).toHaveLength(1);
    expect(filterNewChunks(null, [])).toEqual([]);
  });

  it('keeps the newest entries within the cap and does not duplicate', () => {
    let known = [];
    for (let i = 0; i < 6; i++) known = rememberChunks(known, [chunk(i, `t${i}`)], 4);
    expect(known).toHaveLength(4);
    expect(filterNewChunks([chunk(0, 't0')], known)).toHaveLength(1);
    expect(filterNewChunks([chunk(5, 't5')], known)).toHaveLength(0);
    expect(rememberChunks(known, [chunk(5, 't5')], 4)).toHaveLength(4);
  });
});

describe('pause after a failed write', () => {
  it('pauses until the retry time and not after', () => {
    const retryAt = nextChunkSyncRetry(1000);
    expect(retryAt).toBe(1000 + CHUNK_SYNC_RETRY_MS);
    expect(chunkSyncPaused(retryAt, 2000)).toBe(true);
    expect(chunkSyncPaused(retryAt, retryAt + 1)).toBe(false);
    expect(chunkSyncPaused(undefined, 2000)).toBe(false);
  });
});

describe('withProjectDefaults', () => {
  it('fills a missing address and key and keeps stored values', () => {
    const defaults = { supabaseUrl: 'https://built-in.example', supabaseKey: 'built-in' };
    expect(withProjectDefaults({ disableQueryTransformation: true }, defaults))
      .toEqual({ disableQueryTransformation: true, supabaseUrl: 'https://built-in.example', supabaseKey: 'built-in' });
    expect(withProjectDefaults({ supabaseUrl: 'https://stored.example', supabaseKey: '' }, defaults))
      .toEqual({ supabaseUrl: 'https://stored.example', supabaseKey: 'built-in' });
    expect(withProjectDefaults(undefined, defaults)).toEqual(defaults);
  });
});

describe('question generation during sync', () => {
  it('stays off while no search function reads the questions', async () => {
    expect(SYNC_QUESTIONS_ENABLED).toBe(false);
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = 'supabase/functions';
    const readers = [];
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const path = `${d}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/search|relevant_memories|rerank/.test(path) && readFileSync(path, 'utf8').includes('hypothetical_questions')) readers.push(path);
      }
    };
    walk(dir);
    // If a search function starts reading the questions, revisit the switch.
    expect(readers).toEqual([]);
  });
});

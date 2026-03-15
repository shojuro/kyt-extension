import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithTimeout } from '../../src/utils/fetch.js';
import { normalizePlatform } from '../../src/utils/normalize-platform.js';

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the response on a successful fetch', async () => {
    vi.useFakeTimers();
    const mockResponse = { ok: true, status: 200 };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const promise = fetchWithTimeout('https://example.com', {}, 5000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(mockResponse);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('propagates fetch errors that are not AbortError', async () => {
    // Use real timers so the rejected promise settles cleanly without leaking
    vi.useRealTimers();
    const networkError = new Error('Network failure');
    global.fetch = vi.fn().mockRejectedValue(networkError);

    await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
      'Network failure'
    );
  });

  it('throws a timeout error when the request exceeds timeoutMs', async () => {
    vi.useRealTimers();
    const timeoutMs = 50; // real 50ms — fast enough for tests

    // Mock fetch to respect the AbortSignal and reject with AbortError when aborted
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      let rejectFn;
      const p = new Promise((_resolve, reject) => { rejectFn = reject; });
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          rejectFn(err);
        });
      }
      return p;
    });

    await expect(fetchWithTimeout('https://example.com', {}, timeoutMs)).rejects.toThrow(
      `API request timed out after ${timeoutMs}ms`
    );
  });

  it('clears the timeout on success (no dangling timers)', async () => {
    vi.useFakeTimers();
    const mockResponse = { ok: true, status: 200 };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const promise = fetchWithTimeout('https://example.com', {}, 5000);
    await vi.runAllTimersAsync();
    await promise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('clears the timeout on fetch error', async () => {
    // Use real timers so the rejected promise settles cleanly without leaking
    vi.useRealTimers();
    const networkError = new Error('Network failure');
    global.fetch = vi.fn().mockRejectedValue(networkError);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await expect(fetchWithTimeout('https://example.com', {}, 5000)).rejects.toThrow(
      'Network failure'
    );
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// normalizePlatform
// ---------------------------------------------------------------------------

describe('normalizePlatform', () => {
  it('passes through valid platform "chatgpt"', () => {
    expect(normalizePlatform('chatgpt')).toBe('chatgpt');
  });

  it('passes through valid platform "claude"', () => {
    expect(normalizePlatform('claude')).toBe('claude');
  });

  it('passes through valid platform "gemini"', () => {
    expect(normalizePlatform('gemini')).toBe('gemini');
  });

  it('passes through valid platform "claude-code"', () => {
    expect(normalizePlatform('claude-code')).toBe('claude-code');
  });

  it('passes through valid platform "cli"', () => {
    expect(normalizePlatform('cli')).toBe('cli');
  });

  it('maps alias "gpt" to "chatgpt"', () => {
    expect(normalizePlatform('gpt')).toBe('chatgpt');
  });

  it('maps alias "openai" to "chatgpt"', () => {
    expect(normalizePlatform('openai')).toBe('chatgpt');
  });

  it('maps alias "bard" to "gemini"', () => {
    expect(normalizePlatform('bard')).toBe('gemini');
  });

  it('maps alias "google" to "gemini"', () => {
    expect(normalizePlatform('google')).toBe('gemini');
  });

  it('maps alias "google-gemini" to "gemini"', () => {
    expect(normalizePlatform('google-gemini')).toBe('gemini');
  });

  it('returns "chatgpt" for null', () => {
    expect(normalizePlatform(null)).toBe('chatgpt');
  });

  it('returns "chatgpt" for undefined', () => {
    expect(normalizePlatform(undefined)).toBe('chatgpt');
  });

  it('returns "chatgpt" for empty string', () => {
    expect(normalizePlatform('')).toBe('chatgpt');
  });

  it('is case-insensitive: "ChatGPT" normalizes to "chatgpt"', () => {
    expect(normalizePlatform('ChatGPT')).toBe('chatgpt');
  });

  it('is case-insensitive: "CLAUDE" normalizes to "claude"', () => {
    expect(normalizePlatform('CLAUDE')).toBe('claude');
  });

  it('returns "chatgpt" for unknown string', () => {
    expect(normalizePlatform('some-unknown-platform')).toBe('chatgpt');
  });

  it('returns "chatgpt" for non-string number input', () => {
    expect(normalizePlatform(42)).toBe('chatgpt');
  });
});

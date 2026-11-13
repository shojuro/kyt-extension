/**
 * Server retry policy (supabase/functions/_shared/retry-policy.ts).
 *
 * Regression for 2026-11-13: Hugging Face answered every embedding call with
 * HTTP 402 (billing), and the wrapper retried each one 6 times with backoff,
 * about 31 s per message, while the extension timed out waiting.
 */
import { describe, it, expect, vi } from 'vitest';
import { retryWrapper, isNonRetryableError } from '../../supabase/functions/_shared/retry-policy.ts';

const fast = { maxRetries: 3, baseDelayMs: 1, timeoutMs: 1000 };

describe('retryWrapper', () => {
  it('does not retry a billing refusal (402)', async () => {
    const fn = vi.fn().mockRejectedValue(
      new Error('HF Embedding API Error: 402 - {"error":"Pay-as-you go is not enabled for provider scaleway yet."}'));
    await expect(retryWrapper(fn, fast)).rejects.toThrow('402');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 422])('does not retry a %i request error', async (status) => {
    const fn = vi.fn().mockRejectedValue(new Error(`Anthropic API Error: ${status} - bad request`));
    await expect(retryWrapper(fn, fast)).rejects.toThrow(String(status));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries rate limits and server errors, then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('HF Embedding API Error: 429 - slow down'))
      .mockRejectedValueOnce(new Error('HF Embedding API Error: 503 - unavailable'))
      .mockResolvedValue('ok');
    await expect(retryWrapper(fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('still retries errors that carry no HTTP status (timeouts, bad JSON)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to parse JSON from Anthropic response: Unexpected token'))
      .mockResolvedValue('ok');
    await expect(retryWrapper(fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('isNonRetryableError', () => {
  it('reads the status only from the "API Error: NNN" prefix, not from body text', () => {
    expect(isNonRetryableError('HF Batch Embedding API Error: 402 - x')).toBe(true);
    expect(isNonRetryableError('HF Embedding API Error: 500 - upstream said 402')).toBe(false);
    expect(isNonRetryableError('Request timeout')).toBe(false);
    expect(isNonRetryableError(undefined)).toBe(false);
  });
});

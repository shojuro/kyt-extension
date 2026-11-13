// Retry policy for upstream API calls. Pure module (no remote imports) so it can be
// unit-tested outside Deno: tests/unit/retry-policy.test.js.

/**
 * Retry wrapper with exponential backoff and timeout.
 *
 * Enhanced resilience for embedding generation:
 * - 403 (provider down): longer delay (30s) since it's likely a sustained outage
 * - 429 (rate limit): standard exponential backoff
 * - 500/503 (server error): standard exponential backoff
 * - timeout: standard exponential backoff
 * - 400/402/404/422: no retry (the request or the account is wrong, not the moment)
 */
// Request errors that will fail the same way on every attempt: bad request,
// payment required (provider billing), not found, unprocessable. 401, 403, 408
// and 429 stay retryable: they have been transient with these providers.
const NON_RETRYABLE_STATUS = new Set([400, 402, 404, 422]);

/** True when the error message carries an upstream "... API Error: NNN" status that retrying cannot fix. */
export function isNonRetryableError(message: unknown): boolean {
    if (typeof message !== 'string') return false;
    const match = message.match(/API Error: (\d{3})\b/);
    return match !== null && NON_RETRYABLE_STATUS.has(Number(match[1]));
}

export async function retryWrapper<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelayMs?: number;
        timeoutMs?: number;
    } = {}
): Promise<T> {
    const { maxRetries = 3, baseDelayMs = 1000, timeoutMs = 10000 } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Wrap with timeout
            const result = await Promise.race([
                fn(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
                )
            ]);
            return result;
        } catch (e: any) {
            if (attempt === maxRetries) throw e;
            if (isNonRetryableError(e?.message)) {
                console.error(`Not retrying (request error): ${e.message}`);
                throw e;
            }

            // 403 = provider unavailable (sustained outage) → longer backoff
            const is403 = e.message?.includes('403');
            const delay = is403
                ? 30000 // 30s for provider outages (403)
                : baseDelayMs * Math.pow(2, attempt); // standard exponential

            console.warn(`Attempt ${attempt + 1}/${maxRetries + 1} failed: ${e.message}. Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error('Unreachable');
}

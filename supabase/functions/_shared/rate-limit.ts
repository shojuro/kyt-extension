/**
 * Shared rate limiter for edge functions.
 *
 * In-memory sliding window per Deno isolate instance.
 * Supabase free tier runs single instance — acceptable.
 * At scale, move to Redis or table-based counting.
 */

import { securityHeaders } from './headers.ts';

const rateLimitMaps = new Map<string, Map<string, number[]>>();
const WINDOW_MS = 60_000;

/**
 * Check if a request is within the rate limit.
 *
 * @param namespace - Isolates rate limit counters per function (e.g. 'search_memories')
 * @param key - Usually the userId
 * @param max - Max requests per minute
 * @returns true if allowed, false if rate limited
 */
export function checkRateLimit(namespace: string, key: string, max: number): boolean {
  if (!rateLimitMaps.has(namespace)) rateLimitMaps.set(namespace, new Map());
  const map = rateLimitMaps.get(namespace)!;
  const now = Date.now();
  const timestamps = (map.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (timestamps.length >= max) {
    map.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  map.set(key, timestamps);
  return true;
}

/**
 * Standard 429 response with Retry-After header.
 */
export function rateLimitResponse(
  corsHeaders: Record<string, string>,
  retryAfterSec = 60,
): Response {
  return new Response(
    JSON.stringify({ error: 'Rate limit exceeded', retry_after: retryAfterSec }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
        ...securityHeaders(),
      },
    },
  );
}

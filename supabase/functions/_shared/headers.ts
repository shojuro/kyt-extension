/**
 * Shared security headers for all edge function responses.
 */

export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

/**
 * Standard CORS headers used by all edge functions.
 * During development, allows all origins.
 * In production, set CORS_RESTRICT=true and EXTENSION_ID env vars.
 */
export function corsHeaders(): Record<string, string> {
  const restrict = Deno.env.get('CORS_RESTRICT') === 'true';

  const origin = restrict
    ? (Deno.env.get('CORS_ALLOWED_ORIGIN') || `chrome-extension://${Deno.env.get('EXTENSION_ID') || '*'}`)
    : '*';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    ...securityHeaders(),
  };
}

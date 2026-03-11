import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/headers.ts';
import { checkRateLimit, rateLimitResponse } from '../_shared/rate-limit.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_SOURCES = new Set(['hero', 'cta', 'exit-intent']);

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  // Rate limit by IP (10 req/min)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown';

  if (!checkRateLimit('waitlist', ip, 10)) {
    return rateLimitResponse(corsHeaders());
  }

  try {
    const body = await req.json();

    // Honeypot — bots fill this hidden field; silently accept to avoid tipping off
    if (body.website) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Validate email
    const email = (body.email || '').toString().trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Validate source
    const source = (body.source || '').toString();
    if (!VALID_SOURCES.has(source)) {
      return new Response(JSON.stringify({ error: 'Invalid source' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Hash IP with daily salt for privacy
    const dailySalt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(ip + dailySalt),
    );
    const ipHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Supabase client with service role (bypasses RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Upsert — duplicate emails update source + timestamp
    const { error } = await supabase.from('waitlist_captures').upsert(
      {
        email,
        source,
        ip_hash: ipHash,
        utm_source: body.utm_source || null,
        utm_medium: body.utm_medium || null,
        utm_campaign: body.utm_campaign || null,
        utm_content: body.utm_content || null,
        utm_term: body.utm_term || null,
        referrer: body.referrer || null,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'email' },
    );

    if (error) {
      console.error('Waitlist insert error:', error);
      return new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }

    // Always return ok (prevents email enumeration)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Waitlist capture error:', err);
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
});

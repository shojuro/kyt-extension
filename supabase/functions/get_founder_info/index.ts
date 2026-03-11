/**
 * Edge Function: get_founder_info
 *
 * Token-based access to founder dashboard data.
 * POST { token } → founder info (email masked)
 * PATCH { token, wants_to_test, contact_info } → update tester fields
 * Public endpoint (no JWT) — token is the auth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/headers.ts'
import { checkRateLimit, rateLimitResponse } from '../_shared/rate-limit.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const MAX_FIELD_LEN = 256

/** Strip HTML tags and cap length (reuses waitlist_capture pattern). */
function sanitize(val: unknown): string | null {
  if (val == null) return null
  const s = String(val).replace(/<[^>]*>/g, '').trim()
  return s ? s.slice(0, MAX_FIELD_LEN) : null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }

  // Rate limit: 20 req/min per IP
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'

  if (!checkRateLimit('founder_info', ip, 20)) {
    return rateLimitResponse(corsHeaders())
  }

  try {
    const body = await req.json()
    const token = (body.token || '').toString().trim()

    if (!token) {
      return new Response(JSON.stringify({ error: 'Token required' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      })
    }

    if (req.method === 'POST') {
      // Look up founder by access token
      const { data: founder, error } = await supabase
        .from('founders')
        .select('founder_number, email, wants_to_test, created_at')
        .eq('access_token', token)
        .single()

      if (error || !founder) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 404,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        })
      }

      // Get total founders for display
      const { data: countData } = await supabase.rpc('get_founder_count')
      const totalFounders = (countData as number) || founder.founder_number

      // Mask email for display (j***@gmail.com)
      const [local, domain] = founder.email.split('@')
      const maskedEmail = local[0] + '***@' + domain

      return new Response(JSON.stringify({
        founder_number: founder.founder_number,
        total_founders: totalFounders,
        email: maskedEmail,
        wants_to_test: founder.wants_to_test,
        created_at: founder.created_at,
      }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      })
    }

    // PATCH — update tester fields
    const updates: Record<string, unknown> = {}

    if (body.wants_to_test !== undefined) {
      updates.wants_to_test = Boolean(body.wants_to_test)
    }
    if (body.contact_info !== undefined) {
      updates.contact_info = sanitize(body.contact_info)
    }

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      })
    }

    const { error: updateError, count } = await supabase
      .from('founders')
      .update(updates)
      .eq('access_token', token)

    if (updateError) {
      console.error('Founder update error:', updateError)
      throw updateError
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Founder info error:', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }
})

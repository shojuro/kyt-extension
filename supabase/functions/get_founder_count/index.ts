/**
 * Edge Function: get_founder_count
 *
 * Returns current founder count and total cap.
 * Public endpoint (no JWT) — landing page polls this.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/headers.ts'
import { checkRateLimit, rateLimitResponse } from '../_shared/rate-limit.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  // Rate limit: 30 req/min per IP
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'

  if (!checkRateLimit('founder_count', ip, 30)) {
    return rateLimitResponse(corsHeaders())
  }

  try {
    const { data, error } = await supabase.rpc('get_founder_count')

    if (error) {
      console.error('Error getting founder count:', error)
      throw error
    }

    return new Response(JSON.stringify({
      count: data as number,
      total: 200,
    }), {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    })
  } catch (err) {
    console.error('Founder count error:', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }
})

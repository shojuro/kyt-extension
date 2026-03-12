/**
 * Edge Function: create_founder_checkout
 *
 * Creates a Stripe Checkout Session for Founder's List purchase.
 * Public endpoint (no JWT) — rate limited by IP.
 * Hybrid pricing: $5 (spots 1-100), $10 (spots 101-200), cap 200.
 */

import Stripe from 'https://esm.sh/stripe@14?target=denonext'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/headers.ts'
import { checkRateLimit, rateLimitResponse } from '../_shared/rate-limit.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2025-02-24.acacia',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const PRICE_TIER_1 = 'price_1T9lKzRYAcScMJtScvDwYDxg' // $5 (spots 1-100)
const PRICE_TIER_2 = 'price_1T9lKzRYAcScMJtSQb6Tu6UT' // $10 (spots 101-200)
const FOUNDER_CAP = 200
const LANDING_URL = Deno.env.get('LANDING_PAGE_URL') || 'https://keepyourthoughts.app'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }

  // Rate limit: 5 req/min per IP (tighter than waitlist)
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'

  if (!checkRateLimit('founder_checkout', ip, 5)) {
    return rateLimitResponse(corsHeaders())
  }

  try {
    const body = await req.json()
    const email = (body.email || '').toString().trim().toLowerCase()

    // Get current founder count
    const { data: countData, error: countError } = await supabase.rpc('get_founder_count')
    if (countError) {
      console.error('Error getting founder count:', countError)
      throw countError
    }

    const count = countData as number

    if (count >= FOUNDER_CAP) {
      return new Response(JSON.stringify({
        sold_out: true,
        spots_remaining: 0,
      }), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      })
    }

    // Select price based on current count
    const selectedPriceId = count < 100 ? PRICE_TIER_1 : PRICE_TIER_2
    const priceCents = count < 100 ? 500 : 1000

    // Generate access token for founder page
    const accessToken = crypto.randomUUID()

    // Create Stripe Checkout Session
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: [{ price: selectedPriceId, quantity: 1 }],
      success_url: `${LANDING_URL}/founders.html?token=${accessToken}`,
      cancel_url: `${LANDING_URL}/?checkout=canceled`,
      metadata: {
        product: 'founder_list',
        access_token: accessToken,
      },
      payment_intent_data: {
        metadata: {
          product: 'founder_list',
          access_token: accessToken,
        },
      },
    }

    // Prefill email on Stripe form if provided
    if (email) {
      sessionParams.customer_email = email
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    return new Response(JSON.stringify({
      url: session.url,
      spots_remaining: FOUNDER_CAP - count,
      price_cents: priceCents,
    }), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Founder checkout error:', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }
})

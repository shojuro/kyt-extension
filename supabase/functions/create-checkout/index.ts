/**
 * Supabase Edge Function: create-checkout
 *
 * Purpose: Create Stripe Checkout session for subscription purchases
 * Features:
 * - Creates/retrieves Stripe customer ID
 * - Supports beta coupons (100% off forever)
 * - Returns Checkout URL for redirect
 *
 * IMPORTANT: This endpoint requires JWT auth (verify_jwt=true in config.toml)
 *
 * Request body:
 * - userId: Supabase user ID
 * - priceId: Stripe price ID (from dashboard)
 * - couponCode: Optional coupon code (e.g., BETA_VIP_2024)
 */

import Stripe from 'https://esm.sh/stripe@14?target=denonext'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { securityHeaders } from '../_shared/headers.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-11-20',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  ...securityHeaders(),
}

// Checkout redirect URLs - configure via environment or use defaults
const SUCCESS_URL = Deno.env.get('CHECKOUT_SUCCESS_URL') || 'https://keepyourthoughts.xyz/checkout/success'
const CANCEL_URL = Deno.env.get('CHECKOUT_CANCEL_URL') || 'https://keepyourthoughts.xyz/pricing'

// Tier + interval → Stripe price ID mapping
// TODO: Replace with real Stripe price IDs after creating them in dashboard
const TIER_PRICES: Record<string, Record<string, string>> = {
  pro: {
    monthly: 'price_xxx_pro_monthly',
    annual: 'price_xxx_pro_annual',
  },
  max: {
    monthly: 'price_xxx_max_monthly',
    annual: 'price_xxx_max_annual',
  },
}

function resolvePriceId(tier?: string, interval?: string, priceId?: string): string {
  // Direct priceId takes precedence (backward compat)
  if (priceId) return priceId
  if (!tier) throw new Error('Either priceId or tier is required')
  const tierPrices = TIER_PRICES[tier]
  if (!tierPrices) throw new Error(`Unknown tier: ${tier}`)
  const resolvedInterval = interval || 'monthly'
  const resolved = tierPrices[resolvedInterval]
  if (!resolved) throw new Error(`Unknown interval: ${resolvedInterval}`)
  return resolved
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { userId, priceId, tier, interval, couponCode } = await req.json()

    // Validate required fields
    if (!userId) {
      throw new Error('userId is required')
    }

    const resolvedPriceId = resolvePriceId(tier, interval, priceId)

    console.log(`Creating checkout session for user ${userId}, price ${resolvedPriceId}`)

    // Check if user already has a Stripe customer
    const { data: existingCustomer } = await supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single()

    let customerId = existingCustomer?.stripe_customer_id

    // Create Stripe customer if not exists
    if (!customerId) {
      // Get user email from Supabase auth
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId)

      if (userError) {
        console.error('Error fetching user:', userError)
        throw new Error('User not found')
      }

      const userEmail = userData.user?.email

      // Create Stripe customer
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { supabase_user_id: userId },
      })
      customerId = customer.id

      console.log(`Created Stripe customer ${customerId} for user ${userId}`)

      // Save customer mapping
      const { error: insertError } = await supabase.from('stripe_customers').insert({
        user_id: userId,
        stripe_customer_id: customerId,
        email: userEmail,
      })

      if (insertError) {
        console.error('Error saving customer mapping:', insertError)
        // Don't fail - customer was created in Stripe
      }
    }

    // Build checkout session options
    const sessionOptions: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      allow_promotion_codes: true, // Allow users to enter coupon codes at checkout
      metadata: { supabase_user_id: userId },
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
    }

    // Apply coupon if provided (for beta users)
    // Note: Can't use both discounts and allow_promotion_codes
    if (couponCode) {
      sessionOptions.discounts = [{ coupon: couponCode }]
      delete sessionOptions.allow_promotion_codes
      console.log(`Applying coupon: ${couponCode}`)
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create(sessionOptions)

    console.log(`Created checkout session ${session.id}`)

    return new Response(
      JSON.stringify({
        url: session.url,
        sessionId: session.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Checkout error:', error)

    const message = error instanceof Error ? error.message : 'Unknown error'

    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})

/**
 * Supabase Edge Function: billing-portal
 *
 * Purpose: Create Stripe Billing Portal session for subscription management
 * Features:
 * - Retrieves Stripe customer ID from database
 * - Creates billing portal session
 * - Returns portal URL for redirect
 *
 * IMPORTANT: This endpoint requires JWT auth (verify_jwt=true in config.toml)
 *
 * Request body:
 * - userId: Supabase user ID
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

// Billing portal return URL - configure via environment or use default
const RETURN_URL = Deno.env.get('BILLING_PORTAL_RETURN_URL') || 'https://kyt.memory/settings'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { userId } = await req.json()

    // Validate required fields
    if (!userId) {
      throw new Error('userId is required')
    }

    console.log(`Creating billing portal session for user ${userId}`)

    // Look up Stripe customer ID from database
    const { data: customer, error: customerError } = await supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single()

    if (customerError || !customer?.stripe_customer_id) {
      console.error('Customer lookup error:', customerError)
      throw new Error('No Stripe customer found for this user. Please subscribe first.')
    }

    // Create billing portal session
    let session: Stripe.BillingPortal.Session
    try {
      session = await stripe.billingPortal.sessions.create({
        customer: customer.stripe_customer_id,
        return_url: RETURN_URL,
      })
    } catch (stripeError) {
      console.error('Stripe API error:', stripeError)
      throw new Error('Failed to create billing portal session')
    }

    console.log(`Created billing portal session for customer ${customer.stripe_customer_id}`)

    return new Response(
      JSON.stringify({
        url: session.url,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Billing portal error:', error)

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

/**
 * Supabase Edge Function: stripe-webhook
 *
 * Purpose: Handle Stripe webhook events for subscription management
 * Features:
 * - Webhook signature verification using Web Crypto API
 * - Idempotent event processing via stripe_events table
 * - Automatic tier sync between Stripe and users table
 *
 * IMPORTANT: This endpoint has verify_jwt=false in config.toml
 * Authentication is done via Stripe webhook signature verification
 *
 * Events handled:
 * - checkout.session.completed
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.paid
 * - invoice.payment_failed
 */

import Stripe from 'https://esm.sh/stripe@14?target=denonext'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Initialize Stripe with Web Crypto provider for Deno
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2025-02-24.acacia',
})
const cryptoProvider = Stripe.createSubtleCryptoProvider()

// Initialize Supabase with service role (bypasses RLS for webhook writes)
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// Price ID to tier mapping - UPDATE with real price IDs after Stripe Dashboard setup
const PRICE_TO_TIER: Record<string, string> = {
  'price_xxx_pro_monthly': 'pro',  // TODO: Replace with real Pro monthly price ID
  'price_xxx_pro_annual': 'pro',   // TODO: Replace with real Pro annual price ID
  'price_xxx_max_monthly': 'max',  // TODO: Replace with real Max monthly price ID
  'price_xxx_max_annual': 'max',   // TODO: Replace with real Max annual price ID
}

// Founder's List price IDs (one-time purchase, not subscription)
const FOUNDER_PRICE_IDS = new Set([
  'price_1T9lKzRYAcScMJtScvDwYDxg', // $5 tier
  'price_1T9lKzRYAcScMJtSQb6Tu6UT', // $10 tier
])

function getTierFromPriceId(priceId: string): string {
  return PRICE_TO_TIER[priceId] || 'free'
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

async function handleFounderPurchase(session: Stripe.Checkout.Session) {
  const accessToken = session.metadata?.access_token
  if (!accessToken) {
    console.error('Founder purchase missing access_token in metadata')
    throw new Error('Missing access_token in session metadata')
  }

  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase()
  if (!email) {
    console.error('Founder purchase missing email')
    throw new Error('Missing email in session')
  }

  // Link to waitlist if exists
  const { data: waitlistRow } = await supabase
    .from('waitlist_captures')
    .select('id')
    .eq('email', email)
    .single()

  // Insert founder (trigger auto-assigns founder_number, enforces cap)
  const { data, error } = await supabase.from('founders').insert({
    email,
    stripe_session_id: session.id,
    stripe_customer_id: session.customer as string || null,
    price_paid_cents: session.amount_total || 0,
    access_token: accessToken,
    waitlist_id: waitlistRow?.id || null,
  }).select('founder_number').single()

  if (error) {
    // Cap exceeded (23514) or duplicate (23505) — auto-refund
    if (error.code === '23514' || error.code === '23505') {
      const paymentIntentId = session.payment_intent as string
      if (paymentIntentId) {
        try {
          await stripe.refunds.create({ payment_intent: paymentIntentId })
          console.log(`Auto-refunded founder purchase (${error.code}): ${paymentIntentId}`)
        } catch (refundErr) {
          // Log failed refund for manual recovery
          console.error(`REFUND FAILED for ${paymentIntentId}:`, refundErr)
          await supabase.from('stripe_events').upsert({
            stripe_event_id: `refund_failed_${paymentIntentId}`,
            event_type: 'refund_failed',
            data: { payment_intent: paymentIntentId, error: (refundErr as Error).message },
            status: 'failed',
          }, { onConflict: 'stripe_event_id' })
        }
      }
    }
    throw error
  }

  console.log(`Founder #${data.founder_number} registered: ${email}`)
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Intercept founder purchases before subscription logic
  if (session.metadata?.product === 'founder_list') {
    await handleFounderPurchase(session)
    return
  }

  const userId = session.metadata?.supabase_user_id
  if (!userId) {
    console.error('No supabase_user_id in session metadata')
    return
  }

  const subscriptionId = session.subscription as string
  if (!subscriptionId) {
    console.log('No subscription in session (one-time payment?)')
    return
  }

  // Fetch full subscription details with error handling
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId)
  } catch (err) {
    console.error('Stripe API error retrieving subscription:', err)
    throw err // Will mark event as failed for retry
  }

  const priceId = subscription.items.data[0]?.price.id
  const tier = getTierFromPriceId(priceId)

  console.log(`Processing checkout for user ${userId}, tier: ${tier}`)

  // Upsert subscription record
  const { error: subError } = await supabase.from('stripe_subscriptions').upsert({
    user_id: userId,
    stripe_subscription_id: subscriptionId,
    stripe_product_id: subscription.items.data[0]?.price.product as string,
    stripe_price_id: priceId,
    status: subscription.status,
    tier: tier,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
  }, { onConflict: 'stripe_subscription_id' })

  if (subError) {
    console.error('Error upserting subscription:', subError)
    throw subError
  }

  // Update user tier in public.users
  const { error: userError } = await supabase
    .from('users')
    .update({ tier })
    .eq('id', userId)

  if (userError) {
    console.error('Error updating user tier:', userError)
    // Don't throw - subscription record is more important
  }

  console.log(`User ${userId} upgraded to ${tier}`)
}

async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  // For subscriptions created outside checkout (API, dashboard)
  // Try to find user by customer metadata or existing mapping
  const { data: customerRecord } = await supabase
    .from('stripe_customers')
    .select('user_id')
    .eq('stripe_customer_id', subscription.customer as string)
    .single()

  if (!customerRecord) {
    console.log('No customer mapping found for subscription.created event')
    return
  }

  const priceId = subscription.items.data[0]?.price.id
  const tier = getTierFromPriceId(priceId)

  const { error: subError } = await supabase.from('stripe_subscriptions').upsert({
    user_id: customerRecord.user_id,
    stripe_subscription_id: subscription.id,
    stripe_product_id: subscription.items.data[0]?.price.product as string,
    stripe_price_id: priceId,
    status: subscription.status,
    tier: tier,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
  }, { onConflict: 'stripe_subscription_id' })

  if (subError) {
    console.error('Error upserting subscription:', subError)
    throw subError
  }

  // Update user tier
  await supabase.from('users').update({ tier }).eq('id', customerRecord.user_id)
  console.log(`Subscription created for user ${customerRecord.user_id}, tier: ${tier}`)
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const { data: subRecord } = await supabase
    .from('stripe_subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscription.id)
    .single()

  if (!subRecord) {
    console.log('No subscription record found for update event')
    return
  }

  const priceId = subscription.items.data[0]?.price.id
  const tier = getTierFromPriceId(priceId)

  const { error } = await supabase.from('stripe_subscriptions').update({
    status: subscription.status,
    tier: tier,
    stripe_price_id: priceId,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
  }).eq('stripe_subscription_id', subscription.id)

  if (error) {
    console.error('Error updating subscription:', error)
    throw error
  }

  // Update user tier if subscription is active
  if (subscription.status === 'active') {
    await supabase.from('users').update({ tier }).eq('id', subRecord.user_id)
  }

  console.log(`Subscription ${subscription.id} updated, status: ${subscription.status}, tier: ${tier}`)
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const { data: subRecord } = await supabase
    .from('stripe_subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscription.id)
    .single()

  if (!subRecord) {
    console.log('No subscription record found for delete event')
    return
  }

  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : new Date()

  if (periodEnd > new Date()) {
    // Grace period — mark as canceled but keep tier until period ends
    const { error } = await supabase.from('stripe_subscriptions').update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      // tier stays current until period_end
    }).eq('stripe_subscription_id', subscription.id)

    if (error) {
      console.error('Error marking subscription canceled:', error)
      throw error
    }

    console.log(`Subscription canceled but tier kept until ${periodEnd.toISOString()} for user ${subRecord.user_id}`)
  } else {
    // Period ended — downgrade now
    const { error } = await supabase.from('stripe_subscriptions').update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    }).eq('stripe_subscription_id', subscription.id)

    if (error) {
      console.error('Error marking subscription canceled:', error)
      throw error
    }

    await supabase.from('users').update({ tier: 'free' }).eq('id', subRecord.user_id)
    console.log(`User ${subRecord.user_id} downgraded to free (subscription period ended)`)
  }
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  // Subscription renewal successful - subscription.updated handles tier update
  console.log(`Invoice ${invoice.id} paid for subscription ${invoice.subscription}`)
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return

  const { data: subRecord } = await supabase
    .from('stripe_subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', invoice.subscription as string)
    .single()

  if (!subRecord) return

  // Mark subscription as past_due
  const { error } = await supabase.from('stripe_subscriptions').update({
    status: 'past_due',
  }).eq('stripe_subscription_id', invoice.subscription as string)

  if (error) {
    console.error('Error marking subscription past_due:', error)
  }

  console.log(`Payment failed for subscription ${invoice.subscription}, marked as past_due`)
  // Note: User keeps tier for now - Stripe will retry payment
  // If all retries fail, subscription.deleted event will fire
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature')
  if (!signature) {
    return new Response('Missing Stripe-Signature header', { status: 400 })
  }

  // MUST use .text() for signature verification (not .json())
  const body = await req.text()

  // 1. Verify webhook signature
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
      undefined,
      cryptoProvider
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message)
    return new Response(`Webhook Error: ${(err as Error).message}`, { status: 400 })
  }

  console.log(`Received Stripe event: ${event.type} (${event.id})`)

  // 2. Idempotency check - has this event been processed?
  const { data: existingEvent } = await supabase
    .from('stripe_events')
    .select('id, status, retry_count')
    .eq('stripe_event_id', event.id)
    .single()

  if (existingEvent?.status === 'processed') {
    console.log(`Event ${event.id} already processed, skipping`)
    return new Response(JSON.stringify({ ok: true, message: 'Already processed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Cap retries: if this event has failed 5+ times, dead-letter it (return 200 to stop Stripe retries)
  const MAX_RETRIES = 5
  if (existingEvent?.status === 'failed' && (existingEvent as any).retry_count >= MAX_RETRIES) {
    console.error(`Event ${event.id} failed ${(existingEvent as any).retry_count} times, dead-lettering`)
    await supabase.from('stripe_events').update({
      status: 'dead_letter',
      error_message: `Gave up after ${(existingEvent as any).retry_count} retries`,
    }).eq('stripe_event_id', event.id)
    return new Response(JSON.stringify({ ok: true, message: 'Dead-lettered' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 3. Mark event as processing (upsert handles retries)
  await supabase.from('stripe_events').upsert({
    stripe_event_id: event.id,
    event_type: event.type,
    data: event.data,
    status: 'processing',
  }, { onConflict: 'stripe_event_id' })

  // 4. Handle event by type
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice)
        break

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    // 5. Mark as processed
    await supabase.from('stripe_events').update({
      status: 'processed',
      processed_at: new Date().toISOString(),
    }).eq('stripe_event_id', event.id)

    console.log(`Event ${event.id} processed successfully`)

  } catch (error) {
    console.error(`Error processing event ${event.id}:`, error)

    const retryCount = ((existingEvent as any)?.retry_count ?? 0) + 1
    await supabase.from('stripe_events').update({
      status: 'failed',
      error_message: (error as Error).message,
      retry_count: retryCount,
    }).eq('stripe_event_id', event.id)

    // Return 500 so Stripe retries
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

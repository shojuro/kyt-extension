-- Stripe Integration Migration
-- Creates tables for Stripe customer mapping, subscriptions, and webhook idempotency

-- ============================================================================
-- STRIPE CUSTOMERS TABLE
-- Maps Supabase users to Stripe customer IDs
-- ============================================================================
CREATE TABLE IF NOT EXISTS stripe_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_customer_id TEXT UNIQUE NOT NULL,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT stripe_customers_user_id_unique UNIQUE (user_id)
);

-- Index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_stripe_customers_user_id ON stripe_customers(user_id);

-- ============================================================================
-- STRIPE SUBSCRIPTIONS TABLE
-- Tracks active and historical subscriptions
-- ============================================================================
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_product_id TEXT,
    stripe_price_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
    tier TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'dev')),
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_user_id ON stripe_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_status ON stripe_subscriptions(status);

-- ============================================================================
-- STRIPE EVENTS TABLE (Webhook Idempotency)
-- Prevents duplicate processing of Stripe webhook events
-- ============================================================================
CREATE TABLE IF NOT EXISTS stripe_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    data JSONB,
    processed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for idempotency lookups
CREATE INDEX IF NOT EXISTS idx_stripe_events_stripe_event_id ON stripe_events(stripe_event_id);
-- Index for monitoring failed events
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events(status) WHERE status = 'failed';

-- ============================================================================
-- ROW LEVEL SECURITY
-- Users can read their own data; service role handles all writes
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

-- stripe_customers: Users can read their own customer record
CREATE POLICY "Users can read own stripe_customers"
    ON stripe_customers
    FOR SELECT
    USING (auth.uid() = user_id);

-- stripe_subscriptions: Users can read their own subscriptions
CREATE POLICY "Users can read own stripe_subscriptions"
    ON stripe_subscriptions
    FOR SELECT
    USING (auth.uid() = user_id);

-- stripe_events: No user access (service role only for webhooks)
-- No policy = no user access, service role bypasses RLS

-- ============================================================================
-- UPDATED_AT TRIGGER
-- Auto-update updated_at timestamp on row changes
-- ============================================================================
CREATE OR REPLACE FUNCTION update_stripe_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stripe_customers_updated_at
    BEFORE UPDATE ON stripe_customers
    FOR EACH ROW
    EXECUTE FUNCTION update_stripe_updated_at();

CREATE TRIGGER stripe_subscriptions_updated_at
    BEFORE UPDATE ON stripe_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_stripe_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE stripe_customers IS 'Maps Supabase auth.users to Stripe customer IDs';
COMMENT ON TABLE stripe_subscriptions IS 'Tracks Stripe subscription status and tier mapping';
COMMENT ON TABLE stripe_events IS 'Webhook event log for idempotency - prevents duplicate processing';
COMMENT ON COLUMN stripe_subscriptions.tier IS 'KYT tier: free, pro, or dev - synced from Stripe price_id';

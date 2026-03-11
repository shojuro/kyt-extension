-- Founder's List: one-time purchase, lifetime Pro access, capped at 200
-- Hybrid pricing: $5 (spots 1-100), $10 (spots 101-200)

-- ============================================================================
-- 1. FOUNDERS TABLE
-- ============================================================================
CREATE TABLE public.founders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    founder_number INTEGER NOT NULL,
    email TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    price_paid_cents INTEGER NOT NULL,
    access_token TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    waitlist_id UUID REFERENCES public.waitlist_captures(id) ON DELETE SET NULL,
    wants_to_test BOOLEAN DEFAULT FALSE,
    contact_info TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_founders_email ON public.founders (email);
CREATE UNIQUE INDEX idx_founders_number ON public.founders (founder_number);

ALTER TABLE public.founders ENABLE ROW LEVEL SECURITY;
-- No RLS policies = service_role only (webhook writes, edge function reads)

-- ============================================================================
-- 2. ATOMIC FOUNDER COUNT HELPER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_founder_count()
RETURNS INTEGER AS $$
    SELECT COALESCE(MAX(founder_number), 0) FROM public.founders;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ============================================================================
-- 3. AUTO-ASSIGN FOUNDER NUMBER + ENFORCE CAP VIA TRIGGER
-- ============================================================================
-- Why trigger over SERIAL: SERIAL creates gaps when transactions fail
-- (sequences don't roll back). The trigger gives gap-free founder numbers
-- so "Founder #47" is always correct. UNIQUE index handles concurrency.
CREATE OR REPLACE FUNCTION assign_founder_number()
RETURNS TRIGGER AS $$
BEGIN
    SELECT COALESCE(MAX(founder_number), 0) + 1
    INTO NEW.founder_number
    FROM public.founders;

    IF NEW.founder_number > 200 THEN
        RAISE EXCEPTION 'Founder cap of 200 exceeded'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_founder_number
    BEFORE INSERT ON public.founders
    FOR EACH ROW EXECUTE FUNCTION assign_founder_number();

-- ============================================================================
-- 4. EXPAND TIER CHECK CONSTRAINTS TO INCLUDE 'founder'
-- ============================================================================
-- Drop + recreate approach handles both named and unnamed constraints.
-- Uses DO block to find actual constraint names from pg_constraint.

DO $$
DECLARE
    _con_name TEXT;
BEGIN
    -- public.users tier CHECK
    SELECT conname INTO _con_name
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tier%'
    LIMIT 1;

    IF _con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', _con_name);
    END IF;

    ALTER TABLE public.users
        ADD CONSTRAINT users_tier_check
        CHECK (tier IN ('free', 'pro', 'dev', 'founder'));

    -- public.stripe_subscriptions tier CHECK
    SELECT conname INTO _con_name
    FROM pg_constraint
    WHERE conrelid = 'public.stripe_subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tier%'
    LIMIT 1;

    IF _con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.stripe_subscriptions DROP CONSTRAINT %I', _con_name);
    END IF;

    ALTER TABLE public.stripe_subscriptions
        ADD CONSTRAINT stripe_subscriptions_tier_check
        CHECK (tier IN ('free', 'pro', 'dev', 'founder'));
END $$;

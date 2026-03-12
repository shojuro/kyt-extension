-- Waitlist email captures from landing page
CREATE TABLE IF NOT EXISTS public.waitlist_captures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('hero', 'cta', 'exit-intent')),
    ip_hash TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    referrer TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT waitlist_captures_email_key UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_source ON public.waitlist_captures (source);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON public.waitlist_captures (created_at);

-- RLS enabled, NO policies = only service_role can access
ALTER TABLE public.waitlist_captures ENABLE ROW LEVEL SECURITY;

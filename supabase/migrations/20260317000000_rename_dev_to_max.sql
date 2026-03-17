-- Rename tier 'dev' → 'max' across the system
-- Part of pricing model update: Free ($0) / Pro ($7) / Max ($15)

BEGIN;

-- 1. Update existing profiles from dev → max
UPDATE profiles SET tier = 'max' WHERE tier = 'dev';

-- 2. Update CHECK constraint on profiles.tier
--    Drop old constraint, add new one with 'max' replacing 'dev'
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tier_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_tier_check
  CHECK (tier IN ('free', 'pro', 'founder', 'max'));

-- 3. Update stripe_subscriptions tier column if it has a CHECK
ALTER TABLE stripe_subscriptions DROP CONSTRAINT IF EXISTS stripe_subscriptions_tier_check;
ALTER TABLE stripe_subscriptions ADD CONSTRAINT stripe_subscriptions_tier_check
  CHECK (tier IN ('free', 'pro', 'founder', 'max'));

-- 4. Update users table tier if it has a CHECK
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check
  CHECK (tier IN ('free', 'pro', 'founder', 'max'));

-- 5. Migrate any users table rows
UPDATE users SET tier = 'max' WHERE tier = 'dev';

-- 6. Migrate any stripe_subscriptions rows
UPDATE stripe_subscriptions SET tier = 'max' WHERE tier = 'dev';

COMMIT;

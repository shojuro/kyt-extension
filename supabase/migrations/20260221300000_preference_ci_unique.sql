-- Case-insensitive UNIQUE constraint on user_preferences
--
-- Problem: entity extractor may produce "Car" and "car" as separate categories.
-- The existing unique_user_pref constraint (user_id, category, value) is
-- case-sensitive, so both rows get inserted. lookup_user_preferences then
-- returns duplicate logical preferences.
--
-- Fix: Replace with a unique index on LOWER(category), LOWER(value).

-- Drop the old case-sensitive constraint
ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS unique_user_pref;

-- Before creating the CI index, deduplicate existing rows.
-- Keep the row with the latest updated_at for each (user_id, lower(category), lower(value)).
DELETE FROM user_preferences a
USING user_preferences b
WHERE a.user_id = b.user_id
  AND LOWER(a.category) = LOWER(b.category)
  AND LOWER(a.value) = LOWER(b.value)
  AND a.updated_at < b.updated_at;

-- Also handle exact ties on updated_at: keep the one with the smaller id
DELETE FROM user_preferences a
USING user_preferences b
WHERE a.user_id = b.user_id
  AND LOWER(a.category) = LOWER(b.category)
  AND LOWER(a.value) = LOWER(b.value)
  AND a.updated_at = b.updated_at
  AND a.id > b.id;

-- Case-insensitive unique index
CREATE UNIQUE INDEX unique_user_pref_ci
  ON user_preferences (user_id, LOWER(category), LOWER(value));

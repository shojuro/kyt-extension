-- Migration: Add missing profile_id indexes for entity_mentions, user_preferences, messages
--
-- These tables had profile_id columns added (20260226100000) but were not indexed.
-- Low priority (small tables, not queried directly by profile_id in current code)
-- but included for forward-compatibility with multi-profile search.

CREATE INDEX IF NOT EXISTS idx_entity_mentions_profile_id ON entity_mentions(profile_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_profile_id ON user_preferences(profile_id);
CREATE INDEX IF NOT EXISTS idx_messages_profile_id ON messages(profile_id);

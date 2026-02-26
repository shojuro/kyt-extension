-- Migration: Add profile_id columns to 6 tables
-- Phase 0 deployed profiles table has id = auth.users.id (1:1)
-- For MVP: profile_id = user_id everywhere. Future multi-profile adds junction table.
-- Columns are NULLABLE for backward compatibility (orphan rows keep NULL profile_id).

ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS profile_id UUID;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS profile_id UUID;
ALTER TABLE entity_mentions ADD COLUMN IF NOT EXISTS profile_id UUID;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS profile_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS profile_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile_id UUID;

-- Backfill: profile_id = user_id (valid because profiles.id = auth.users.id)
UPDATE chat_turns SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);
UPDATE entities SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);
UPDATE entity_mentions SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);
UPDATE user_preferences SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);
UPDATE messages SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);
UPDATE conversations SET profile_id = user_id WHERE profile_id IS NULL AND user_id IN (SELECT id FROM profiles);

-- FK constraints (nullable — orphan rows keep NULL profile_id)
-- profiles PK is "id" which references auth.users(id)
ALTER TABLE chat_turns ADD CONSTRAINT fk_chat_turns_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);
ALTER TABLE entities ADD CONSTRAINT fk_entities_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);
ALTER TABLE entity_mentions ADD CONSTRAINT fk_entity_mentions_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);
ALTER TABLE user_preferences ADD CONSTRAINT fk_user_preferences_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);
ALTER TABLE messages ADD CONSTRAINT fk_messages_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);
ALTER TABLE conversations ADD CONSTRAINT fk_conversations_profile FOREIGN KEY (profile_id) REFERENCES profiles(id);

-- Indexes for filter performance
CREATE INDEX IF NOT EXISTS idx_chat_turns_profile_id ON chat_turns(profile_id);
CREATE INDEX IF NOT EXISTS idx_entities_profile_id ON entities(profile_id);
CREATE INDEX IF NOT EXISTS idx_conversations_profile_id ON conversations(profile_id);

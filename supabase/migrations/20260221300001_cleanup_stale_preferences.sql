-- Clean up stale preference rows superseded by temporal dedup
--
-- After the temporal supersession fix (20260221200001), lookup_user_preferences
-- returns only the newest row per (category, sentiment). But old rows still
-- exist in the table, wasting storage and confusing admin queries.
--
-- This migration physically removes rows that would be hidden by DISTINCT ON.
-- Keeps only the newest updated_at per (user_id, category, sentiment).

DELETE FROM user_preferences
WHERE id NOT IN (
    SELECT DISTINCT ON (user_id, category, sentiment) id
    FROM user_preferences
    ORDER BY user_id, category, sentiment, updated_at DESC
);

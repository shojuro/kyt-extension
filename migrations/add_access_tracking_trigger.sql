-- Migration: Add access tracking function for rehearsal effect
-- Purpose: Enable automatic tracking when memories are explicitly marked as accessed
-- Note: This is NOT an automatic trigger - access tracking is handled by
--       match_messages_with_gravity_and_update() function for controlled updates
-- Author: SQL Engineer (Temporal Decay Feature - Worktree 1)
-- Date: 2025-11-24

-- Function: update_memory_access
-- Purpose: Manually callable function to increment access tracking
-- Usage: Called explicitly when memory retrieval happens (not automatic)
CREATE OR REPLACE FUNCTION update_memory_access(p_memory_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE chat_turns
  SET
    access_count = COALESCE(access_count, 0) + 1,
    last_accessed = NOW()
  WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_memory_access IS
  'Increments access_count and updates last_accessed for a specific memory. '
  'Call this when a memory is retrieved to implement rehearsal effect. '
  'NOT an automatic trigger - must be called explicitly.';

-- Batch update function for multiple memories
CREATE OR REPLACE FUNCTION update_memory_access_batch(p_memory_ids UUID[])
RETURNS INT AS $$
DECLARE
  v_updated_count INT;
BEGIN
  UPDATE chat_turns
  SET
    access_count = COALESCE(access_count, 0) + 1,
    last_accessed = NOW()
  WHERE id = ANY(p_memory_ids);

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_memory_access_batch IS
  'Batch version of update_memory_access for efficient bulk updates. '
  'Returns the number of rows updated.';

-- Optional: Create a view for recently accessed memories
CREATE OR REPLACE VIEW recently_accessed_memories AS
SELECT
  id,
  content,
  speakers,
  topics,
  impact_score,
  intimacy_level,
  access_count,
  last_accessed,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 3600.0 AS hours_since_access
FROM chat_turns
WHERE last_accessed IS NOT NULL
  AND last_accessed > NOW() - INTERVAL '7 days'
ORDER BY last_accessed DESC;

COMMENT ON VIEW recently_accessed_memories IS
  'View of memories accessed within the last 7 days. '
  'Useful for analyzing rehearsal patterns and frequently retrieved content.';

-- Optional: Function to identify "anchored" memories
-- (High-access memories that resist decay through rehearsal)
CREATE OR REPLACE FUNCTION find_anchored_memories(
  p_user_id UUID,
  min_access_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  impact_score INT,
  intimacy_level INT,
  access_count INT,
  last_accessed TIMESTAMPTZ,
  days_old FLOAT,
  gravity_score FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.id,
    ct.content,
    ct.impact_score,
    ct.intimacy_level,
    ct.access_count,
    ct.last_accessed,
    EXTRACT(EPOCH FROM (NOW() - ct.created_at)) / 86400.0 AS days_old,
    ct.gravity_score
  FROM chat_turns ct
  WHERE
    ct.user_id = p_user_id
    AND ct.access_count >= min_access_count
  ORDER BY ct.access_count DESC, ct.gravity_score DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION find_anchored_memories IS
  'Finds memories with high rehearsal (frequently accessed). '
  'These "anchored" memories resist decay and remain highly available.';

-- Verification
DO $$
BEGIN
  RAISE NOTICE 'Access tracking migration successful';
  RAISE NOTICE 'Available functions:';
  RAISE NOTICE '  - update_memory_access(memory_id): Update single memory';
  RAISE NOTICE '  - update_memory_access_batch(memory_ids[]): Update multiple memories';
  RAISE NOTICE '  - find_anchored_memories(user_id, min_access): Find frequently accessed memories';
  RAISE NOTICE 'Available views:';
  RAISE NOTICE '  - recently_accessed_memories: Last 7 days of accessed memories';
END $$;

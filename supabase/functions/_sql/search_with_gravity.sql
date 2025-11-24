-- Function: match_messages_with_gravity
-- Purpose: Vector similarity search with gravity-based ranking
-- Replaces: Standard time-decay ranking with salience-aware semantic decay
-- Author: SQL Engineer (Temporal Decay Feature - Worktree 1)
-- Date: 2025-11-24

CREATE OR REPLACE FUNCTION match_messages_with_gravity(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  turn_range TEXT,
  conversation_id TEXT,
  speakers TEXT[],
  topics TEXT[],
  created_at TIMESTAMPTZ,
  vector_similarity FLOAT,
  gravity_score FLOAT,
  impact_score INT,
  intimacy_level INT,
  access_count INT,
  last_accessed TIMESTAMPTZ
) AS $$
BEGIN
  -- Input validation
  IF match_threshold < 0 OR match_threshold > 1 THEN
    RAISE EXCEPTION 'match_threshold must be between 0 and 1, got %', match_threshold;
  END IF;

  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100, got %', match_count;
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for security (RLS enforcement)';
  END IF;

  RETURN QUERY
  SELECT
    ct.id,
    ct.content,
    ct.turn_range,
    ct.conversation_id,
    ct.speakers,
    ct.topics,
    ct.created_at,
    -- Vector similarity (cosine distance: 1 - distance)
    (1 - (ct.embedding <=> query_embedding)) AS vector_similarity,
    -- Gravity score (salience-based ranking)
    calculate_gravity_score(
      1 - (ct.embedding <=> query_embedding),
      COALESCE(ct.impact_score, 0),
      COALESCE(ct.intimacy_level, 0),
      ct.created_at,
      COALESCE(ct.last_accessed, ct.created_at),
      COALESCE(ct.access_count, 0)
    ) AS gravity_score,
    ct.impact_score,
    ct.intimacy_level,
    ct.access_count,
    ct.last_accessed
  FROM chat_turns ct
  WHERE
    -- Security: User isolation via RLS
    ct.user_id = p_user_id
    -- Similarity threshold
    AND (1 - (ct.embedding <=> query_embedding)) > match_threshold
    -- Temporal exclusion: Avoid returning very recent context
    AND ct.created_at < NOW() - (exclude_recent_seconds || ' seconds')::INTERVAL
  ORDER BY
    -- Primary sort: Gravity score (salience-aware relevance)
    gravity_score DESC NULLS LAST
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Add function comment
COMMENT ON FUNCTION match_messages_with_gravity IS
  'Vector similarity search with gravity-based ranking. '
  'High-impact memories persist longer through logarithmic decay. '
  'Returns top-k results sorted by semantic gravity score.';

-- Create alternative function: match_messages_with_gravity_and_update
-- Purpose: Retrieve memories AND update access tracking for rehearsal effect
CREATE OR REPLACE FUNCTION match_messages_with_gravity_and_update(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  exclude_recent_seconds int DEFAULT 120,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  turn_range TEXT,
  conversation_id TEXT,
  speakers TEXT[],
  topics TEXT[],
  created_at TIMESTAMPTZ,
  vector_similarity FLOAT,
  gravity_score FLOAT,
  impact_score INT,
  intimacy_level INT,
  access_count INT,
  last_accessed TIMESTAMPTZ
) AS $$
DECLARE
  v_result RECORD;
  v_matched_ids UUID[];
BEGIN
  -- First, get matching results (using read-only function)
  FOR v_result IN
    SELECT * FROM match_messages_with_gravity(
      query_embedding,
      match_threshold,
      match_count,
      exclude_recent_seconds,
      p_user_id
    )
  LOOP
    -- Collect IDs for batch update
    v_matched_ids := array_append(v_matched_ids, v_result.id);

    -- Return this row
    id := v_result.id;
    content := v_result.content;
    turn_range := v_result.turn_range;
    conversation_id := v_result.conversation_id;
    speakers := v_result.speakers;
    topics := v_result.topics;
    created_at := v_result.created_at;
    vector_similarity := v_result.vector_similarity;
    gravity_score := v_result.gravity_score;
    impact_score := v_result.impact_score;
    intimacy_level := v_result.intimacy_level;
    access_count := v_result.access_count;
    last_accessed := v_result.last_accessed;

    RETURN NEXT;
  END LOOP;

  -- Batch update: Increment access_count and update last_accessed
  -- This implements the "rehearsal effect" - retrieved memories get stronger
  UPDATE chat_turns
  SET
    access_count = COALESCE(access_count, 0) + 1,
    last_accessed = NOW()
  WHERE id = ANY(v_matched_ids);

  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Add function comment
COMMENT ON FUNCTION match_messages_with_gravity_and_update IS
  'Vector similarity search with gravity ranking AND rehearsal tracking. '
  'Updates access_count and last_accessed for retrieved memories. '
  'Use this for actual retrieval; use match_messages_with_gravity for read-only queries.';

-- Performance analysis function
CREATE OR REPLACE FUNCTION analyze_gravity_distribution(p_user_id UUID)
RETURNS TABLE (
  impact_range TEXT,
  intimacy_range TEXT,
  memory_count BIGINT,
  avg_gravity_score FLOAT,
  avg_access_count FLOAT,
  avg_age_days FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    CASE
      WHEN ct.impact_score >= 75 THEN 'High Impact (75-100)'
      WHEN ct.impact_score >= 50 THEN 'Medium Impact (50-74)'
      WHEN ct.impact_score >= 25 THEN 'Low Impact (25-49)'
      ELSE 'Minimal Impact (0-24)'
    END AS impact_range,
    CASE
      WHEN ct.intimacy_level = 3 THEN 'Core Identity (3)'
      WHEN ct.intimacy_level = 2 THEN 'Personal Feelings (2)'
      WHEN ct.intimacy_level = 1 THEN 'Personal Facts (1)'
      ELSE 'Surface (0)'
    END AS intimacy_range,
    COUNT(*) AS memory_count,
    AVG(ct.gravity_score) AS avg_gravity_score,
    AVG(ct.access_count) AS avg_access_count,
    AVG(EXTRACT(EPOCH FROM (NOW() - ct.created_at)) / 86400.0) AS avg_age_days
  FROM chat_turns ct
  WHERE ct.user_id = p_user_id
  GROUP BY impact_range, intimacy_range
  ORDER BY
    MIN(ct.impact_score) DESC,
    MIN(ct.intimacy_level) DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Add function comment
COMMENT ON FUNCTION analyze_gravity_distribution IS
  'Diagnostic function to analyze gravity score distribution across impact/intimacy categories. '
  'Useful for validating decay behavior and identifying memory patterns.';

-- Test the search function (placeholder - requires actual data)
DO $$
BEGIN
  RAISE NOTICE 'Search function created successfully';
  RAISE NOTICE 'To test, use: SELECT * FROM match_messages_with_gravity(<embedding>, 0.7, 10, 120, <user_id>)';
  RAISE NOTICE 'To enable rehearsal effect, use: match_messages_with_gravity_and_update()';
END $$;

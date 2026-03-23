-- Function: calculate_gravity_score
-- Purpose: Compute salience-based relevance score for memory retrieval
-- Formula: vector_similarity × importance_multiplier × time_decay × rehearsal_bonus
-- Author: SQL Engineer (Temporal Decay Feature - Worktree 1)
-- Date: 2025-11-24

CREATE OR REPLACE FUNCTION calculate_gravity_score(
  p_vector_similarity FLOAT,
  p_impact_score INT,
  p_intimacy_level INT,
  p_created_at TIMESTAMPTZ,
  p_last_accessed TIMESTAMPTZ,
  p_access_count INT,
  p_valence FLOAT DEFAULT NULL,
  p_arousal FLOAT DEFAULT NULL
) RETURNS FLOAT AS $$
DECLARE
  v_importance_multiplier FLOAT;
  v_emotional_intensity FLOAT;
  v_time_decay FLOAT;
  v_rehearsal_bonus FLOAT;
  v_days_since_creation FLOAT;
  v_days_since_access FLOAT;
  v_gravity_score FLOAT;
BEGIN
  -- Input validation
  IF p_vector_similarity IS NULL OR p_vector_similarity < 0 OR p_vector_similarity > 1 THEN
    RAISE EXCEPTION 'Invalid vector_similarity: must be between 0 and 1, got %', p_vector_similarity;
  END IF;

  IF p_impact_score < 0 OR p_impact_score > 100 THEN
    RAISE EXCEPTION 'Invalid impact_score: must be between 0 and 100, got %', p_impact_score;
  END IF;

  IF p_intimacy_level < 0 OR p_intimacy_level > 3 THEN
    RAISE EXCEPTION 'Invalid intimacy_level: must be between 0 and 3, got %', p_intimacy_level;
  END IF;

  -- Calculate time deltas (in days)
  v_days_since_creation := EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 86400.0;
  v_days_since_access := EXTRACT(EPOCH FROM (NOW() - p_last_accessed)) / 86400.0;

  -- Component 1: Importance Multiplier
  -- Formula: 1 + (impact/100) + (intimacy × 0.2) + emotional_intensity
  -- Range: [1.0, 3.0] (was [1.0, 2.6] before emotional_intensity)
  --   - Baseline: 1.0 (all memories start equal)
  --   - Impact: +0.0 to +1.0 (Holmes-Rahe scale contribution)
  --   - Intimacy: +0.0 to +0.6 (Aron's 36 Questions contribution)
  --   - Emotional intensity: +0.0 to +0.4 (Russell's Circumplex: |valence| × arousal)

  -- Emotional intensity: high |valence| × high arousal = emotionally charged content
  -- Range: [0, 0.4] — enough to shift decay tier but not dominate
  -- NULL-safe: existing rows without valence/arousal get 0 boost
  v_emotional_intensity := COALESCE(ABS(p_valence) * COALESCE(p_arousal, 0.5), 0) * 0.4;

  v_importance_multiplier := 1.0 +
    (p_impact_score::FLOAT / 100.0) +
    (p_intimacy_level::FLOAT * 0.2) +
    v_emotional_intensity;

  -- Component 2: Adaptive Time Decay
  -- Strategy: High-importance memories decay slower, low-importance decay faster

  IF v_importance_multiplier > 1.5 THEN
    -- HIGH IMPORTANCE (>1.5): Logarithmic decay
    -- Formula: 1 / (1 + ln(1 + days/30))
    -- Behavior: Fades slowly, asymptotically approaches 0 but never reaches it
    -- Example: After 1 year, high-impact memory retains ~20% strength
    v_time_decay := 1.0 / (1.0 + LN(1.0 + v_days_since_access / 30.0));

  ELSIF v_importance_multiplier < 1.2 THEN
    -- LOW IMPORTANCE (<1.2): Exponential decay
    -- Formula: e^(-days/30)
    -- Behavior: Fades quickly after 30 days
    -- Example: After 60 days, low-impact memory retains ~13.5% strength
    v_time_decay := EXP(-v_days_since_access / 30.0);

  ELSE
    -- MEDIUM IMPORTANCE (1.2-1.5): Linear interpolation between strategies
    -- Formula: 1 / (1 + days/60)
    -- Behavior: Moderate fade, balanced between log and exp
    -- Example: After 60 days, medium-impact memory retains ~50% strength
    v_time_decay := 1.0 / (1.0 + v_days_since_access / 60.0);
  END IF;

  -- Component 3: Rehearsal Bonus
  -- Formula: 1 + (access_count × 0.05), capped at 1.5x
  -- Behavior: Each retrieval strengthens memory by 5%, up to 50% boost
  -- Rationale: Mimics human memory consolidation through repetition
  v_rehearsal_bonus := LEAST(1.0 + (p_access_count::FLOAT * 0.05), 1.5);

  -- Final Gravity Score
  -- Range: [0.0, ~4.5]
  --   - 0.0: Completely irrelevant (vector_similarity = 0)
  --   - ~4.5: Max theoretical (similarity=1.0, importance=3.0, decay=1.0, rehearsal=1.5)
  --   - Typical: 0.5-2.5 for most memories
  v_gravity_score := p_vector_similarity *
                     v_importance_multiplier *
                     v_time_decay *
                     v_rehearsal_bonus;

  RETURN v_gravity_score;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Add function comment for documentation
COMMENT ON FUNCTION calculate_gravity_score IS
  'Calculates semantic gravity score using adaptive time decay based on memory salience. '
  'High-importance memories (weddings, loss) decay logarithmically and persist longer. '
  'Low-importance memories (daily chit-chat) decay exponentially and fade quickly.';

-- Test the function with sample data
DO $$
DECLARE
  v_test_score FLOAT;
BEGIN
  -- Test Case 1: High-impact, high-intimacy memory after 365 days
  -- Expected: High gravity score due to logarithmic decay
  v_test_score := calculate_gravity_score(
    0.9,  -- 90% vector similarity
    95,   -- High impact (e.g., "death of loved one")
    3,    -- Deep intimacy
    NOW() - INTERVAL '365 days',
    NOW() - INTERVAL '365 days',
    0     -- Never accessed
  );
  RAISE NOTICE 'Test 1 (High impact, old): Gravity Score = %', v_test_score;
  IF v_test_score < 1.0 THEN
    RAISE EXCEPTION 'Test 1 FAILED: High-impact memory should retain >1.0 gravity after 1 year';
  END IF;

  -- Test Case 2: Low-impact, surface-level memory after 60 days
  -- Expected: Low gravity score due to exponential decay
  v_test_score := calculate_gravity_score(
    0.8,  -- 80% vector similarity
    5,    -- Low impact (e.g., "weather chat")
    0,    -- Surface intimacy
    NOW() - INTERVAL '60 days',
    NOW() - INTERVAL '60 days',
    0     -- Never accessed
  );
  RAISE NOTICE 'Test 2 (Low impact, old): Gravity Score = %', v_test_score;
  IF v_test_score > 0.2 THEN
    RAISE EXCEPTION 'Test 2 FAILED: Low-impact memory should have <0.2 gravity after 60 days';
  END IF;

  -- Test Case 3: Medium-impact memory with high rehearsal
  -- Expected: Boosted score due to 10 accesses (1.5x multiplier)
  v_test_score := calculate_gravity_score(
    0.85,  -- 85% vector similarity
    50,    -- Medium impact
    1,     -- Personal facts
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '1 day',  -- Recently accessed
    10     -- High rehearsal
  );
  RAISE NOTICE 'Test 3 (Medium impact, high rehearsal): Gravity Score = %', v_test_score;
  IF v_test_score < 1.5 THEN
    RAISE EXCEPTION 'Test 3 FAILED: High-rehearsal memory should have >1.5 gravity';
  END IF;

  RAISE NOTICE 'All gravity score tests PASSED';
END $$;

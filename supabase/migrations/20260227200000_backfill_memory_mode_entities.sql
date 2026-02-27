-- Backfill memory mode entities for graph walk completeness
-- Problem: Only "incognito_mode" exists as an entity. "full memory" and "clean room"
-- modes are missing, so graph walk from "3 levels" → "modes" has no path.
--
-- This migration:
-- 1. Inserts 2 missing mode entities (full_memory_mode, clean_room_mode)
-- 2. Creates bidirectional entity_relationships between all 3 modes
-- 3. Creates entity_mentions from chat_turns content matching these modes

-- Step 1: Find the existing incognito mode entity
-- (canonical_name may be incognito_mode_discussed or similar)
DO $$
DECLARE
  v_user_id UUID := '0499c405-3bff-4901-bc94-d5d0a0c301e4';
  v_incognito_id UUID;
  v_full_id UUID;
  v_clean_id UUID;
  v_turn RECORD;
BEGIN
  -- Look up existing incognito entity
  SELECT id INTO v_incognito_id
  FROM entities
  WHERE user_id = v_user_id
    AND (canonical_name ILIKE '%incognito%mode%' OR entity_text ILIKE '%incognito%mode%')
    AND entity_type = 'TECH'
  LIMIT 1;

  IF v_incognito_id IS NULL THEN
    RAISE NOTICE 'No existing incognito mode entity found — creating all 3 mode entities';

    INSERT INTO entities (user_id, entity_text, normalized_name, canonical_name, display_name,
                          entity_type, relationship, context_category, mention_count, first_seen, last_seen)
    VALUES (v_user_id, 'incognito mode', 'incognito_mode', 'incognito_mode_discussed',
            'Incognito Mode', 'TECH', 'discussed', 'product', 1, NOW(), NOW())
    RETURNING id INTO v_incognito_id;
  END IF;

  -- Insert full memory mode (skip if already exists)
  INSERT INTO entities (user_id, entity_text, normalized_name, canonical_name, display_name,
                        entity_type, relationship, context_category, mention_count, first_seen, last_seen)
  VALUES (v_user_id, 'full memory mode', 'full_memory_mode', 'full_memory_mode_discussed',
          'Full Memory Mode', 'TECH', 'discussed', 'product', 1, NOW(), NOW())
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_full_id;

  -- If it already existed, look it up
  IF v_full_id IS NULL THEN
    SELECT id INTO v_full_id FROM entities
    WHERE user_id = v_user_id AND canonical_name = 'full_memory_mode_discussed';
  END IF;

  -- Insert clean room mode (skip if already exists)
  INSERT INTO entities (user_id, entity_text, normalized_name, canonical_name, display_name,
                        entity_type, relationship, context_category, mention_count, first_seen, last_seen)
  VALUES (v_user_id, 'clean room mode', 'clean_room_mode', 'clean_room_mode_discussed',
          'Clean Room Mode', 'TECH', 'discussed', 'product', 1, NOW(), NOW())
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_clean_id;

  IF v_clean_id IS NULL THEN
    SELECT id INTO v_clean_id FROM entities
    WHERE user_id = v_user_id AND canonical_name = 'clean_room_mode_discussed';
  END IF;

  -- Step 2: Create bidirectional entity_relationships between all 3 modes
  -- Uses upsert_entity_relationship RPC pattern (manual here since we're in plpgsql)
  IF v_incognito_id IS NOT NULL AND v_full_id IS NOT NULL THEN
    INSERT INTO entity_relationships (user_id, entity_a_id, entity_b_id, co_occurrence_count)
    VALUES (v_user_id, LEAST(v_incognito_id, v_full_id), GREATEST(v_incognito_id, v_full_id), 1)
    ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
      co_occurrence_count = entity_relationships.co_occurrence_count + 1,
      last_seen = NOW();
  END IF;

  IF v_incognito_id IS NOT NULL AND v_clean_id IS NOT NULL THEN
    INSERT INTO entity_relationships (user_id, entity_a_id, entity_b_id, co_occurrence_count)
    VALUES (v_user_id, LEAST(v_incognito_id, v_clean_id), GREATEST(v_incognito_id, v_clean_id), 1)
    ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
      co_occurrence_count = entity_relationships.co_occurrence_count + 1,
      last_seen = NOW();
  END IF;

  IF v_full_id IS NOT NULL AND v_clean_id IS NOT NULL THEN
    INSERT INTO entity_relationships (user_id, entity_a_id, entity_b_id, co_occurrence_count)
    VALUES (v_user_id, LEAST(v_full_id, v_clean_id), GREATEST(v_full_id, v_clean_id), 1)
    ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
      co_occurrence_count = entity_relationships.co_occurrence_count + 1,
      last_seen = NOW();
  END IF;

  -- Step 3: Create entity_mentions from chat_turns that discuss these modes
  -- Full memory mode mentions
  IF v_full_id IS NOT NULL THEN
    FOR v_turn IN
      SELECT id, conversation_id, created_at
      FROM chat_turns
      WHERE user_id = v_user_id
        AND (content ILIKE '%full memory%' OR content ILIKE '%full mode%')
        AND speakers @> ARRAY['user']
      LIMIT 10
    LOOP
      INSERT INTO entity_mentions (entity_id, conversation_id, chat_turn_id, mention_text, timestamp)
      VALUES (v_full_id, v_turn.conversation_id, v_turn.id, 'full memory mode', v_turn.created_at)
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- Update mention_count
    UPDATE entities SET mention_count = (
      SELECT COUNT(*) FROM entity_mentions WHERE entity_id = v_full_id
    ) WHERE id = v_full_id;
  END IF;

  -- Clean room mode mentions
  IF v_clean_id IS NOT NULL THEN
    FOR v_turn IN
      SELECT id, conversation_id, created_at
      FROM chat_turns
      WHERE user_id = v_user_id
        AND (content ILIKE '%clean room%' OR content ILIKE '%clean_room%')
        AND speakers @> ARRAY['user']
      LIMIT 10
    LOOP
      INSERT INTO entity_mentions (entity_id, conversation_id, chat_turn_id, mention_text, timestamp)
      VALUES (v_clean_id, v_turn.conversation_id, v_turn.id, 'clean room mode', v_turn.created_at)
      ON CONFLICT DO NOTHING;
    END LOOP;

    UPDATE entities SET mention_count = (
      SELECT COUNT(*) FROM entity_mentions WHERE entity_id = v_clean_id
    ) WHERE id = v_clean_id;
  END IF;

  -- Incognito mode mentions (backfill any missing)
  IF v_incognito_id IS NOT NULL THEN
    FOR v_turn IN
      SELECT id, conversation_id, created_at
      FROM chat_turns
      WHERE user_id = v_user_id
        AND content ILIKE '%incognito%'
        AND speakers @> ARRAY['user']
        AND id NOT IN (SELECT chat_turn_id FROM entity_mentions WHERE entity_id = v_incognito_id)
      LIMIT 10
    LOOP
      INSERT INTO entity_mentions (entity_id, conversation_id, chat_turn_id, mention_text, timestamp)
      VALUES (v_incognito_id, v_turn.conversation_id, v_turn.id, 'incognito mode', v_turn.created_at)
      ON CONFLICT DO NOTHING;
    END LOOP;

    UPDATE entities SET mention_count = (
      SELECT COUNT(*) FROM entity_mentions WHERE entity_id = v_incognito_id
    ) WHERE id = v_incognito_id;
  END IF;

  RAISE NOTICE 'Memory mode entities backfill complete. IDs: incognito=%, full=%, clean=%',
    v_incognito_id, v_full_id, v_clean_id;
END $$;

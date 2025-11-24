-- ============================================
-- ENTITY MEMORY RLS POLICY TESTS
-- ============================================
-- Purpose: Verify Row Level Security policies work correctly
-- Date: 2025-11-25
--
-- TESTING METHODOLOGY:
-- 1. Create two test users
-- 2. Insert data as each user
-- 3. Verify users can only see their own data
-- 4. Verify cross-user data leakage is prevented
--
-- PREREQUISITE: entity_memory.sql migration must be applied first
--
-- SECURITY REQUIREMENT: All tests must PASS to deploy to production

-- ============================================
-- TEST SETUP
-- ============================================

-- Create test users (requires SUPERUSER or Supabase dashboard)
-- In production, use Supabase Auth signup

CREATE OR REPLACE FUNCTION setup_test_users()
RETURNS TABLE (user1_id UUID, user2_id UUID) AS $$
DECLARE
    v_user1 UUID;
    v_user2 UUID;
BEGIN
    -- Create user 1
    INSERT INTO auth.users (id, email)
    VALUES (gen_random_uuid(), 'test_user1@example.com')
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_user1;

    -- Create user 2
    INSERT INTO auth.users (id, email)
    VALUES (gen_random_uuid(), 'test_user2@example.com')
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_user2;

    RETURN QUERY SELECT v_user1, v_user2;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- TEST 1: Entities Table RLS
-- ============================================

DO $$
DECLARE
    v_user1 UUID;
    v_user2 UUID;
    v_entity1_id UUID;
    v_entity2_id UUID;
    v_count INT;
BEGIN
    -- Get test users
    SELECT user1_id, user2_id INTO v_user1, v_user2
    FROM setup_test_users();

    RAISE NOTICE '=== TEST 1: Entities Table RLS ===';
    RAISE NOTICE 'User 1 ID: %', v_user1;
    RAISE NOTICE 'User 2 ID: %', v_user2;

    -- Insert entity as user 1
    SET LOCAL role = authenticated;
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user1::text)::text;

    INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
    VALUES (v_user1, 'John Smith', 'PER', 'john_smith')
    RETURNING id INTO v_entity1_id;

    RAISE NOTICE 'User 1 created entity: %', v_entity1_id;

    -- Verify user 1 can see their own entity
    SELECT COUNT(*) INTO v_count FROM entities WHERE id = v_entity1_id;
    IF v_count != 1 THEN
        RAISE EXCEPTION 'TEST FAILED: User 1 cannot see own entity (expected 1, got %)', v_count;
    END IF;
    RAISE NOTICE '✅ PASS: User 1 can see own entity';

    -- Insert entity as user 2
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user2::text)::text;

    INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
    VALUES (v_user2, 'Jane Doe', 'PER', 'jane_doe')
    RETURNING id INTO v_entity2_id;

    RAISE NOTICE 'User 2 created entity: %', v_entity2_id;

    -- Verify user 2 can see their own entity
    SELECT COUNT(*) INTO v_count FROM entities WHERE id = v_entity2_id;
    IF v_count != 1 THEN
        RAISE EXCEPTION 'TEST FAILED: User 2 cannot see own entity (expected 1, got %)', v_count;
    END IF;
    RAISE NOTICE '✅ PASS: User 2 can see own entity';

    -- Verify user 2 CANNOT see user 1's entity
    SELECT COUNT(*) INTO v_count FROM entities WHERE id = v_entity1_id;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'TEST FAILED: User 2 can see User 1 entity (data leak!)';
    END IF;
    RAISE NOTICE '✅ PASS: User 2 cannot see User 1 entity (isolation works)';

    -- Switch back to user 1
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user1::text)::text;

    -- Verify user 1 CANNOT see user 2's entity
    SELECT COUNT(*) INTO v_count FROM entities WHERE id = v_entity2_id;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'TEST FAILED: User 1 can see User 2 entity (data leak!)';
    END IF;
    RAISE NOTICE '✅ PASS: User 1 cannot see User 2 entity (isolation works)';

    RAISE NOTICE '=== TEST 1: PASSED ===';
END $$;

-- ============================================
-- TEST 2: Entity Mentions RLS (Inherited Security)
-- ============================================

DO $$
DECLARE
    v_user1 UUID;
    v_user2 UUID;
    v_entity1_id UUID;
    v_entity2_id UUID;
    v_chat_turn1_id UUID;
    v_mention1_id UUID;
    v_count INT;
BEGIN
    -- Get test users and entities from previous test
    SELECT user1_id INTO v_user1 FROM setup_test_users() LIMIT 1;

    SET LOCAL role = authenticated;
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user1::text)::text;

    -- Get user 1's entity
    SELECT id INTO v_entity1_id FROM entities WHERE user_id = v_user1 LIMIT 1;

    -- Create a chat turn for user 1 (prerequisite)
    INSERT INTO chat_turns (
        user_id, turn_range, conversation_id, platform,
        content, speakers, turn_count, start_timestamp, end_timestamp
    ) VALUES (
        v_user1, '1-2', 'test_conv_1', 'cli',
        'User: Hi John\nAssistant: Hello!',
        ARRAY['user', 'assistant'], 2, 1000000, 1000001
    ) RETURNING id INTO v_chat_turn1_id;

    RAISE NOTICE '=== TEST 2: Entity Mentions RLS ===';

    -- Insert mention as user 1
    INSERT INTO entity_mentions (
        entity_id, chat_turn_id, conversation_id,
        mention_text, confidence, timestamp
    ) VALUES (
        v_entity1_id, v_chat_turn1_id, 'test_conv_1',
        'John', 0.95, NOW()
    ) RETURNING id INTO v_mention1_id;

    RAISE NOTICE 'User 1 created mention: %', v_mention1_id;

    -- Verify user 1 can see their own mention
    SELECT COUNT(*) INTO v_count FROM entity_mentions WHERE id = v_mention1_id;
    IF v_count != 1 THEN
        RAISE EXCEPTION 'TEST FAILED: User 1 cannot see own mention (expected 1, got %)', v_count;
    END IF;
    RAISE NOTICE '✅ PASS: User 1 can see own mention';

    -- Switch to user 2
    SELECT user2_id INTO v_user2 FROM setup_test_users() LIMIT 1;
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user2::text)::text;

    -- Verify user 2 CANNOT see user 1's mention (inherited from entity ownership)
    SELECT COUNT(*) INTO v_count FROM entity_mentions WHERE id = v_mention1_id;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'TEST FAILED: User 2 can see User 1 mention (data leak!)';
    END IF;
    RAISE NOTICE '✅ PASS: User 2 cannot see User 1 mention (inherited RLS works)';

    RAISE NOTICE '=== TEST 2: PASSED ===';
END $$;

-- ============================================
-- TEST 3: Entity Relationships RLS
-- ============================================

DO $$
DECLARE
    v_user1 UUID;
    v_user2 UUID;
    v_entity1a_id UUID;
    v_entity1b_id UUID;
    v_rel1_id UUID;
    v_count INT;
BEGIN
    -- Get test users
    SELECT user1_id, user2_id INTO v_user1, v_user2 FROM setup_test_users();

    RAISE NOTICE '=== TEST 3: Entity Relationships RLS ===';

    -- Set user 1 context
    SET LOCAL role = authenticated;
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user1::text)::text;

    -- Create two entities for user 1
    INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
    VALUES (v_user1, 'Alice', 'PER', 'alice')
    RETURNING id INTO v_entity1a_id;

    INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
    VALUES (v_user1, 'Bob', 'PER', 'bob')
    RETURNING id INTO v_entity1b_id;

    -- Create relationship as user 1
    INSERT INTO entity_relationships (user_id, entity_a_id, entity_b_id)
    VALUES (v_user1, v_entity1a_id, v_entity1b_id)
    RETURNING id INTO v_rel1_id;

    RAISE NOTICE 'User 1 created relationship: %', v_rel1_id;

    -- Verify user 1 can see their relationship
    SELECT COUNT(*) INTO v_count FROM entity_relationships WHERE id = v_rel1_id;
    IF v_count != 1 THEN
        RAISE EXCEPTION 'TEST FAILED: User 1 cannot see own relationship (expected 1, got %)', v_count;
    END IF;
    RAISE NOTICE '✅ PASS: User 1 can see own relationship';

    -- Switch to user 2
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user2::text)::text;

    -- Verify user 2 CANNOT see user 1's relationship
    SELECT COUNT(*) INTO v_count FROM entity_relationships WHERE id = v_rel1_id;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'TEST FAILED: User 2 can see User 1 relationship (data leak!)';
    END IF;
    RAISE NOTICE '✅ PASS: User 2 cannot see User 1 relationship (isolation works)';

    RAISE NOTICE '=== TEST 3: PASSED ===';
END $$;

-- ============================================
-- TEST 4: Cross-User INSERT Protection
-- ============================================

DO $$
DECLARE
    v_user1 UUID;
    v_user2 UUID;
    v_entity1_id UUID;
    v_should_fail BOOLEAN := FALSE;
BEGIN
    -- Get test users
    SELECT user1_id, user2_id INTO v_user1, v_user2 FROM setup_test_users();

    RAISE NOTICE '=== TEST 4: Cross-User INSERT Protection ===';

    -- Set user 2 context
    SET LOCAL role = authenticated;
    SET LOCAL request.jwt.claims = json_build_object('sub', v_user2::text)::text;

    -- Try to insert entity with user 1's ID (should FAIL)
    BEGIN
        INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
        VALUES (v_user1, 'Malicious Entity', 'PER', 'malicious')
        RETURNING id INTO v_entity1_id;

        -- If we reach here, the test FAILED
        RAISE EXCEPTION 'TEST FAILED: User 2 could insert entity with User 1 ID (security breach!)';
    EXCEPTION
        WHEN insufficient_privilege OR check_violation THEN
            -- Expected: RLS policy blocked the insert
            RAISE NOTICE '✅ PASS: User 2 blocked from inserting with User 1 ID';
    END;

    RAISE NOTICE '=== TEST 4: PASSED ===';
END $$;

-- ============================================
-- TEST CLEANUP
-- ============================================

-- Clean up test data
DELETE FROM entity_relationships WHERE user_id IN (
    SELECT id FROM auth.users WHERE email LIKE 'test_user%@example.com'
);

DELETE FROM entity_mentions WHERE entity_id IN (
    SELECT id FROM entities WHERE user_id IN (
        SELECT id FROM auth.users WHERE email LIKE 'test_user%@example.com'
    )
);

DELETE FROM entities WHERE user_id IN (
    SELECT id FROM auth.users WHERE email LIKE 'test_user%@example.com'
);

DELETE FROM chat_turns WHERE user_id IN (
    SELECT id FROM auth.users WHERE email LIKE 'test_user%@example.com'
);

DELETE FROM auth.users WHERE email LIKE 'test_user%@example.com';

-- ============================================
-- TEST SUMMARY
-- ============================================

-- If all tests passed, you should see:
-- ✅ TEST 1: PASSED (entities isolation)
-- ✅ TEST 2: PASSED (entity_mentions inherited isolation)
-- ✅ TEST 3: PASSED (entity_relationships isolation)
-- ✅ TEST 4: PASSED (cross-user INSERT blocked)
--
-- If ANY test failed, DO NOT deploy to production.
-- Fix RLS policies first, then re-run tests.

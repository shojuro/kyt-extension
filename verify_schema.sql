-- ============================================
-- chat_turns Schema Verification Queries
-- Based on: PHASE_2_SCHEMA_APPLICATION.md
-- ============================================

-- Run these queries in Supabase SQL Editor to verify schema

\echo '=== 1. Verify pgvector Extension ==='
SELECT
  extname,
  extversion,
  'pgvector extension enabled' as status
FROM pg_extension
WHERE extname = 'vector';

\echo '\n=== 2. Verify Table Structure (Expected: 15-17 columns) ==='
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'chat_turns'
  AND table_schema = 'public'
ORDER BY ordinal_position;

\echo '\n=== 3. Verify Indexes (Expected: 6 indexes) ==='
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'chat_turns'
  AND schemaname = 'public'
ORDER BY indexname;

\echo '\n=== 4. Verify RLS Policies (Expected: 1 policy) ==='
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  qual
FROM pg_policies
WHERE tablename = 'chat_turns';

\echo '\n=== 5. Verify RLS is Enabled ==='
SELECT
  relname as table_name,
  relrowsecurity as rls_enabled
FROM pg_class
WHERE relname = 'chat_turns';

\echo '\n=== 6. Verify Constraints (Expected: 4 constraints minimum) ==='
SELECT
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON tc.constraint_name = cc.constraint_name
WHERE tc.table_name = 'chat_turns'
  AND tc.table_schema = 'public'
ORDER BY tc.constraint_type, tc.constraint_name;

\echo '\n=== 7. Verify search_chat_turns() Function ==='
SELECT
  routine_name,
  routine_type,
  data_type as return_type
FROM information_schema.routines
WHERE routine_name = 'search_chat_turns'
  AND routine_schema = 'public';

\echo '\n=== 8. Verify chat_turns_free View ==='
SELECT
  table_name,
  table_type,
  'chat_turns_free view exists' as status
FROM information_schema.tables
WHERE table_name = 'chat_turns_free'
  AND table_schema = 'public';

\echo '\n=== 9. Verification Summary (Quick Check) ==='
SELECT
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'chat_turns') as column_count,
  (SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'chat_turns') as index_count,
  (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'chat_turns') as policy_count,
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_name = 'chat_turns') as constraint_count,
  (SELECT COUNT(*) FROM information_schema.routines WHERE routine_name = 'search_chat_turns') as function_count,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'chat_turns_free') as view_count;

\echo '\n=== Expected Results ==='
\echo 'column_count: 15-17'
\echo 'index_count: 6'
\echo 'policy_count: 1'
\echo 'constraint_count: 4+'
\echo 'function_count: 1'
\echo 'view_count: 1'

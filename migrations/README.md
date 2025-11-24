# KYT Entity Memory Migration Guide

This guide covers the application and testing of the Entity Memory database schema.

## Overview

The Entity Memory feature adds three core tables to support entity extraction and relationship tracking:

- **entities**: Canonical deduplicated entities (people, organizations, locations, etc.)
- **entity_mentions**: Individual occurrences of entities in chat turns
- **entity_relationships**: Co-occurrence tracking between entities

## Prerequisites

### Required

1. **Supabase Project Access**
   - Project URL and service role key configured in `.env`
   - PostgreSQL database with pgvector extension

2. **Existing Schema**
   - `chat_turns` table must exist (from `supabase_chat_turns_schema.sql`)
   - `auth.users` table must exist (Supabase Auth enabled)

3. **Database Permissions**
   - SUPERUSER or equivalent permissions for:
     - Creating tables and indexes
     - Enabling RLS policies
     - Creating functions

### Verification

Check prerequisites with:

```bash
# Verify chat_turns table exists
psql $DATABASE_URL -c "SELECT COUNT(*) FROM chat_turns;"

# Verify pgvector extension
psql $DATABASE_URL -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Verify auth.users table
psql $DATABASE_URL -c "SELECT COUNT(*) FROM auth.users;"
```

## Migration Application

### Step 1: Apply Main Migration

```bash
# Connect to Supabase database
psql $DATABASE_URL -f migrations/entity_memory.sql
```

**Expected Output:**
```
CREATE EXTENSION
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE INDEX
CREATE INDEX
...
CREATE POLICY
CREATE FUNCTION
```

**Verification Queries** (included at end of migration):
- Check tables exist
- Check columns and types
- Check indexes
- Check RLS policies
- Check functions exist

### Step 2: Verify Schema

The migration includes verification queries that run automatically. Check the output for:

```sql
-- Should show 3 tables
table_name              | table_type
------------------------+-----------
entities                | BASE TABLE
entity_mentions         | BASE TABLE
entity_relationships    | BASE TABLE

-- Should show 3 helper functions
routine_name                | routine_type
---------------------------+-------------
find_similar_entities      | FUNCTION
get_related_entities       | FUNCTION
upsert_entity_relationship | FUNCTION
```

### Step 3: Run RLS Security Tests

```bash
# Run comprehensive RLS test suite
psql $DATABASE_URL -f migrations/test_entity_memory_rls.sql
```

**Expected Output:**
```
NOTICE:  === TEST 1: Entities Table RLS ===
NOTICE:  ✅ PASS: User 1 can see own entity
NOTICE:  ✅ PASS: User 2 can see own entity
NOTICE:  ✅ PASS: User 2 cannot see User 1 entity (isolation works)
NOTICE:  ✅ PASS: User 1 cannot see User 2 entity (isolation works)
NOTICE:  === TEST 1: PASSED ===

NOTICE:  === TEST 2: Entity Mentions RLS ===
NOTICE:  ✅ PASS: User 1 can see own mention
NOTICE:  ✅ PASS: User 2 cannot see User 1 mention (inherited RLS works)
NOTICE:  === TEST 2: PASSED ===

NOTICE:  === TEST 3: Entity Relationships RLS ===
NOTICE:  ✅ PASS: User 1 can see own relationship
NOTICE:  ✅ PASS: User 2 cannot see User 1 relationship (isolation works)
NOTICE:  === TEST 3: PASSED ===

NOTICE:  === TEST 4: Cross-User INSERT Protection ===
NOTICE:  ✅ PASS: User 2 blocked from inserting with User 1 ID
NOTICE:  === TEST 4: PASSED ===
```

**IMPORTANT**: All tests must PASS before deploying to production.

If any test fails:
1. Review the error message
2. Check RLS policies in `entity_memory.sql`
3. Fix the issue
4. Re-run the migration
5. Re-run the tests

## Post-Migration Verification

### Check Table Row Counts

```sql
-- Should all be 0 for fresh migration
SELECT 'entities' AS table_name, COUNT(*) FROM entities
UNION ALL
SELECT 'entity_mentions', COUNT(*) FROM entity_mentions
UNION ALL
SELECT 'entity_relationships', COUNT(*) FROM entity_relationships;
```

### Test Entity Insertion

```sql
-- Insert test entity (requires auth context)
INSERT INTO entities (user_id, entity_text, entity_type, canonical_name)
VALUES (auth.uid(), 'Test Person', 'PER', 'test_person');

-- Verify insertion
SELECT * FROM entities WHERE canonical_name = 'test_person';

-- Clean up test data
DELETE FROM entities WHERE canonical_name = 'test_person';
```

### Test Helper Functions

```sql
-- Test find_similar_entities (requires sample data)
SELECT * FROM find_similar_entities(
    auth.uid(),
    'PER',
    '[1536-dim embedding vector]'::vector,
    'john_smith',
    0.85
);

-- Test get_related_entities
SELECT * FROM get_related_entities('[entity-uuid]'::uuid, 10);
```

## Rollback Procedure

**WARNING**: This will delete ALL entity data. Backup first if needed.

```sql
-- Drop helper functions
DROP FUNCTION IF EXISTS get_related_entities(UUID, INT);
DROP FUNCTION IF EXISTS upsert_entity_relationship(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS find_similar_entities(UUID, TEXT, VECTOR(1536), TEXT, FLOAT);

-- Drop tables (CASCADE removes dependent objects)
DROP TABLE IF EXISTS entity_relationships CASCADE;
DROP TABLE IF EXISTS entity_mentions CASCADE;
DROP TABLE IF EXISTS entities CASCADE;
```

**Verify Rollback:**

```sql
-- Should return no rows
SELECT table_name
FROM information_schema.tables
WHERE table_name IN ('entities', 'entity_mentions', 'entity_relationships');
```

## Troubleshooting

### Error: "extension 'vector' does not exist"

**Solution**: Enable pgvector extension first:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Error: "relation 'chat_turns' does not exist"

**Solution**: Apply `supabase_chat_turns_schema.sql` migration first:
```bash
psql $DATABASE_URL -f supabase_chat_turns_schema.sql
```

### Error: "column 'user_id' does not exist in table 'auth.users'"

**Solution**: Ensure Supabase Auth is enabled for your project. Check:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'auth' AND table_name = 'users';
```

### Error: RLS Test Fails with "permission denied"

**Possible Causes**:
1. RLS policies not created correctly
2. Test user creation failed
3. JWT claims not set properly

**Solution**: Run migration again and check policy definitions:
```sql
SELECT policyname, cmd FROM pg_policies
WHERE tablename IN ('entities', 'entity_mentions', 'entity_relationships');
```

## Production Deployment Checklist

Before deploying to production:

- [ ] All RLS tests PASS
- [ ] Schema verification queries complete successfully
- [ ] No errors in migration output
- [ ] Helper functions tested with sample data
- [ ] Rollback procedure tested in staging environment
- [ ] Database backup created
- [ ] Supabase project has sufficient storage for vector embeddings
- [ ] Performance tested with expected data volume

## Performance Considerations

### Expected Data Volume

- **10,000 users** × **30 entities/user** = 300,000 entity records
- Vector embeddings: 300,000 × 1536 dimensions × 4 bytes = ~1.8GB
- Indexes: ~2-3x data size = ~4-5GB total

### Index Build Times

- IVFFlat index: ~2 minutes for 300,000 vectors
- HNSW upgrade (future): ~5 minutes for 300,000 vectors

### Query Performance Targets

- Entity lookup by canonical_name: <10ms
- Vector similarity search (top-5): <50ms with IVFFlat
- Relationship queries: <20ms
- RLS overhead: minimal (<5ms) with user_id index

## Next Steps

After successful migration:

1. **Integrate with NER Pipeline**: Implement entity extraction in `save_chat_turn` Edge Function
2. **Add Entity Search**: Extend search queries to include entity-aware boosting
3. **Build Entity UI**: Create interface for viewing entities and relationships
4. **Upgrade to HNSW**: Consider upgrading vector index for better performance
5. **Implement Deduplication**: Add batch job for entity consolidation

## Related Migrations

- `supabase_schema.sql` - Original messages table (legacy)
- `supabase_chat_turns_schema.sql` - Chat turns with embeddings (required)
- `temporal_filtering.sql` - Temporal decay scoring
- `add_mmr_support.sql` - MMR diversity ranking

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review migration file comments in `entity_memory.sql`
3. Verify prerequisites are met
4. Check Supabase dashboard for errors

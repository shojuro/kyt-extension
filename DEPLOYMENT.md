# Entity Memory Feature - Deployment Guide

**Date**: 2025-11-25
**Status**: Ready for Deployment
**Branch**: feature/entity-memory

## Overview

This guide covers deploying the entity memory feature to production Supabase environment.

## Prerequisites

- [ ] Supabase CLI installed (`npm install -g supabase`)
- [ ] Supabase project linked (`supabase link --project-ref YOUR_PROJECT_REF`)
- [ ] OpenAI API key configured in Supabase dashboard
- [ ] Database backup created (precautionary)

## Deployment Steps

### 1. Pre-Deployment Checks

```bash
# Verify all tests pass
npm test

# Check git status
git status

# Verify on correct branch
git branch --show-current  # Should show: feature/entity-memory

# Review commits
git log --oneline -5
```

**Expected commits**:
- `7725234` - Task 4: Integrate entity extraction with save_chat_turn
- `72e2765` - Task 3: Add entity saving logic (TDD)
- `2ceed92` - Task 2: Create entity extractor module (TDD)
- `4af59e6` - Task 1: Fix migration schema for relationship-aware entities

### 2. Apply Database Migration

**Method A: Using Supabase CLI** (Recommended)
```bash
# Push migration to production
supabase db push

# Verify migration applied
supabase db diff
```

**Method B: Manual SQL Execution**
```bash
# Connect to production database
psql $DATABASE_URL

# Execute migration
\i migrations/entity_memory.sql

# Verify tables exist
\dt entities entity_mentions entity_relationships

# Verify columns
\d entities

# Check indexes
\di idx_entities_*

# Exit
\q
```

### 3. Configure Environment Variables

In Supabase Dashboard: **Settings > Edge Functions > Secrets**

Ensure these are set:
- `OPENAI_API_KEY` - Your OpenAI API key for entity extraction
- `SUPABASE_URL` - Auto-configured by Supabase
- `SUPABASE_SERVICE_ROLE_KEY` - Auto-configured by Supabase

### 4. Deploy Edge Function

```bash
# Deploy save_chat_turn with entity extraction
supabase functions deploy save_chat_turn

# Verify deployment
supabase functions list
```

Expected output:
```
┌─────────────────┬─────────┬──────────┐
│ NAME            │ STATUS  │ REGION   │
├─────────────────┼─────────┼──────────┤
│ save_chat_turn  │ ACTIVE  │ us-east-1│
└─────────────────┴─────────┴──────────┘
```

### 5. Run Verification Tests

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export TEST_USER_ID="your-test-user-id"
export OPENAI_API_KEY="your-openai-api-key"

# Run verification script
node scripts/verify_entity_memory.js
```

Expected output:
```
==========================================
Entity Memory Verification
==========================================

Test 1: Verifying database schema...
✅ PASSED: All required tables exist

Test 2: Verifying entity columns...
✅ PASSED: All required columns exist

Test 3: Testing save_chat_turn with entity extraction...
✅ Chat turn saved: uuid-here
✅ Entities extracted: 2
✅ PASSED: 2 entities found in database
✅ PASSED: Jennifer (trainer) correctly identified
✅ PASSED: 2 entity mentions recorded

==========================================
All Verification Tests Passed! ✅
==========================================
```

### 6. Monitor Production

```bash
# Watch Edge Function logs
supabase functions logs save_chat_turn --follow

# Check for errors
supabase functions logs save_chat_turn --level error

# Verify entity extraction working
supabase db exec "SELECT COUNT(*) FROM entities"
supabase db exec "SELECT COUNT(*) FROM entity_mentions"
```

### 7. Production Smoke Test

Send a test conversation through your production client:

```javascript
const response = await fetch('https://your-project.supabase.co/functions/v1/save_chat_turn', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
  },
  body: JSON.stringify({
    content: "I had lunch with my colleague Sarah at Google today. We discussed the new React project.",
    speakers: ['User', 'Assistant'],
    topics: ['work', 'lunch', 'projects'],
    embedding: [...],  // 1536-dim vector
    user_id: 'your-user-id'
  })
});

const result = await response.json();
console.log(result);
```

Expected response:
```json
{
  "success": true,
  "id": "uuid-of-chat-turn",
  "classification": {
    "impact_score": 15,
    "intimacy_level": 1,
    "reasoning": "Routine work conversation..."
  },
  "entities_extracted": 3
}
```

Then verify entities were saved:
```sql
SELECT
  canonical_name,
  entity_type,
  relationship,
  context_category,
  mention_count
FROM entities
WHERE user_id = 'your-user-id'
ORDER BY last_seen DESC
LIMIT 10;
```

Expected results:
```
 canonical_name    | entity_type | relationship | context_category | mention_count
-------------------+-------------+--------------+------------------+--------------
 sarah_colleague   | PERSON      | colleague    | work             | 1
 google_unknown    | ORG         | unknown      | work             | 1
 react_unknown     | TECH        | unknown      | work             | 1
```

## Rollback Procedure

If issues occur, rollback immediately:

### 1. Revert Edge Function
```bash
# Get previous deployment ID
supabase functions list --with-versions save_chat_turn

# Rollback to previous version
supabase functions deploy save_chat_turn --version VERSION_ID
```

### 2. Disable Entity Extraction
If Edge Function rollback not possible, disable extraction:

```sql
-- Temporary: Make entity extraction fail gracefully
-- This keeps conversation saving working
UPDATE pg_settings
SET setting = 'invalid_key'
WHERE name = 'app.openai_api_key';
```

The `Promise.allSettled` pattern ensures conversation saving continues even if entity extraction fails.

### 3. Rollback Database Migration
```sql
-- Remove entity memory tables (DESTRUCTIVE)
DROP TABLE IF EXISTS entity_relationships CASCADE;
DROP TABLE IF EXISTS entity_mentions CASCADE;
DROP TABLE IF EXISTS entities CASCADE;

-- Or keep tables but disable RLS
ALTER TABLE entities DISABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mentions DISABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relationships DISABLE ROW LEVEL SECURITY;
```

## Post-Deployment Monitoring

### Key Metrics

Monitor these for 48 hours after deployment:

1. **Entity Extraction Rate**
```sql
SELECT
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as chat_turns,
  COUNT(DISTINCT user_id) as users
FROM chat_turns
WHERE created_at > NOW() - INTERVAL '48 hours'
GROUP BY hour
ORDER BY hour DESC;

SELECT
  DATE_TRUNC('hour', timestamp) as hour,
  COUNT(*) as entities_extracted
FROM entity_mentions
WHERE timestamp > NOW() - INTERVAL '48 hours'
GROUP BY hour
ORDER BY hour DESC;
```

2. **Error Rate**
```bash
# Check Edge Function errors
supabase functions logs save_chat_turn --level error | grep "Entity extraction failed"
```

3. **Performance Impact**
```sql
-- Average response time (if you add timing metrics)
SELECT AVG(processing_time_ms)
FROM chat_turns
WHERE created_at > NOW() - INTERVAL '24 hours';
```

### Success Criteria

- ✅ Conversation saving success rate: >99.9%
- ✅ Entity extraction success rate: >90%
- ✅ No increase in Edge Function errors
- ✅ Response time increase: <500ms
- ✅ Entity deduplication working (same person = same canonical_name)

## Troubleshooting

### Issue: Entity extraction failing

**Symptoms**: `entities_extracted: 0` in all responses

**Check**:
```bash
# Verify OpenAI API key
supabase functions logs save_chat_turn | grep "OPENAI_API_KEY"

# Test OpenAI connection
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

**Fix**: Update OpenAI API key in Supabase dashboard

### Issue: Entities not being saved

**Symptoms**: `entities_extracted > 0` but `SELECT COUNT(*) FROM entities` returns 0

**Check**:
```sql
-- Verify RLS policies
SELECT * FROM pg_policies
WHERE tablename IN ('entities', 'entity_mentions');

-- Check if service role key is correct
SELECT current_user;
```

**Fix**: Verify service role key has correct permissions

### Issue: Duplicate entities

**Symptoms**: Same person appears multiple times with different IDs

**Check**:
```sql
SELECT
  normalized_name,
  relationship,
  COUNT(*) as duplicates
FROM entities
GROUP BY normalized_name, relationship
HAVING COUNT(*) > 1;
```

**Fix**: This indicates canonical name generation issue. Check entity-extractor.ts logic.

### Issue: Performance degradation

**Symptoms**: Slow response times after deployment

**Check**:
```bash
# Monitor Edge Function duration
supabase functions logs save_chat_turn | grep "duration"
```

**Fix**: Entity extraction and gravity classification run in parallel, but if both are slow:
1. Check OpenAI API latency
2. Consider caching common entities
3. Batch entity saves (future optimization)

## Files Modified

| File | Purpose | Status |
|------|---------|--------|
| `migrations/entity_memory.sql` | Database schema | ✅ Ready |
| `supabase/functions/_shared/entity-extractor.ts` | Entity extraction | ✅ Ready |
| `supabase/functions/_shared/entity-extractor.test.js` | Module tests | ✅ Passing |
| `supabase/functions/save_chat_turn/index.ts` | Integration | ✅ Ready |
| `supabase/functions/save_chat_turn/index.test.js` | Integration tests | ✅ Passing |

## Git Integration

After successful deployment:

```bash
# Merge to main branch
git checkout main
git merge feature/entity-memory

# Tag the release
git tag -a v1.0.0-entity-memory -m "Entity memory feature with relationship-aware disambiguation"

# Push to origin
git push origin main --tags
```

## Support

If deployment issues occur:
1. Check Supabase dashboard logs
2. Review Edge Function error logs
3. Verify migration applied correctly
4. Contact team for assistance

---

**Deployment Owner**: AI Engineer (Entity Memory Feature)
**Last Updated**: 2025-11-25
**Deployment Status**: ⏳ Ready for Production

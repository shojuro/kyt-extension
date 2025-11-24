# Temporal Decay (Gravity Scoring) Deployment Guide

**Feature**: Semantic memory decay with salience-based persistence
**Status**: ⚠️ Code complete, database deployment required
**Date**: 2025-11-24

---

## 🚀 Quick Start: Manual SQL Deployment

### Step 1: Open Supabase SQL Editor

**URL**: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/sql/new

### Step 2: Execute SQL Files (In Order)

Copy and paste each file's contents into the SQL Editor and run:

#### 1️⃣ Add Gravity Columns (Required)
**File**: `migrations/add_gravity_columns.sql`
**What it does**: Adds 5 new columns to `chat_turns` table
- `impact_score` (0-100): Holmes-Rahe Life Change Scale
- `intimacy_level` (0-3): Aron's 36 Questions
- `access_count` (int): Rehearsal effect counter
- `last_accessed` (timestamp): Last retrieval time
- `gravity_score` (float): Computed relevance

**Expected output**: "Migration successful: Gravity columns added to chat_turns"

---

#### 2️⃣ Deploy Gravity Calculation Function (Required)
**File**: `supabase/functions/_sql/calculate_gravity_score.sql`
**What it does**: Creates `calculate_gravity_score()` function
- Implements adaptive time decay (log/exp/linear)
- Formula: `vector_similarity × importance × time_decay × rehearsal`

**Expected output**: "All gravity score tests PASSED"

---

#### 3️⃣ Deploy Search Functions (Required)
**File**: `supabase/functions/_sql/search_with_gravity.sql`
**What it does**: Creates 3 new functions
- `match_messages_with_gravity()`: Retrieval with gravity ranking
- `match_messages_with_gravity_and_update()`: Includes rehearsal tracking
- `analyze_gravity_distribution()`: Diagnostic queries

**Expected output**: "Search function created successfully"

---

#### 4️⃣ Deploy Access Tracking (Optional but Recommended)
**File**: `migrations/add_access_tracking_trigger.sql`
**What it does**: Creates helper functions for rehearsal effect
- `update_memory_access()`: Manual access tracking
- `find_anchored_memories()`: High-rehearsal queries

**Expected output**: "Access tracking migration successful"

---

### Step 3: Verify Migration

Run this verification query in SQL Editor:

```sql
-- Check columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'chat_turns'
  AND column_name IN ('impact_score', 'intimacy_level', 'gravity_score', 'access_count', 'last_accessed')
ORDER BY column_name;

-- Should return 5 rows
```

**Expected result**: 5 rows showing all gravity columns

```sql
-- Check functions exist
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE '%gravity%'
ORDER BY routine_name;

-- Should return 3+ functions
```

---

## 🤖 Edge Functions Deployment (Phase 2)

### Prerequisites
✅ SQL migrations complete
✅ OpenAI API key obtained
⬜ Supabase CLI installed (optional)

### Option A: Supabase Dashboard (Recommended)

1. **Set Environment Variables**
   - Go to: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/settings/functions
   - Click "Environment variables"
   - Add:
     - `OPENAI_API_KEY` = your OpenAI API key
     - `SUPABASE_URL` = https://svrcvfzlwhnixzuxaccf.supabase.co
     - `SUPABASE_SERVICE_ROLE_KEY` = your service role key (from Settings → API)

2. **Deploy Edge Function**
   - Go to: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/functions
   - Click "Create a new function"
   - Name: `save_chat_turn`
   - Copy/paste contents from: `supabase/functions/save_chat_turn/index.ts`
   - Also upload: `supabase/functions/_shared/memory-classifier.ts`
   - Click "Deploy"

### Option B: Supabase CLI

```bash
# Install Supabase CLI (if not installed)
npm install -g supabase

# Login
supabase login

# Link to project
supabase link --project-ref svrcvfzlwhnixzuxaccf

# Deploy function
supabase functions deploy save_chat_turn
```

---

## 🧪 Testing & Verification

### Test 1: SQL Functions (Run in SQL Editor)

```sql
-- Test gravity score calculation
SELECT calculate_gravity_score(
  0.9,   -- 90% vector similarity
  95,    -- High impact (death of loved one)
  3,     -- Deep intimacy
  NOW() - INTERVAL '365 days',  -- Created 1 year ago
  NOW() - INTERVAL '365 days',  -- Last accessed 1 year ago
  0      -- Never rehearsed
);

-- Expected: Score > 1.0 (high-impact memory persists)
```

### Test 2: Memory Classifier (Local)

Run the verification script:
```bash
node migrations/verify-gravity-system.js
```

### Test 3: End-to-End Integration

```bash
npm run test:gravity-e2e
```

---

## 📊 Cost Estimates

**OpenAI API (GPT-4o-mini):**
- Per memory: $0.00012
- 1,000 users, 10 memories each: $1.20
- 10,000 users: $12.00

**Recommended Budget Alerts:**
- $10 (warning)
- $50 (review)
- $100 (circuit breaker)

Set up in: https://platform.openai.com/account/limits

---

## 🔍 Troubleshooting

### Issue: "Column does not exist"
**Solution**: Run `migrations/add_gravity_columns.sql` again

### Issue: "Function does not exist"
**Solution**: Run `supabase/functions/_sql/calculate_gravity_score.sql` again

### Issue: "OpenAI API error"
**Solution**: Check `OPENAI_API_KEY` environment variable in Edge Functions settings

### Issue: Classification too slow
**Solution**: Reduce batch size or implement caching

---

## 📋 Rollback Plan

If you need to rollback the migration:

```sql
-- Remove gravity columns
ALTER TABLE chat_turns
  DROP COLUMN IF EXISTS impact_score,
  DROP COLUMN IF EXISTS intimacy_level,
  DROP COLUMN IF EXISTS access_count,
  DROP COLUMN IF EXISTS last_accessed,
  DROP COLUMN IF EXISTS gravity_score;

-- Drop functions
DROP FUNCTION IF EXISTS calculate_gravity_score;
DROP FUNCTION IF EXISTS match_messages_with_gravity;
DROP FUNCTION IF EXISTS match_messages_with_gravity_and_update;
DROP FUNCTION IF EXISTS analyze_gravity_distribution;
```

---

## ✅ Deployment Checklist

- [ ] SQL migrations executed (4 files)
- [ ] Verification query shows 5 columns
- [ ] Verification query shows 3+ functions
- [ ] OpenAI API key added to Edge Functions
- [ ] `save_chat_turn` function deployed
- [ ] Test classification with sample memory
- [ ] Monitor OpenAI API costs
- [ ] Update client code to call new Edge Function
- [ ] Run end-to-end tests
- [ ] Deploy to production

---

## 🆘 Need Help?

1. **Check logs**: Supabase Dashboard → Logs → Functions
2. **Verify schema**: Run verification queries above
3. **Test locally**: `node migrations/verify-gravity-system.js`
4. **Manual verification**: Check each SQL file ran without errors

---

**Next**: After completing SQL deployment, run `node migrations/verify-gravity-system.js` to confirm everything works!

# Temporal Decay (Gravity Scoring) Test Suite

Comprehensive testing for the memory persistence system.

## Test Files

### 1. `test_classifier_local.ts` - Local Classifier Testing
**Purpose**: Test the AI classification logic without database dependency

**Prerequisites**:
- Deno installed: `curl -fsSL https://deno.land/install.sh | sh`
- `OPENAI_API_KEY` in environment or `.env` file

**Run**:
```bash
deno run --allow-env --allow-net tests/test_classifier_local.ts
```

**What it tests**:
- ✅ Holmes-Rahe impact scoring (0-100)
- ✅ Aron's intimacy levels (0-3)
- ✅ Classification reasoning quality
- ✅ Boundary cases (high/medium/low impact)
- ✅ API key security (server-side only)

**Test cases**:
1. High impact, deep intimacy (death/grief)
2. Medium impact, personal disclosure (promotion)
3. Low impact, surface conversation (weather)
4. Maximum vulnerability (crisis/mental health)
5. Medium impact, moderate intimacy (relocation)
6. Technical/factual query (zero intimacy)

**Expected output**:
```
╔════════════════════════════════════════════════════════════╗
║  MEMORY CLASSIFIER LOCAL TEST SUITE                       ║
╚════════════════════════════════════════════════════════════╝

📋 Test: High Impact, Deep Intimacy
   Impact Score: 95 (expected 80-100)
   Intimacy Level: 3 (expected 2-3)
   Reasoning: ...
   ✅ PASSED

...

Total Tests: 6
✅ Passed: 6
❌ Failed: 0
Success Rate: 100.0%

🎉 All tests passed! The memory classifier is working correctly.
```

**Cost**: ~$0.0007 per test run (6 API calls × ~$0.00012 each)

---

### 2. `test_gravity_e2e.js` - End-to-End Acceptance Tests
**Purpose**: Validate the complete deployed system

**Prerequisites**:
- ✅ Database migrations deployed (4 SQL files)
- ✅ Edge Functions deployed (`save_chat_turn`)
- ✅ Environment variables in `.env`:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
  - `OPENAI_API_KEY` (in Edge Function environment)
- ✅ Test user ID (set `TEST_USER_ID` or use default)

**Run**:
```bash
node tests/test_gravity_e2e.js
```

**What it tests**:
1. **Prerequisites Check**
   - ✅ Gravity columns exist in `chat_turns` table
   - ✅ `calculate_gravity_score()` function is callable

2. **Save with Classification**
   - ✅ Edge Function processes conversations
   - ✅ AI classification produces valid scores
   - ✅ Data is inserted with correct schema

3. **Gravity Score Calculation**
   - ✅ Scores are computed correctly
   - ✅ High-impact memories have higher scores
   - ✅ Time decay is applied appropriately

4. **Semantic Search** (optional if embeddings exist)
   - ✅ Vector search returns results
   - ✅ Gravity ranking affects result order

5. **Rehearsal Effect**
   - ✅ Access count increments on retrieval
   - ✅ Gravity score increases with rehearsal
   - ✅ Last accessed timestamp updates

**Expected output**:
```
╔════════════════════════════════════════════════════════════╗
║  TEMPORAL DECAY E2E ACCEPTANCE TESTS                       ║
╚════════════════════════════════════════════════════════════╝

📋 Test 1: Prerequisites Check
  ✅ Gravity columns exist
  ✅ calculate_gravity_score() function

📋 Test 2: Save Conversation with Classification
  ✅ Save conversation: "[TEST] My grandmother passed away..."
  ✅ Save conversation: "[TEST] I got accepted into my dream..."
  ✅ Save conversation: "[TEST] The weather is nice today."

...

Total Tests: 12
✅ Passed: 12
❌ Failed: 0
Success Rate: 100.0%

🎉 ALL ACCEPTANCE TESTS PASSED!
```

**Cleanup**: Automatically removes test data after completion

---

## Testing Workflow

### Phase 1: Pre-Deployment (Local)
```bash
# Test classifier logic locally
deno run --allow-env --allow-net tests/test_classifier_local.ts
```

**Expected**: All 6 tests pass, validating classification logic

---

### Phase 2: Post-Deployment (Database)
After running SQL migrations in Supabase Dashboard:

```bash
# Verify database deployment
node migrations/verify-gravity-system.js
```

**Expected**: All column and function checks pass

---

### Phase 3: Post-Deployment (Edge Functions)
After deploying `save_chat_turn` Edge Function:

```bash
# Run end-to-end acceptance tests
node tests/test_gravity_e2e.js
```

**Expected**: All 12 tests pass, system fully operational

---

## Troubleshooting

### Error: "OPENAI_API_KEY not found"
**Solution**: Add to `.env` file or export:
```bash
export OPENAI_API_KEY=your_key_here
```

### Error: "column does not exist"
**Solution**: Run database migrations:
```bash
# See DEPLOYMENT_GUIDE.md
# Open: https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/sql/new
# Paste and run: migrations/add_gravity_columns.sql
```

### Error: "function does not exist"
**Solution**: Deploy SQL functions:
```bash
# Run in Supabase SQL Editor:
# 1. supabase/functions/_sql/calculate_gravity_score.sql
# 2. supabase/functions/_sql/search_with_gravity.sql
```

### Error: "Edge Function not available"
**Solution**: Deploy Edge Function via Dashboard or CLI:
```bash
supabase functions deploy save_chat_turn
```

### Error: "Classification failed"
**Solution**: Check Edge Function logs:
```
https://supabase.com/dashboard/project/svrcvfzlwhnixzuxaccf/functions/save_chat_turn/logs
```

---

## Cost Monitoring

**Local Classifier Test**:
- Cost: ~$0.0007 per run (6 API calls)
- Frequency: Run as needed during development

**E2E Acceptance Test**:
- Cost: ~$0.0004 per run (3 API calls)
- Frequency: Run after each deployment

**Total Testing Cost**: ~$0.001 per full test cycle

Set up budget alerts at: https://platform.openai.com/account/limits

---

## Next Steps After All Tests Pass

1. **Deploy to Production**
   - Merge `feature/temporal-decay-integrated` → `main`
   - Tag release: `v1.0.0-temporal-decay`

2. **Monitor in Production**
   - Watch OpenAI API costs
   - Track gravity score distribution
   - Collect user feedback

3. **Iterate**
   - Tune decay parameters if needed
   - Adjust impact/intimacy thresholds
   - Add more test cases for edge cases

---

For deployment instructions, see: `DEPLOYMENT_GUIDE.md`

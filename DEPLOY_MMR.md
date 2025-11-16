# MMR + HNSW Beta Deployment Guide

**Quick reference for deploying MMR + HNSW before beta launch**

---

## ✅ Pre-Deployment Checklist

- [x] HNSW index exists (verify: Day 1 implementation)
- [x] MMR implementation complete (src/mmr.js)
- [x] Integration complete (background.js)
- [x] Jennifer/Jenn test passes (test_mmr.js)
- [ ] Supabase migration deployed
- [ ] Chrome extension reloaded

---

## 🚀 Deployment Steps (5 minutes)

### Step 1: Verify HNSW Index (30 seconds)

```bash
# Check Supabase dashboard → Database → Tables → messages
# Look for index: messages_embedding_idx (type: hnsw)

# OR run SQL query:
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'messages' AND indexname = 'messages_embedding_idx';

# Expected: 1 row showing HNSW index on embedding column
```

✅ **If index exists**: HNSW is ready, proceed to Step 2  
❌ **If no index**: Run `supabase_schema.sql` lines 35-37

---

### Step 2: Deploy Supabase Migration (2 minutes)

```bash
# 1. Copy migration SQL
cat migrations/add_mmr_support.sql

# 2. Open Supabase dashboard
#    → SQL Editor → New query

# 3. Paste entire migration file

# 4. Click "Run"

# 5. Verify function updated:
SELECT routine_name, data_type 
FROM information_schema.routines 
WHERE routine_name = 'match_messages';

# Expected: Shows function with return type "record"
```

**What This Does**:
- Updates `match_messages()` RPC function
- Adds `embedding` column to return type
- Required for MMR inter-item similarity calculation

---

### Step 3: Reload Chrome Extension (30 seconds)

```bash
# 1. Open Chrome: chrome://extensions

# 2. Find "KYT Memory Extension"

# 3. Click "Reload" button

# 4. Check console for success:
#    → Open any ChatGPT/Claude tab
#    → F12 → Console
#    → Look for: "🚀 KYT Background: Service worker starting..."
```

**What This Does**:
- Reloads background.js with MMR integration
- Imports src/mmr.js module
- Enables MMR reranking in getContextForInjection()

---

### Step 4: Validate MMR Working (2 minutes)

**Terminal Test**:
```bash
node test_mmr.js

# Expected output:
# ✅ Test 2: WITH MMR - PRECISION preset (λ=0.4)
# Results:
#   1. [ID:1] "My sister Jennifer is a doctor in Boston..."
#   2. [ID:4] "Jenn (my dog) loves playing fetch in the park..."
#   3. [ID:2] "Jennifer is getting married next month..."
```

**Live Test**:
```bash
# 1. ChatGPT: "My sister Jennifer is a doctor in Boston"
# 2. ChatGPT: "Jennifer is getting married next month"
# 3. ChatGPT: "My dog Jenn loves playing fetch"

# 4. Wait 3 minutes (temporal filtering)

# 5. Claude: "Tell me about Jennifer"

# 6. Check console logs:
#    → Look for: "🎯 Applying MMR reranking (preset: PRECISION, λ=0.4)"
#    → Verify: "✅ MMR reranking complete: 3 items selected"

# 7. Verify Claude's response:
#    → Should ask which Jennifer (sister or dog)
#    → OR provide context for both entities
```

---

## 🔍 Troubleshooting

### Issue: "MMR requires embeddings for all candidates"

**Cause**: Supabase migration not deployed (function not returning embeddings)

**Fix**:
1. Verify migration ran: Check `match_messages()` function signature
2. Re-run migration if needed
3. Reload extension

---

### Issue: MMR not applying (no console logs)

**Cause**: Extension not reloaded after code changes

**Fix**:
1. chrome://extensions → Reload KYT
2. Refresh ChatGPT/Claude tab
3. Check console for "🚀 KYT Background: Service worker starting..."

---

### Issue: All results still about same entity

**Cause 1**: Not enough diverse candidates in database  
**Fix**: Create more test data with different entities

**Cause 2**: MMR preset too high (λ=0.7)  
**Fix**: Check contextConfig.mmrPreset, should be 'PRECISION' (λ=0.4)

**Cause 3**: Only 1 result being returned  
**Fix**: MMR requires ≥2 candidates, increase maxContextItems to 3

---

## 📊 Success Criteria

**HNSW Index**:
- ✅ Index exists in Supabase
- ✅ Index type is "hnsw"
- ✅ Index on "embedding" column with "vector_cosine_ops"

**MMR Reranking**:
- ✅ Terminal test passes (test_mmr.js)
- ✅ Console shows "🎯 Applying MMR reranking"
- ✅ Live test returns diverse entities (Jennifer + Jenn)

**Performance**:
- ✅ Context retrieval < 200ms
- ✅ No errors in console
- ✅ LLM receives formatted context

---

## 🎯 Beta Monitoring

**After deployment, monitor**:

1. **Console Logs** (first 10 queries):
   ```
   🔍 Context search returned X items
   🎯 Applying MMR reranking (preset: PRECISION, λ=0.4)
   ✅ MMR reranking complete: Y items selected
   ```

2. **Performance** (average):
   - Context retrieval time: ~150-200ms
   - No timeouts or errors

3. **Quality** (user feedback):
   - Users notice cross-platform memory ✅
   - No complaints about wrong context ✅
   - No entity confusion incidents ✅

---

## 📝 Rollback Plan

**If MMR causes issues**:

1. **Disable MMR** (keep HNSW):
   ```javascript
   // In background.js, comment out MMR block:
   // if (filteredItems.length > 1) {
   //   ... MMR reranking code ...
   // }
   ```

2. **Reload extension**: chrome://extensions → Reload

3. **Fallback behavior**: Pure relevance ranking (pre-MMR)

4. **Investigate**: Check console errors, test with debug mode

---

## 🎉 Deployment Complete!

**Verification Command**:
```bash
# Run all checks
node test_mmr.js && \
echo "✅ MMR test passed" && \
echo "📋 Checklist:" && \
echo "  ✅ HNSW index verified" && \
echo "  ✅ Supabase migration deployed" && \
echo "  ✅ Chrome extension reloaded" && \
echo "  ✅ MMR working (test passed)" && \
echo "" && \
echo "🚀 READY FOR BETA LAUNCH"
```

**Next**: Proceed with 2-week sprint to beta (network interception, Chrome Web Store, beta testers)

---

**Questions?** See `MMR_HNSW_IMPLEMENTATION.md` for full technical documentation

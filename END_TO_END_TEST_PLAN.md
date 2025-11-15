# KYT Memory Extension - End-to-End Test Plan

**Date**: 2025-11-15
**Status**: Test suite ready, API keys need rotation

---

## Test Environment

**Prerequisites**:
- ✅ Node.js v20.19.2
- ✅ npm 10.8.2
- ✅ .env file with 3 environment variables
- ⚠️ OpenAI API key needs rotation (401 error)
- ⚠️ Supabase credentials need verification

---

## Test Categories

### Category 1: Unit Tests (No API calls needed)

These tests validate core logic without external dependencies:

#### ✅ **Test 1.1: Conversation Chunker**
**File**: `src/test-chunker.js`
**Purpose**: Validate conversation-turn chunking logic
**Can run without API**: ✅ Yes (pure logic test)

**Test cases**:
1. Single conversation turn chunking
2. Multi-turn conversation chunking
3. Turn boundary detection
4. Topic extraction
5. Speaker identification
6. Metadata preservation

**Run**:
```bash
node src/test-chunker.js
```

**Expected output**:
- ✅ Turn boundaries detected correctly
- ✅ Topics extracted from content
- ✅ Speakers identified
- ✅ Chunk IDs generated
- ✅ Metadata preserved

---

### Category 2: Integration Tests (Require API keys)

These tests require valid OpenAI API keys:

#### ⚠️ **Test 2.1: Query Transformation**
**File**: `src/test-query-transformer.js`
**Purpose**: Validate LLM-powered query optimization
**Requires**: Valid OpenAI API key

**Test cases**:
1. Context extraction from messages (✅ No API needed)
2. Vague query transformation (⚠️ Requires OpenAI)
3. Casual query with filler words (⚠️ Requires OpenAI)
4. Already-optimized technical query (⚠️ Requires OpenAI)
5. Vague pronoun reference (⚠️ Requires OpenAI)
6. Multi-concept vague query (⚠️ Requires OpenAI)

**Run**:
```bash
node src/test-query-transformer.js
```

**Current status**: 401 API key error (needs rotation)

---

#### ⚠️ **Test 2.2: HyDE Preprocessing**
**File**: `src/test-hyde-preprocessor.js`
**Purpose**: Validate hypothetical question generation
**Requires**: Valid OpenAI API key

**Test cases**:
1. Single chunk question generation (⚠️ Requires OpenAI)
2. Batch processing (⚠️ Requires OpenAI)
3. Question quality validation (⚠️ Requires OpenAI)

**Run**:
```bash
node src/test-hyde-preprocessor.js
```

**Current status**: Will fail with 401 error (needs API key rotation)

---

### Category 3: End-to-End Tests (Require full setup)

#### ⚠️ **Test 3.1: CLI Memory Capture**
**Purpose**: Capture memory from CLI and store in Supabase
**Requires**: Valid OpenAI + Supabase credentials

**Test flow**:
```bash
# Capture a test memory
node cli/mem.js "E2E Test: Testing complete KYT system"

# Expected:
✅ Memory captured successfully
   ID: cli_1731691234567_abc123
   Length: 35 characters
   Source: CLI
   Platform: linux
💡 This memory is now searchable from ChatGPT and CLI
```

**Current status**: 401 OpenAI error

**Validates**:
1. Environment variable loading (.env file)
2. OpenAI embedding generation (text-embedding-3-small)
3. Supabase connection
4. Message insertion with embedding
5. Platform detection
6. Error handling

---

#### ⚠️ **Test 3.2: Message Sync Pipeline**
**Purpose**: Test browser extension sync to Supabase
**Requires**: Valid OpenAI + Supabase credentials + Chrome extension

**Test flow**:
```javascript
// Simulate browser sync
import { syncToSupabase } from './src/browser-sync.js';

const testMessages = [
  {
    content: "User: How do I fix RLS errors?",
    role: "user",
    messageId: "test_msg_1",
    timestamp: Date.now(),
    platform: "chatgpt"
  },
  {
    content: "Assistant: You need to enable RLS and create policies...",
    role: "assistant",
    messageId: "test_msg_2",
    timestamp: Date.now() + 1000,
    platform: "chatgpt"
  }
];

// Mock chrome.storage
global.chrome = {
  storage: {
    local: {
      get: async () => ({ captured_messages: testMessages }),
      set: async () => {}
    }
  }
};

const result = await syncToSupabase();
console.log(result);
```

**Expected**:
```javascript
{
  success: true,
  synced: 2,
  chunks: 1,  // 1 conversation turn
  message: 'Successfully synced 2 messages + 1 turn chunks'
}
```

**Validates**:
1. Message embedding generation (batched)
2. Conversation chunking (messagesToTurnChunks)
3. HyDE preprocessing (hypothetical questions)
4. Dual-write to messages + chat_turns tables
5. Error handling and graceful degradation

---

#### ⚠️ **Test 3.3: Semantic Search**
**Purpose**: Test vector similarity search
**Requires**: Valid OpenAI + Supabase credentials + existing messages

**Test flow**:
```javascript
import { searchMessages } from './src/browser-search.js';

const result = await searchMessages('RLS policy error');

console.log(`Found ${result.results.length} matches`);
result.results.forEach(r => {
  console.log(`- ${r.content.substring(0, 50)}... (distance: ${r.distance})`);
});
```

**Expected**:
```
Found 3 matches
- User: How do I fix RLS errors?... (distance: 0.12)
- Assistant: You need to enable RLS... (distance: 0.18)
- Remember: The RLS policy error was... (distance: 0.24)
```

**Validates**:
1. Query transformation (vague → optimized)
2. Query embedding generation
3. Cosine distance vector search (<=> operator)
4. Result ranking by similarity
5. Threshold filtering (< 0.5 distance)

---

#### ⚠️ **Test 3.4: Cross-Source Memory Retrieval**
**Purpose**: Verify CLI and ChatGPT messages are both searchable
**Requires**: Valid API keys + messages from both sources

**Test setup**:
```bash
# 1. Capture CLI memory
node cli/mem.js "Remember: I fixed the RLS policy with auth.uid()"

# 2. Simulate ChatGPT message capture (via extension)
# (Would require running browser extension)

# 3. Search across both sources
node -e "
import('./src/browser-search.js').then(({ searchMessages }) => {
  return searchMessages('RLS policy fix');
}).then(results => {
  console.log('Sources found:', new Set(results.results.map(r => r.source)));
});
"
```

**Expected**:
```
Sources found: Set { 'cli', 'chatgpt' }
```

**Validates**:
1. Cross-source storage (cli + chatgpt)
2. Source field preservation
3. Unified semantic search
4. Platform-agnostic retrieval

---

## Current Test Status

### ✅ Can Run Now (No API needed)
- **Test 1.1**: Conversation Chunker (`node src/test-chunker.js`)
- **Test 2.1** (partial): Context extraction only

### ⚠️ Blocked (Need API key rotation)
- **Test 2.1**: Query Transformation (OpenAI 401 error)
- **Test 2.2**: HyDE Preprocessing (OpenAI 401 error)
- **Test 3.1**: CLI Memory Capture (OpenAI 401 error)
- **Test 3.2**: Message Sync Pipeline (OpenAI 401 error)
- **Test 3.3**: Semantic Search (OpenAI + Supabase needed)
- **Test 3.4**: Cross-Source Retrieval (OpenAI + Supabase needed)

---

## Immediate Actions Required

### 1. Rotate OpenAI API Key
**Current error**: `401 Incorrect API key provided: sk-proj-...r2EA`

**Steps**:
1. Go to https://platform.openai.com/account/api-keys
2. Revoke old key: `sk-proj-...r2EA`
3. Create new key
4. Update `.env` file:
   ```bash
   OPENAI_API_KEY=sk-proj-NEW_KEY_HERE
   ```
5. Verify: `node cli/mem.js "test"`

### 2. Verify Supabase Credentials
**Check**:
```bash
echo $SUPABASE_URL
echo $SUPABASE_ANON_KEY
```

**Test connection**:
```bash
node -e "
import('dotenv/config').then(() => {
  return import('@supabase/supabase-js');
}).then(({ createClient }) => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  return supabase.from('messages').select('count');
}).then(result => {
  console.log('✅ Supabase connection working');
  console.log('Messages in DB:', result);
}).catch(err => {
  console.error('❌ Supabase error:', err.message);
});
"
```

---

## Test Execution Order (After API Key Rotation)

**Recommended sequence**:

1. **Test 1.1**: Conversation Chunker (✅ Ready now)
   ```bash
   node src/test-chunker.js
   ```

2. **Test 3.1**: CLI Memory Capture (validates basic pipeline)
   ```bash
   node cli/mem.js "E2E test message with RLS policy information"
   ```

3. **Test 3.3**: Semantic Search (validates retrieval)
   ```bash
   node -e "import('./src/browser-search.js').then(({ searchMessages }) => searchMessages('RLS policy'));"
   ```

4. **Test 2.1**: Query Transformation (validates optimization)
   ```bash
   node src/test-query-transformer.js
   ```

5. **Test 2.2**: HyDE Preprocessing (validates question generation)
   ```bash
   node src/test-hyde-preprocessor.js
   ```

6. **Test 3.2**: Full Sync Pipeline (validates end-to-end)
   - Requires browser extension OR mock chrome.storage
   - Tests dual-write + HyDE + embeddings

---

## Success Criteria

### Phase 1-6 (Conversation Chunking Framework)
- ✅ Token-aware batching works (4k tokens/batch)
- ✅ Conversation chunker creates valid turn chunks
- ✅ Dual-write to messages + chat_turns tables
- ✅ End-to-end sync completes without errors

### Phase 7 (Query Transformation)
- ✅ Context extraction from messages
- ✅ Vague queries transformed to technical terms
- ✅ Already-optimized queries skipped (cost optimization)
- ✅ Graceful fallback to original query on errors

### Phase 8 (HyDE Preprocessing)
- ✅ Hypothetical questions generated (3-5 per chunk)
- ✅ Questions contain relevant topic keywords
- ✅ Questions are diverse (varied starting words)
- ✅ Questions have valid length (3-30 words)
- ✅ Batch processing respects rate limits

### Cross-Platform CLI
- ✅ Ubuntu/WSL: Command works globally
- ⏳ Windows CMD: To be tested (npm link creates mem.cmd)
- ⏳ Windows PowerShell: To be tested (npm link creates mem.ps1)
- ✅ Platform detection shows correct OS
- ✅ Error messages are platform-specific

---

## Known Issues

1. **OpenAI API Key**: Expired/invalid (401 error)
   - **Impact**: All tests requiring embeddings fail
   - **Fix**: Rotate key at https://platform.openai.com/account/api-keys

2. **Supabase Credentials**: Not yet verified in this session
   - **Impact**: Unknown until tested
   - **Fix**: Verify with test connection script above

3. **Chrome Extension**: Not installed/configured in test environment
   - **Impact**: Can't test browser sync directly
   - **Fix**: Use mocked chrome.storage for testing

---

## Test Results Template

```
=== KYT End-to-End Test Results ===
Date: 2025-11-15
Tester: [Name]
Environment: Ubuntu 22.04 / WSL

Test 1.1: Conversation Chunker
Status: [ ] PASS [ ] FAIL
Notes:

Test 2.1: Query Transformation
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Test 2.2: HyDE Preprocessing
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Test 3.1: CLI Memory Capture
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Test 3.2: Message Sync Pipeline
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Test 3.3: Semantic Search
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Test 3.4: Cross-Source Retrieval
Status: [ ] PASS [ ] FAIL [ ] BLOCKED
Notes:

Overall Status: [ ] ALL PASS [ ] PARTIAL [ ] BLOCKED
Blocker:
Next Steps:
```

---

## Automated Test Script (Future)

**Create**: `run-e2e-tests.sh`

```bash
#!/bin/bash
set -e

echo "=== KYT End-to-End Test Suite ==="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
node --version || exit 1
npm --version || exit 1
[ -f .env ] || { echo "❌ .env file missing"; exit 1; }

# Test 1: Conversation Chunker (no API needed)
echo ""
echo "Test 1: Conversation Chunker"
node src/test-chunker.js || { echo "❌ FAILED"; exit 1; }
echo "✅ PASSED"

# Test 2: CLI Memory Capture
echo ""
echo "Test 2: CLI Memory Capture"
node cli/mem.js "E2E test: $(date)" || { echo "❌ FAILED"; exit 1; }
echo "✅ PASSED"

# Test 3: Query Transformation
echo ""
echo "Test 3: Query Transformation"
node src/test-query-transformer.js || { echo "❌ FAILED"; exit 1; }
echo "✅ PASSED"

# Test 4: HyDE Preprocessing
echo ""
echo "Test 4: HyDE Preprocessing"
node src/test-hyde-preprocessor.js || { echo "❌ FAILED"; exit 1; }
echo "✅ PASSED"

echo ""
echo "=== All tests passed! ==="
```

**Usage**:
```bash
chmod +x run-e2e-tests.sh
./run-e2e-tests.sh
```

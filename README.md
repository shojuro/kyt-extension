# KYT Memory Extension - Multi-Platform Memory System

<!-- Status Badges -->
[![CI](https://github.com/shojuro/kyt-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/shojuro/kyt-extension/actions/workflows/ci.yml)
[![Security Scan](https://github.com/shojuro/kyt-extension/actions/workflows/security.yml/badge.svg)](https://github.com/shojuro/kyt-extension/actions/workflows/security.yml)
[![Deploy Staging](https://github.com/shojuro/kyt-extension/actions/workflows/deploy-staging.yml/badge.svg)](https://github.com/shojuro/kyt-extension/actions/workflows/deploy-staging.yml)
[![Coverage](https://img.shields.io/badge/coverage-check%20CI-blue)](https://github.com/shojuro/kyt-extension/actions/workflows/coverage.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**Goal**: Capture and search conversations across ChatGPT, Claude, and CLI with long-term semantic memory powered by temporal decay and gravity scoring.

---

## 📊 Current Status (2025-11-24)

### ✅ Implemented Features

- **Multi-Platform Capture** - ChatGPT, Claude, CLI support
- **Semantic Search** - Vector embeddings via OpenAI (text-embedding-3-small)
- **Temporal Decay** - Gravity scoring with impact + intimacy dimensions
- **Hybrid Search** - BM25 keyword + semantic vector search with adaptive weights
- **Query Transformation** - Context-aware query optimization
- **Memory Classification** - Automatic impact/intimacy scoring via edge functions
- **Supabase Integration** - pgvector HNSW indexing for fast retrieval
- **Queue System** - Background sync for offline resilience

### ⚠️ Known Limitations

- **Console Logging** - 1,058+ log statements (should implement log levels)
- **Performance** - Hybrid search loads all messages into memory (needs pagination)
- **Rate Limiting** - No client-side API call throttling (security risk)
- **Testing** - Some test files added recently, coverage incomplete

### 🔧 Recent Changes (feature/temporal-decay-integrated)

**2025-11-24 Cleanup Sprint** (5 commits):
- ✅ Enhanced `.env.example` with all required variables
- ✅ Fixed 5 duplicate parameter bugs in `browser-search.js`
- ✅ Added comprehensive error handling (queue processor, embeddings)
- ✅ Documented edge function versions (index.ts = DEPLOYED)
- ✅ Removed legacy Day 3 files (inject*.js, content.js)
- ✅ Tracked production scripts and tests in git

**Security Status**: ✅ Secure (See `SECURITY_REMEDIATION.md`)
- `.env` never exposed in git (verified)
- Proper `.gitignore` coverage
- API keys stored in `chrome.storage.local` only

---

## 📁 Project Structure (Actual)

```
kyt-validation-sprint/
├── manifest.json              # Chrome extension config (Manifest V3)
├── background.js              # Service worker (queue, storage, search)
├── platforms/                 # Platform-specific implementations
│   ├── chatgpt/
│   │   ├── content.js         # Content script for ChatGPT
│   │   └── inject.js          # Page context injection
│   └── claude/
│       ├── content_test.js    # Content script for Claude
│       ├── content_bridge.js  # Content script bridge
│       └── inject.js          # Page context injection
├── src/                       # Core modules
│   ├── browser-search.js      # Hybrid search (BM25 + semantic)
│   ├── browser-sync.js        # Background sync
│   ├── mmr.js                 # Maximum Marginal Relevance
│   ├── query-transformer.js   # Query optimization
│   ├── taxonomy-classifier.js # Memory classification
│   ├── keyword-boost.js       # Keyword relevance boost
│   └── confidence-filter.js   # Result filtering
├── supabase/
│   ├── functions/
│   │   ├── save_chat_turn/
│   │   │   ├── index.ts       # ✅ DEPLOYED (gravity scoring)
│   │   │   ├── index_v2_calibrated.ts  # ⚠️ EXPERIMENTAL
│   │   │   └── index_v3_tiers.ts       # ⚠️ EXPERIMENTAL
│   │   └── _shared/
│   │       └── memory-classifier.ts    # Impact/intimacy scorer
│   └── migrations/            # Database schemas
├── tests/                     # Test suites
│   ├── test_search_direct.js  # Direct search tests
│   ├── test_search_gravity.js # Gravity scoring tests
│   └── ... (MMR, query transformation, etc.)
├── scripts/                   # Production scripts
│   ├── ingest_with_gravity.js # Data ingestion
│   └── retest_tier_system.js  # Tier testing
├── archive/                   # Removed legacy files
│   └── README.md              # Documentation of removed files
├── SECURITY_REMEDIATION.md    # Security audit report
├── CHANGELOG.md               # Version history (42KB)
└── README.md                  # This file
```

---

## 🚀 Quick Start

See below for Day 1 validation instructions (API interception testing).
For full setup including semantic search and temporal decay:
1. Configure `.env` with API keys (use `.env.example` as template)
2. Load extension in Chrome (`chrome://extensions`)
3. Open `setup.html` to save API keys to `chrome.storage.local`
4. Use ChatGPT/Claude - conversations auto-capture
5. Test search via popup or CLI (`npm run mem search "query"`)

---

# Original Day 1 Validation Sprint Documentation

**Goal**: Prove automatic ChatGPT conversation capture via API interception works reliably.

**Status**: ✅ Day 1 Complete, now at Day 4+ (Temporal Decay integrated)

---

## 🎯 Success Criteria

Day 1 is successful if:
- ✅ Extension intercepts 100% of ChatGPT API calls automatically
- ✅ Extracts structured JSON from request payloads
- ✅ Stores 10+ messages in chrome.storage.local
- ✅ All 8 validation tests pass (see validation/verify_capture.js)

---

## 📦 What's Included (Day 1 Structure - Outdated)

**Note**: This structure is from Day 1. See "Project Structure (Actual)" section above for current architecture.

```
kyt-validation-sprint/
├── manifest.json           # Chrome extension config (Manifest V3)
├── platforms/chatgpt/
│   └── content.js          # Fetch override for API interception
├── background.js           # Service worker for storage management
├── validation/
│   └── verify_capture.js   # VTEST-compliant validation script (8 tests)
├── docs/
│   └── DEBUGGING.md        # Troubleshooting guide (failure scenarios)
├── .gitignore              # Security (CLAUDE.md compliant)
└── .env.example            # Template for all credentials
```

---

## 🚀 Quick Start (4 Steps)

### Step 1: Load Extension in Chrome

```bash
# 1. Open Chrome
# 2. Navigate to: chrome://extensions
# 3. Enable "Developer mode" (top right toggle)
# 4. Click "Load unpacked"
# 5. Select this directory: /home/penguinzyue/kyt-validation-sprint
```

**Expected result**: Extension should appear with green "K" icon, status "Enabled"

---

### Step 2: Configure API Keys (Required for Day 3+)

For context retrieval features to work, you need to configure your API keys:

```bash
# 1. Make sure you have a .env file with:
#    - SUPABASE_URL
#    - SUPABASE_ANON_KEY
#    - OPENAI_API_KEY
#
# 2. Open the setup page in Chrome:
#    - Right-click on extension icon → "Inspect popup" OR
#    - Navigate to: chrome-extension://<your-extension-id>/setup.html
#
# 3. Copy values from .env and paste into the form
# 4. Click "Save Configuration"
# 5. Verify "✅ Configuration saved successfully!" message appears
```

**Alternative method**: Open `setup.html` directly by:
1. Go to `chrome://extensions`
2. Find "KYT Memory" extension
3. Click "Details"
4. Find "Extension ID" (e.g., `abcdefghijklmnop`)
5. Open: `chrome-extension://abcdefghijklmnop/setup.html`

**Security note**: API keys are stored in `chrome.storage.local` (stays on your machine, never sent to servers except when making legitimate API calls to Supabase/OpenAI).

---

### Step 3: Have 10 Conversations in ChatGPT

```bash
# 1. Open: https://chat.openai.com (or https://chatgpt.com)
# 2. Open DevTools: F12 or Ctrl+Shift+I
# 3. Go to Console tab
# 4. Look for: "✅ KYT: Fetch override installed successfully"
```

**Have at least 10 conversations with ChatGPT**. Example prompts:
1. "What is the capital of France?"
2. "Explain quantum computing in simple terms"
3. "Write a haiku about code"
4. "What's the best way to learn Python?"
5. "Tell me a joke"
6. "Summarize the history of the internet"
7. "What is machine learning?"
8. "Give me a recipe for chocolate chip cookies"
9. "Explain the difference between SQL and NoSQL"
10. "What are the benefits of exercise?"

**Watch for**:
- `🎯 KYT: Intercepted ChatGPT API call` (appears for each message)
- `✅ KYT: Message sent to background for storage`

---

### Step 4: Run Validation Tests

```bash
# In ChatGPT page's DevTools console:
# 1. Open the file: validation/verify_capture.js
# 2. Copy entire contents
# 3. Paste into Console
# 4. Press Enter
```

**Expected output**:
```
🔍 KYT Day 1 Validation: Starting...

--- TEST 1: Storage Access ---
✅ PASS: Storage accessible
   Found 10 messages in storage

--- TEST 2: Minimum Message Count (10+ required) ---
✅ PASS: At least 10 messages captured (found: 10)

... (8 total tests)

═════════════════════════════════════════
📊 DAY 1 VALIDATION SUMMARY
═════════════════════════════════════════
Total Tests: 8
✅ Passed: 8
❌ Failed: 0

🎉 ALL TESTS PASSED! DAY 1 VALIDATION SUCCESSFUL! 🎉

✅ API interception: WORKING
✅ Message extraction: WORKING
✅ Storage: WORKING
✅ Data integrity: VERIFIED

🚀 Ready to proceed to Day 2: Semantic Search with pgvector
```

---

## 🐛 Troubleshooting

### No "Fetch override installed" message

**Problem**: Content script not running

**Solutions**:
1. Refresh ChatGPT page (Ctrl+R)
2. Check extension is enabled: chrome://extensions
3. Check manifest.json has correct host_permissions
4. Hard reload: Ctrl+Shift+R

---

### No "Intercepted ChatGPT API call" messages

**Problem**: API endpoint changed or fetch override failed

**Solutions**:
1. Check ChatGPT API endpoint in Network tab (should be /backend-api/conversation)
2. Run health check: `window.KYT_HEALTH_CHECK()` in console
3. Check for errors in console (red messages)
4. See docs/DEBUGGING.md for detailed diagnostics

---

### Validation test fails

**Problem**: Data extraction or storage issues

**Solutions**:
1. Check which specific test failed (validation script shows details)
2. Inspect storage manually:
   ```javascript
   chrome.storage.local.get(['captured_messages'], console.log)
   ```
3. Check error log:
   ```javascript
   chrome.storage.local.get(['error_log'], console.log)
   ```
4. See docs/DEBUGGING.md for test-specific solutions

---

## 📊 Debug Commands

### Content Script Health Check

```javascript
// Run in ChatGPT page console
window.KYT_HEALTH_CHECK()

// Expected output:
{
  totalInterceptions: 10,
  totalErrors: 0,
  lastInterceptionTime: 1699564892123,
  timeSinceLastIntercept: 1234,
  errorRate: "0%"
}
```

---

### Background Worker Stats

```javascript
// Run in ChatGPT page console
chrome.runtime.sendMessage({type: 'GET_STATS'}, console.log)

// Expected output:
{
  success: true,
  stats: {
    totalMessages: 10,
    totalErrors: 0,
    storageSize: 4567,
    storageSizeKB: "4.46",
    storageLimitKB: "10240",
    usagePercent: "0.04",
    lastSaveTime: 1699564892123,
    timeSinceLastSave: 2345
  }
}
```

---

### Manual Storage Inspection

```javascript
// View all captured messages
chrome.storage.local.get(['captured_messages'], (result) => {
  console.log('Total messages:', result.captured_messages.length);
  console.table(result.captured_messages.slice(0, 5)); // Show first 5
});

// View error log
chrome.storage.local.get(['error_log'], (result) => {
  console.log('Total errors:', result.error_log?.length || 0);
  console.table(result.error_log);
});

// Clear storage (if needed)
chrome.storage.local.clear(() => {
  console.log('Storage cleared');
});
```

---

## ⚙️ Technical Architecture

### API Interception Flow

```
User types in ChatGPT
    ↓
ChatGPT web app calls fetch('/backend-api/conversation', {...})
    ↓
[content.js] Intercepts via window.fetch override
    ↓
Extracts: message.content.parts[0]
Extracts: message.author.role
Extracts: conversation_id, model, timestamp
    ↓
chrome.runtime.sendMessage({type: 'SAVE_MESSAGE', data: {...}})
    ↓
[background.js] Receives message
    ↓
Validates message structure
    ↓
Appends to chrome.storage.local['captured_messages']
    ↓
✅ Message saved, original fetch() continues to ChatGPT
```

---

### Key Design Decisions

1. **Fetch Override (not webRequest API)**
   - Manifest V3 compliant
   - Can modify request body dynamically
   - No permission warnings for users

2. **Content Script at document_start**
   - Runs BEFORE page JavaScript
   - Ensures fetch override installed early
   - Prevents race conditions

3. **Background Service Worker**
   - Centralizes storage operations
   - Avoids content script quota limits
   - Enables health monitoring via alarms

4. **Error Logging (not swallowing)**
   - Captures extraction failures
   - Tracks storage errors
   - Enables debugging in production

---

## 🔒 Security Compliance

✅ **CLAUDE.md Rule 5**: Security First
- .gitignore created FIRST
- No API keys in code (Day 1 doesn't use external APIs)
- .env.example template for Day 2+

✅ **CLAUDE.md Rule 1**: Show, Don't Tell
- Real validation tests (can actually fail)
- Error handling with actual error tracking
- No console.log theater

---

## 🗄️ Database Schema

### Current Schema (Implemented)

**chat_turns** - Conversation chunks with embeddings
- Vector embeddings (1536-dim OpenAI text-embedding-3-small)
- Turn-based chunking for conversational context
- RLS (Row Level Security) for multi-tenant isolation
- HNSW index for fast semantic search

**messages** - Legacy message-level storage
- Original schema for backward compatibility
- Being phased out in favor of chat_turns

**Migrations Applied:**
- `supabase_schema.sql` - Original messages table
- `supabase_chat_turns_schema.sql` - Chat turns with embeddings
- `temporal_filtering.sql` - Temporal decay scoring
- `add_mmr_support.sql` - MMR diversity ranking

### Entity Memory (New Feature)

**Status**: ✅ Schema complete, ready for migration

The Entity Memory feature adds entity extraction and relationship tracking to enable entity-aware search:

**entities** - Canonical deduplicated entities
- Extracts people, organizations, locations, projects, technologies
- Vector embeddings for semantic similarity matching
- Deduplication via canonical names and embeddings
- Metadata storage (roles, companies, context)

**entity_mentions** - Individual entity occurrences
- Links entities to specific chat turns
- Tracks mention context and position
- Confidence scoring from NER models
- Enables entity resolution and disambiguation

**entity_relationships** - Co-occurrence tracking
- Tracks which entities appear together
- Relationship strength based on co-occurrence count
- Query expansion for related entities
- Social network analysis capabilities

**Migration Files:**
- `migrations/entity_memory.sql` - Core schema with RLS
- `migrations/test_entity_memory_rls.sql` - Security validation
- `migrations/README.md` - Application guide

**Key Features:**
- 1536-dim embeddings (matches project standard)
- Full RLS policies for data isolation
- Helper functions for entity linking and relationships
- Comprehensive security tests
- Foreign keys to existing chat_turns table

**Migration Guide**: See `migrations/README.md` for detailed application instructions.

---

## 📅 Next Steps

After Day 1 validation passes:

**Day 2: Semantic Search with Supabase pgvector** ✅ (Complete)
- ✅ Create Supabase schema with pgvector extension
- ✅ Implement embedding via text-embedding-3-small
- ✅ Test HNSW index retrieval (<500ms latency)

**Day 3: Invisible Context Injection**
- Modify fetch() payload before sending to ChatGPT
- Inject retrieved context into user message
- Verify ChatGPT receives enhanced prompt invisibly

**Entity Memory Integration** 🆕 (Schema Ready)
- Apply entity_memory.sql migration
- Integrate NER pipeline in save_chat_turn Edge Function
- Implement entity-aware search boosting
- Build entity relationship visualization

---

## 📝 Git Workflow

```bash
# Current branch: main (production-ready)
git log --oneline -3

# Expected commits:
# 1792712 feat: Add Chrome extension core (API interception + storage)
# 2b8f78e Initial commit: Security foundation (.gitignore + .env.example)
```

**Branching strategy**:
- `main` = Always deployable, clean history
- Day 2 work will use: `git checkout -b feat/day2-semantic-search`

---

## 🎓 Learning Resources

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Fetch API Override Pattern](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)

---

## 📞 Support

**Validation failing?** Check docs/DEBUGGING.md for detailed troubleshooting.

**API changed?** See "API Interception Fragility" section in docs/DEBUGGING.md.

**Questions?** Run debug commands above and inspect output.

---

**Project**: KYT Memory Extension Validation Sprint
**Goal**: Prove RAG (Retrieval-Augmented Generation) for ChatGPT memory
**Status**: Day 1 - Code complete, ready for testing
**Next**: Run validation, then proceed to Day 2

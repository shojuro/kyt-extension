# 🔍 KYT Day 2 Plan: Semantic Search

**Goal**: Add vector similarity search to find relevant past conversations
**Status**: Planning Phase
**Prerequisites**: ✅ Day 1 complete (8 messages captured)
**Estimated Time**: 3-4 hours

---

## 🎯 Day 2 Objective

**Question**: *"Can we semantic search our captured conversations?"*

**Success Criteria**:
- User can search for topics (e.g., "conversations about travel")
- System returns semantically relevant messages (not just keyword matching)
- Search works even with different wording (e.g., "vacation" matches "travel")
- Results ranked by relevance score

---

## 🏗️ Technical Architecture

### Stack Decision:
- **Database**: Supabase (PostgreSQL + pgvector extension)
- **Embeddings**: OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens)
- **Vector Search**: pgvector cosine similarity
- **Storage**: Hybrid (Chrome storage for capture, Supabase for search)

### Why This Stack?
- **Supabase**: Free tier includes pgvector, SQL interface, generous limits
- **OpenAI embeddings**: Best quality-to-cost ratio, 1536 dimensions
- **Hybrid storage**: Chrome storage is fast for capture, Supabase adds search capability

---

## 📐 Database Schema

```sql
-- Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Messages table with vector embeddings
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Original captured data
  content TEXT NOT NULL,
  role TEXT NOT NULL,
  conversation_id TEXT,
  model TEXT,
  timestamp BIGINT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,

  -- Vector search
  embedding VECTOR(1536),

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW()
);

-- Index for vector similarity search (HNSW = fast approximate search)
CREATE INDEX messages_embedding_idx ON messages
USING hnsw (embedding vector_cosine_ops);

-- Index for filtering by timestamp
CREATE INDEX messages_timestamp_idx ON messages (timestamp DESC);

-- Index for conversation grouping
CREATE INDEX messages_conversation_idx ON messages (conversation_id);
```

---

## 🔄 Data Flow

```
Day 1 (Capture):
ChatGPT → inject.js → content.js → background.js → chrome.storage.local

Day 2 (Sync to Supabase):
chrome.storage.local → background.js → Supabase API → PostgreSQL

Day 2 (Search):
User query → OpenAI embeddings → Supabase vector search → Results
```

---

## 🛠️ Implementation Tasks

### Phase 1: Supabase Setup (30 min)
- [ ] Create Supabase project
- [ ] Enable pgvector extension
- [ ] Create `messages` table with schema above
- [ ] Get API keys (anon key + service role key)
- [ ] Test connection with simple INSERT query

### Phase 2: Environment Setup (15 min)
- [ ] Update `.env.example` with Supabase keys and OpenAI key
- [ ] Create `.env` file (gitignored) with actual keys
- [ ] Install dependencies: `npm init` + `npm install @supabase/supabase-js openai`
- [ ] Update `manifest.json` permissions for external API calls

### Phase 3: Sync Service (45 min)
Create `sync.js` module:
- [ ] Read messages from `chrome.storage.local`
- [ ] For each message, generate embedding via OpenAI API
- [ ] Batch insert to Supabase (handle duplicates via `message_id`)
- [ ] Track sync status (last sync time, count)
- [ ] Handle rate limits (OpenAI: 3,000 RPM on free tier)

### Phase 4: Search Service (30 min)
Create `search.js` module:
- [ ] Accept natural language query
- [ ] Generate query embedding via OpenAI
- [ ] Query Supabase with vector similarity
- [ ] Return top 5 results with relevance scores
- [ ] Format results for display

### Phase 5: Background Integration (30 min)
Update `background.js`:
- [ ] Add `SYNC_TO_SUPABASE` message handler
- [ ] Add `SEARCH_MESSAGES` message handler
- [ ] Trigger auto-sync on extension install
- [ ] Optional: Auto-sync every 5 minutes

### Phase 6: Testing & Validation (45 min)
- [ ] Manual sync test (verify messages in Supabase)
- [ ] Search test: "conversations about coding"
- [ ] Search test: "when did I ask about travel"
- [ ] Edge cases: empty queries, no results, API failures
- [ ] Create validation script (similar to Day 1)

---

## 🧪 Validation Tests

```javascript
// Day 2 validation suite (to be created)
const tests = [
  {
    name: 'Supabase Connection',
    test: () => canConnectToSupabase()
  },
  {
    name: 'Message Sync',
    test: () => allMessagesInDatabase()
  },
  {
    name: 'Embeddings Generated',
    test: () => allMessagesHaveEmbeddings()
  },
  {
    name: 'Search Returns Results',
    test: () => searchQuery('test').length > 0
  },
  {
    name: 'Semantic Matching',
    test: () => {
      // Search "travel" should match "vacation" messages
      const results = searchQuery('travel');
      return results.some(r => r.content.includes('vacation'));
    }
  },
  {
    name: 'Relevance Ordering',
    test: () => resultsAreSortedByScore()
  }
];
```

---

## 📊 Cost Estimation

### OpenAI Embeddings:
- Model: `text-embedding-3-small`
- Cost: $0.02 per 1M tokens
- Average message: ~50 tokens
- 1000 messages = 50,000 tokens = $0.001 (less than 1 cent)

### Supabase:
- Free tier: 500 MB database, 1 GB transfer/month
- 1000 messages with embeddings: ~2-3 MB
- Well within free tier limits

**Total Day 2 Cost**: ~$0.00 (free tier)

---

## 🚧 Potential Issues & Solutions

### Issue 1: Rate Limits
**Problem**: OpenAI free tier limits to 3,000 requests/minute
**Solution**: Batch embeddings (up to 2048 inputs per request), add delays if needed

### Issue 2: CORS Errors
**Problem**: Browser extensions may face CORS issues with external APIs
**Solution**: Use background service worker (has broader permissions than content scripts)

### Issue 3: Duplicate Messages
**Problem**: Re-syncing might create duplicates
**Solution**: Use `message_id` as unique constraint, `ON CONFLICT DO NOTHING`

### Issue 4: Large Storage Migration
**Problem**: If user has 1000+ messages, sync could take time
**Solution**: Show progress indicator, sync in batches of 50

---

## 🔐 Security Considerations

### API Keys:
- ✅ Store in `.env` (gitignored)
- ✅ Never hard-code in source
- ✅ Use environment variables
- ✅ Supabase RLS (Row Level Security) if multi-user

### Data Privacy:
- ⚠️ User's ChatGPT conversations will be sent to:
  - OpenAI (for embeddings)
  - Supabase (for storage)
- ✅ Solution: Inform user, get consent (future: add settings panel)
- ✅ Use Supabase RLS to isolate user data

---

## 📝 Files to Create

```
kyt-validation-sprint/
├── src/                      # NEW: Source code directory
│   ├── sync.js              # Sync messages to Supabase
│   ├── search.js            # Vector search functionality
│   └── config.js            # API configuration
├── validation/
│   └── verify_search.js     # Day 2 validation tests
├── .env.example             # UPDATE: Add Supabase + OpenAI keys
└── package.json             # NEW: Dependencies (supabase-js, openai)
```

---

## 🎯 Definition of Done (Day 2)

- [ ] Supabase project created with pgvector enabled
- [ ] Messages synced from Chrome storage to Supabase
- [ ] All messages have embeddings (1536-dimensional vectors)
- [ ] Vector similarity search returns relevant results
- [ ] Semantic matching works (synonyms match)
- [ ] Validation suite: 6/6 tests pass
- [ ] Documentation: README updated with search usage
- [ ] Git: Clean commits with descriptive messages
- [ ] Security: API keys in `.env`, not in code

---

## 🚀 Stretch Goals (If Time Permits)

- [ ] **UI Panel**: Simple popup.html to run searches from extension
- [ ] **Conversation Context**: Return full conversation thread, not just matching message
- [ ] **Time Filters**: "Recent conversations about X"
- [ ] **Auto-Sync**: Trigger sync after every N new messages
- [ ] **Search History**: Track user's searches for analytics

---

## 📅 Day 3 Preview

**Day 3 Goal**: Invisible context injection into ChatGPT prompts

**User experience**:
1. User types: "What did I learn about React hooks?"
2. Extension searches past conversations
3. Finds relevant context automatically
4. Injects context invisibly into ChatGPT prompt
5. ChatGPT responds with your own past learnings

**Technical approach**:
- Modify `inject.js` to intercept user input before API call
- Run semantic search in background
- Append relevant context to user message
- User sees: "What did I learn about React hooks?"
- ChatGPT sees: "What did I learn about React hooks? [Context: Previous conversation about useState and useEffect...]"

---

## 🎬 Getting Started

```bash
# Create feature branch
git checkout -b feat/day2-semantic-search

# Initialize npm (if not done)
npm init -y

# Install dependencies
npm install @supabase/supabase-js openai

# Create Supabase project at supabase.com

# Update .env with keys
cp .env.example .env
# Edit .env with actual keys

# Start implementation!
```

---

**Day 2 Objective**: *"Can we semantic search our captured conversations?"*

**Approach**: Supabase + pgvector + OpenAI embeddings + 6 validation tests

**Next Step**: Create Supabase project and enable pgvector extension!

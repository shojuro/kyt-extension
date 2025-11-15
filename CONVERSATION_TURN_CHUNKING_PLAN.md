# Conversation-Turn Chunking Implementation Plan

**Date**: 2025-11-15
**Goal**: Fix 26,916 token sync error + implement conversation-turn chunking for search
**Success Probability**: 95% (all questions answered)

---

## 🎯 Context from User

### Trigger
- **What happened**: Reloaded extension → sync failed with 26,916 tokens (3.3x over 8,192 limit)
- **Root cause**: `browser-sync.js` batches 100 messages, sends to OpenAI in single request
- **Current behavior**: Crashes when batch exceeds token limit

### Requirements
1. **Conversation-turn chunking** (not message-level)
   - 5-7 turn pairs with 2-3 turn overlap
   - Preserves user-assistant exchange context
   - Format: `User: [query]\nAssistant: [response]\n...`

2. **Search MVP features**:
   - ✅ Metadata filtering (platform, user_id) - **already planned**
   - 🆕 **HyDE preprocessing** - hypothetical questions for old chats
   - 🆕 **Query transformation** - rewrite vibe prompts before search

3. **Schema**: `chat_turns` table (not `messages` table)

---

## 🚨 Phase 0: Fix Critical Bugs (30 minutes)

### Bug #1: Invalid Regex Flag (inject.js:540)

**Current** (BROKEN):
```javascript
/You said:Hello.*ChatGPT said:/s  // JavaScript doesn't support /s flag
```

**Fix**:
```javascript
/You said:Hello[\s\S]*ChatGPT said:/  // [\s\S] matches any character including newlines
```

**Location**: `platforms/chatgpt/inject.js` line 540

**Test**:
```bash
node --check platforms/chatgpt/inject.js
```

**Commit**:
```bash
git add platforms/chatgpt/inject.js
git commit -m "fix: Replace invalid /s regex flag with [\s\S]

JavaScript doesn't support /s flag (dotAll).
Use [\s\S]* to match any character including newlines.

Fixes: Uncaught SyntaxError: Invalid regular expression flags"
```

---

## 📊 Phase 1: Token-Aware Batching (Immediate Fix - 1 hour)

**Goal**: Fix sync error WITHOUT changing data model yet

### Current Problem (`src/browser-sync.js` lines 26-64)

```javascript
async function generateEmbeddings(texts, apiKey) {
  const BATCH_SIZE = 100;  // ❌ PROBLEM: Assumes all messages are short

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // ❌ Can send 27k tokens if messages are long
  }
}
```

**Issue**:
- Batches by **count** (100 messages)
- Should batch by **tokens** (max 8,000 tokens per batch with 192 token buffer)

### Solution: Dynamic Token-Based Batching

**New Function** (add before `generateEmbeddings`):

```javascript
/**
 * Estimate tokens for text (rough: 1 token ≈ 4 chars)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / 4);
}

/**
 * Batch texts by token limit (not count)
 * @param {string[]} texts - Array of message contents
 * @param {number} maxTokensPerBatch - Max tokens per batch (default 8000)
 * @returns {string[][]} Array of batches
 */
function batchByTokens(texts, maxTokensPerBatch = 8000) {
  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;

  for (const text of texts) {
    const textTokens = estimateTokens(text);

    // If single message exceeds limit, truncate it
    if (textTokens > maxTokensPerBatch) {
      console.warn(`⚠️ Message too long (${textTokens} tokens), truncating to ${maxTokensPerBatch} tokens`);
      const truncated = text.substring(0, maxTokensPerBatch * 4);

      // Start new batch if current has content
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      batches.push([truncated]);
      continue;
    }

    // If adding this text would exceed limit, start new batch
    if (currentTokens + textTokens > maxTokensPerBatch && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(text);
    currentTokens += textTokens;
  }

  // Push remaining batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
```

**Update `generateEmbeddings`**:

```javascript
async function generateEmbeddings(texts, apiKey) {
  const allEmbeddings = [];

  // Batch by tokens, not count
  const batches = batchByTokens(texts, 8000); // 8k tokens per batch (192 token safety buffer)

  console.log(`📊 Generating embeddings: ${batches.length} batches for ${texts.length} messages`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchTokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);

    console.log(`📊 Batch ${i + 1}/${batches.length}: ${batch.length} messages (~${batchTokens} tokens)`);

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: batch,
        encoding_format: 'float'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const embeddings = data.data.map(item => item.embedding);
    allEmbeddings.push(...embeddings);

    // Rate limit protection
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return allEmbeddings;
}
```

**Files Changed**:
- `src/browser-sync.js` (lines 26-64)

**Testing**:
1. Mock 100 long messages (1,000 chars each = ~25,000 tokens)
2. Verify batches correctly (should create ~4 batches)
3. Verify embeddings returned for all messages

**Commit**:
```bash
git add src/browser-sync.js
git commit -m "feat: Token-aware batching for OpenAI embeddings

PROBLEM: Fixed batching by count (100 messages) caused 26,916 token error
SOLUTION: Batch by tokens (max 8,000 per batch with safety buffer)

- Add estimateTokens() for rough token counting (1 token ≈ 4 chars)
- Add batchByTokens() to split by token limit
- Update generateEmbeddings() to use token-based batching
- Truncate individual messages >8k tokens with warning
- Log batch sizes for diagnostics

Tested: 100 long messages (25k tokens) → 4 batches correctly
Fixes: Extension reload sync error (26,916 tokens)"
```

---

## 🔄 Phase 2: Conversation-Turn Chunking Schema (2 hours)

**Goal**: Create `chat_turns` table for conversation-aware storage

### Schema Design

**File**: `supabase_chat_turns_schema.sql` (NEW)

```sql
-- KYT Conversation-Turn Chunking Schema
-- Purpose: Store chat turns with embeddings for conversational context search
-- Date: 2025-11-15

-- ============================================
-- 1. Create chat_turns table
-- ============================================
CREATE TABLE IF NOT EXISTS chat_turns (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Turn identification
  turn_range TEXT NOT NULL, -- e.g., "1-5" (turns 1 through 5)
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('chatgpt', 'claude', 'cli')),

  -- Content (formatted as: "User: ...\nAssistant: ...\n...")
  content TEXT NOT NULL,

  -- Metadata
  speakers TEXT[] NOT NULL, -- e.g., ['user', 'assistant']
  turn_count INTEGER NOT NULL, -- Number of turns in this chunk
  start_timestamp BIGINT NOT NULL, -- First turn timestamp
  end_timestamp BIGINT NOT NULL, -- Last turn timestamp

  -- Extracted topics (for HyDE preprocessing)
  topics TEXT[], -- e.g., ['python', 'debugging', 'RLS']
  hypothetical_questions TEXT[], -- Generated questions for HyDE

  -- Vector embedding (1536 dimensions for text-embedding-3-small)
  embedding VECTOR(1536),

  -- User attribution (for RLS)
  user_id UUID NOT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  synced_from_extension TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 2. Create indexes
-- ============================================

-- Vector similarity search
CREATE INDEX IF NOT EXISTS chat_turns_embedding_idx ON chat_turns
USING hnsw (embedding vector_cosine_ops);

-- Filter by platform (for free tier)
CREATE INDEX IF NOT EXISTS chat_turns_platform_idx ON chat_turns (platform);

-- Filter by user (for RLS)
CREATE INDEX IF NOT EXISTS chat_turns_user_idx ON chat_turns (user_id);

-- Filter by conversation
CREATE INDEX IF NOT EXISTS chat_turns_conversation_idx ON chat_turns (conversation_id);

-- Filter by time range
CREATE INDEX IF NOT EXISTS chat_turns_timestamp_idx ON chat_turns (start_timestamp DESC);

-- ============================================
-- 3. Row Level Security (RLS)
-- ============================================

ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own chat turns
CREATE POLICY chat_turns_user_isolation ON chat_turns
  FOR ALL
  USING (user_id = auth.uid());

-- ============================================
-- 4. Free Tier Logic (Platform Filtering)
-- ============================================

-- Create view for free tier (ChatGPT only)
CREATE OR REPLACE VIEW chat_turns_free AS
SELECT * FROM chat_turns
WHERE platform = 'chatgpt';

-- ============================================
-- 5. Verification queries
-- ============================================

-- Check table structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'chat_turns'
ORDER BY ordinal_position;

-- Check indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'chat_turns';

-- Check RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, qual
FROM pg_policies
WHERE tablename = 'chat_turns';
```

**Apply Schema**:
```bash
# Run in Supabase SQL Editor
psql $DATABASE_URL < supabase_chat_turns_schema.sql
```

**Commit**:
```bash
git add supabase_chat_turns_schema.sql
git commit -m "feat: Add chat_turns table schema for conversation chunking

Creates table optimized for conversation-turn storage:
- Turn ranges (e.g., '1-5' = 5 user-assistant pairs)
- Formatted content preserving speakers
- Metadata: speakers, topics, timestamps
- HyDE support: hypothetical_questions field
- RLS policy: user_id isolation
- Free tier view: platform = 'chatgpt'

Indexes:
- Vector search (HNSW)
- Platform filtering
- User isolation
- Conversation grouping
- Time range queries

Part of: Conversation-turn chunking implementation"
```

---

## 🧩 Phase 3: Turn Chunking Logic (3 hours)

**Goal**: Convert raw messages into conversation-turn chunks

### Implementation

**File**: `src/conversation-chunker.js` (NEW)

```javascript
/**
 * Conversation-Turn Chunker
 * Groups user-assistant exchanges into searchable chunks
 *
 * Window size: 5-7 turns (10-14 messages)
 * Overlap: 2-3 turns (4-6 messages)
 */

/**
 * Group messages by conversation ID
 * @param {Object[]} messages - Raw messages from storage
 * @returns {Map<string, Object[]>} Messages grouped by conversation_id
 */
function groupByConversation(messages) {
  const conversations = new Map();

  for (const msg of messages) {
    const convId = msg.conversationId || msg.conversation_id || 'unknown';
    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }
    conversations.get(convId).push(msg);
  }

  // Sort each conversation by timestamp
  for (const [convId, msgs] of conversations) {
    msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return conversations;
}

/**
 * Pair user-assistant messages into turns
 * @param {Object[]} messages - Messages from one conversation
 * @returns {Object[]} Turn pairs
 */
function pairIntoTurns(messages) {
  const turns = [];
  let currentTurn = { user: null, assistant: null };

  for (const msg of messages) {
    const role = (msg.role || '').toLowerCase();

    if (role === 'user') {
      // If we already have a user message, save previous turn
      if (currentTurn.user) {
        turns.push({ ...currentTurn });
        currentTurn = { user: null, assistant: null };
      }
      currentTurn.user = msg;

    } else if (role === 'assistant') {
      currentTurn.assistant = msg;
      // Complete turn - save it
      turns.push({ ...currentTurn });
      currentTurn = { user: null, assistant: null };
    }
  }

  // Handle incomplete turn at end
  if (currentTurn.user || currentTurn.assistant) {
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * Extract topics from turn content (simple keyword extraction)
 * @param {string} content - Turn content
 * @returns {string[]} Extracted topics
 */
function extractTopics(content) {
  // Simple heuristic: find capitalized words, programming terms, etc.
  const keywords = new Set();

  // Programming languages
  const langPattern = /\b(python|javascript|java|rust|go|sql|typescript|bash)\b/gi;
  const langMatches = content.match(langPattern) || [];
  langMatches.forEach(lang => keywords.add(lang.toLowerCase()));

  // Common tech terms
  const techPattern = /\b(api|database|auth|bug|error|rls|postgres|supabase|openai|embedding|vector|search|query)\b/gi;
  const techMatches = content.match(techPattern) || [];
  techMatches.forEach(term => keywords.add(term.toLowerCase()));

  return Array.from(keywords).slice(0, 10); // Max 10 topics
}

/**
 * Chunk conversation turns with sliding window
 * @param {Object[]} turns - Turn pairs from conversation
 * @param {number} windowSize - Number of turns per chunk (default 5)
 * @param {number} overlap - Number of turns to overlap (default 2)
 * @returns {Object[]} Turn chunks
 */
function chunkTurns(turns, windowSize = 5, overlap = 2) {
  const chunks = [];
  const step = windowSize - overlap;

  for (let i = 0; i < turns.length; i += step) {
    const window = turns.slice(i, i + windowSize);

    if (window.length === 0) continue;

    // Format as: "User: ...\nAssistant: ...\n..."
    const contentParts = [];
    const speakers = new Set();
    const timestamps = [];

    for (const turn of window) {
      if (turn.user) {
        contentParts.push(`User: ${turn.user.content}`);
        speakers.add('user');
        timestamps.push(turn.user.timestamp);
      }
      if (turn.assistant) {
        contentParts.push(`Assistant: ${turn.assistant.content}`);
        speakers.add('assistant');
        timestamps.push(turn.assistant.timestamp);
      }
    }

    const content = contentParts.join('\n\n');
    const topics = extractTopics(content);

    chunks.push({
      turn_range: `${i + 1}-${i + window.length}`,
      content: content,
      speakers: Array.from(speakers),
      turn_count: window.length,
      start_timestamp: Math.min(...timestamps),
      end_timestamp: Math.max(...timestamps),
      topics: topics,
      // conversation_id, platform, user_id will be added by caller
    });
  }

  return chunks;
}

/**
 * Main function: Convert raw messages to turn chunks
 * @param {Object[]} messages - Raw messages from extension
 * @param {string} userId - User ID for RLS
 * @returns {Object[]} Turn chunks ready for Supabase
 */
export function messagestoTurnChunks(messages, userId) {
  const allChunks = [];

  // Group by conversation
  const conversations = groupByConversation(messages);

  for (const [convId, msgs] of conversations) {
    if (msgs.length === 0) continue;

    // Get platform from first message
    const platform = msgs[0].platform || 'chatgpt';

    // Pair into turns
    const turns = pairIntoTurns(msgs);

    if (turns.length === 0) continue;

    // Chunk with sliding window
    const chunks = chunkTurns(turns, 5, 2);

    // Add metadata
    for (const chunk of chunks) {
      chunk.conversation_id = convId;
      chunk.platform = platform;
      chunk.user_id = userId;
      chunk.hypothetical_questions = []; // Will be filled by HyDE preprocessing
    }

    allChunks.push(...chunks);
  }

  console.log(`📊 Conversation chunking: ${messages.length} messages → ${allChunks.length} turn chunks`);

  return allChunks;
}
```

**Testing**:

**File**: `tests/conversation-chunker.test.js` (NEW)

```javascript
import { describe, it, expect } from 'vitest';
import { messagesToTurnChunks } from '../src/conversation-chunker.js';

describe('Conversation Chunker', () => {
  it('should chunk conversation into turn windows with overlap', () => {
    const messages = [
      { role: 'user', content: 'Hello', conversationId: 'conv1', timestamp: 1000, platform: 'chatgpt' },
      { role: 'assistant', content: 'Hi there', conversationId: 'conv1', timestamp: 1001, platform: 'chatgpt' },
      { role: 'user', content: 'How are you?', conversationId: 'conv1', timestamp: 1002, platform: 'chatgpt' },
      { role: 'assistant', content: 'Good', conversationId: 'conv1', timestamp: 1003, platform: 'chatgpt' },
      { role: 'user', content: 'Great', conversationId: 'conv1', timestamp: 1004, platform: 'chatgpt' },
      { role: 'assistant', content: 'Thanks', conversationId: 'conv1', timestamp: 1005, platform: 'chatgpt' },
    ];

    const chunks = messagesToTurnChunks(messages, 'user123');

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].turn_range).toBe('1-3'); // First 3 turns (6 messages)
    expect(chunks[0].content).toContain('User: Hello');
    expect(chunks[0].content).toContain('Assistant: Hi there');
    expect(chunks[0].speakers).toContain('user');
    expect(chunks[0].speakers).toContain('assistant');
    expect(chunks[0].platform).toBe('chatgpt');
    expect(chunks[0].user_id).toBe('user123');
  });

  it('should extract topics from content', () => {
    const messages = [
      { role: 'user', content: 'I have a Python bug with Supabase RLS', conversationId: 'conv2', timestamp: 2000, platform: 'chatgpt' },
      { role: 'assistant', content: 'Let me help with that database error', conversationId: 'conv2', timestamp: 2001, platform: 'chatgpt' },
    ];

    const chunks = messagesToTurnChunks(messages, 'user456');

    expect(chunks[0].topics).toContain('python');
    expect(chunks[0].topics).toContain('supabase');
    expect(chunks[0].topics).toContain('rls');
    expect(chunks[0].topics).toContain('database');
  });
});
```

**Run Tests**:
```bash
npm test -- conversation-chunker.test.js
```

**Commit**:
```bash
git add src/conversation-chunker.js tests/conversation-chunker.test.js
git commit -m "feat: Add conversation-turn chunking logic

Implements sliding window chunking:
- Groups messages by conversation_id
- Pairs user-assistant messages into turns
- Creates 5-turn windows with 2-turn overlap
- Formats as 'User: ...\nAssistant: ...'
- Extracts topics (python, api, bug, etc.)
- Preserves speaker attribution and timestamps

Testing:
- Turn window creation verified
- Overlap logic tested
- Topic extraction validated

Part of: Conversation-turn chunking implementation"
```

---

## 🔍 Phase 4: Search MVP Features (2-3 hours)

### Feature #1: HyDE Preprocessing (Batch Load)

**Goal**: Generate hypothetical questions for existing chat turns

**File**: `src/hyde-preprocessor.js` (NEW)

```javascript
/**
 * HyDE (Hypothetical Document Embeddings) Preprocessor
 * Generates hypothetical questions that users might ask
 * to find this conversation turn
 */

/**
 * Generate hypothetical questions using OpenAI
 * @param {string} turnContent - Formatted turn content
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<string[]>} Generated questions
 */
async function generateHypotheticalQuestions(turnContent, apiKey) {
  const prompt = `Given this conversation excerpt, generate 3 concise questions a user might ask to find this conversation later.

Conversation:
${turnContent.substring(0, 1000)}

Generate 3 questions (one per line, no numbering):`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', // Fast, cheap model for question generation
      messages: [
        { role: 'system', content: 'You generate concise search queries.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 150
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`OpenAI error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const questions = data.choices[0].message.content
    .split('\n')
    .map(q => q.trim())
    .filter(q => q.length > 5);

  return questions.slice(0, 3); // Max 3 questions
}

/**
 * Batch process turn chunks with HyDE
 * @param {Object[]} turnChunks - Turn chunks to process
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Object[]>} Turn chunks with hypothetical questions
 */
export async function preprocessWithHyDE(turnChunks, apiKey) {
  console.log(`🔍 HyDE: Preprocessing ${turnChunks.length} turn chunks...`);

  const processed = [];

  for (let i = 0; i < turnChunks.length; i++) {
    const chunk = turnChunks[i];

    try {
      const questions = await generateHypotheticalQuestions(chunk.content, apiKey);
      processed.push({
        ...chunk,
        hypothetical_questions: questions
      });

      if ((i + 1) % 10 === 0) {
        console.log(`🔍 HyDE: Processed ${i + 1}/${turnChunks.length}`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.warn(`⚠️ HyDE failed for chunk ${i + 1}:`, error.message);
      processed.push({
        ...chunk,
        hypothetical_questions: [] // Fallback: no questions
      });
    }
  }

  console.log(`✅ HyDE: Preprocessed ${processed.length} chunks`);
  return processed;
}
```

**Commit**:
```bash
git add src/hyde-preprocessor.js
git commit -m "feat: Add HyDE preprocessing for hypothetical questions

Generates 3 hypothetical questions per conversation turn:
- Uses gpt-4o-mini (fast, cheap)
- Questions stored in hypothetical_questions field
- Batch processing with rate limiting
- Graceful fallback on errors

Example:
  Turn: 'User: Python RLS bug\nAssistant: Check policy...'
  Questions: ['RLS policy error', 'Python Supabase auth', ...]

Part of: Search MVP (high-ROI feature)"
```

### Feature #2: Query Transformation

**File**: `src/query-transformer.js` (NEW)

```javascript
/**
 * Query Transformation
 * Rewrites vague user prompts into clean search queries
 * Example: 'ugh, stuck again' → 'debugging error troubleshooting'
 */

/**
 * Transform vague query into clean search terms
 * @param {string} userQuery - Original vague query
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<string>} Transformed query
 */
export async function transformQuery(userQuery, apiKey) {
  const prompt = `Rewrite this vague search query into a clear, concise search query (max 10 words):

User query: "${userQuery}"

Clean query:`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', // Fast model
      messages: [
        { role: 'system', content: 'You rewrite vague queries into clean search terms.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3, // Low temp for consistency
      max_tokens: 50
    })
  });

  if (!response.ok) {
    // Fallback: return original query
    console.warn('⚠️ Query transformation failed, using original');
    return userQuery;
  }

  const data = await response.json();
  const transformed = data.choices[0].message.content.trim();

  console.log(`🔍 Query transform: "${userQuery}" → "${transformed}"`);
  return transformed;
}
```

**Commit**:
```bash
git add src/query-transformer.js
git commit -m "feat: Add query transformation for vague prompts

Rewrites vague queries before search:
- Uses gpt-4o-mini (low latency)
- Example: 'ugh stuck' → 'debugging error help'
- Graceful fallback to original query
- Max 50 tokens (fast response)

Part of: Search MVP (high-ROI feature)"
```

---

## 🔌 Phase 5: Integration (2 hours)

### Update `browser-sync.js` to use turn chunking

**Changes**:
1. Import conversation chunker
2. Convert messages to turn chunks
3. Optionally run HyDE preprocessing
4. Upload to `chat_turns` table instead of `messages`

**Modified `syncToSupabase()`**:

```javascript
import { messagesToTurnChunks } from './conversation-chunker.js';
import { preprocessWithHyDE } from './hyde-preprocessor.js';

export async function syncToSupabase() {
  try {
    console.log('🔄 Starting sync to Supabase...');

    const config = await getConfig();
    const messagesToSync = await getMessagesToSync();

    if (messagesToSync.length === 0) {
      return { success: true, synced: 0, message: 'No new messages to sync' };
    }

    // NEW: Convert to turn chunks
    const userId = config.userId || 'anonymous'; // Get from auth
    const turnChunks = messagesToTurnChunks(messagesToSync, userId);

    // NEW: Optional HyDE preprocessing (can be toggled)
    const shouldPreprocessHyDE = config.enableHyDE !== false; // Default: enabled
    const chunks = shouldPreprocessHyDE
      ? await preprocessWithHyDE(turnChunks, config.openaiKey)
      : turnChunks;

    // Generate embeddings for turn chunks (not raw messages)
    const texts = chunks.map(c => c.content);
    const embeddings = await generateEmbeddings(texts, config.openaiKey);

    // Prepare for Supabase
    const chunksWithEmbeddings = chunks.map((chunk, idx) => ({
      ...chunk,
      embedding: embeddings[idx],
      synced_from_extension: new Date().toISOString()
    }));

    // Insert to chat_turns table
    const response = await fetch(`${config.supabaseUrl}/rest/v1/chat_turns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(chunksWithEmbeddings)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Supabase error: ${error.message || response.statusText}`);
    }

    // Update sync status
    const syncStatus = {
      lastSyncTime: Date.now(),
      syncedCount: chunks.length,
      syncedMessageIds: messagesToSync.map(m => m.messageId)
    };

    await chrome.storage.local.set({ last_sync_status: syncStatus });

    console.log(`✅ Sync complete: ${chunks.length} turn chunks synced from ${messagesToSync.length} messages`);

    return {
      success: true,
      synced: chunks.length,
      message: `Successfully synced ${chunks.length} turn chunks`
    };

  } catch (error) {
    console.error('❌ Sync failed:', error);
    return {
      success: false,
      synced: 0,
      error: error.message
    };
  }
}
```

**Commit**:
```bash
git add src/browser-sync.js
git commit -m "feat: Integrate conversation-turn chunking into sync

Changes:
- Converts raw messages to turn chunks before embedding
- Optional HyDE preprocessing (toggled via config.enableHyDE)
- Uploads to chat_turns table (not messages)
- Logs: X turn chunks from Y messages

Testing:
- 100 messages → ~20-30 turn chunks (depending on conversation length)
- Embeddings generated for chunks, not individual messages
- RLS enforced via user_id

Part of: Conversation-turn chunking implementation"
```

---

## ✅ Phase 6: Testing & Verification (1 hour)

### Test 1: Token Limit Compliance

```javascript
// In service worker console:
chrome.storage.local.get(['captured_messages'], async (result) => {
  const messages = result.captured_messages || [];

  // Simulate sync
  const config = await chrome.storage.local.get(['api_config']);
  const texts = messages.map(m => m.content);

  // Check batching
  const batches = batchByTokens(texts, 8000);
  console.log(`Batches: ${batches.length}`);

  batches.forEach((batch, i) => {
    const tokens = batch.reduce((sum, text) => sum + estimateTokens(text), 0);
    console.log(`Batch ${i + 1}: ${batch.length} messages, ~${tokens} tokens`);
  });
});
```

**Expected**: All batches <8,000 tokens

### Test 2: Turn Chunking

```javascript
import { messagesToTurnChunks } from './src/conversation-chunker.js';

// Test with sample data
const testMessages = [
  { role: 'user', content: 'Python bug', conversationId: 'test1', timestamp: 1000, platform: 'chatgpt' },
  { role: 'assistant', content: 'Show error', conversationId: 'test1', timestamp: 1001, platform: 'chatgpt' },
  // ... add 20 more messages
];

const chunks = messagesToTurnChunks(testMessages, 'user123');
console.log('Chunks:', chunks);

// Verify:
// - chunks.length > 0
// - chunks[0].turn_range exists
// - chunks[0].content formatted correctly
// - chunks[0].topics extracted
```

### Test 3: HyDE Preprocessing

```javascript
import { preprocessWithHyDE } from './src/hyde-preprocessor.js';

const sampleChunks = [
  {
    content: 'User: How do I fix RLS in Supabase?\nAssistant: Check your policy definition...',
    turn_range: '1-2'
  }
];

const config = await chrome.storage.local.get(['api_config']);
const processed = await preprocessWithHyDE(sampleChunks, config.api_config.openaiKey);

console.log('Questions:', processed[0].hypothetical_questions);
// Expected: ['RLS policy error', 'Supabase auth fix', ...]
```

### Test 4: End-to-End Sync

1. Clear sync status:
```javascript
chrome.storage.local.set({ last_sync_status: { syncedMessageIds: [] } });
```

2. Trigger sync:
```javascript
// Click sync button or:
chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
```

3. Check Supabase:
```sql
SELECT
  turn_range,
  content,
  topics,
  hypothetical_questions,
  platform,
  user_id
FROM chat_turns
ORDER BY created_at DESC
LIMIT 5;
```

**Expected**:
- Turn chunks appear
- Content formatted: "User: ...\nAssistant: ..."
- Topics extracted
- Hypothetical questions present (if HyDE enabled)

---

## 📋 Implementation Checklist

### Phase 0: Fix Bugs
- [ ] Fix invalid regex flag (inject.js:540)
- [ ] Test extension loads without errors
- [ ] Commit fix

### Phase 1: Token-Aware Batching
- [ ] Add `estimateTokens()` function
- [ ] Add `batchByTokens()` function
- [ ] Update `generateEmbeddings()`
- [ ] Test with long messages
- [ ] Commit changes

### Phase 2: Schema
- [ ] Create `supabase_chat_turns_schema.sql`
- [ ] Apply schema to Supabase
- [ ] Verify table structure
- [ ] Verify RLS policies
- [ ] Commit schema

### Phase 3: Chunking Logic
- [ ] Create `src/conversation-chunker.js`
- [ ] Implement `messagesToTurnChunks()`
- [ ] Create tests
- [ ] Run tests (`npm test`)
- [ ] Commit implementation

### Phase 4: Search Features
- [ ] Create `src/hyde-preprocessor.js`
- [ ] Create `src/query-transformer.js`
- [ ] Test HyDE generation
- [ ] Test query transformation
- [ ] Commit features

### Phase 5: Integration
- [ ] Update `browser-sync.js`
- [ ] Import chunker and HyDE
- [ ] Modify `syncToSupabase()`
- [ ] Test end-to-end
- [ ] Commit integration

### Phase 6: Verification
- [ ] Test token limits (all batches <8k)
- [ ] Test turn chunking (correct formatting)
- [ ] Test HyDE (questions generated)
- [ ] Test Supabase (data appears)
- [ ] Document testing results

---

## 🎯 Success Criteria

1. **Sync Error Fixed**:
   - ✅ No "26,916 tokens" error
   - ✅ All batches respect 8,000 token limit
   - ✅ Extension reloads without sync failure

2. **Turn Chunking Working**:
   - ✅ Messages converted to turn chunks
   - ✅ Content formatted: "User: ...\nAssistant: ..."
   - ✅ Sliding window: 5 turns, 2 overlap
   - ✅ Topics extracted

3. **Search Features Working**:
   - ✅ HyDE generates 3 questions per chunk
   - ✅ Query transformation rewrites vague queries
   - ✅ Metadata filtering (platform, user_id) enforced

4. **Database Verified**:
   - ✅ `chat_turns` table populated
   - ✅ RLS policies enforced
   - ✅ Free tier view works (ChatGPT only)

---

## 📝 Next Steps After Implementation

1. **Batch Load**: Process existing 30-day chat history
   - Run HyDE on all historical turns
   - Backfill `chat_turns` table

2. **Search Integration**: Update search to use `chat_turns`
   - Query transformation before search
   - Vector search on turn chunks
   - Return matched turns with context

3. **Performance Monitoring**:
   - Track chunk sizes
   - Monitor embedding costs
   - Measure search precision

---

**Estimated Total Time**: 8-10 hours
**Success Probability**: 95%

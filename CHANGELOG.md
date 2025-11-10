# Changelog

All notable changes to the KYT Memory Extension project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - Day 2: Semantic Search Infrastructure

#### Database Layer
- **Database Schema** (`supabase_schema.sql`): PostgreSQL schema with pgvector extension
  - Messages table with 1536-dimensional vector embeddings (OpenAI text-embedding-3-small)
  - HNSW index for fast approximate nearest neighbor search (vector_cosine_ops)
  - B-tree indexes on timestamp, conversation_id, and role for filtering
  - Unique constraint on message_id to prevent duplicate syncs
  - Verified working: Table created and accessible via Supabase client

- **Search Function** (`supabase_search_function.sql`): PostgreSQL RPC function
  - `match_messages()`: Performs cosine similarity search on embeddings
  - Returns ranked results with similarity scores (1 - cosine distance)
  - Configurable match_threshold and match_count parameters
  - Must be executed in Supabase SQL Editor after schema creation

#### Application Layer
- **Sync Module** (`src/sync.js`): Message synchronization service
  - `syncMessages()`: Syncs Chrome storage messages to Supabase with embeddings
  - `generateEmbeddingsBatch()`: Batch embedding generation (100 messages/batch)
  - `getMessagesToSync()`: Identifies new messages to avoid duplicate syncing
  - `getSyncStatus()`: Returns total synced messages and last sync timestamp
  - Handles OpenAI API rate limits and Supabase upsert conflicts

- **Search Module** (`src/search.js`): Vector similarity search service
  - `searchMessages()`: Natural language semantic search with filters
  - `findSimilarMessages()`: Find conversations similar to a reference message
  - `getConversationContext()`: Retrieve full conversation thread by ID
  - `advancedSearch()`: Search with date range and role filters
  - Returns results ranked by cosine similarity scores

- **Configuration Module** (`src/config.js`): Centralized environment management
  - Environment variable validation on import
  - Initialized Supabase and OpenAI clients with error handling
  - Exported configuration constants (batch size, thresholds, models)
  - `validateConfig()`: Runtime configuration verification

#### Build & Tooling
- **NPM Package** (`package.json`): ES module configuration
  - Added `"type": "module"` for native ES imports
  - Dependencies: @supabase/supabase-js@2.80.0, openai@6.8.1, dotenv@17.2.3
  - NPM scripts: `npm run sync`, `npm run search` (placeholders for test scripts)

- **Setup Scripts**:
  - `setup_supabase.js`: Verifies Supabase connection and table existence
  - `setup_database_direct.js`: Automated SQL execution with manual fallback
  - Both use environment variables from `.env` (no hardcoded credentials)

#### Git Workflow
- Created feature branch: `feat/day2-semantic-search`
- Atomic commits with conventional commit messages:
  - `9a6e73f`: Database schema with pgvector
  - `0ba61ad`: NPM initialization and dependencies
  - `6f0ea33`: Database setup scripts
  - `9ee1407`: Changelog documentation
  - `1ba97a9`: Sync and search modules

### Status
- ✅ **Phase 1 Complete**: Database schema and setup verified
- ✅ **Phase 2 Complete**: Sync and search modules implemented
- ⏳ **Phase 3 In Progress**: Background.js integration pending
- ⏳ **Phase 4 Pending**: Validation test suite
- ⏳ **Phase 5 Pending**: End-to-end testing with real messages

---

## [0.1.1] - 2025-11-10

### Validated
- ✅ **DAY 1 VALIDATION COMPLETE**: 6/6 tests passed at 3:18 PM
  - 8 messages captured automatically during field testing
  - All required fields present and valid
  - Conversation IDs successfully extracted from API
  - No race conditions detected
  - All message IDs unique
  - Sequential timestamp ordering maintained

### Fixed
- Chrome extension manifest icon field now uses actual SVG file instead of inline data URIs
- Resolves "Invalid value for 'icons[\"128\"]'" error when loading extension
- Updated API endpoint detection to match ChatGPT's new endpoint: `/backend-api/f/conversation`
- Fetch override now intercepts both old (`/backend-api/conversation`) and new (`/backend-api/f/conversation`) endpoints
- Re-install fetch override after page load to ensure KYT wraps fetch last (fixes conflict with uBlock Origin and other extensions)
- Added debug logging for backend-api fetch calls to aid troubleshooting
- Aggressive fetch monitoring: Re-install override at 100ms, 500ms, 1s, and 2s after page load
- Continuous monitoring every 1 second to detect and fix when other scripts replace window.fetch
- **ARCHITECTURAL CHANGE**: Switched from content script fetch override to page context injection
  - Created `inject.js` that runs in PAGE CONTEXT instead of isolated content script world
  - Allows fetch override to operate at same level as competing extensions (uBlock Origin, Dark Reader)
  - Uses CustomEvent (`KYT_MESSAGE_CAPTURED`) to communicate between page context and content script
  - Content script now acts as bridge: receives events from page, forwards to background for storage
  - Solves extension conflict issue where VM scripts were replacing fetch after content script initialization

### Planned
- Day 2: Semantic search with Supabase pgvector
- Day 3: Invisible context injection into ChatGPT prompts
- MVP: Full RAG system with HyDE and Query Transformation

---

## [0.1.0] - 2025-11-10

### Added

#### Core Extension Features
- Chrome extension with Manifest V3 configuration supporting ChatGPT domains (chat.openai.com and chatgpt.com)
- Content script with `window.fetch` override for automatic API interception
- Message extraction from ChatGPT API request payloads (`/backend-api/conversation` endpoint)
- Support for nested JSON structure (`message.content.parts[0]`)
- Background service worker for centralized storage management
- Chrome storage operations with validation and error handling
- Unique message ID generation (`msg_timestamp_random`)
- Conversation metadata extraction (conversation_id, model, timestamp, role)

#### Health Monitoring
- Health check system with 5-minute interval alarms
- Detection of API interception failures (alerts after 5+ minutes of inactivity)
- Storage quota monitoring with 80% usage warnings
- Error logging with 100-error circular buffer
- Real-time interception metrics tracking

#### Validation & Testing
- 8-test validation suite (`validation/verify_capture.js`) with:
  - Storage access verification
  - Minimum message count check (10+ required)
  - Required fields validation (content, timestamp, role)
  - Non-empty content verification
  - Sequential timestamp validation (race condition detection)
  - Conversation ID presence check (proves API extraction)
  - Content length distribution analysis
  - Unique message ID verification
- Debug functions: `window.KYT_HEALTH_CHECK()` and `chrome.runtime.sendMessage({type: 'GET_STATS'})`

#### Documentation
- Comprehensive README with:
  - 3-step quick start guide
  - Troubleshooting section
  - Debug command reference
  - Technical architecture overview
  - Security compliance checklist
- Debugging playbook (`docs/DEBUGGING.md`) covering 6 failure scenarios:
  - Extension not loading (manifest/permissions)
  - Content script not running (CSP/injection)
  - No API interceptions (endpoint changes)
  - Extraction errors (API structure changes)
  - Storage quota exceeded (cleanup strategies)
  - Validation test failures (per-test debugging)
- Day 1 completion summary (`DAY1_COMPLETE.md`)

#### Security & Project Infrastructure
- Comprehensive `.gitignore` covering secrets, logs, cache, and artifacts (132 lines)
- Environment variable template (`.env.example`) for Day 2+ configuration
- Git repository initialization with clean commit history
- Security-first development approach (CLAUDE.md Rule 5 compliant)

### Technical Details

#### API Interception
- Fetch override installed at `document_start` (runs before page JavaScript)
- Handles both old (`chat.openai.com`) and new (`chatgpt.com`) domains
- Error handling with extraction failure logging
- Race condition prevention with sequential timestamp validation

#### Storage Architecture
- Append-only message storage (no overwrites)
- Async storage operations with promise-based API
- Storage overflow protection (prevents quota exceeded errors)
- Separate error log storage with automatic pruning

#### Performance
- Content script: ~200 lines, 6KB
- Background worker: ~250 lines, 8KB
- Validation suite: ~250 lines with 8 independent tests
- Storage quota monitoring with proactive warnings

### Compliance
- CLAUDE.md Rule 1: Show, Don't Tell (real validation, not theater)
- CLAUDE.md Rule 5: Security First (.gitignore created before code)
- CLAUDE.md Rule 6: Atomic Commits (separate commits for features/docs)
- Manifest V3 compliant (Chrome future-proof)

### Git History
```
d5792d6 docs: Add comprehensive debugging playbook for Day 1
10b3975 docs: Add Day 1 validation suite and documentation
1792712 feat: Add Chrome extension core (API interception + storage)
2b8f78e Initial commit: Security foundation (.gitignore + .env.example)
```

### Known Limitations
- Day 1 scope: Capture only (no semantic search yet)
- API fragility: ChatGPT endpoint changes can break interception
- Manual validation required (paste script into console)
- Chrome-only (no Firefox/Edge support yet)

### Breaking Changes
- None (initial release)

---

## Project Information

**Project**: KYT Memory Extension
**Goal**: RAG (Retrieval-Augmented Generation) system for ChatGPT long-term memory
**Architecture**: Chrome extension + Supabase backend + OpenAI embeddings
**Validation Approach**: 3-day sprint (capture → search → inject)

**Repository**: kyt-validation-sprint
**License**: TBD
**Maintainer**: penguinzyue

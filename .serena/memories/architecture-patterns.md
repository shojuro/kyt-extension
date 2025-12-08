# K.Y.T. Memory Extension - Architecture Patterns

## Core Architectural Principles

### Modular ES6 Architecture with Clear Separation of Concerns

**Project**: K.Y.T. Memory Extension (Chrome Extension for AI conversation memory)

**Architectural Approach**: The project uses a modular ES6 architecture with clear separation of concerns across multiple layers:

#### Layer Separation

1. **Content Layer** (Page Context)
   - `platforms/chatgpt/inject.js` - API interception
   - `platforms/chatgpt/dom-observer.js` - Mobile message capture
   - `platforms/claude/inject.js` - Claude API interception
   - `src/content/queue-manager.js` - Message queueing

2. **Messaging Layer**
   - `platforms/chatgpt/content.js` - ChatGPT content script
   - `platforms/claude/content.js` - Claude content script
   - `src/storage/local-queue.js` - Encrypted local fallback

3. **Background Service Worker**
   - `background.js` - Main orchestrator
   - `src/browser-sync.js` - Supabase sync
   - `src/browser-search.js` - Semantic search
   - `src/background/queue-processor.js` - Queue management

4. **Search & Retrieval Pipeline**
   - `src/browser-search.js` - Semantic + BM25 hybrid
   - `src/bm25-search.js` - BM25 implementation
   - `src/query-expansion.js` - Query synonyms
   - `src/hyde-preprocessor.js` - Hypothetical questions
   - `src/conversation-chunker.js` - Turn-based chunking
   - `src/context-injector.js` - Memory injection

5. **Data Layer**
   - chrome.storage.local (Messages, config, queue)
   - Supabase PostgreSQL (messages, chat_turns tables)
   - OpenAI API (Embeddings generation)

#### Key Characteristics

- **ES6 Modules**: Native JavaScript modules with import/export
- **Single Responsibility**: Each module handles one specific concern
- **Dependency Injection**: Components receive dependencies rather than creating them
- **Event-Driven**: CustomEvent messaging for CSP-safe communication
- **Functional Composition**: Pure functions where possible
- **Error Boundaries**: Each layer has comprehensive error handling

#### Benefits Achieved

- Easy to test individual components in isolation
- Clear data flow and dependencies
- Simple to extend with new features (e.g., mobile voice capture added cleanly)
- Maintainable codebase (~17,700 lines across 56 files)
- Performance optimized through separation (throttling, batching at appropriate layers)

#### Pattern Examples

**Separation of Concerns Example**:
- Message capture (content layer) ≠ Message storage (background layer)
- API interception (inject.js) ≠ DOM observation (dom-observer.js)
- Queue management (queue-manager.js) ≠ Queue encryption (local-queue.js)
- Search execution (browser-search.js) ≠ Query optimization (query-transformer.js)

**Module Boundaries**:
- Each platform (ChatGPT, Claude) has isolated implementation
- Shared utilities in `src/utils/`
- Storage abstraction layer
- Search pipeline as composable stages

This architectural approach allowed the project to scale from basic API interception to advanced semantic search with context injection across 8 development phases while maintaining code quality and testability.

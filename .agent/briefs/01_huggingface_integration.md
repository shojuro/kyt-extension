# Brief: HuggingFace API Integration (Worktree 1)

**Branch:** `feature/huggingface-integration`
**Goal:** Replace OpenAI embeddings with HuggingFace API (`Qwen/Qwen3-Embedding-8B`) and add reranking (`bge-reranker-v2-m3`).

## Objectives
1.  **HuggingFace Client**: Create `supabase/functions/_shared/huggingface-client.ts`.
2.  **Embeddings**: Implement `Qwen/Qwen3-Embedding-8B` (32k context).
3.  **Reranking**: Implement `BAAI/bge-reranker-v2-m3`.
4.  **Integration**: Update `save_chat_turn` and `get_relevant_memories` (or equivalent search function).

## Constraints
*   **Latency**: Embedding < 200ms, Reranking < 100ms.
*   **No Fallback**: Remove OpenAI embedding dependency.
*   **Context**: 32k window for embeddings.

## Tasks
- [ ] Obtain HF API Key (User to provide).
- [ ] Create `huggingface-client.ts` with error handling.
- [ ] Implement `generateEmbedding(text)` using Qwen3.
- [ ] Implement `rerank(query, documents)` using BGE-M3.
- [ ] Update `save_chat_turn` to use new embedding.
- [ ] Update search logic to: Vector Search (Top 20) -> Rerank -> Top 5.
- [ ] Verify latency.

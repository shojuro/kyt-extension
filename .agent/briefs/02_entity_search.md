# Brief: Entity-Aware Search (Worktree 2)

**Branch:** `feature/entity-aware-search`
**Goal:** Implement `hybrid_search_with_entities` to boost results mentioning queried entities.

## Objectives
1.  **Search Logic**: Implement `hybrid_search_with_entities`.
2.  **Boosting**: Boost scores for results containing entities found in the query.
3.  **Disambiguation**: Resolve "Jenn" -> "jennifer_nanny" using normalized matching (and eventually embeddings).

## Constraints
*   **Embedding Agnostic**: Initially work with existing embeddings, ready to swap to HF later.
*   **Performance**: Minimal latency impact (< 50ms overhead).

## Tasks
- [ ] Create/Update search function (SQL/RPC) to accept `entity_boost` parameters.
- [ ] Implement logic to extract entities from the *query* (using existing extractor or simple matching).
- [ ] Modify scoring: `Final Score = (Vector Score * 0.7) + (BM25 * 0.2) + (Entity Boost * 0.1)`.
- [ ] Implement disambiguation logic (e.g., if query has "Jenn", boost "jennifer_nanny").
- [ ] Test with "Jenn" query surfacing "jennifer_nanny" results.

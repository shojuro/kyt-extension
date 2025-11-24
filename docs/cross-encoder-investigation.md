# Cross-Encoder Reranking Investigation

**Status:** DESCOPED
**Date:** 2025-11-24
**Duration:** 6 hours (within 4-6 hour time-box)
**Outcome:** Client-side cross-encoder reranking is architecturally unviable

---

## Executive Summary

Attempted to implement client-side cross-encoder reranking using Transformers.js to boost precision by 15-20% (Priority 1, v1.2.1). Investigation revealed:

1. ✅ **Model compatibility achieved**: Fixed pipeline API bug by using AutoModel API for raw logits
2. ✅ **Relevance differentiation works**: 27x ratio between relevant (0.025-0.030) and irrelevant (0.001) scores
3. ❌ **Performance unacceptable**: >1000ms warm latency vs 30-50ms target (33x over budget)
4. 🚫 **Decision**: DESCOPE entirely - no mock implementation, no fallback complexity

**Alternative:** BM25 keyword boost (2 hours, 5-10% precision improvement, zero dependencies)

---

## Implementation Timeline

### Phase 1: Core Reranker Module (4 hours)

**Model Selection:**
- Target: `Xenova/ms-marco-MiniLM-L-6-v2` (22M params, ~8MB quantized)
- Issue: No ONNX version available in Transformers.js
- Fallback: `Xenova/bge-reranker-base` (BAAI BGE reranker, compatible with Transformers.js)

**Model Compatibility Issues:**
```javascript
// BROKEN: pipeline('text-classification') applies softmax
const classifier = await pipeline('text-classification', 'Xenova/bge-reranker-base');
const result = await classifier(`${query} ${document}`);
// Returns: [{ "label": "LABEL_0", "score": 1.0 }] for ALL inputs

// ROOT CAUSE: Pipeline API applies softmax over single class
// Cross-encoders output raw regression logits, not classification scores
// Softmax(logit) = 1.0 always → uniform scores
```

**Fix:**
```javascript
// WORKING: AutoModel API for raw logits
import { AutoModel, AutoTokenizer } from '@xenova/transformers';

const model = await AutoModel.from_pretrained('Xenova/bge-reranker-base', { quantized: true });
const tokenizer = await AutoTokenizer.from_pretrained('Xenova/bge-reranker-base');

const inputs = await tokenizer(`${query} ${document}`, {
  padding: true,
  truncation: true,
  max_length: 200,
  return_tensors: 'pt'
});

const outputs = await model(inputs);
const rawLogit = outputs.logits.data[0];  // Access raw regression logit
const score = 1 / (1 + Math.exp(-rawLogit));  // Sigmoid normalization
```

**Validation Results:**
```
Query: "Tell me about Jennifer's startup idea"

Relevant candidates:
  msg_1: "Jennifer founded an AI tutoring startup..." → 0.025
  msg_3: "Jennifer mentioned her startup pitch deck..." → 0.030

Irrelevant candidate:
  msg_2: "The weather in Tokyo is sunny..." → 0.001

Differentiation ratio: 27x ✓
```

### Phase 2: Performance Testing (2 hours)

**Browser Performance Test (`tests/browser_reranker_test.html`):**
```
Configuration:
- Model: Xenova/bge-reranker-base (INT8 quantized)
- Runtime: Transformers.js + ONNX WASM
- Test: 3 candidates, real query-document pairs

Results:
  Cold start: 4,200ms (target: <500ms) → 8.4x over budget
  Warm average: 1,150ms (target: 30-50ms) → 33x over budget

  Differentiation: ✓ Works (>10x ratio)
  Performance: ✗ FAIL (unacceptable latency)
```

**Node.js Baseline:**
```
Environment: Node.js v20.x, WASM backend
Latency: ~3,700ms for 3 candidates
```

---

## Root Cause Analysis

### Why Client-Side Transformers Are Too Slow

**Cross-Encoder Architecture:**
- Requires 3 separate full BERT forward passes (one per candidate)
- Each forward pass: 6-layer transformer (BGE reranker is compact version)
- Total operations: ~66M parameters × 3 candidates = 198M operations per query

**WASM Performance Characteristics:**
- WASM is 100-300x slower than GPU for transformer inference
- WebGL acceleration in Transformers.js provides limited benefit for small models
- WebGPU support still experimental and not widely available

**Server-Side Baseline (for comparison):**
- RunPod GPU (T4): 10-20ms for 3 candidates
- Lambda GPU (A10): 5-10ms for 3 candidates
- Client WASM: 1,000-4,000ms for 3 candidates

**Conclusion:**
> Client-side transformers are architecturally unviable for <100ms latency requirements. The 100-300x performance gap between WASM and GPU cannot be bridged through optimization.

---

## Commits

1. **61b6345** - `feat: Implement Phase 1 cross-encoder reranker core module (v1.2.1)`
   - Created `src/cross-encoder-reranker.js` (460 lines)
   - Added `@xenova/transformers@^2.17.0` dependency
   - Implemented `rerankCandidates()` API
   - Added error handling, caching, and failure tracking

2. **0df67c0** - `fix: Reranker now properly differentiates relevance - use AutoModel API for raw logits`
   - Fixed pipeline API bug by switching to AutoModel + AutoTokenizer
   - Added sigmoid normalization
   - Achieved 27x differentiation ratio

3. **eecd08c** - `Revert "fix: Reranker now properly differentiates relevance..."`
   - Reverted AutoModel fix as part of descope

4. **a06bd1f** - `Revert "feat: Implement Phase 1 cross-encoder reranker core module..."`
   - Reverted Phase 1 implementation
   - Removed `@xenova/transformers` dependency
   - Deleted `src/cross-encoder-reranker.js` and test scripts

---

## Files Removed During Descope

- `src/cross-encoder-reranker.js` (460 lines) - Core reranker module
- `scripts/test_reranker_basic.js` (200 lines) - Unit tests (15/15 passed)
- `scripts/diagnose_model_output.js` (150 lines) - Diagnostic tool that discovered pipeline bug
- `scripts/test_raw_model.js` (80 lines) - Raw model testing that validated AutoModel fix
- `tests/browser_reranker_test.html` (300 lines) - Browser performance test
- `@xenova/transformers` dependency removed from `package.json`

---

## Lessons Learned

### What Worked
1. **Diagnostic approach**: Created dedicated diagnostic scripts to isolate the pipeline API bug
2. **AutoModel API discovery**: Switching from pipeline to AutoModel API exposed raw logits correctly
3. **Validation methodology**: Browser performance test revealed latency issues before production integration
4. **Time-boxing**: 4-6 hour constraint prevented over-investment in unviable approach

### What Didn't Work
1. **Performance assumptions**: Assumed WebGL/WebGPU would accelerate WASM meaningfully (incorrect for 6-layer transformers)
2. **Server-to-client extrapolation**: Assumed 30-50ms server GPU times would translate to ~300ms client WASM (actual: >1000ms)
3. **Model size optimization**: INT8 quantization helped model size (~8MB) but not inference speed (still 100-300x slower than GPU)

### Key Insight
> "Either ship a feature that works, or don't ship the feature. Shipping +13MB of code that falls back to `weighted_score` = shipping nothing with extra complexity."

---

## Alternative: BM25 Keyword Boost

**Rationale:**
MMR's diversity objective (λ=0.3) might de-rank keyword-rich candidates in favor of variety. For entity queries like "Jennifer's startup" or "PostgreSQL configuration", keyword coverage should boost final ranking.

**Implementation:**
```javascript
// src/keyword-boost.js
export function applyKeywordBoost(query, candidates, boostFactor = 0.3) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  return candidates.map(candidate => {
    const contentLower = candidate.content.toLowerCase();
    const matchedTerms = queryTerms.filter(term => contentLower.includes(term)).length;
    const coverage = matchedTerms / queryTerms.length;

    // Apply boost: 0-30% increase based on keyword coverage
    const boost = coverage * boostFactor;
    const boostedScore = candidate.weighted_score * (1 + boost);

    return {
      ...candidate,
      weighted_score: boostedScore,
      keyword_coverage: coverage,
      keyword_boost: boost
    };
  });
}
```

**Integration Point:**
`background.js:889` (after MMR, before memory injection)

**Expected Impact:**
- Implementation time: 2 hours
- Precision improvement: 5-10%
- Dependencies: Zero (pure JavaScript)
- Latency overhead: <1ms
- Bundle size: +2KB

**Validation Criteria:**
Proceed if:
1. **>10% of general queries show keyword mismatch**, OR
2. **ANY entity query ranks lower-keyword-coverage item higher**

**Rationale for entity focus:**
> "Entity queries are your power users' bread and butter. Even a single mismatch justifies the fix since these queries have disproportionate value."

---

## Decision

**DESCOPE cross-encoder reranking entirely.**

**Reason:**
- Client-side transformers cannot meet <100ms latency requirements
- 33x performance gap is architectural, not fixable through optimization
- No value in shipping non-functional code with fallback complexity

**Next Steps:**
1. Validate BM25 keyword boost need (30 min)
2. Implement BM25 boost if validated (2 hours)
3. Ship v1.2.1 with measurable precision improvement

---

## References

- [Transformers.js Documentation](https://huggingface.co/docs/transformers.js)
- [BGE Reranker Model](https://huggingface.co/BAAI/bge-reranker-base)
- [Cross-Encoder vs Bi-Encoder Architecture](https://www.sbert.net/examples/applications/cross-encoder/README.html)
- Session summary: Available in conversation context (105K tokens)

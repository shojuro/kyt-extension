# K.Y.T. Memory Injection Protocol v1.0

## Overview

This specification defines how K.Y.T. injects retrieved memories into LLM context windows and controls LLM behavior regarding native search tools vs K.Y.T. memory.

---

## The Defiance Problem

During testing, a critical failure mode was identified: **the LLM had the correct memory in context but invented interpretations instead of recognizing the literal answer.**

### Example Failure

- **User asked**: "What did someone claim to bring to the masses as a counter?"
- **Memory context contained**: `"This is a test memory that I have brought to the masses as a counter."`
- **LLM response**: Invented "memes", "counter-mass physics pun", "kitchen counter" instead of recognizing the literal test string
- **Correct response**: The literal sentence from memory

### Root Cause

1. LLM prioritized creative interpretation over literal pattern matching
2. LLM triggered native `conversation_search` tools when K.Y.T. had already provided relevant results
3. No explicit instruction to check for literal matches before interpreting

---

## Protocol Specification

### Header Block (Always Injected)

```
================================================================================
K.Y.T. MEMORY INJECTION PROTOCOL v1.0
================================================================================

[KYT_STATUS]
retrieval_state: {FOUND | EMPTY | ERROR}
result_count: {n}
confidence_score: {0.00-1.00}
query_type: {EXACT_MATCH | SEMANTIC | HYBRID | BM25}
query_original: "{user's original query}"
query_transformed: "{transformed search query, if any}"
latency_ms: {ms}
timestamp: {ISO 8601}

[KYT_PRIORITY_DIRECTIVE]
IF retrieval_state == FOUND AND confidence_score >= 0.60:
  → USE K.Y.T. MEMORY AS PRIMARY SOURCE
  → DO NOT use conversation_search or recent_chats tools
  → DO NOT invent interpretations—if memory contains literal answer, return it
  → Treat injected memories as authoritative for this query

IF retrieval_state == FOUND AND confidence_score < 0.60:
  → USE K.Y.T. MEMORY but acknowledge uncertainty
  → MAY supplement with conversation_search if context seems incomplete
  → Flag low confidence to user if directly relevant

IF retrieval_state == EMPTY:
  → FALLBACK TO conversation_search and recent_chats PERMITTED
  → Inform user: "K.Y.T. found no matches, searching Claude history..."

IF retrieval_state == ERROR:
  → FALLBACK TO conversation_search and recent_chats REQUIRED
  → Log error context for debugging
  → Do not mention K.Y.T. failure unless user asks

[INTERPRETATION_RULES]
1. LITERAL FIRST: When memory contains text that directly answers the query, return it verbatim—do not paraphrase or interpret
2. EXACT MATCH PRIORITY: If user asks "what did I say about X" and memory contains user's exact words, quote them
3. NO FABRICATION: Do not invent connections between unrelated memories
4. CONFLICT RESOLUTION: If multiple memories conflict, present both with timestamps
5. MARKER RECOGNITION: Treat test/marker strings ("@@@", "!!!", "counter", unusual phrases) as high-signal—match literally first, interpret second
6. QUERY ECHO: If the memory contains the exact phrase from the user's query, that IS the answer

[ANTI-DEFIANCE CHECKS]
Before generating a response, verify:
□ Did I check if any memory item contains the literal answer?
□ Am I inventing meaning when the text speaks for itself?
□ Did I trigger native search tools when K.Y.T. already provided results?
□ Am I over-interpreting a simple/absurd test string?

[CITATION_FORMAT]
When referencing K.Y.T. memory:
- Present information naturally as shared context
- Do NOT say "according to my memory" or "I remember"
- If user asks WHERE info came from: "From our conversation on {date} via {platform}"

[DEBUG_MODE]
If KYT_DEBUG == TRUE in header:
- Show retrieval metadata in response
- Display confidence scores per result
- List query transformations applied
- Show which interpretation rule triggered

================================================================================
[Memory Context - {n} relevant items]
{injected memories here}
[End of Memory Context]
================================================================================
```

---

## Confidence Score Mapping

| Cosine Similarity | Confidence | Behavior |
|-------------------|------------|----------|
| 0.85 - 1.00 | HIGH | Treat as authoritative, no fallback |
| 0.70 - 0.84 | MEDIUM | Primary source, light hedging ok |
| 0.60 - 0.69 | LOW | Use but acknowledge uncertainty |
| < 0.60 | SUSPECT | Consider fallback to native tools |

---

## Query Type Indicators

- `EXACT_MATCH`: BM25 or keyword hit, high literal confidence
- `SEMANTIC`: Embedding similarity only, may need interpretation
- `HYBRID`: Combined BM25 + semantic, balanced confidence
- `BM25`: Pure keyword match, very high literal confidence

---

## Error State Payload

```json
{
  "retrieval_state": "ERROR",
  "error_code": "SUPABASE_TIMEOUT | EMBEDDING_FAILED | QUOTA_EXCEEDED | AUTH_EXPIRED",
  "error_message": "Human-readable description",
  "fallback_permitted": true,
  "retry_after_ms": 5000
}
```

---

## Empty State Payload

```json
{
  "retrieval_state": "EMPTY",
  "result_count": 0,
  "confidence_score": 0.00,
  "query_original": "what did I say about the counter",
  "query_transformed": "counter masses brought claim",
  "fallback_permitted": true,
  "suggestion": "Try more specific keywords or check if this was discussed on another platform"
}
```

---

## Implementation Notes

1. **Always inject the header block**, even when results are empty—this controls LLM behavior
2. **Confidence scores must be real**, not fabricated—derive from actual similarity metrics
3. **Query transformation should be visible** so debugging is possible
4. **Debug mode** should be toggleable per-user or per-session for development

---

## Testing Checklist

- [ ] Inject literal test string, ask about it—LLM returns it verbatim
- [ ] Inject memory with marker ("@@@"), query marker—LLM finds it
- [ ] High confidence retrieval—LLM does NOT trigger native search
- [ ] Empty retrieval—LLM DOES trigger native search with appropriate message
- [ ] Conflicting memories—LLM presents both with timestamps
- [ ] Low confidence retrieval—LLM hedges appropriately
- [ ] Defiance test: inject obvious answer, verify LLM doesn't invent alternatives

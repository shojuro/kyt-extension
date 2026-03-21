# K.Y.T. Product Constraints

## Core Constraint: No Paid API Keys at Scale

K.Y.T. is a cross-platform memory app for **public distribution**. Every feature must be viable at 100, 1,000, and 10,000 users without per-query API costs.

## Decision: YouTube Search via Invidious (2026-03-21)

### Problem

YouTube Data API v3 has a 10,000 unit/day quota shared across ALL users of a single API key:

| Scale | Searches/day | Quota Used | Over 10K limit? |
|-------|-------------|-----------|------------------|
| 100 users × 1 search | 100 | 10,100 | Yes (exhausted) |
| 100 users × 3 searches | 300 | 30,300 | 3x over |
| 1,000 users × 2 searches | 2,000 | 202,000 | 20x over |

Third-party proxy costs (SerpAPI-class):

| Scale | Monthly Cost |
|-------|-------------|
| 100 users × 5/day | $150/mo |
| 1,000 users × 5/day | $1,500/mo |
| 10,000 users × 5/day | $15,000/mo |

### Solution (Attempt 1 — Invidious, REJECTED 2026-03-21)

Invidious API was evaluated — free, no key, no quota, full filters. **Rejected** because:
- Most public instances have disabled their API (`api: false` in registry)
- Instance availability is volatile — of 5 tested, only 1 responded with HTTP 200
- Google actively blocks Invidious instances
- Third-party dependency risk unacceptable for a consumer product

### Solution (Current — NotebookLM Native Research)

YouTube discovery uses NotebookLM's built-in research feature:
- `search_youtube` MCP tool wraps `start_research` with YouTube-optimized queries
- Extracts YouTube URLs from research results
- Uses Google's own infrastructure — zero third-party dependencies
- Trade-off: less granular filtering (hints via natural language, not structured filters)
- Channel bookmarks stored locally for query construction

## General Rule

When evaluating any new external API integration:

1. Calculate cost at 100, 1,000, 10,000 user scale
2. If non-trivial → find free/open-source alternative
3. If no free alternative → route through existing infrastructure (Supabase edge functions, built-in platform features)
4. Document the cost analysis in this file

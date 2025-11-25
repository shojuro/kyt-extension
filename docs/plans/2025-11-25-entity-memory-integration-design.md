# Entity Memory Integration Design

**Date**: 2025-11-25
**Status**: Approved
**Author**: AI Engineer (Entity Memory Feature)

## Overview

Integrate entity extraction into the existing `save_chat_turn` Edge Function to automatically identify and track people, organizations, projects, and other entities mentioned in conversations.

**Key Insight**: Use relationship-aware canonical naming to solve the entity disambiguation problem (e.g., "jennifer_trainer" vs "jennifer_sister").

## Goals

1. **Extract entities** from conversations during sync (server-side)
2. **Deduplicate entities** using relationship-aware canonical names
3. **Track entity mentions** with references to specific chat turns
4. **Enable entity-aware search** (deferred to next phase)

## Non-Goals (Out of Scope)

- Entity relationship visualization UI (Priority 4)
- Advanced entity linking via embeddings (future optimization)
- Real-time entity extraction in browser (architecture decision: server-side only)
- Batch processing of existing conversations (separate task)

## Architecture Decisions

### Decision 1: Server-Side Entity Extraction

**Rationale**: Client-side ML is too slow (learned from cross-encoder mistake).

**Alternatives Considered**:
- Client-side NER: Rejected (performance impact, limited model quality)
- Hybrid approach: Rejected (unnecessary complexity for MVP)

**Choice**: Server-side extraction using GPT-4o-mini (~$0.0001/conversation)

**Benefits**:
- Consistent with existing architecture (gravity classifier runs server-side)
- Better model quality
- Batch during sync, not real-time
- No browser performance impact

### Decision 2: Parallel Processing with Fault Isolation

**Rationale**: Gravity classification and entity extraction are independent operations.

**Implementation**: `Promise.allSettled()` pattern

```typescript
const [gravityResult, entityResult] = await Promise.allSettled([
  classifyMemory(content, openaiApiKey),
  extractEntities(content, openaiApiKey)
]);

// Each operation succeeds/fails independently
const gravity = gravityResult.status === 'fulfilled'
  ? gravityResult.value
  : defaultGravity;

const entities = entityResult.status === 'fulfilled'
  ? entityResult.value
  : [];
```

**Benefits**:
- Fastest execution (parallel API calls)
- Fault isolation (one failure doesn't break the other)
- Simpler than message queue architecture

### Decision 3: Relationship-Aware Canonical Naming

**Problem**: Simple name normalization collapses distinct people:
```
"Jennifer" → jennifer
  ├─ Jennifer (trainer) - gym context
  ├─ Jennifer (sister) - family context
  └─ Jenn (nanny) - childcare context
```

**Solution**: Include relationship in canonical name:
```
jennifer_trainer → Entity 1
jennifer_sister → Entity 2
jenn_nanny → Entity 3
```

**Schema**:
```sql
normalized_name TEXT,    -- "jennifer" (for lookup)
canonical_name TEXT,     -- "jennifer_trainer" (unique key)
relationship TEXT,       -- "trainer", "sister", "nanny", "unknown"
context_category TEXT    -- "fitness", "family", "childcare"
```

**Deduplication Key**: `(user_id, canonical_name, entity_type)`

**Query Flow**:
1. User searches "Jennifer"
2. Lookup by `normalized_name = 'jennifer'` → returns all Jennifers
3. Disambiguate using context_category or relationship

### Decision 4: Exact Match Deduplication (MVP)

**Alternatives Considered**:
- Real-time embedding similarity: Rejected (too slow, multiple DB queries)
- Nightly batch deduplication: Rejected (delayed accuracy, complex cron)
- Hybrid exact + delayed embedding: Deferred (optimization for later)

**Choice**: Exact canonical name match only

**Rationale**:
- Fast inserts (single exact match query)
- Handles 80% of disambiguation via relationship extraction
- Future: Add embedding-based similarity for "Jenn" → "jennifer_nanny" linking

### Decision 5: Fetch-Then-Update for Mention Count

**Alternatives Considered**:
- SQL increment via RPC: More complex, requires migration
- Batched upserts: Optimization deferred

**Choice**: Fetch current count, increment, update

```typescript
const { data: existing } = await supabase
  .from('entities')
  .select('id, mention_count')
  .eq('canonical_name', canonicalName)
  .single();

await supabase.from('entities')
  .update({
    mention_count: existing.mention_count + 1,
    last_seen: new Date().toISOString()
  })
  .eq('id', entityId);
```

**Trade-offs**:
- Slight race condition risk (negligible at current scale)
- Simpler implementation (no RPC required)
- Good enough for MVP

## Schema Modifications

### Updated `entities` Table

```sql
-- Add new columns to existing schema
ALTER TABLE entities ADD COLUMN IF NOT EXISTS normalized_name TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS relationship TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS context_category TEXT;

-- Update canonical_name to use relationship suffix
-- Format: {normalized_name}_{relationship}
-- Example: "jennifer_trainer", "project_phoenix_unknown"

-- Add lookup index
CREATE INDEX IF NOT EXISTS idx_entities_lookup
  ON entities(user_id, normalized_name, entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_relationship
  ON entities(user_id, relationship);
```

**Field Definitions**:
- `entity_text`: Original text as it appeared ("Jennifer")
- `normalized_name`: Lowercase, no special chars ("jennifer") - for lookup
- `canonical_name`: Unique identifier ("jennifer_trainer") - deduplication key
- `display_name`: How to display in UI ("Jennifer")
- `entity_type`: PERSON, ORG, LOCATION, PROJECT, TECH, MISC
- `relationship`: trainer, sister, colleague, boss, friend, unknown
- `context_category`: fitness, family, work, health, social, unknown

### Relationship Vocabulary

**Family**: parent, sibling, spouse, child, relative
**Work**: colleague, boss, employee, client, partner
**Service**: trainer, doctor, therapist, teacher, nanny
**Social**: friend, neighbor, acquaintance
**Unknown**: unknown (insufficient context)

## Implementation

### Module 1: Entity Extractor (_shared/entity-extractor.ts)

```typescript
export interface ExtractedEntity {
  entity_text: string;        // "Jennifer"
  normalized_name: string;    // "jennifer"
  entity_type: 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC';
  relationship: string;       // "trainer", "sister", "unknown"
  context_category: string;   // "fitness", "family", "work"
}

export async function extractEntities(
  data: { content: string; speakers: string[] },
  openaiApiKey: string
): Promise<ExtractedEntity[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ENTITY_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(data) }
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    throw new Error(`Entity extraction failed: ${response.status}`);
  }

  const result = await response.json();

  // Parse with error handling
  try {
    const parsed = JSON.parse(result.choices[0].message.content);
    return Array.isArray(parsed.entities) ? parsed.entities : [];
  } catch (e) {
    console.warn('Entity extraction JSON parse failed:', e);
    return [];
  }
}

export async function saveEntitiesWithMentions(
  entities: ExtractedEntity[],
  chatTurnId: string,
  conversationId: string,
  userId: string,
  supabase: SupabaseClient
): Promise<void> {
  for (const entity of entities) {
    // Server-side canonical name generation
    const canonicalName = `${entity.normalized_name}_${entity.relationship}`;

    // Exact match check
    const { data: existing } = await supabase
      .from('entities')
      .select('id, mention_count')
      .eq('user_id', userId)
      .eq('canonical_name', canonicalName)
      .eq('entity_type', entity.entity_type)
      .maybeSingle();

    let entityId: string;

    if (existing) {
      // Update existing entity
      entityId = existing.id;
      await supabase.from('entities')
        .update({
          mention_count: existing.mention_count + 1,
          last_seen: new Date().toISOString()
        })
        .eq('id', entityId);
    } else {
      // Create new entity
      const { data: newEntity, error } = await supabase
        .from('entities')
        .insert({
          user_id: userId,
          entity_text: entity.entity_text,
          normalized_name: entity.normalized_name,
          canonical_name: canonicalName,
          display_name: entity.entity_text,
          entity_type: entity.entity_type,
          relationship: entity.relationship,
          context_category: entity.context_category,
          mention_count: 1,
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error) throw error;
      entityId = newEntity.id;
    }

    // Create mention record
    await supabase.from('entity_mentions').insert({
      entity_id: entityId,
      conversation_id: conversationId,
      chat_turn_id: chatTurnId,
      mention_text: entity.entity_text,
      timestamp: new Date().toISOString()
    });
  }
}

const ENTITY_EXTRACTION_SYSTEM_PROMPT = `Extract named entities from the conversation with their relationship to the user.

For each entity, provide:
1. Original text (how it appeared)
2. Normalized name (lowercase, no special chars, underscores for spaces)
3. Entity type (PERSON, ORG, LOCATION, PROJECT, TECH, MISC)
4. Relationship to user (if detectable from context)
5. Context category (work, family, health, etc.)

Relationship vocabulary:
- Family: parent, sibling, spouse, child, relative
- Work: colleague, boss, employee, client, partner
- Service: trainer, doctor, therapist, teacher, nanny
- Social: friend, neighbor, acquaintance
- Unknown: unknown (when insufficient context)

Use "unknown" for organizations, projects, locations unless specific relationship indicated.

Return ONLY valid JSON (no markdown):
{
  "entities": [
    {
      "entity_text": "Jennifer",
      "normalized_name": "jennifer",
      "entity_type": "PERSON",
      "relationship": "trainer",
      "context_category": "fitness"
    }
  ]
}`;

function buildExtractionPrompt(data: { content: string; speakers: string[] }): string {
  const speakers = data.speakers?.length
    ? `SPEAKERS: ${data.speakers.join(', ')}\n`
    : '';

  return `Extract entities from this conversation:

${speakers}CONTENT:
${data.content}

Return entities with their relationship to the user.`;
}
```

### Module 2: Save Chat Turn Integration (save_chat_turn/index.ts)

```typescript
// Add to imports
import { extractEntities, saveEntitiesWithMentions } from '../_shared/entity-extractor.ts';

// Modify main handler
async function saveWithEntities(requestData: SaveChatTurnRequest, openaiApiKey: string, supabase: SupabaseClient) {
  // Parallel execution with fault isolation
  const [gravityResult, entityResult] = await Promise.allSettled([
    classifyMemory({
      content: requestData.content,
      speakers: requestData.speakers,
      topics: requestData.topics
    }, openaiApiKey),

    extractEntities({
      content: requestData.content,
      speakers: requestData.speakers
    }, openaiApiKey)
  ]);

  // Handle results independently
  const classification = gravityResult.status === 'fulfilled'
    ? gravityResult.value
    : { impact_score: 0, intimacy_level: 0, reasoning: 'Classification failed' };

  const entities = entityResult.status === 'fulfilled'
    ? entityResult.value
    : [];

  // Log failures
  if (gravityResult.status === 'rejected') {
    console.warn('Gravity classification failed:', gravityResult.reason);
  }

  if (entityResult.status === 'rejected') {
    console.warn('Entity extraction failed:', entityResult.reason);
  }

  // Save chat turn first (entities need chat_turn_id)
  const { data: chatTurnData, error: chatTurnError } = await supabase
    .from('chat_turns')
    .insert({
      content: requestData.content,
      turn_range: requestData.turn_range,
      conversation_id: requestData.conversation_id,
      platform: requestData.platform || 'cli',
      speakers: requestData.speakers,
      turn_count: requestData.turn_count,
      start_timestamp: requestData.start_timestamp,
      end_timestamp: requestData.end_timestamp,
      topics: requestData.topics,
      hypothetical_questions: requestData.hypothetical_questions,
      embedding: `[${requestData.embedding.join(',')}]`,
      user_id: requestData.user_id,
      impact_score: classification.impact_score,
      intimacy_level: classification.intimacy_level,
      last_accessed: new Date().toISOString(),
      access_count: 0,
      gravity_score: null
    })
    .select('id')
    .single();

  if (chatTurnError) throw chatTurnError;

  // Save entities if extraction succeeded
  if (entities.length > 0) {
    await saveEntitiesWithMentions(
      entities,
      chatTurnData.id,
      requestData.conversation_id,
      requestData.user_id,
      supabase
    );
  }

  return {
    success: true,
    id: chatTurnData.id,
    classification: {
      impact_score: classification.impact_score,
      intimacy_level: classification.intimacy_level,
      reasoning: classification.reasoning
    },
    entities_extracted: entities.length
  };
}
```

## Testing Strategy

### Unit Tests

1. **Entity Extractor Tests**:
   - Valid extraction with relationships
   - Empty content handling
   - JSON parse error recovery
   - Empty speakers guard

2. **Canonical Name Tests**:
   - Relationship suffix generation
   - Special character handling
   - Consistency across variations

3. **Deduplication Tests**:
   - Exact match detection
   - New entity creation
   - Mention count increments

### Integration Tests

1. **Parallel Execution**:
   - Both operations succeed
   - One operation fails (verify fault isolation)
   - Both operations fail

2. **End-to-End**:
   - Save conversation → verify entities extracted
   - Multiple mentions → verify deduplication
   - Cross-conversation entities → verify linking

## Performance Considerations

### Current MVP Performance

- **Entity extraction latency**: ~200-300ms (GPT-4o-mini)
- **Gravity classification latency**: ~200-300ms
- **Parallel execution**: ~300ms total (not 600ms sequential)
- **Entity saving**: ~50ms per entity × 5-10 entities = 250-500ms
- **Total additional latency**: ~500-800ms per conversation

### Future Optimizations (Deferred)

1. **Batch entity inserts**: Replace loop with single upsert
2. **RPC for mention count**: Atomic increments
3. **Embedding-based linking**: "Jenn" → "jennifer_nanny"
4. **Entity relationship graph**: Co-occurrence tracking

## Rollback Plan

If entity extraction causes issues:

1. **Disable extraction**: Comment out `extractEntities` call, return empty array
2. **Keep migration**: Tables remain (for future retry)
3. **Monitor**: Entity extraction failures won't break conversation saving

**Graceful degradation**: Conversation saving always succeeds, entity extraction is best-effort.

## Success Metrics

- **Extraction accuracy**: >90% of obvious entities detected
- **Deduplication quality**: <5% duplicate entities with different relationships
- **Performance impact**: <1s additional latency for conversation save
- **Failure resilience**: 0% conversation save failures due to entity extraction

## Future Work (Not in This Phase)

1. **Entity-aware search** (Priority 2): Boost search results mentioning user's entities
2. **Relationship visualization** (Priority 4): Graph UI showing entity connections
3. **Advanced linking** (Priority 7): Embedding-based "Jenn" → "Jennifer" merging
4. **Batch backfill**: Process existing conversations for entities

## Dependencies

- Existing Edge Function: `save_chat_turn/index.ts`
- Existing Module: `_shared/memory-classifier.ts`
- Database: Entity memory schema (migrated)
- API: OpenAI GPT-4o-mini access

## Deployment

1. Apply schema migration: `migrations/entity_memory.sql`
2. Run RLS tests: `migrations/test_entity_memory_rls.sql`
3. Deploy updated Edge Function: `supabase functions deploy save_chat_turn`
4. Monitor logs for extraction failures
5. Validate entity data in production

---

**Design Status**: ✅ Approved
**Ready for Implementation**: Yes
**Estimated Effort**: 1-2 days

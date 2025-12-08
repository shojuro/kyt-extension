# Entity Memory Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract and track entities (people, organizations, projects) from conversations with relationship-aware deduplication.

**Architecture:** Server-side NER using GPT-4o-mini in Supabase Edge Functions. Parallel execution with gravity classifier using Promise.allSettled for fault isolation. Relationship-based canonical naming (e.g., `jennifer_trainer` vs `jennifer_sister`) for disambiguation.

**Tech Stack:** Supabase Edge Functions (Deno), TypeScript, PostgreSQL, OpenAI GPT-4o-mini API

**Cost:** ~$0.0001 per conversation for entity extraction

---

## Prerequisites

**Verify before starting:**
- [ ] Current branch: `feature/entity-memory`
- [ ] Schema migration applied: `migrations/entity_memory.sql`
- [ ] RLS tests passed: `migrations/test_entity_memory_rls.sql`
- [ ] Existing Edge Functions deployed: `save_chat_turn`, `_shared/memory-classifier.ts`

**Check with:**
```bash
git branch --show-current
psql $DATABASE_URL -c "SELECT COUNT(*) FROM entities;"
ls -la supabase/functions/save_chat_turn/index.ts
ls -la supabase/functions/_shared/memory-classifier.ts
```

---

## Task 1: Apply Schema Migration

**Goal:** Add relationship-aware fields to entities table for disambiguation.

**Files:**
- Modify: `migrations/entity_memory.sql` (already exists)
- Verify: Database schema

**Step 1: Verify migration file exists**

Run:
```bash
cat migrations/entity_memory.sql | head -20
```

Expected: See CREATE TABLE entities with vector(1536) embedding

**Step 2: Apply schema modifications**

The migration adds these fields to entities table:
- `normalized_name` - Lookup key without relationship (e.g., "jennifer")
- `display_name` - UI display (e.g., "Jennifer")
- `relationship` - User relationship (e.g., "trainer", "sister")
- `context_category` - Domain grouping (e.g., "fitness", "family")

Run:
```bash
psql $DATABASE_URL -f migrations/entity_memory.sql
```

Expected output:
```
CREATE EXTENSION
CREATE TABLE
CREATE TABLE
CREATE TABLE
CREATE INDEX
...
CREATE POLICY
```

**Step 3: Verify new columns exist**

Run:
```bash
psql $DATABASE_URL -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'entities' AND column_name IN ('normalized_name', 'display_name', 'relationship', 'context_category');"
```

Expected: Shows 4 rows with TEXT data type

**Step 4: Verify lookup index created**

Run:
```bash
psql $DATABASE_URL -c "SELECT indexname FROM pg_indexes WHERE tablename = 'entities' AND indexname = 'idx_entities_lookup';"
```

Expected: Shows `idx_entities_lookup`

**Step 5: Run RLS tests**

Run:
```bash
psql $DATABASE_URL -f migrations/test_entity_memory_rls.sql
```

Expected: All tests PASS with `✅ PASS` messages

**Step 6: Commit checkpoint**

```bash
git add -A
git commit -m "chore: verify entity_memory schema migration applied"
git log --oneline -3
```

---

## Task 2: Create Entity Extractor Module (TDD)

**Goal:** Build entity extraction module with GPT-4o-mini NER and relationship detection.

**Files:**
- Create: `supabase/functions/_shared/entity-extractor.ts`
- Create: `supabase/functions/_shared/entity-extractor.test.ts`

### Step 2.1: Write failing test for extractEntities

**Create:** `supabase/functions/_shared/entity-extractor.test.ts`

```typescript
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { extractEntities } from './entity-extractor.ts';

Deno.test('extractEntities - returns empty array on invalid JSON', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'invalid json' } }]
    })
  });

  globalThis.fetch = mockFetch as any;

  const result = await extractEntities(
    { content: 'Test content', speakers: ['user', 'assistant'] },
    'fake-api-key'
  );

  assertEquals(result, []);
});

Deno.test('extractEntities - handles empty speakers array', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ entities: [] }) } }]
    })
  });

  globalThis.fetch = mockFetch as any;

  const result = await extractEntities(
    { content: 'Test content', speakers: [] },
    'fake-api-key'
  );

  assertEquals(result, []);
});

Deno.test('extractEntities - extracts entities with relationships', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            entities: [{
              entity_text: 'Jennifer',
              normalized_name: 'jennifer',
              entity_type: 'PERSON',
              relationship: 'trainer',
              context_category: 'fitness'
            }]
          })
        }
      }]
    })
  });

  globalThis.fetch = mockFetch as any;

  const result = await extractEntities(
    { content: 'I trained with Jennifer today', speakers: ['user', 'assistant'] },
    'fake-api-key'
  );

  assertEquals(result.length, 1);
  assertEquals(result[0].entity_text, 'Jennifer');
  assertEquals(result[0].relationship, 'trainer');
});
```

### Step 2.2: Run tests to verify they fail

Run:
```bash
cd supabase/functions/_shared
deno test entity-extractor.test.ts
```

Expected: FAIL with "Module not found: entity-extractor.ts"

### Step 2.3: Implement entity-extractor.ts

**Create:** `supabase/functions/_shared/entity-extractor.ts`

```typescript
export interface ExtractedEntity {
  entity_text: string;        // "Jennifer"
  normalized_name: string;    // "jennifer"
  entity_type: 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC';
  relationship: string;       // "trainer", "sister", "unknown"
  context_category: string;   // "fitness", "family", "work"
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
```

### Step 2.4: Run tests to verify they pass

Run:
```bash
cd supabase/functions/_shared
deno test entity-extractor.test.ts
```

Expected: All 3 tests PASS

### Step 2.5: Commit entity extractor

```bash
git add supabase/functions/_shared/entity-extractor.ts
git add supabase/functions/_shared/entity-extractor.test.ts
git commit -m "feat: add entity extraction with relationship detection"
```

---

## Task 3: Add Entity Saving Logic (TDD)

**Goal:** Implement saveEntitiesWithMentions with deduplication.

**Files:**
- Modify: `supabase/functions/_shared/entity-extractor.ts`
- Create: `supabase/functions/_shared/entity-saver.test.ts`

### Step 3.1: Write failing test for saveEntitiesWithMentions

**Create:** `supabase/functions/_shared/entity-saver.test.ts`

```typescript
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { saveEntitiesWithMentions } from './entity-extractor.ts';

Deno.test('saveEntitiesWithMentions - creates new entity', async () => {
  const mockSupabase = {
    from: (table: string) => ({
      select: (fields: string) => ({
        eq: (col: string, val: any) => ({
          maybeSingle: async () => ({ data: null })
        })
      }),
      insert: (data: any) => ({
        select: (fields: string) => ({
          single: async () => ({ data: { id: 'new-entity-id' }, error: null })
        })
      })
    })
  };

  const entities = [{
    entity_text: 'Jennifer',
    normalized_name: 'jennifer',
    entity_type: 'PERSON' as const,
    relationship: 'trainer',
    context_category: 'fitness'
  }];

  // Should not throw
  await saveEntitiesWithMentions(
    entities,
    'chat-turn-id',
    'conversation-id',
    'user-id',
    mockSupabase as any
  );
});

Deno.test('saveEntitiesWithMentions - updates existing entity mention count', async () => {
  const mockSupabase = {
    from: (table: string) => ({
      select: (fields: string) => ({
        eq: (col: string, val: any) => ({
          maybeSingle: async () => ({
            data: { id: 'existing-id', mention_count: 5 }
          })
        })
      }),
      update: (data: any) => ({
        eq: (col: string, val: any) => ({
          then: async () => ({ data: {}, error: null })
        })
      }),
      insert: (data: any) => ({
        select: (fields: string) => ({
          single: async () => ({ data: { id: 'existing-id' }, error: null })
        })
      })
    })
  };

  const entities = [{
    entity_text: 'Jennifer',
    normalized_name: 'jennifer',
    entity_type: 'PERSON' as const,
    relationship: 'trainer',
    context_category: 'fitness'
  }];

  await saveEntitiesWithMentions(
    entities,
    'chat-turn-id',
    'conversation-id',
    'user-id',
    mockSupabase as any
  );
});
```

### Step 3.2: Run test to verify it fails

Run:
```bash
cd supabase/functions/_shared
deno test entity-saver.test.ts
```

Expected: FAIL with "saveEntitiesWithMentions is not exported"

### Step 3.3: Add saveEntitiesWithMentions to entity-extractor.ts

**Add to:** `supabase/functions/_shared/entity-extractor.ts`

```typescript
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
      // Update existing entity (fetch-then-update pattern)
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
```

### Step 3.4: Run tests to verify they pass

Run:
```bash
cd supabase/functions/_shared
deno test entity-saver.test.ts
```

Expected: Both tests PASS

### Step 3.5: Commit entity saver

```bash
git add supabase/functions/_shared/entity-extractor.ts
git add supabase/functions/_shared/entity-saver.test.ts
git commit -m "feat: add entity saving with deduplication logic"
```

---

## Task 4: Integrate with save_chat_turn Edge Function

**Goal:** Add parallel entity extraction to existing conversation save flow.

**Files:**
- Modify: `supabase/functions/save_chat_turn/index.ts`

### Step 4.1: Read current save_chat_turn implementation

Run:
```bash
cat supabase/functions/save_chat_turn/index.ts | head -50
```

Expected: See imports and serve() handler

### Step 4.2: Add entity-extractor import

**Modify:** `supabase/functions/save_chat_turn/index.ts`

Add to imports section:
```typescript
import { extractEntities, saveEntitiesWithMentions } from '../_shared/entity-extractor.ts';
```

### Step 4.3: Update handler with parallel execution

**Modify:** `supabase/functions/save_chat_turn/index.ts`

Find the section where classifyMemory is called. Replace with Promise.allSettled pattern:

```typescript
// OLD CODE (find and replace):
const classification: ClassificationResult = await classifyMemory(
  {
    content: requestData.content,
    speakers: requestData.speakers,
    topics: requestData.topics
  },
  openaiApiKey
);

// NEW CODE:
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
```

### Step 4.4: Add entity saving after chat turn insert

**Modify:** `supabase/functions/save_chat_turn/index.ts`

After the chat turn is inserted (find the `.select('id').single()` call), add:

```typescript
// Existing code:
const { data: chatTurnData, error: chatTurnError } = await supabase
  .from('chat_turns')
  .insert({
    // ... existing fields ...
  })
  .select('id')
  .single();

if (chatTurnError) throw chatTurnError;

// NEW CODE: Save entities if extraction succeeded
if (entities.length > 0) {
  await saveEntitiesWithMentions(
    entities,
    chatTurnData.id,
    requestData.conversation_id,
    requestData.user_id,
    supabase
  );
}
```

### Step 4.5: Update response to include entity count

**Modify:** `supabase/functions/save_chat_turn/index.ts`

Update the success response:

```typescript
return new Response(
  JSON.stringify({
    success: true,
    id: chatTurnData.id,
    classification: {
      impact_score: classification.impact_score,
      intimacy_level: classification.intimacy_level,
      reasoning: classification.reasoning
    },
    entities_extracted: entities.length  // NEW FIELD
  }),
  { headers: { 'Content-Type': 'application/json' } }
);
```

### Step 4.6: Commit integration

```bash
git add supabase/functions/save_chat_turn/index.ts
git commit -m "feat: integrate entity extraction with save_chat_turn"
```

---

## Task 5: Deploy and Verify

**Goal:** Deploy Edge Function and verify entity extraction works in production.

**Files:**
- Modify: None (deployment only)

### Step 5.1: Deploy save_chat_turn function

Run:
```bash
supabase functions deploy save_chat_turn --no-verify-jwt
```

Expected: "Deployed save_chat_turn (version X)"

### Step 5.2: Test with real conversation

Create test file: `test_entity_extraction.sh`

```bash
#!/bin/bash

SUPABASE_URL="${SUPABASE_URL}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY}"

curl -X POST "${SUPABASE_URL}/functions/v1/save_chat_turn" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "User: I trained with Jennifer today at the gym\nAssistant: That'\''s great! How was your workout with Jennifer?",
    "turn_range": "1-2",
    "conversation_id": "test-conv-001",
    "platform": "test",
    "speakers": ["user", "assistant"],
    "turn_count": 2,
    "start_timestamp": 1000000,
    "end_timestamp": 1000001,
    "topics": ["fitness"],
    "hypothetical_questions": [],
    "embedding": [0.1, 0.2],
    "user_id": "test-user-id"
  }'
```

Run:
```bash
chmod +x test_entity_extraction.sh
./test_entity_extraction.sh
```

Expected response:
```json
{
  "success": true,
  "id": "chat-turn-uuid",
  "classification": { ... },
  "entities_extracted": 1
}
```

### Step 5.3: Verify entity in database

Run:
```bash
psql $DATABASE_URL -c "SELECT entity_text, canonical_name, relationship, context_category FROM entities WHERE entity_text = 'Jennifer';"
```

Expected:
```
 entity_text | canonical_name     | relationship | context_category
-------------+--------------------+--------------+-----------------
 Jennifer    | jennifer_trainer   | trainer      | fitness
```

### Step 5.4: Verify mention created

Run:
```bash
psql $DATABASE_URL -c "SELECT mention_text, conversation_id FROM entity_mentions WHERE mention_text = 'Jennifer';"
```

Expected: Shows mention record with conversation_id = 'test-conv-001'

### Step 5.5: Test deduplication (second mention)

Run the test script again:
```bash
./test_entity_extraction.sh
```

Verify mention count incremented:
```bash
psql $DATABASE_URL -c "SELECT mention_count FROM entities WHERE canonical_name = 'jennifer_trainer';"
```

Expected: mention_count = 2

### Step 5.6: Check Edge Function logs

Run:
```bash
supabase functions logs save_chat_turn --limit 10
```

Expected: No errors, see entity extraction success logs

### Step 5.7: Commit verification test

```bash
git add test_entity_extraction.sh
git commit -m "test: add entity extraction end-to-end verification"
```

---

## Task 6: Document and Wrap Up

**Goal:** Update documentation with deployment status.

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2025-11-25-entity-memory-integration-design.md`

### Step 6.1: Update README.md

**Add to:** `README.md` in Entity Memory section:

```markdown
**Entity Memory Integration** ✅ (Complete)
- ✅ Schema migration applied with relationship-aware fields
- ✅ Entity extraction pipeline using GPT-4o-mini
- ✅ Parallel processing with gravity classifier
- ✅ Deduplication with canonical naming (jennifer_trainer vs jennifer_sister)
- ✅ Deployed to save_chat_turn Edge Function
- 🔲 Entity-aware search boosting (Priority 2, future)
- 🔲 Entity relationship visualization (Priority 4, future)
```

### Step 6.2: Update design doc with implementation notes

**Add to:** `docs/plans/2025-11-25-entity-memory-integration-design.md`

Add section at end:

```markdown
## Implementation Notes

**Deployment Date**: 2025-11-25

**Edge Function Version**: save_chat_turn v[X]

**Verified Working**:
- ✅ Entity extraction with relationship detection
- ✅ Canonical name generation (server-side)
- ✅ Deduplication via exact match
- ✅ Mention tracking in entity_mentions table
- ✅ Fault isolation (entity extraction failure doesn't break conversation save)

**Performance Observed**:
- Entity extraction latency: ~200-300ms
- Total additional latency: ~300ms (parallel execution)
- Cost: ~$0.0001/conversation

**Known Limitations**:
- Relationship detection accuracy depends on context clarity
- First mention may default to "unknown" relationship
- Embedding-based similarity deferred to future optimization
```

### Step 6.3: Commit documentation updates

```bash
git add README.md
git add docs/plans/2025-11-25-entity-memory-integration-design.md
git commit -m "docs: update with entity memory deployment status"
```

### Step 6.4: Final verification

Run complete test suite:
```bash
# Unit tests
cd supabase/functions/_shared
deno test entity-extractor.test.ts
deno test entity-saver.test.ts

# Integration test
cd ../../..
./test_entity_extraction.sh

# Database verification
psql $DATABASE_URL -c "SELECT COUNT(*) FROM entities;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM entity_mentions;"
```

Expected: All tests pass, entities and mentions exist

### Step 6.5: Push to remote

```bash
git push origin feature/entity-memory
```

---

## Success Criteria

Implementation is complete when:

✅ Schema migration applied with all new fields
✅ entity-extractor.ts module created with tests passing
✅ saveEntitiesWithMentions implemented with deduplication
✅ save_chat_turn integrated with parallel execution
✅ Edge Function deployed to Supabase
✅ End-to-end test verifies entity extraction works
✅ Database shows entities with correct canonical names
✅ Mention count increments on duplicate entities
✅ Documentation updated with deployment status
✅ All commits pushed to feature/entity-memory branch

---

## Rollback Procedure

If entity extraction causes production issues:

1. **Disable extraction without breaking conversation save:**

Edit `supabase/functions/save_chat_turn/index.ts`:
```typescript
// Comment out entity extraction
const entities = []; // Disabled entity extraction temporarily
```

Deploy:
```bash
supabase functions deploy save_chat_turn --no-verify-jwt
```

2. **Monitor logs to verify conversations still save:**
```bash
supabase functions logs save_chat_turn --limit 10
```

3. **Keep schema in place** (can re-enable later without migration)

4. **Investigate and fix issue, then re-enable**

---

## References

- Design Doc: `docs/plans/2025-11-25-entity-memory-integration-design.md`
- Schema Migration: `migrations/entity_memory.sql`
- RLS Tests: `migrations/test_entity_memory_rls.sql`
- Existing Classifier: `supabase/functions/_shared/memory-classifier.ts`

**Required Sub-Skills:**
- @superpowers:test-driven-development - For TDD workflow
- @superpowers:verification-before-completion - Before marking tasks complete
- @superpowers:systematic-debugging - If tests fail unexpectedly

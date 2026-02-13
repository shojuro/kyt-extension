/**
 * Entity Extractor Module - Relationship-Aware Version
 * Purpose: Extract named entities with relationships from conversation content
 * Framework: Uses OpenAI GPT-4o-mini for entity recognition
 * Date: 2025-11-25
 *
 * Key Feature: Relationship-aware canonical naming for disambiguation
 * Example: "jennifer_trainer" vs "jennifer_sister"
 *
 * Entity Types (matching entity_memory.sql schema):
 * - PERSON: Individuals, names
 * - ORG: Companies, institutions
 * - LOCATION: Cities, countries, places
 * - PROJECT: Software projects, initiatives
 * - TECH: Programming languages, frameworks, tools
 * - MISC: Miscellaneous entities
 */

// Types (matching approved design from entity-memory-integration-design.md)
export interface ExtractedEntity {
  entity_text: string;         // Original text: "Jennifer"
  normalized_name: string;     // Lowercase, no special chars: "jennifer"
  entity_type: 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC' | 'CONCEPT' | 'ANALOGY' | 'THEME';
  relationship: string;        // "trainer", "sister", "colleague", "unknown"
  context_category: string;    // "fitness", "family", "work", "general"
}

export interface EntityExtractionData {
  content: string;              // Conversation content to extract from
  speakers: string[];           // Participants in conversation
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * System prompt for relationship-aware entity extraction
 * Instructs GPT-4o-mini to identify entities AND their relationship to the user
 */
const ENTITY_EXTRACTION_SYSTEM_PROMPT = `Extract named entities AND abstract concepts from the conversation with their relationship to the user.

For each entity, provide:
1. Original text (how it appeared)
2. Normalized name (lowercase, no special chars, underscores for spaces)
3. Entity type: PERSON, ORG, LOCATION, PROJECT, TECH, MISC, CONCEPT, ANALOGY, THEME
4. Relationship to user (if detectable from context)
5. Context category (work, family, health, etc.)

Entity type definitions:
- PERSON: Individuals, names
- ORG: Companies, institutions
- LOCATION: Cities, countries, places
- PROJECT: Software projects, initiatives
- TECH: Programming languages, frameworks, tools
- MISC: Miscellaneous named entities
- CONCEPT: Abstract ideas or principles discussed ("incremental learning", "progressive complexity", "sunk cost")
- ANALOGY: Metaphors, comparisons, or illustrative stories used ("walking analogy for learning", "child taking steps")
- THEME: Recurring life themes or philosophies ("parenting philosophy", "growth mindset", "resilience")

Relationship vocabulary:
- Family: parent, sibling, spouse, child, relative
- Work: colleague, boss, employee, client, partner
- Service: trainer, doctor, therapist, teacher, nanny
- Social: friend, neighbor, acquaintance
- Conceptual: discussed, illustrates, demonstrates, advocates
- Unknown: unknown (when insufficient context)

Use "unknown" for organizations, projects, locations unless specific relationship indicated.
For CONCEPT/ANALOGY/THEME types, use "discussed" as default relationship.

Return ONLY valid JSON (no markdown):
{
  "entities": [
    {
      "entity_text": "Jennifer",
      "normalized_name": "jennifer",
      "entity_type": "PERSON",
      "relationship": "trainer",
      "context_category": "fitness"
    },
    {
      "entity_text": "incremental learning",
      "normalized_name": "incremental_learning",
      "entity_type": "CONCEPT",
      "relationship": "discussed",
      "context_category": "education"
    },
    {
      "entity_text": "walking analogy for learning",
      "normalized_name": "walking_analogy_for_learning",
      "entity_type": "ANALOGY",
      "relationship": "illustrates",
      "context_category": "parenting"
    }
  ]
}`;

/**
 * Build extraction prompt from conversation data
 */
function buildExtractionPrompt(data: EntityExtractionData): string {
  const { content, speakers } = data;

  const speakersInfo = speakers.length > 0
    ? `SPEAKERS: ${speakers.join(', ')}\n\n`
    : '';

  return `Extract entities from this conversation:

${speakersInfo}CONTENT:
${content}

Return entities with their relationship to the user.`;
}

/**
 * Main entity extraction function
 * Calls OpenAI GPT-4o-mini to extract entities with relationships
 * Returns array of extracted entities with relationship-aware metadata
 */
export async function extractEntities(
  data: EntityExtractionData,
  openaiApiKey: string
): Promise<ExtractedEntity[]> {
  // Input validation
  if (!data.content || data.content.trim().length === 0) {
    throw new Error('Content cannot be empty');
  }

  if (!data.speakers || data.speakers.length === 0) {
    throw new Error('Speakers array cannot be empty');
  }

  if (!openaiApiKey || openaiApiKey.trim().length === 0) {
    throw new Error('OpenAI API key is required');
  }

  // Build extraction prompt
  const prompt = buildExtractionPrompt(data);

  // Call OpenAI API with structured output
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
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,          // Low temperature for consistent extraction
      max_tokens: 700,           // Sufficient for entity + concept lists
      response_format: { type: 'json_object' }  // Force JSON output
    })
  });

  // Error handling for API failures
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const result: OpenAIResponse = await response.json();

  // Parse entity extraction results
  try {
    const content = result.choices[0]?.message?.content;
    if (!content) {
      return [];  // No entities extracted
    }

    const parsed = JSON.parse(content);
    const entities = Array.isArray(parsed.entities) ? parsed.entities : [];

    // Validate and normalize entities
    return entities.map((entity: any) => ({
      entity_text: entity.entity_text || '',
      normalized_name: entity.normalized_name || normalizeEntityName(entity.entity_text),
      entity_type: validateEntityType(entity.entity_type),
      relationship: entity.relationship || 'unknown',
      context_category: entity.context_category || 'general'
    }));

  } catch (error) {
    // JSON parse error - return empty array instead of failing
    console.warn('Entity extraction JSON parse failed:', error);
    return [];
  }
}

/**
 * Normalize entity name to standard form
 * Converts "Jennifer Smith" -> "jennifer_smith"
 */
function normalizeEntityName(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')  // Remove punctuation
    .replace(/\s+/g, '_');     // Replace spaces with underscores
}

/**
 * Validate and normalize entity type
 * Ensures type matches schema enum values
 */
function validateEntityType(type: string): 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC' | 'CONCEPT' | 'ANALOGY' | 'THEME' {
  const upperType = (type || '').toUpperCase();

  // Map common variations
  if (upperType === 'PER' || upperType === 'PERSON') return 'PERSON';
  if (upperType === 'LOC' || upperType === 'LOCATION') return 'LOCATION';
  if (upperType === 'ORG' || upperType === 'ORGANIZATION') return 'ORG';
  if (upperType === 'PROJ' || upperType === 'PROJECT') return 'PROJECT';
  if (upperType === 'TECH' || upperType === 'TECHNOLOGY') return 'TECH';
  if (upperType === 'CONCEPT') return 'CONCEPT';
  if (upperType === 'ANALOGY' || upperType === 'METAPHOR') return 'ANALOGY';
  if (upperType === 'THEME') return 'THEME';

  return 'MISC';
}

/**
 * Save extracted entities to database with deduplication
 * Creates entity_mentions records linking entities to chat turns
 * Uses relationship-aware canonical naming (e.g., "jennifer_trainer")
 * Generates embeddings for new entities using HuggingFace if client provided
 * Tracks co-occurrence relationships between entities in the same turn
 *
 * @param entities - Array of extracted entities from extractEntities()
 * @param chatTurnId - UUID of the chat turn where entities were mentioned
 * @param conversationId - TEXT conversation ID for grouping
 * @param userId - UUID of the user who owns these entities
 * @param supabase - Supabase client with auth context
 * @param hfClient - Optional HuggingFaceClient for generating entity embeddings
 */
export async function saveEntitiesWithMentions(
  entities: ExtractedEntity[],
  chatTurnId: string,
  conversationId: string,
  userId: string,
  supabase: any,
  hfClient?: any
): Promise<void> {
  const savedEntityIds: string[] = [];

  for (const entity of entities) {
    // Server-side canonical name generation
    // Format: normalized_name + "_" + relationship
    // Example: "jennifer_trainer", "jennifer_sister"
    const canonicalName = `${entity.normalized_name}_${entity.relationship}`;

    // Exact match check using canonical_name for deduplication
    const { data: existing } = await supabase
      .from('entities')
      .select('id, mention_count')
      .eq('user_id', userId)
      .eq('canonical_name', canonicalName)
      .eq('entity_type', entity.entity_type)
      .maybeSingle();

    let entityId: string;

    if (existing) {
      // Update existing entity: increment mention_count, update last_seen
      entityId = existing.id;
      await supabase.from('entities')
        .update({
          mention_count: existing.mention_count + 1,
          last_seen: new Date().toISOString()
        })
        .eq('id', entityId);
    } else {
      // Phase 5: Fuzzy dedup — check if a similar entity exists via embedding similarity
      // Only merge if: same entity_type AND high embedding similarity (>= 0.90)
      // This handles "Jenn" → "Jennifer_trainer" merges while keeping
      // "Jennifer_trainer" and "Jennifer_sister" distinct
      let mergedEntityId: string | null = null;

      if (hfClient) {
        try {
          // Generate embedding to compare against existing entities
          const candidateEmbeddings = await hfClient.generateEmbeddings(
            `${entity.entity_text} (${entity.entity_type}, ${entity.relationship})`
          );
          const candidateEmbedding = candidateEmbeddings[0];

          if (candidateEmbedding) {
            const { data: similarEntities, error: simError } = await supabase
              .rpc('find_similar_entities', {
                p_user_id: userId,
                p_entity_type: entity.entity_type,
                p_embedding: `[${candidateEmbedding.join(',')}]`,
                p_canonical_name: canonicalName,
                p_similarity_threshold: 0.90
              });

            if (!simError && similarEntities && similarEntities.length > 0) {
              // Additional guard: relationship suffix must match to prevent cross-merging
              // e.g. "jenn_trainer" can merge into "jennifer_trainer" but NOT "jennifer_sister"
              const bestMatch = similarEntities.find((s: any) => {
                const matchRelationship = s.canonical_name.split('_').pop();
                return matchRelationship === entity.relationship;
              });

              if (bestMatch) {
                console.log(`Entity resolution: merging "${canonicalName}" into existing "${bestMatch.canonical_name}" (similarity: ${bestMatch.similarity.toFixed(3)})`);
                mergedEntityId = bestMatch.id;
                await supabase.from('entities')
                  .update({
                    mention_count: bestMatch.mention_count + 1,
                    last_seen: new Date().toISOString()
                  })
                  .eq('id', mergedEntityId);
              }
            }
          }
        } catch (err) {
          console.warn(`Entity resolution check failed for "${canonicalName}":`, err);
          // Fall through to create new entity
        }
      }

      if (mergedEntityId) {
        entityId = mergedEntityId;
      } else {
      // Generate embedding for the new entity's canonical name
      let entityEmbedding: number[] | null = null;
      if (hfClient) {
        try {
          const embeddings = await hfClient.generateEmbeddings(
            `${entity.entity_text} (${entity.entity_type}, ${entity.relationship})`
          );
          entityEmbedding = embeddings[0] || null;
        } catch (err) {
          console.warn(`Failed to generate embedding for entity "${canonicalName}":`, err);
        }
      }

      // Create new entity with all required fields
      const insertData: Record<string, any> = {
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
      };

      if (entityEmbedding) {
        insertData.embedding = `[${entityEmbedding.join(',')}]`;
      }

      const { data: newEntity, error } = await supabase
        .from('entities')
        .insert(insertData)
        .select('id')
        .single();

      if (error) throw error;
      entityId = newEntity.id;
      } // close: else → create new entity (no merge candidate found)
    } // close: outer else → no exact canonical_name match

    savedEntityIds.push(entityId);

    // Create mention record linking entity to this chat turn
    await supabase.from('entity_mentions').insert({
      entity_id: entityId,
      conversation_id: conversationId,
      chat_turn_id: chatTurnId,
      mention_text: entity.entity_text,
      timestamp: new Date().toISOString()
    });
  }

  // Track co-occurrence relationships between all entity pairs in this turn
  if (savedEntityIds.length >= 2) {
    for (let i = 0; i < savedEntityIds.length; i++) {
      for (let j = i + 1; j < savedEntityIds.length; j++) {
        try {
          const relType = classifyRelationshipType(entities[i], entities[j]);
          await supabase.rpc('upsert_entity_relationship', {
            p_user_id: userId,
            p_entity_a: savedEntityIds[i],
            p_entity_b: savedEntityIds[j],
            p_relationship_type: relType
          });
        } catch (err) {
          console.warn(`Failed to upsert entity relationship:`, err);
        }
      }
    }
  }
}

/**
 * Classify the relationship type between two entities based on their metadata.
 * Derives type from entity_type and relationship fields — no extra LLM call needed.
 *
 * Classification rules (in priority order):
 * 1. Family relationships (PERSON + family relationship) → 'family_of'
 * 2. Work/service relationships (PERSON + work/service) → 'works_with'
 * 3. CONCEPT/ANALOGY/THEME pairs → 'illustrates' or 'discussed_together'
 * 4. Default → 'co_occurrence'
 */
function classifyRelationshipType(entityA: ExtractedEntity, entityB: ExtractedEntity): string {
  const familyRelations = new Set(['parent', 'sibling', 'spouse', 'child', 'relative', 'mother', 'father', 'sister', 'brother', 'daughter', 'son', 'wife', 'husband']);
  const workRelations = new Set(['colleague', 'boss', 'employee', 'client', 'partner', 'coworker']);
  const serviceRelations = new Set(['trainer', 'doctor', 'therapist', 'teacher', 'nanny', 'coach', 'mentor', 'advisor']);
  const conceptTypes = new Set(['CONCEPT', 'ANALOGY', 'THEME']);

  // Check if either entity has a family relationship
  if (entityA.entity_type === 'PERSON' || entityB.entity_type === 'PERSON') {
    if (familyRelations.has(entityA.relationship) || familyRelations.has(entityB.relationship)) {
      return 'family_of';
    }
    if (workRelations.has(entityA.relationship) || workRelations.has(entityB.relationship)) {
      return 'works_with';
    }
    if (serviceRelations.has(entityA.relationship) || serviceRelations.has(entityB.relationship)) {
      return 'works_with';
    }
  }

  // CONCEPT/ANALOGY/THEME entities
  const aIsConcept = conceptTypes.has(entityA.entity_type);
  const bIsConcept = conceptTypes.has(entityB.entity_type);

  if (aIsConcept || bIsConcept) {
    // If one is ANALOGY and the other is not, it "illustrates" the relationship
    if (entityA.entity_type === 'ANALOGY' || entityB.entity_type === 'ANALOGY') {
      return 'illustrates';
    }
    return 'discussed_together';
  }

  return 'co_occurrence';
}

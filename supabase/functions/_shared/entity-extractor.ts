/**
 * Entity Extractor Module - Relationship-Aware Version
 * Purpose: Extract named entities with relationships from conversation content
 * Framework: Uses Claude Haiku 4.5 for entity recognition (migrated from GPT-4o-mini)
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

export interface ExtractedPreference {
    category: string;
    value: string;
    sentiment: 'positive' | 'negative' | 'neutral';
}

export interface EntityExtractionData {
  content: string;              // Conversation content to extract from
  speakers: string[];           // Participants in conversation
}

import { AnthropicClient } from "./anthropic-client.ts";

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
- TECH: Programming languages, frameworks, tools, AND user-defined product modes, features, or configuration options
  (e.g., "incognito mode", "clean room mode", "full memory mode", "dark mode", "dev mode")
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

When the user defines or names configuration modes, feature tiers, or classification levels, extract each as a TECH entity even if the name uses common words (e.g., "clean room" is a TECH entity when it names a product mode, not a LOCATION).

PREFERENCE EXTRACTION (in the same response):
Also extract user preferences — things the user states they like, love, prefer, dislike, hate, want, enjoy, find amazing, can't stand, always use, or have switched to. Include strong evaluative statements ("X is amazing", "nothing beats X") and behavioral signals ("I always use X", "I switched to X").

Rules:
- ONLY extract from USER statements, never from assistant responses
- ONLY extract when the user STATES a preference — NOT when they ASK about one
- Normalize categories to common singular nouns: "car" not "vehicle/automobile"
- Sentiment: "positive" for likes/loves/favorites, "negative" for dislikes/hates, "neutral" otherwise

EXPLICIT preference examples:
"My favorite car is Lamborghini"               → {category: "car", value: "Lamborghini", sentiment: "positive"}
"I love sushi"                                  → {category: "food", value: "sushi", sentiment: "positive"}
"Python is my go-to language"                   → {category: "programming_language", value: "Python", sentiment: "positive"}
"I hate cold weather"                           → {category: "weather", value: "cold weather", sentiment: "negative"}
"I prefer Neovim over VS Code"                  → {category: "editor", value: "Neovim", sentiment: "positive"}

EVALUATIVE preference examples (strong opinions = preferences):
"The Lamborghini FenoMeno is amazing. I want it." → {category: "car", value: "Lamborghini FenoMeno", sentiment: "positive"}
"Nothing beats a good steak"                    → {category: "food", value: "steak", sentiment: "positive"}

BEHAVIORAL preference examples (habitual use = preferences):
"I always use Docker for deployment"            → {category: "deployment_tool", value: "Docker", sentiment: "positive"}
"I switched from VS Code to Cursor"             → {category: "editor", value: "Cursor", sentiment: "positive"}

EXPERIENTIAL preference examples (strong reactions = preferences):
"I really enjoyed raging rapids as a kid"       → {category: "activity", value: "raging rapids", sentiment: "positive"}
"I can't stand meetings without agendas"        → {category: "work_practice", value: "meetings without agendas", sentiment: "negative"}

DO NOT extract preferences from questions:
"What is my favorite car?"              → NO preference extraction (this is a question)
"Do I like Ferraris?"                   → NO preference extraction (this is a question)
"Tell me about my food preferences"     → NO preference extraction (this is a question)

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
  ],
  "preferences": [
    {
      "category": "car",
      "value": "Lamborghini",
      "sentiment": "positive"
    }
  ]
}`;

/**
 * Strip assistant content from multi-turn chunks.
 * Prevents the extractor from pulling preferences from assistant echoes
 * (e.g. "your favorite car is Lamborghini" in an assistant response).
 *
 * Format produced by conversation-chunker.js:
 *   "User: {msg}\n\nAssistant: {msg}\n\nUser: {msg}"
 *
 * For single-role turns (from save_chat_turn_batch), content has no
 * "Assistant:" prefix, so this function is a no-op (correct behavior).
 */

/**
 * Strip K.Y.T. injection blocks from user content.
 * Injection blocks contain retrieved items from the user's knowledge base
 * that were prepended to the user's actual message. The LLM falsely extracts
 * preferences from these echo items (e.g. "your favorite car is red Lamborghinis").
 *
 * Two formats exist:
 *  1. Full: "==== K.Y.T. — User's Personal Knowledge Base ==== ... [End of Knowledge Base Context] ==== --- actual message"
 *  2. Compact: "K.Y.T. — User's Personal Knowledge Base [RESPONSE_PRIORITY] ... --- actual message"
 *
 * Both end with a "---" separator before the actual user message.
 * If no K.Y.T. marker is found, returns content unchanged.
 */
function stripInjectionBlocks(content: string): string {
  // Fast path: no injection block present
  if (!content.includes('K.Y.T.')) return content;

  // Split on lines, find K.Y.T. block boundaries and strip them
  const lines = content.split('\n');
  const kept: string[] = [];
  let inInjectionBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of injection block
    if (!inInjectionBlock && /K\.Y\.T\.\s*(?:—|[-–])\s*User/i.test(line)) {
      inInjectionBlock = true;
      // Also skip preceding === separator lines
      while (kept.length > 0 && /^=+$/.test(kept[kept.length - 1].trim())) {
        kept.pop();
      }
      continue;
    }

    // Detect end of injection block: a line that is just "---"
    if (inInjectionBlock && /^-{3,}\s*$/.test(line)) {
      inInjectionBlock = false;
      continue;
    }

    if (!inInjectionBlock) {
      kept.push(line);
    }
  }

  const result = kept.join('\n').trim();
  // If stripping removed everything (edge case), return original
  return result.length > 0 ? result : content;
}

function stripAssistantContent(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inAssistantBlock = false;

  for (const line of lines) {
    if (/^Assistant\s*:/i.test(line)) {
      inAssistantBlock = true;
      continue;
    }
    if (/^User\s*:/i.test(line)) {
      inAssistantBlock = false;
    }
    if (!inAssistantBlock) {
      kept.push(line);
    }
  }

  return kept.join('\n').trim();
}

function buildExtractionPrompt(data: EntityExtractionData): string {
  const { content, speakers } = data;

  // Strip assistant blocks, then K.Y.T. injection blocks from user content.
  // Prevents false preference extraction from assistant echoes and
  // retrieved-item context that contains previously-stored preferences.
  const cleaned = stripInjectionBlocks(stripAssistantContent(content));

  const speakersInfo = speakers.length > 0
    ? `SPEAKERS: ${speakers.join(', ')}\n\n`
    : '';

  return `Extract entities and user preferences from this conversation:

${speakersInfo}CONTENT:
${cleaned}

Return entities with their relationship to the user, and any user preferences detected.`;
}

/**
 * Main entity extraction function
 * Calls Claude Haiku 4.5 to extract entities with relationships
 * Returns array of extracted entities with relationship-aware metadata
 *
 * Benefits of Haiku 4.5 over GPT-4o-mini for this task:
 * - Prompt caching: 1600-word system prompt cached after first call (90% discount within 5min TTL)
 * - Better instruction following for structured extraction
 */
export async function extractEntities(
  data: EntityExtractionData,
  anthropicApiKey: string
): Promise<{ entities: ExtractedEntity[], preferences: ExtractedPreference[] }> {
  // Input validation
  if (!data.content || data.content.trim().length === 0) {
    throw new Error('Content cannot be empty');
  }

  if (!data.speakers || data.speakers.length === 0) {
    throw new Error('Speakers array cannot be empty');
  }

  if (!anthropicApiKey || anthropicApiKey.trim().length === 0) {
    throw new Error('Anthropic API key is required');
  }

  // Build extraction prompt
  const prompt = buildExtractionPrompt(data);

  try {
    const client = new AnthropicClient(anthropicApiKey);

    const parsed = await client.generateJsonCompletion<{
      entities?: Array<{
        entity_text?: string;
        normalized_name?: string;
        entity_type?: string;
        relationship?: string;
        context_category?: string;
      }>;
      preferences?: Array<{
        category?: string;
        value?: string;
        sentiment?: string;
      }>;
    }>(
      ENTITY_EXTRACTION_SYSTEM_PROMPT,
      prompt,
      {
        temperature: 0.2,
        maxTokens: 900,
        maxRetries: 2,
        timeoutMs: 8000,
        operation: 'entity_extraction',
      }
    );

    const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];

    // Validate and normalize entities
    const entities: ExtractedEntity[] = rawEntities.map((entity: any) => ({
      entity_text: entity.entity_text || '',
      normalized_name: entity.normalized_name || normalizeEntityName(entity.entity_text),
      entity_type: validateEntityType(entity.entity_type),
      relationship: entity.relationship || 'unknown',
      context_category: entity.context_category || 'general'
    }));

    // Validate and normalize preferences
    const rawPreferences = Array.isArray(parsed.preferences) ? parsed.preferences : [];
    const validSentiments = new Set(['positive', 'negative', 'neutral']);
    const preferences: ExtractedPreference[] = rawPreferences
      .filter((p: any) => p.category && p.value)  // Require both fields
      .map((p: any) => ({
        category: String(p.category).toLowerCase().trim(),
        value: String(p.value).toLowerCase().trim().replace(/[.,!?;:]+$/, ''),
        sentiment: validSentiments.has(p.sentiment) ? p.sentiment : 'positive'
      }));

    return { entities, preferences };

  } catch (error) {
    // Parse/API error - return empty arrays instead of failing
    console.warn('Entity extraction failed:', (error as Error).message);
    return { entities: [], preferences: [] };
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
 * Save extracted preferences to the user_preferences table.
 * Upserts on (user_id, category, value) — updates sentiment and source on conflict.
 *
 * @param preferences - Array of extracted preferences from extractEntities()
 * @param chatTurnId - UUID of the source chat turn
 * @param userId - UUID of the user
 * @param supabase - Supabase client
 * @returns Number of preferences saved
 */
export async function savePreferences(
    preferences: ExtractedPreference[],
    chatTurnId: string,
    userId: string,
    supabase: any
): Promise<number> {
    if (preferences.length === 0) return 0;

    let saved = 0;
    for (const pref of preferences) {
        try {
            // ignoreDuplicates: true → ON CONFLICT DO NOTHING.
            // If (user_id, category, value) already exists, skip entirely —
            // don't touch updated_at. This preserves temporal ordering so that
            // DISTINCT ON (category, sentiment) ORDER BY updated_at DESC
            // in lookup_user_preferences returns the genuinely newest preference,
            // not a backfill-refreshed old one.
            const { error } = await supabase
                .from('user_preferences')
                .upsert(
                    {
                        user_id: userId,
                        category: pref.category,
                        value: pref.value,
                        sentiment: pref.sentiment,
                        confidence: 0.8,
                        source_turn_id: chatTurnId,
                        updated_at: new Date().toISOString()
                    },
                    { onConflict: 'user_id,category,value', ignoreDuplicates: true }
                );

            if (error) {
                console.warn(`Failed to save preference ${pref.category}=${pref.value}: ${error.message}`);
            } else {
                saved++;
            }
        } catch (err) {
            console.warn(`Error saving preference: ${(err as Error).message}`);
        }
    }

    if (saved > 0) {
        console.log(`Saved ${saved}/${preferences.length} preferences for turn ${chatTurnId}`);
    }
    return saved;
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

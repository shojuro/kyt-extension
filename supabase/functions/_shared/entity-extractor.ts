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
  entity_type: 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC';
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
      max_tokens: 500,           // Sufficient for entity lists
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
function validateEntityType(type: string): 'PERSON' | 'ORG' | 'LOCATION' | 'PROJECT' | 'TECH' | 'MISC' {
  const upperType = (type || '').toUpperCase();

  // Map common variations
  if (upperType === 'PER' || upperType === 'PERSON') return 'PERSON';
  if (upperType === 'LOC' || upperType === 'LOCATION') return 'LOCATION';
  if (upperType === 'ORG' || upperType === 'ORGANIZATION') return 'ORG';
  if (upperType === 'PROJ' || upperType === 'PROJECT') return 'PROJECT';
  if (upperType === 'TECH' || upperType === 'TECHNOLOGY') return 'TECH';

  return 'MISC';
}

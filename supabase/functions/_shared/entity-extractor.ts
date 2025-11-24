/**
 * Entity Extractor Module
 * Purpose: Extract named entities from conversation content for entity memory
 * Framework: Uses OpenAI GPT-4o-mini for entity recognition
 * Date: 2025-11-25
 *
 * Entity Types (matching entity_memory.sql schema):
 * - PER: Person (individuals, names)
 * - ORG: Organization (companies, institutions)
 * - LOC: Location (cities, countries, places)
 * - MISC: Miscellaneous (other named entities)
 * - PROJ: Project (software projects, initiatives)
 * - TECH: Technology (programming languages, frameworks, tools)
 */

// Types
export interface ExtractedEntity {
  entity_text: string;         // Raw text as it appears: "John Smith"
  entity_type: string;          // PER, ORG, LOC, MISC, PROJ, TECH
  confidence: number;           // 0.0-1.0 confidence score
  canonical_name?: string;      // Normalized form: "john_smith"
  context_before?: string;      // 100 chars before mention
  context_after?: string;       // 100 chars after mention
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
 * System prompt for entity extraction
 * Instructs GPT-4o-mini to identify and classify entities
 */
const ENTITY_EXTRACTION_SYSTEM_PROMPT = `You are an expert entity extraction system. Your task is to identify and classify named entities from conversation text.

Extract entities in these categories:
- PER (Person): Individual people, names (e.g., "John Smith", "Sarah")
- ORG (Organization): Companies, institutions, organizations (e.g., "Google", "MIT")
- LOC (Location): Cities, countries, places (e.g., "San Francisco", "Paris")
- PROJ (Project): Software projects, initiatives (e.g., "Linux", "React")
- TECH (Technology): Programming languages, frameworks, tools (e.g., "Python", "Docker")
- MISC (Miscellaneous): Other significant entities not fitting above categories

Return a JSON array of entities with this structure:
{
  "entities": [
    {
      "entity_text": "exact text as it appears",
      "entity_type": "PER|ORG|LOC|PROJ|TECH|MISC",
      "confidence": 0.95,
      "canonical_name": "normalized_lowercase_form"
    }
  ]
}

Rules:
1. Only extract entities explicitly mentioned in the text
2. Confidence should reflect certainty (0.0-1.0)
3. canonical_name should be lowercase with underscores replacing spaces
4. Be conservative - only extract clear, unambiguous entities
5. Avoid extracting common words or pronouns
6. Return empty array if no entities found`;

/**
 * Build extraction prompt from conversation data
 */
function buildExtractionPrompt(data: EntityExtractionData): string {
  const { content, speakers } = data;
  
  return `Extract named entities from this conversation:

Speakers: ${speakers.join(', ')}

Content:
${content}

Return JSON with extracted entities.`;
}

/**
 * Main entity extraction function
 * Calls OpenAI GPT-4o-mini to extract entities from conversation content
 * Returns array of extracted entities with types and confidence scores
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
      temperature: 0.1,      // Low temperature for consistent extraction
      max_tokens: 1000,      // Sufficient for entity lists
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
    const entities = parsed.entities || [];

    // Validate and normalize entities
    return entities.map((entity: any) => ({
      entity_text: entity.entity_text || '',
      entity_type: entity.entity_type || 'MISC',
      confidence: Math.max(0.0, Math.min(1.0, entity.confidence || 0.0)),
      canonical_name: entity.canonical_name || normalizeEntityName(entity.entity_text),
      context_before: entity.context_before || '',
      context_after: entity.context_after || ''
    }));

  } catch (error) {
    // JSON parse error - return empty array instead of failing
    console.error('Failed to parse entity extraction response:', error);
    return [];
  }
}

/**
 * Normalize entity name to canonical form
 * Converts "John Smith" -> "john_smith"
 */
function normalizeEntityName(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')  // Remove punctuation
    .replace(/\s+/g, '_');     // Replace spaces with underscores
}

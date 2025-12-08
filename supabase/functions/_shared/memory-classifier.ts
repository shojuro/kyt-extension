/**
 * Memory Classifier Module
 * Purpose: Server-side classification of conversation memories for gravity scoring
 * Framework: Holmes-Rahe Life Change Scale (impact) + Aron's 36 Questions (intimacy)
 * Author: AI Engineer (Temporal Decay Feature - Worktree 2)
 * Date: 2025-11-24
 *
 * SECURITY: All LLM API calls happen server-side. Never expose API keys to client.
 */

// Types
export interface ClassificationResult {
  impact_score: number;      // Holmes-Rahe scale: 0-100
  intimacy_level: number;    // Aron's 36 Questions: 0-3
  reasoning: string;         // Brief justification for debugging
}

export interface ClassifierPromptData {
  content: string;           // The conversation content to classify
  speakers: string[];        // Who participated in the conversation
  topics?: string[];         // Extracted topics (if available)
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Main classification function
 * Calls OpenAI GPT-4o-mini to classify conversation memory
 * Returns impact score (0-100) and intimacy level (0-3)
 */
export async function classifyMemory(
  data: ClassifierPromptData,
  openaiApiKey: string
): Promise<ClassificationResult> {
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

  // Build classification prompt
  const prompt = buildClassifierPrompt(data);

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
        { role: 'system', content: getClassifierSystemPrompt() },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,  // Low temperature for consistent classification
      max_tokens: 300,   // Sufficient for classification + reasoning
      response_format: { type: 'json_object' }  // Force JSON output
    })
  });

  // Error handling for API failures
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const result: OpenAIResponse = await response.json();

  // Parse and validate classification result
  let classification;
  try {
    classification = JSON.parse(result.choices[0].message.content);
  } catch (e) {
    throw new Error(`Failed to parse OpenAI response: ${e.message}`);
  }

  // Validate and bound scores
  const impact_score = Math.max(0, Math.min(100, classification.impact || 0));
  const intimacy_level = Math.max(0, Math.min(3, classification.intimacy || 0));

  return {
    impact_score,
    intimacy_level,
    reasoning: classification.reasoning || 'No reasoning provided'
  };
}

/**
 * System prompt with classification guidelines
 * Defines Holmes-Rahe and Aron's 36 Questions frameworks
 */
function getClassifierSystemPrompt(): string {
  return `You are a memory classification expert for an AI emotional intelligence system. Your task is to score conversations on two psychological dimensions:

## 1. IMPACT SCORE (0-100): Holmes-Rahe Life Change Scale
Rate the life event significance and stress impact:

**100 (Catastrophic)**: Death of spouse, divorce, major trauma, life-threatening events
**90-99 (Severe)**: Death of close family, marital separation, major illness/injury
**75-89 (Major)**: Marriage, job loss, retirement, pregnancy, major financial crisis
**60-74 (Significant)**: Career change, business readjustment, major relationship milestone
**50-59 (Moderate)**: Home purchase, new job, major achievement, relationship changes
**40-49 (Notable)**: Personal injury, work conflicts, mortgage/loan, family changes
**25-39 (Minor)**: Vacation, holidays, minor violations, habit changes
**10-24 (Trivial)**: Social gatherings, minor life events, routine disruptions
**0-9 (Surface)**: Daily routines, weather, small talk, generic facts

## 2. INTIMACY LEVEL (0-3): Aron's 36 Questions Framework
Rate the depth of personal vulnerability and self-disclosure:

**3 (Core Identity)**: Deep fears, traumas, existential questions, core values, life purpose, intense emotions, relationship fears, death, regrets, dreams, vulnerabilities
**2 (Personal Feelings)**: Emotions, values, relationship feelings, disappointments, hopes, insecurities, personal struggles, vulnerabilities, meaningful memories
**1 (Personal Facts)**: Preferences, habits, hobbies, opinions, interests, background, daily life, family structure, career details, life history
**0 (Surface)**: Weather, news, public facts, generic topics, small talk, transactional conversation

## Classification Rules:
1. **Context matters**: A wedding discussed casually (impact=75, intimacy=1) vs shared with deep emotion (impact=85, intimacy=3)
2. **Recency bias**: Recent events have higher salience (boost by 10-20%)
3. **Personal involvement**: First-person experiences score higher than third-person stories
4. **Emotional intensity**: Strong emotions elevate both scores
5. **Multiple dimensions**: Consider both event significance AND personal disclosure

## Output Format:
Return ONLY valid JSON (no markdown, no explanations outside JSON):
{
  "impact": <0-100 integer>,
  "intimacy": <0-3 integer>,
  "reasoning": "<1-2 sentence justification>"
}`;
}

/**
 * Build user prompt with conversation context
 */
function buildClassifierPrompt(data: ClassifierPromptData): string {
  const topicsSection = data.topics && data.topics.length > 0
    ? `TOPICS: ${data.topics.join(', ')}\n`
    : '';

  return `Classify this conversation memory:

SPEAKERS: ${data.speakers.join(', ')}
${topicsSection}
CONTENT:
${data.content}

Provide impact score (0-100) and intimacy level (0-3) with brief reasoning.`;
}

/**
 * Batch classification for multiple memories
 * More efficient than individual calls (reduces API overhead)
 * Note: Currently processes sequentially - could be parallelized
 */
export async function classifyMemoryBatch(
  memories: ClassifierPromptData[],
  openaiApiKey: string
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];

  for (const memory of memories) {
    try {
      const result = await classifyMemory(memory, openaiApiKey);
      results.push(result);
    } catch (error) {
      // On error, return default classification rather than failing entire batch
      console.error(`Classification failed for memory: ${error.message}`);
      results.push({
        impact_score: 0,
        intimacy_level: 0,
        reasoning: `Classification failed: ${error.message}`
      });
    }
  }

  return results;
}

/**
 * Validation helper: Check if classification result is reasonable
 * Used for quality assurance and debugging
 */
export function validateClassification(result: ClassificationResult): boolean {
  if (result.impact_score < 0 || result.impact_score > 100) {
    console.warn(`Invalid impact_score: ${result.impact_score}`);
    return false;
  }

  if (result.intimacy_level < 0 || result.intimacy_level > 3) {
    console.warn(`Invalid intimacy_level: ${result.intimacy_level}`);
    return false;
  }

  if (!result.reasoning || result.reasoning.trim().length === 0) {
    console.warn('Missing reasoning in classification');
    return false;
  }

  return true;
}

/**
 * Memory Classifier Module
 * Purpose: Server-side classification of conversation memories for gravity scoring
 * Framework: Holmes-Rahe Life Change Scale (impact) + Aron's 36 Questions (intimacy)
 *            + Russell's Circumplex Model of Affect (valence/arousal)
 * LLM: Claude Haiku 4.5 (migrated from GPT-4o-mini)
 *
 * SECURITY: All LLM API calls happen server-side. Never expose API keys to client.
 */

import { AnthropicClient, type ClientContext } from "./anthropic-client.ts";

// Types
export interface ClassificationResult {
  impact_score: number;      // Holmes-Rahe scale: 0-100
  intimacy_level: number;    // Aron's 36 Questions: 0-3
  valence: number;           // Russell's Circumplex: -1.0 (unpleasant) to +1.0 (pleasant)
  arousal: number;           // Russell's Circumplex: 0.0 (deactivated) to 1.0 (activated)
  emotion_keywords: string[];// 5-8 contextual emotional synonyms for BM25 search
  reasoning: string;         // Brief justification for debugging
}

export interface ClassifierPromptData {
  content: string;           // The conversation content to classify
  speakers: string[];        // Who participated in the conversation
  topics?: string[];         // Extracted topics (if available)
}

/**
 * Main classification function
 * Calls Claude Haiku 4.5 to classify conversation memory
 * Returns impact score (0-100) and intimacy level (0-3)
 */
export async function classifyMemory(
  data: ClassifierPromptData,
  anthropicApiKey: string,
  context?: ClientContext
): Promise<ClassificationResult> {
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

  // Build classification prompt
  const prompt = buildClassifierPrompt(data);

  const client = new AnthropicClient(anthropicApiKey, context);

  let classification: {
    impact?: number;
    intimacy?: number;
    valence?: number;
    arousal?: number;
    emotion_keywords?: string[];
    reasoning?: string;
  };

  try {
    classification = await client.generateJsonCompletion<typeof classification>(
      getClassifierSystemPrompt(),
      prompt,
      {
        temperature: 0.3,
        maxTokens: 400,
        maxRetries: 2,
        timeoutMs: 15000,
        operation: 'memory_classification',
      }
    );
    console.log(`[classifier] Raw result: impact=${classification.impact}, intimacy=${classification.intimacy}, valence=${classification.valence}, arousal=${classification.arousal}, keywords=${classification.emotion_keywords?.length || 0}`);
  } catch (classifyErr: any) {
    console.error(`[classifier] FAILED: ${classifyErr.message}`);
    console.error(`[classifier] Content preview: ${data.content?.substring(0, 100)}`);
    // Return zeros — but now we know WHY
    return {
      impact_score: 0,
      intimacy_level: 0,
      valence: 0,
      arousal: 0,
      emotion_keywords: [],
      reasoning: `Classification failed: ${classifyErr.message}`,
    };
  }

  // Validate and bound scores
  const impact_score = Math.max(0, Math.min(100, classification.impact || 0));
  const intimacy_level = Math.max(0, Math.min(3, classification.intimacy || 0));
  const valence = Math.max(-1.0, Math.min(1.0, classification.valence ?? 0));
  const arousal = Math.max(0.0, Math.min(1.0, classification.arousal ?? 0));

  // Sanitize emotion_keywords: string array, max 8 items, max 30 chars each,
  // alphanumeric+space+hyphen only. Strips injection attempts from LLM output.
  const rawKeywords = Array.isArray(classification.emotion_keywords) ? classification.emotion_keywords : [];
  const emotion_keywords = rawKeywords
    .filter((k): k is string => typeof k === 'string')
    .map(k => k.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim())
    .filter(k => k.length >= 2 && k.length <= 30)
    .slice(0, 8);

  // Monitor LLM output quality — log non-standard terms without rejecting
  const flaggedKeywords = emotion_keywords.filter(k => !VALID_EMOTION_TERMS.has(k));
  if (flaggedKeywords.length > 0) {
    console.warn(`[memory-classifier] Non-standard emotion keywords: ${flaggedKeywords.join(', ')}`);
  }

  return {
    impact_score,
    intimacy_level,
    valence,
    arousal,
    emotion_keywords,
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

## 3. VALENCE (-1.0 to +1.0): Russell's Circumplex — Pleasant↔Unpleasant
Rate the emotional valence of the content:

**+0.8 to +1.0**: Pure joy, ecstasy, deep gratitude, overwhelming love
**+0.4 to +0.7**: Happy, pleased, hopeful, amused, proud
**+0.1 to +0.3**: Mildly positive, content, curious, interested
**0.0**: Neutral, factual, no emotional coloring
**-0.1 to -0.3**: Mildly negative, concerned, disappointed
**-0.4 to -0.7**: Sad, frustrated, anxious, guilty, embarrassed
**-0.8 to -1.0**: Devastated, enraged, terrified, despairing

## 4. AROUSAL (0.0 to 1.0): Russell's Circumplex — Deactivated↔Activated
Rate the emotional activation level:

**0.8-1.0**: Panic, rage, ecstasy, mania, acute crisis
**0.5-0.7**: Excited, angry, anxious, enthusiastic, scared
**0.3-0.5**: Alert, engaged, annoyed, hopeful, worried
**0.1-0.3**: Calm, reflective, melancholic, bored
**0.0**: Completely disengaged, zero emotional activation

## 5. EMOTION KEYWORDS (5-8 words)
Generate 5-8 contextual emotional synonyms that describe the emotional content of this memory. These are search terms that would help find this memory when someone searches for similar emotional experiences. Include:
- The primary emotion (e.g., "grief")
- Related emotions (e.g., "sadness", "loss")
- Contextual descriptors (e.g., "bereavement", "mourning")
- Intensity markers (e.g., "devastating", "heartbroken")
Only include emotional/psychological terms, NOT factual content words.
For neutral/surface content (impact < 10), return an empty array [].

## Classification Rules:
1. **Context matters**: A wedding discussed casually (impact=75, intimacy=1) vs shared with deep emotion (impact=85, intimacy=3)
2. **Recency bias**: Recent events have higher salience (boost by 10-20%)
3. **Personal involvement**: First-person experiences score higher than third-person stories
4. **Emotional intensity**: Strong emotions elevate both scores AND valence/arousal extremes
5. **Multiple dimensions**: Consider both event significance AND personal disclosure
6. **Valence direction**: A wedding (+0.8) and a funeral (-0.9) may have similar impact but opposite valence

## Output Format:
Return ONLY valid JSON (no markdown, no explanations outside JSON):
{
  "impact": <0-100 integer>,
  "intimacy": <0-3 integer>,
  "valence": <-1.0 to 1.0 float, 1 decimal place>,
  "arousal": <0.0 to 1.0 float, 1 decimal place>,
  "emotion_keywords": ["word1", "word2", ...up to 8],
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

Provide impact (0-100), intimacy (0-3), valence (-1.0 to +1.0), arousal (0.0 to 1.0), emotion_keywords, and brief reasoning.`;
}

/**
 * Batch classification for multiple memories
 * More efficient than individual calls (reduces API overhead)
 * Note: Currently processes sequentially - could be parallelized
 */
export async function classifyMemoryBatch(
  memories: ClassifierPromptData[],
  anthropicApiKey: string,
  context?: ClientContext
): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];

  for (const memory of memories) {
    try {
      const result = await classifyMemory(memory, anthropicApiKey, context);
      results.push(result);
    } catch (error) {
      // On error, return default classification rather than failing entire batch
      console.error(`Classification failed for memory: ${error.message}`);
      results.push({
        impact_score: 0,
        intimacy_level: 0,
        valence: 0,
        arousal: 0,
        emotion_keywords: [],
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

  if (result.valence < -1.0 || result.valence > 1.0) {
    console.warn(`Invalid valence: ${result.valence}`);
    return false;
  }

  if (result.arousal < 0.0 || result.arousal > 1.0) {
    console.warn(`Invalid arousal: ${result.arousal}`);
    return false;
  }

  if (!Array.isArray(result.emotion_keywords)) {
    console.warn('emotion_keywords is not an array');
    return false;
  }

  if (!result.reasoning || result.reasoning.trim().length === 0) {
    console.warn('Missing reasoning in classification');
    return false;
  }

  return true;
}

/**
 * Static validation set for emotion keywords.
 * Used to monitor LLM output quality — terms outside this set are logged
 * (not rejected) to build a dataset for improving the static synonym table.
 * Covers Plutchik's wheel + extended emotional vocabulary.
 */
const VALID_EMOTION_TERMS = new Set([
  // Core emotions (Plutchik's wheel)
  'joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'trust', 'anticipation',
  // Grief & Loss
  'grief', 'loss', 'mourning', 'bereavement', 'death', 'passing',
  // Anxiety & Stress
  'anxiety', 'stress', 'panic', 'worry', 'nervousness', 'nervous', 'anxious',
  'overwhelmed', 'burnout', 'exhaustion', 'exhausted', 'fatigue', 'drained',
  // Depression & Sadness
  'depression', 'depressed', 'hopelessness', 'hopeless', 'despair', 'melancholy',
  'sad', 'unhappy', 'miserable', 'desolate',
  // Loneliness & Isolation
  'loneliness', 'lonely', 'isolated', 'isolation', 'alone', 'disconnected', 'empty',
  // Anger & Frustration
  'angry', 'frustrated', 'frustration', 'irritation', 'irritated', 'resentment',
  'resentful', 'bitterness', 'bitter', 'furious', 'rage', 'mad',
  // Love & Relationships
  'love', 'romance', 'affection', 'attachment', 'crush', 'infatuation',
  'heartbreak', 'heartbroken', 'breakup', 'separation', 'divorce', 'rejection',
  'rejected', 'abandoned', 'neglected', 'betrayed', 'betrayal', 'deceived',
  // Pride & Achievement
  'pride', 'proud', 'accomplishment', 'achievement', 'milestone', 'success',
  // Gratitude & Positivity
  'gratitude', 'grateful', 'thankful', 'thankfulness', 'appreciation',
  'happiness', 'happy', 'content', 'contentment', 'satisfaction', 'satisfied',
  // Excitement & Enthusiasm
  'excitement', 'excited', 'enthusiasm', 'enthusiastic', 'elation', 'euphoria',
  'ecstasy', 'thrill', 'exhilaration',
  // Calm & Peace
  'calm', 'peace', 'peaceful', 'serenity', 'serene', 'relief', 'relaxed', 'tranquil',
  // Guilt & Shame
  'guilt', 'guilty', 'shame', 'embarrassment', 'embarrassed', 'regret', 'remorse',
  // Trauma & Recovery
  'trauma', 'traumatic', 'ptsd', 'abuse', 'recovery', 'healing', 'coping', 'therapy',
  // Confusion & Uncertainty
  'confusion', 'confused', 'uncertainty', 'uncertain', 'ambivalence', 'conflict',
  'lost', 'bewildered',
  // Jealousy & Insecurity
  'jealousy', 'jealous', 'envy', 'envious', 'insecurity', 'insecure', 'vulnerability',
  'vulnerable',
  // Empathy & Compassion
  'empathy', 'compassion', 'sympathy', 'support', 'caring',
  // Nostalgia & Longing
  'nostalgia', 'nostalgic', 'longing', 'homesick', 'homesickness', 'wistful',
  'wistfulness', 'reminiscent',
  // Hope & Optimism
  'hope', 'hopeful', 'optimism', 'optimistic', 'pessimism', 'pessimistic', 'resigned',
  // Intensity markers
  'devastating', 'overwhelming', 'intense', 'mild', 'deep', 'acute',
  'chronic', 'persistent', 'fleeting', 'sudden',
]);

/**
 * Supabase Edge Function: save_chat_turn (CALIBRATED VERSION)
 *
 * **STATUS: EXPERIMENTAL - NOT DEPLOYED** ⚠️
 * This is a development version for testing calibration improvements.
 * The deployed version is index.ts.
 *
 * Purpose: Save conversation turns with automatic memory classification
 * Features: Vector embeddings + gravity score classification (impact + intimacy)
 *
 * CALIBRATION UPDATE v2:
 * - Rates hypothetical questions by emotional topic weight (not 0)
 * - Rates past trauma by severity (not 0 based on timeline)
 * - Elevates base Holmes-Rahe scores with emotional intensity indicators
 * - Uses contextual factors to boost scores appropriately
 *
 * Author: AI Engineer (Temporal Decay Feature - Worktree 2)
 * Date: 2025-11-24 (Calibrated)
 *
 * SECURITY: All API keys (OpenAI, Supabase) are server-side environment variables.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================================
// INLINED MEMORY CLASSIFIER (with calibration fixes)
// ============================================================================

interface ClassificationResult {
  impact_score: number;      // 0-100 (Holmes-Rahe Life Change Scale)
  intimacy_level: number;    // 0-3 (Aron's 36 Questions Framework)
  reasoning: string;
}

function getClassifierSystemPrompt(): string {
  return `You are a memory classification expert for an AI emotional intelligence system. Your task is to score conversations on two psychological dimensions:

## 1. IMPACT SCORE (0-100): Holmes-Rahe Life Change Scale (CONTEXTUAL INTERPRETATION)

**CRITICAL CALIBRATION RULES:**

### A) Hypothetical Questions
Rate hypothetical questions (e.g., "36 Questions", "What would you...") based on the **emotional weight and vulnerability of the TOPIC being discussed**, NOT the conversational mechanism.
- Example: "Of all people in your family, whose death would you find most disturbing?" → Score as if discussing actual death/family loss (85-95), NOT as idle conversation (0)
- Example: "If you were to die this evening..." → Score as existential fear/death anxiety (80-90), NOT as hypothetical (0)
- Example: "What do you value most in friendship?" → Score as values discussion (15-25), NOT as small talk (0)

### B) Past Trauma & Biographical Content
Rate past trauma by the **SEVERITY of the trauma itself**, NOT by timeline distance.
- Example: "I grew up in a cult. I escaped when I was 18." → Score as major trauma/religious upheaval (85-95), NOT as biographical fact (0)
- Example: "My father was abusive" (shared now, happened years ago) → Score as family trauma (85-95), NOT as past event (0)
- Retelling trauma is emotionally significant regardless of when it occurred

### C) Emotional Intensity Elevation
Use emotional intensity indicators to **ELEVATE the base Holmes-Rahe score by 20-40 points**:
- Indicators: "terrified", "world collapsed", "devastated", "can't stop crying", "broke my heart", "feel like I'm dying", "entire world", "completely", "shaking uncontrollably"
- Example: Standard "marital separation" = 65, BUT "my partner moved out, I feel like my entire world has collapsed, I can't stop crying" = 90-95
- Example: Standard "pregnancy" = 40, BUT "I'm terrified, I don't know if I'm ready, my partner and I have been fighting a lot" = 80-85

### D) Specific Context Factors
Elevate base scores when specific severity factors are present:
- Death of spouse (immediate) = 100
- Death of close family member = 90-95
- Life-threatening illness = 90-95
- Major chronic illness (Alzheimer's, cancer stage 3+) = 85-95
- Assault/trauma with ongoing fear = 85-95
- Marital separation WITH extreme distress = 85-95
- Unplanned pregnancy WITH relationship instability = 80-85
- Job loss (15+ years) WITH pregnant partner = 85-90

**Standard Holmes-Rahe Categories (USE AS BASELINE, THEN ELEVATE):**

**100 (Catastrophic - Immediate Crisis)**: Death of spouse (current), imminent death, severe trauma with immediate danger
**90-99 (Severe Life Disruption)**: Death of close family (parent/child/sibling), marital separation with extreme distress, major assault, life-threatening diagnosis
**85-89 (Major Life Crisis)**: Major chronic illness diagnosis (Alzheimer's, cancer), past major trauma being disclosed, divorce proceedings, major financial collapse
**75-84 (Significant Change)**: Marriage, major relationship change, pregnancy with complications, major career loss (15+ years)
**65-74 (Notable Stress)**: Standard marital separation, standard pregnancy, major health change, significant financial issues
**50-64 (Moderate Stress)**: Job change, retirement with identity loss, family illness, moving, legal issues
**40-49 (Life Adjustment)**: Standard pregnancy, minor financial issues, work changes, family health concerns
**25-39 (Minor Stress)**: Minor health changes, minor legal issues, routine life adjustments
**15-24 (Low Impact)**: Vacation planning, hobbies, minor life changes, habit adjustments
**0-14 (Minimal)**: Weather, trivia, technical help, routine tasks

## 2. INTIMACY LEVEL (0-3): Aron's 36 Questions Framework

Rate the depth of personal vulnerability and self-disclosure:

**3 (Core Identity - Deep Vulnerability)**:
- Deep fears, traumas, existential questions
- Core values, life purpose, death/mortality
- Shame, regret, forgiveness, biggest fears
- Hypothetical questions about mortality/death/regret
- "I'm afraid to get close to people because I think I'll die young"
- "I would regret not telling my father I forgive him"
- "Losing my brother would break me more than losing my parents"

**2 (Personal Feelings - Moderate Vulnerability)**:
- Current emotions, relationship feelings, personal struggles
- Identity concerns, life transitions, stress about major events
- "I feel like an imposter", "I'm scared of being irrelevant"
- Job anxiety for dream position, empty nest feelings

**1 (Personal Facts - Light Vulnerability)**:
- Preferences, opinions, hobbies, habits
- "I want to wake up at 5 AM", "I'm taking Spanish classes"
- Future plans, goals, interests

**0 (Surface - No Vulnerability)**:
- Weather, news, facts, technical help
- "What's the capital of Switzerland?", "How do I freeze rows in Excel?"

## Output Format:
Return ONLY valid JSON (no markdown, no explanations outside JSON):
{
  "impact": <0-100 integer>,
  "intimacy": <0-3 integer>,
  "reasoning": "<1-2 sentence justification mentioning both impact basis AND intimacy basis>"
}

**Example Calibrated Classifications:**

1. "My partner just told me they want a separation. They moved out last night. I'm safe physically, but I feel like my entire world has collapsed. I can't stop crying."
   → {"impact": 95, "intimacy": 3, "reasoning": "Marital separation (base 65) elevated to 95 due to extreme emotional distress indicators ('world collapsed', 'can't stop crying'). Core identity crisis with deep vulnerability."}

2. "Of all the people in your family, whose death would you find most disturbing? My brother is sick right now. It's making me realize that losing him would break me more than losing my parents."
   → {"impact": 90, "intimacy": 3, "reasoning": "Hypothetical death question scored by emotional topic weight (potential family death = 90). Core identity exploration with deep vulnerability about family loss hierarchy."}

3. "I grew up in a cult. I escaped when I was 18. I've been trying to learn how to be 'normal' ever since."
   → {"impact": 90, "intimacy": 3, "reasoning": "Past major trauma (cult experience) scored by severity (90) regardless of timeline. Core identity formation with biographical trauma disclosure."}

4. "I just found out I'm pregnant. It wasn't planned. I'm terrified. I don't know if I'm ready to be a mother, and my partner and I have been fighting a lot lately."
   → {"impact": 85, "intimacy": 3, "reasoning": "Unplanned pregnancy (base 40) elevated to 85 due to terror + relationship instability + readiness doubts. Core identity crisis with multiple stressors."}

5. "My mother has been diagnosed with Alzheimer's. It's early stages. It's confusing. She looks the same, but she forgot my name yesterday. It broke my heart."
   → {"impact": 90, "intimacy": 3, "reasoning": "Major chronic illness (Alzheimer's) with specific heartbreak moment ('forgot my name') = 90. Deep emotional vulnerability with family grief."}`;
}

async function classifyMemoryWithOpenAI(
  content: string,
  openaiApiKey: string
): Promise<ClassificationResult> {
  const systemPrompt = getClassifierSystemPrompt();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Classify this conversation:\n\n${content}`
        }
      ],
      temperature: 0.3,
      max_tokens: 150
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const assistantMessage = data.choices[0].message.content;

  // Parse JSON response
  const jsonMatch = assistantMessage.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse classification response: ${assistantMessage}`);
  }

  const classification = JSON.parse(jsonMatch[0]);

  // Validate ranges
  const impact = Math.max(0, Math.min(100, classification.impact));
  const intimacy = Math.max(0, Math.min(3, classification.intimacy));

  return {
    impact_score: impact,
    intimacy_level: intimacy,
    reasoning: classification.reasoning || 'No reasoning provided'
  };
}

// ============================================================================
// EDGE FUNCTION HANDLER
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SaveChatTurnRequest {
  content: string;
  turn_range?: string;
  conversation_id?: string;
  platform?: 'chatgpt' | 'claude' | 'cli';
  speakers: string[];
  turn_count?: number;
  start_timestamp?: number;
  end_timestamp?: number;
  topics?: string[];
  hypothetical_questions?: string[];
  embedding: number[];
  user_id: string;
}

interface SaveChatTurnResponse {
  success: boolean;
  id?: string;
  classification?: {
    impact_score: number;
    intimacy_level: number;
    reasoning: string;
  };
  error?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Parse request body
    const requestData: SaveChatTurnRequest = await req.json();

    // 2. Validate required fields
    if (!requestData.content || requestData.content.trim().length === 0) {
      throw new Error('content is required and cannot be empty');
    }

    if (!requestData.speakers || requestData.speakers.length === 0) {
      throw new Error('speakers array is required and cannot be empty');
    }

    if (!requestData.embedding || requestData.embedding.length !== 1536) {
      throw new Error('embedding is required and must be 1536 dimensions');
    }

    if (!requestData.user_id) {
      throw new Error('user_id is required for RLS enforcement');
    }

    // 3. Get environment variables (SERVER-SIDE ONLY)
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase environment variables not configured');
    }

    // 4. Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 5. Classify the memory (CALIBRATED VERSION)
    console.log('Classifying memory with calibrated prompt...');
    const classification: ClassificationResult = await classifyMemoryWithOpenAI(
      requestData.content,
      openaiApiKey
    );

    console.log(`Classification result: impact=${classification.impact_score}, intimacy=${classification.intimacy_level}`);

    // 6. Insert into database
    const { data, error } = await supabase
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

    if (error) {
      throw new Error(`Database insert failed: ${error.message}`);
    }

    // 7. Return success response
    const response: SaveChatTurnResponse = {
      success: true,
      id: data.id,
      classification: {
        impact_score: classification.impact_score,
        intimacy_level: classification.intimacy_level,
        reasoning: classification.reasoning
      }
    };

    return new Response(
      JSON.stringify(response),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error) {
    console.error('Error in save_chat_turn:', error);

    const errorResponse: SaveChatTurnResponse = {
      success: false,
      error: error.message || 'Unknown error occurred'
    };

    return new Response(
      JSON.stringify(errorResponse),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});

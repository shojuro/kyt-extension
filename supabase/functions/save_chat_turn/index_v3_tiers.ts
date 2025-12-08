/**
 * Supabase Edge Function: save_chat_turn (TIER-BASED VERSION)
 *
 * **STATUS: EXPERIMENTAL - NOT DEPLOYED** ⚠️
 * This is a development version for testing tier-based classification.
 * The deployed version is index.ts.
 *
 * Purpose: Save conversation turns with automatic memory classification
 * Features: Vector embeddings + gravity score classification (stress tiers + intimacy)
 *
 * TIER-BASED CLASSIFICATION v3:
 * - Stress: 5 tiers (CORE, MAJOR, MODERATE, MINOR, NONE) mapped to representative values
 * - Intimacy: 0-3 scale (unchanged, working correctly)
 * - Hypothetical questions scored by emotional topic weight
 * - Past trauma scored by severity, not timeline
 * - Focus: Memory ranking accuracy over false precision
 *
 * Author: AI Engineer (Temporal Decay Feature - Worktree 2)
 * Date: 2025-11-24 (Tier System)
 *
 * SECURITY: All API keys (OpenAI, Supabase) are server-side environment variables.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================================
// TIER-BASED MEMORY CLASSIFIER
// ============================================================================

interface ClassificationResult {
  impact_score: number;      // Representative value from tier (95, 75, 50, 20, 5)
  intimacy_level: number;    // 0-3 (Aron's 36 Questions Framework)
  reasoning: string;
  stress_tier?: string;      // For debugging: CORE, MAJOR, MODERATE, MINOR, NONE
}

function getClassifierSystemPrompt(): string {
  return `You are a memory classification expert for an AI emotional intelligence system. Your task is to score conversations on two dimensions:

## 1. STRESS TIER: Emotional Weight for Memory Ranking

**Your job**: Rate the EMOTIONAL WEIGHT of this conversation for memory retrieval, NOT just the event category.

**Critical Rules:**
- **Hypothetical discussions** about death, loss, fear, regret score HIGH (CORE/MAJOR) even if nothing happened yet
  - Example: "Whose death would disturb you most?" = CORE (discusses mortality, family hierarchy)
  - Example: "If you were to die tonight, what would you regret?" = CORE (existential fear, regret)

- **Past trauma being recounted** scores as emotionally present (CORE/MAJOR) regardless of when it occurred
  - Example: "I escaped a cult 10 years ago" = CORE (identity-defining trauma)
  - Example: "My father was abusive" = CORE (childhood trauma disclosure)

- **Context matters**: Emotional language elevates tier
  - "My partner left" alone = MAJOR
  - "My partner left, my world collapsed, I can't stop crying" = CORE

- **Ask**: "How much does this conversation MATTER to this person's identity and emotional state?"

---

### Stress Tiers (pick ONE):

**CORE (90-100)**: Identity-Defining, Near-Permanent Memory
- Death/imminent death (spouse, close family, self)
- Major trauma (assault, abuse, life-threatening events)
- Severe ongoing crisis (divorce + devastation, terminal illness)
- Past major trauma being disclosed (cult, abuse, major loss)
- Existential fear/mortality discussions (even if hypothetical)
- Life-defining identity moments

**MAJOR (60-89)**: Significant Life Change, High Stress
- Relationship ruptures (separation, major breakup)
- Major health events (cancer diagnosis, Alzheimer's, chronic illness)
- Career upheaval (fired after 15 years, major promotion anxiety)
- Major life transitions (retirement + identity loss, empty nest syndrome)
- Unplanned pregnancy with relationship instability
- Financial crisis (foreclosure, major debt)

**MODERATE (30-59)**: Life Transition, Moderate Stress
- Standard life changes (moving, job change, minor health issues)
- Relationship changes without crisis (reconciliation, dating)
- Moderate anxiety (job interview stress, performance anxiety)
- Family dynamics (parenting concerns, extended family issues)
- Minor financial stress

**MINOR (10-29)**: Routine Life, Small Stressors
- Hobbies, habits, self-improvement (learning Spanish, waking early)
- Minor annoyances (traffic, weather complaints)
- Routine planning (vacation, home improvement)
- Small life adjustments

**NONE (0-9)**: Casual, No Emotional Weight
- Weather, trivia, facts
- Technical help (Excel, software)
- Generic questions with no personal context

---

## 2. INTIMACY LEVEL (0-3): Depth of Disclosure (UNCHANGED - WORKING CORRECTLY)

**3 (Core Identity)**: Deep fears, traumas, existential questions, shame, core values, mortality
**2 (Personal Feelings)**: Current emotions, relationship feelings, identity concerns, stress
**1 (Personal Facts)**: Preferences, habits, hobbies, opinions, goals
**0 (Surface)**: Weather, facts, technical help, public topics

---

## Output Format:
Return ONLY valid JSON (no markdown, no explanations outside JSON):
{
  "stress_tier": "<CORE|MAJOR|MODERATE|MINOR|NONE>",
  "intimacy": <0-3 integer>,
  "reasoning": "<1-2 sentences: stress tier justification + intimacy justification>"
}

---

## Example Classifications:

1. "My partner just told me they want a separation. They moved out last night. I feel like my entire world has collapsed. I can't stop crying."
   → {"stress_tier": "CORE", "intimacy": 3, "reasoning": "Marital separation with extreme emotional devastation ('world collapsed', 'can't stop crying') = identity crisis. Core vulnerability with deep emotional disclosure."}

2. "Of all the people in your family, whose death would you find most disturbing? My brother is sick. Losing him would break me more than losing my parents."
   → {"stress_tier": "CORE", "intimacy": 3, "reasoning": "Hypothetical death question scored by emotional weight (family mortality hierarchy) = existential discussion. Core vulnerability about family loss."}

3. "I grew up in a cult. I escaped when I was 18. I've been trying to learn how to be 'normal' ever since."
   → {"stress_tier": "CORE", "intimacy": 3, "reasoning": "Past major trauma (cult) scored by severity = identity-defining biographical trauma. Core identity disclosure with ongoing impact."}

4. "I'm terrified. I just found out I'm pregnant. It wasn't planned. My partner and I have been fighting a lot lately."
   → {"stress_tier": "MAJOR", "intimacy": 3, "reasoning": "Unplanned pregnancy with relationship instability + terror = significant life change with high stress. Core vulnerability with multiple stressors."}

5. "My mother has been diagnosed with Alzheimer's. She looks the same, but she forgot my name yesterday. It broke my heart."
   → {"stress_tier": "MAJOR", "intimacy": 3, "reasoning": "Major chronic illness (Alzheimer's) with specific heartbreak moment = significant ongoing crisis. Deep emotional vulnerability with family grief."}

6. "I'm nervous about my son leaving for college. I feel like I'm losing my purpose as a mother."
   → {"stress_tier": "MAJOR", "intimacy": 2, "reasoning": "Empty nest syndrome with identity loss = major life transition. Personal feelings about identity and purpose."}

7. "I need to find a new apartment. My landlord is selling the building. Just logistics, packing boxes."
   → {"stress_tier": "MODERATE", "intimacy": 1, "reasoning": "Moving without emotional stress = routine life transition. Personal facts about logistics."}

8. "I'm planning a vacation to Hawaii next month! Just Maui. Need a break from work."
   → {"stress_tier": "MINOR", "intimacy": 1, "reasoning": "Vacation planning = routine positive event. Personal preference about leisure."}

9. "Can you tell me the capital of Switzerland? Doing a crossword puzzle."
   → {"stress_tier": "NONE", "intimacy": 0, "reasoning": "Trivia question = no emotional weight. Surface-level interaction."}`;
}

// Tier to representative value mapping
const TIER_VALUES: Record<string, number> = {
  'CORE': 95,
  'MAJOR': 75,
  'MODERATE': 50,
  'MINOR': 20,
  'NONE': 5
};

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
      max_tokens: 200
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

  // Validate and map tier to value
  const tier = classification.stress_tier?.toUpperCase();
  if (!tier || !TIER_VALUES[tier]) {
    throw new Error(`Invalid stress tier: ${classification.stress_tier}. Expected: CORE, MAJOR, MODERATE, MINOR, or NONE`);
  }

  const impact = TIER_VALUES[tier];
  const intimacy = Math.max(0, Math.min(3, classification.intimacy));

  return {
    impact_score: impact,
    intimacy_level: intimacy,
    reasoning: classification.reasoning || 'No reasoning provided',
    stress_tier: tier  // For debugging
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
    stress_tier?: string;
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

    // 5. Classify the memory (TIER-BASED VERSION)
    console.log('Classifying memory with tier-based system...');
    const classification: ClassificationResult = await classifyMemoryWithOpenAI(
      requestData.content,
      openaiApiKey
    );

    console.log(`Classification result: tier=${classification.stress_tier}, impact=${classification.impact_score}, intimacy=${classification.intimacy_level}`);

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
        reasoning: classification.reasoning,
        stress_tier: classification.stress_tier
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

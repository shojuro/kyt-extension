/**
 * Supabase Edge Function: save_chat_turn
 *
 * **STATUS: DEPLOYED AND ACTIVE** ✅
 * This is the production version deployed to Supabase.
 *
 * Purpose: Save conversation turns with automatic memory classification
 * Features: Vector embeddings + gravity score classification (impact + intimacy)
 * Author: AI Engineer (Temporal Decay Feature - Worktree 2)
 * Date: 2025-11-24
 * Last Modified: 2025-11-24
 *
 * SECURITY: All API keys (OpenAI, Supabase) are server-side environment variables.
 * Never expose credentials to client code.
 *
 * Other Versions:
 * - index_v2_calibrated.ts: Experimental calibrated version (NOT DEPLOYED)
 * - index_v3_tiers.ts: Experimental tier-based version (NOT DEPLOYED)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { classifyMemory, type ClassificationResult } from '../_shared/memory-classifier.ts';

// CORS headers for browser requests
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
  embedding: number[];  // text-embedding-3-small (1536 dimensions)
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

    // 4. Initialize Supabase client (with service role key for bypassing RLS during insert)
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 5. Classify the memory (Holmes-Rahe + Aron's 36 Questions)
    console.log('Classifying memory...');
    const classification: ClassificationResult = await classifyMemory(
      {
        content: requestData.content,
        speakers: requestData.speakers,
        topics: requestData.topics
      },
      openaiApiKey
    );

    console.log(`Classification result: impact=${classification.impact_score}, intimacy=${classification.intimacy_level}`);

    // 6. Insert into database with classification scores
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
        embedding: `[${requestData.embedding.join(',')}]`,  // PostgreSQL vector format
        user_id: requestData.user_id,
        // NEW GRAVITY COLUMNS
        impact_score: classification.impact_score,
        intimacy_level: classification.intimacy_level,
        last_accessed: new Date().toISOString(),
        access_count: 0,
        gravity_score: null  // Will be computed during retrieval
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

/*
 * USAGE EXAMPLE (from client-side code):
 *
 * const response = await fetch('https://your-project.supabase.co/functions/v1/save_chat_turn', {
 *   method: 'POST',
 *   headers: {
 *     'Content-Type': 'application/json',
 *     'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
 *   },
 *   body: JSON.stringify({
 *     content: "My grandmother passed away last week. I'm struggling to process it.",
 *     speakers: ['User', 'Assistant'],
 *     topics: ['grief', 'family', 'loss'],
 *     embedding: [...], // 1536-dim vector from OpenAI
 *     user_id: '...'
 *   })
 * });
 *
 * Expected response:
 * {
 *   "success": true,
 *   "id": "uuid",
 *   "classification": {
 *     "impact_score": 95,
 *     "intimacy_level": 3,
 *     "reasoning": "Major life loss (death of close family) with deep emotional disclosure"
 *   }
 * }
 */

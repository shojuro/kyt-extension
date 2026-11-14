/**
 * Edge Function Name Registry.
 * Single source of truth for all Supabase edge function names.
 */

export const EDGE_FN = Object.freeze({
  SEARCH_MEMORIES:       'search_memories',
  SAVE_CHAT_TURN_BATCH:  'save_chat_turn_batch',
  GENERATE_EMBEDDINGS:   'generate_embeddings',
  BACKFILL_ENTITIES:     'backfill_entities',
  BACKFILL_CONTEXTUAL:   'backfill_contextual',
  BACKFILL_GRAVITY:      'backfill_gravity',
  LLM_COMPLETION:        'llm_completion',
  CLASSIFY_INTENT:       'classify_intent',
  CLAIM_USER_DATA:       'claim_user_data',
  BUILD_MEMORY_CARDS:    'build_memory_cards',
  BACKFILL_SECTIONS:     'backfill_sections',
});

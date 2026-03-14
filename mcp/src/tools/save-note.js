import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { getMemoryMode, getActiveProjectId } from '../lib/config.js';

export const SAVE_NOTE_SCHEMA = {
  content: { type: 'string', description: 'Note content to save to K.Y.T. memory' },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional tags for the note',
  },
};

export async function saveNote({ content, tags = [] }) {
  const mode = getMemoryMode();
  if (mode === 'incognito') {
    return {
      content: [{ type: 'text', text: 'Memory mode is "incognito" — save blocked. Use set_memory_mode to switch.' }],
    };
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: content is required and must be a non-empty string.' }],
      isError: true,
    };
  }

  const userId = getUserId();
  const tagsStr = tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : '';

  const activeProjectId = getActiveProjectId();
  const turn = {
    user_id: userId,
    conversation_id: `note-${Date.now()}`,
    platform: 'claude-code',
    content: content.trim() + tagsStr,
    role: 'user',
    timestamp: new Date().toISOString(),
    is_injection: false,
    content_type: 'note',
  };
  if (activeProjectId) turn.project_id = activeProjectId;

  const body = {
    turns: [turn],
    skip_ai_processing: false,
  };

  const result = await callEdgeFunction('save_chat_turn_batch', body);

  if (result.error) {
    return {
      content: [{ type: 'text', text: `Save error: ${result.error}` }],
      isError: true,
    };
  }

  const inserted = result.inserted || 0;
  return {
    content: [{
      type: 'text',
      text: inserted > 0
        ? `Note saved to K.Y.T. memory. It will be searchable after embedding + entity extraction.`
        : `Note may be a duplicate — ${result.duplicates_skipped || 0} skipped.`,
    }],
  };
}

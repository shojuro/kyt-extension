import { getSupabaseClient, getUserId } from '../lib/supabase-client.js';

export const GET_PREFERENCES_SCHEMA = {
  category: {
    type: 'string',
    description: 'Preference category to look up (e.g. "car", "language", "editor")',
  },
};

export async function getPreferences({ category }) {
  if (!category || typeof category !== 'string' || category.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: category is required.' }],
      isError: true,
    };
  }

  const supabase = getSupabaseClient();
  const userId = getUserId();

  // Try the RPC first
  const { data, error } = await supabase.rpc('lookup_user_preferences', {
    p_user_id: userId,
    p_category: category.trim(),
  });

  if (error) {
    // Fallback: query preferences table directly
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('user_preferences')
      .select('preference_key, preference_value, confidence, source_turn_id, updated_at')
      .eq('user_id', userId)
      .ilike('preference_key', `%${category.trim()}%`)
      .order('confidence', { ascending: false });

    if (fallbackError) {
      return {
        content: [{ type: 'text', text: `Preferences lookup error: ${fallbackError.message}` }],
        isError: true,
      };
    }

    return formatPreferences(fallbackData || [], category);
  }

  return formatPreferences(data || [], category);
}

function formatPreferences(prefs, category) {
  if (prefs.length === 0) {
    return {
      content: [{ type: 'text', text: `No preferences found for category "${category}".` }],
    };
  }

  const formatted = prefs.map((p, i) => {
    const key = p.category || p.preference_key || 'unknown';
    const val = p.value || p.preference_value || '';
    const confidence = p.confidence ? `(confidence: ${(p.confidence * 100).toFixed(0)}%)` : '';
    const sentiment = p.sentiment ? `[${p.sentiment}]` : '';
    const updated = p.updated_at ? `Updated: ${new Date(p.updated_at).toLocaleDateString()}` : '';
    return `${i + 1}. ${key}: ${val} ${sentiment} ${confidence}\n   ${updated}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Preferences for "${category}":\n\n${formatted}`,
    }],
  };
}

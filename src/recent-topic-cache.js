/**
 * Recent Topic Cache
 *
 * Maintains a rolling cache of the last N topic entities extracted from
 * saved messages, per platform. Used by the retrieval pipeline to boost
 * recent topics for vague/implicit queries where the embedding alone
 * is insufficient.
 *
 * Storage: chrome.storage.local key 'kyt_recent_topics'
 * Format: { [platform]: [{ entity: string, timestamp: number }] }
 *
 * Updated on every SAVE_MESSAGE; read by getContextForInjection.
 */

const STORAGE_KEY = 'kyt_recent_topics';
const MAX_ENTITIES_PER_PLATFORM = 10;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Simple noun-phrase extraction for topic detection.
// Not a full NER — just extracts likely topic words from user messages.
// The entity extractor (server-side) does the real work; this is a fast
// client-side approximation for immediate boosting.
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','can','shall','must','need','dare',
  'i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their','mine','yours','ours','theirs',
  'this','that','these','those','what','which','who','whom','whose',
  'when','where','why','how','if','then','else','so','but','and','or',
  'not','no','nor','yet','for','with','from','about','into','through',
  'during','before','after','above','below','between','under','over',
  'again','further','once','here','there','all','each','every','both',
  'few','more','most','some','any','such','only','own','same','than',
  'too','very','just','also','still','already','even',
  'tell','know','think','make','take','get','give','say','go','come',
  'see','look','find','want','use','try','ask','work','call','let',
  'put','run','move','help','show','keep','start','turn','play','like',
  'love','hate','prefer','enjoy','remember','remind','recall','discuss',
  'said','told','asked','talked','mentioned','discussed',
  'please','thanks','thank','okay','ok','sure','yes','no','yeah','hey',
  'something','anything','everything','nothing','thing','stuff',
  'really','actually','basically','literally','probably','maybe',
  'always','never','sometimes','often','usually',
]);

/**
 * Extract likely topic words from a message.
 * Returns up to 3 significant words/phrases.
 *
 * @param {string} content - Message content
 * @param {string} role - 'user' or 'assistant'
 * @returns {string[]} Topic words
 */
export function extractTopicWords(content, role) {
  if (!content || role !== 'user') return [];

  const words = content.toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take up to 3
  const unique = [...new Set(words)];
  return unique.slice(0, 3);
}

/**
 * Update the recent topic cache after a message is saved.
 *
 * @param {string} content - Message content
 * @param {string} role - 'user' or 'assistant'
 * @param {string} platform - Source platform
 */
export async function updateRecentTopics(content, role, platform) {
  if (!content || role !== 'user' || !platform) return;

  const topics = extractTopicWords(content, role);
  if (topics.length === 0) return;

  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const cache = result[STORAGE_KEY] || {};
    const now = Date.now();

    if (!cache[platform]) cache[platform] = [];

    // Add new topics
    for (const topic of topics) {
      // Update existing or add new
      const existing = cache[platform].find(t => t.entity === topic);
      if (existing) {
        existing.timestamp = now;
      } else {
        cache[platform].push({ entity: topic, timestamp: now });
      }
    }

    // Prune: remove expired, keep most recent MAX_ENTITIES_PER_PLATFORM
    cache[platform] = cache[platform]
      .filter(t => now - t.timestamp < MAX_AGE_MS)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ENTITIES_PER_PLATFORM);

    await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  } catch (e) {
    // Non-fatal — cache update failure doesn't affect message capture
    console.warn('⚠️ Recent topic cache update failed:', e.message);
  }
}

/**
 * Read recent topics for entity boosting.
 * Returns topics across all platforms or filtered to one.
 *
 * @param {string|null} platform - Filter to a specific platform, or null for all
 * @returns {Promise<string[]>} Array of topic strings, most recent first
 */
export async function getRecentTopics(platform = null) {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const cache = result[STORAGE_KEY] || {};
    const now = Date.now();

    let topics = [];

    if (platform && cache[platform]) {
      topics = cache[platform].filter(t => now - t.timestamp < MAX_AGE_MS);
    } else {
      // Merge all platforms
      for (const plat of Object.keys(cache)) {
        const valid = (cache[plat] || []).filter(t => now - t.timestamp < MAX_AGE_MS);
        topics.push(...valid);
      }
    }

    // Sort by recency, deduplicate
    topics.sort((a, b) => b.timestamp - a.timestamp);
    const seen = new Set();
    const unique = [];
    for (const t of topics) {
      if (!seen.has(t.entity)) {
        seen.add(t.entity);
        unique.push(t.entity);
      }
    }

    return unique;
  } catch (e) {
    console.warn('⚠️ Recent topic cache read failed:', e.message);
    return [];
  }
}

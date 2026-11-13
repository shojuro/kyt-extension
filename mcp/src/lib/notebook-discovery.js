/**
 * Cross-notebook discovery engine.
 *
 * Pure functions for discovering relevant notebooks from 300+ notebooks
 * using title matching + K.Y.T. entity graph. No API calls — receives
 * data as parameters.
 */

// ── Stopwords ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'about',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'while', 'how',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'it', 'its', 'they', 'them', 'their',
]);

// ── Keyword Extraction ─────────────────────────────────────────────────

/**
 * Extract meaningful keywords from a question.
 * Strips stopwords, punctuation, emoji, lowercases.
 *
 * @param {string} question
 * @returns {string[]} normalized keywords
 */
export function extractKeywords(question) {
  if (!question || typeof question !== 'string') return [];

  return question
    .toLowerCase()
    // Strip emoji and special unicode
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    // Strip punctuation except hyphens within words
    .replace(/[^\w\s-]/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

// ── Title Scoring ──────────────────────────────────────────────────────

/**
 * Score notebooks by title similarity to keywords.
 * Works for ALL notebooks regardless of project link.
 *
 * @param {{ id: string, title: string, sourceCount?: number }[]} notebooks
 * @param {string[]} keywords
 * @returns {{ notebookId: string, title: string, sourceCount: number, titleScore: number, matchedTerms: string[] }[]}
 */
export function scoreByTitle(notebooks, keywords) {
  if (!keywords.length || !notebooks.length) return [];

  const results = [];

  for (const nb of notebooks) {
    const title = (nb.title || '').toLowerCase()
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) continue;

    const titleWords = new Set(title.split(' ').filter(w => w.length > 1));
    const matchedTerms = [];
    let score = 0;

    for (const kw of keywords) {
      if (titleWords.has(kw)) {
        // Exact word match — strongest signal
        score += 1.5;
        matchedTerms.push(kw);
      } else if (title.includes(kw)) {
        // Substring match — weaker signal
        score += 0.8;
        matchedTerms.push(kw + '*');
      }
    }

    if (score === 0) continue;

    // Normalize by keyword count
    const normalizedScore = score / keywords.length;

    // Bonus for notebooks with sources (non-empty are more useful)
    const sourceBonus = (nb.sourceCount || 0) > 0 ? 0.05 : 0;

    results.push({
      notebookId: nb.id,
      title: nb.title || '',
      sourceCount: nb.sourceCount || 0,
      titleScore: Math.min(normalizedScore + sourceBonus, 1.0),
      matchedTerms,
    });
  }

  return results.sort((a, b) => b.titleScore - a.titleScore);
}

// ── Entity Graph Scoring ───────────────────────────────────────────────

/**
 * Score notebooks by entity graph connections.
 * Only works for notebooks with K.Y.T. project links.
 *
 * @param {{ entity_text: string, mention_count: number }[]} entities - from search_entities_by_text
 * @param {{ project_id: string }[]} relatedProjectIds - project IDs from graph walk + chat_turns lookup
 * @param {Map<string, string>} projectToNotebook - projectId → notebookId map
 * @returns {{ notebookId: string, entityScore: number, matchedEntities: string[] }[]}
 */
export function scoreByEntityGraph(entities, relatedProjectIds, projectToNotebook) {
  if (!entities?.length || !relatedProjectIds?.length || !projectToNotebook?.size) return [];

  // Count how many times each project appears in related results
  const projectCounts = new Map();
  for (const { project_id } of relatedProjectIds) {
    if (!project_id) continue;
    const notebookId = projectToNotebook.get(project_id);
    if (!notebookId) continue;
    projectCounts.set(notebookId, (projectCounts.get(notebookId) || 0) + 1);
  }

  if (projectCounts.size === 0) return [];

  // Normalize scores
  const maxCount = Math.max(...projectCounts.values());
  const entityNames = entities.map(e => e.entity_text).slice(0, 5);

  return [...projectCounts.entries()]
    .map(([notebookId, count]) => ({
      notebookId,
      entityScore: count / maxCount,
      matchedEntities: entityNames,
    }))
    .sort((a, b) => b.entityScore - a.entityScore);
}

// ── Merge & Rank ───────────────────────────────────────────────────────

const TITLE_WEIGHT = 0.6;
const ENTITY_WEIGHT = 0.4;

/**
 * Merge title scores and entity scores into a single ranked list.
 * Deduplicates by notebookId, combining scores when both match.
 *
 * @param {{ notebookId: string, title: string, titleScore: number, matchedTerms: string[] }[]} titleScored
 * @param {{ notebookId: string, entityScore: number, matchedEntities: string[] }[]} entityScored
 * @returns {{ notebookId: string, title: string, combinedScore: number, reason: string, sourceCount: number }[]}
 */
export function mergeAndRank(titleScored, entityScored) {
  const merged = new Map();

  // Add title-scored notebooks
  for (const t of titleScored) {
    merged.set(t.notebookId, {
      notebookId: t.notebookId,
      title: t.title,
      sourceCount: t.sourceCount || 0,
      titleScore: t.titleScore,
      entityScore: 0,
      matchedTerms: t.matchedTerms,
      matchedEntities: [],
    });
  }

  // Merge entity-scored notebooks
  for (const e of entityScored) {
    const existing = merged.get(e.notebookId);
    if (existing) {
      existing.entityScore = e.entityScore;
      existing.matchedEntities = e.matchedEntities;
    } else {
      // Entity-only match (no title match)
      merged.set(e.notebookId, {
        notebookId: e.notebookId,
        title: '', // Will be filled by caller
        sourceCount: 0,
        titleScore: 0,
        entityScore: e.entityScore,
        matchedTerms: [],
        matchedEntities: e.matchedEntities,
      });
    }
  }

  // Compute combined scores and generate reasons
  const results = [...merged.values()].map(m => {
    const combinedScore = (m.titleScore * TITLE_WEIGHT) + (m.entityScore * ENTITY_WEIGHT);

    const reasonParts = [];
    if (m.matchedTerms.length > 0) {
      reasonParts.push(`title: "${m.matchedTerms.join(', ')}"`);
    }
    if (m.matchedEntities.length > 0) {
      reasonParts.push(`entities: ${m.matchedEntities.join(', ')}`);
    }
    const reason = reasonParts.join(' + ') || 'unknown';

    return {
      notebookId: m.notebookId,
      title: m.title,
      sourceCount: m.sourceCount,
      combinedScore,
      reason,
    };
  });

  return results.sort((a, b) => b.combinedScore - a.combinedScore);
}

// ── Notebook Cache ─────────────────────────────────────────────────────

let _notebookCache = null;
let _notebookCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get notebooks with caching to avoid repeated API calls.
 *
 * @param {() => Promise<object[]>} listFn - listNotebooks function
 * @param {boolean} [refresh=false] - force cache refresh
 * @returns {Promise<object[]>}
 */
export async function getCachedNotebooks(listFn, refresh = false) {
  if (!refresh && _notebookCache && _notebookCache.length > 0 && Date.now() - _notebookCacheTime < CACHE_TTL_MS) {
    return _notebookCache;
  }
  const result = await listFn();
  // Only cache non-empty results (empty = likely auth/network failure)
  if (result && result.length > 0) {
    _notebookCache = result;
    _notebookCacheTime = Date.now();
  }
  return result || [];
}

/**
 * Clear the notebook cache (for testing).
 */
export function clearNotebookCache() {
  _notebookCache = null;
  _notebookCacheTime = 0;
}

/**
 * NotebookLM Artifact Detector — scans the Studio panel DOM for artifacts.
 *
 * Detects: audio, video, report, quiz, flashcards, infographic, slide deck,
 * data table, mind map. Returns structured metadata for each detected artifact.
 *
 * Selector strategy: aria-label > data attributes > element structure > class names.
 * Multiple fallback selectors per type to survive Google DOM updates.
 *
 * DETECTOR_VERSION: Update this when selectors are revised.
 */

const DETECTOR_VERSION = '2026-03-21';

// Icons for display in the panel
const TYPE_ICONS = {
  audio: '🎧',
  video: '🎬',
  report: '📄',
  quiz: '❓',
  flashcards: '🃏',
  infographic: '📊',
  slide_deck: '📽️',
  data_table: '📋',
  mind_map: '🧠',
};

// Content type classification
const CONTENT_TYPES = {
  audio: 'binary',
  video: 'binary',
  slide_deck: 'binary',
  infographic: 'binary',
  report: 'text',
  quiz: 'interactive',
  flashcards: 'interactive',
  data_table: 'text',
  mind_map: 'text',
};

/**
 * Studio panel selectors — the right-side panel where artifacts live.
 * We first find the Studio panel, then scan within it.
 */
const STUDIO_PANEL_SELECTORS = [
  '[role="tabpanel"][aria-label*="Studio" i]',
  '[aria-label*="Studio" i]',
  '.studio-panel',
  '.artifact-panel',
  // Fallback: the right-side panel in the notebook layout
  'aside',
  '[role="complementary"]',
];

/**
 * Artifact card selectors — individual artifact cards within the Studio panel.
 * Each card typically has a title, type indicator, and click action.
 */
const ARTIFACT_CARD_SELECTORS = [
  '[data-artifact-id]',
  '.artifact-card',
  '.studio-artifact',
  // Google's Angular components often use custom elements
  'studio-artifact-card',
  'artifact-card',
];

/**
 * Per-type detection: selectors for finding artifacts when they're open/visible.
 * Used both for card-level detection and for open-artifact detection.
 */
const TYPE_DETECTORS = {
  audio: {
    selectors: [
      'audio',
      '[aria-label*="Audio" i][aria-label*="Overview" i]',
      '[aria-label*="podcast" i]',
      '.audio-player',
      '[data-artifact-type="audio"]',
    ],
    textSignals: ['audio overview', 'podcast', 'listen'],
  },
  video: {
    selectors: [
      'video',
      '[aria-label*="Video" i][aria-label*="Overview" i]',
      '.video-player',
      '[data-artifact-type="video"]',
    ],
    textSignals: ['video overview', 'watch'],
  },
  report: {
    selectors: [
      '[data-artifact-type="report"]',
      '[data-artifact-type="study_guide"]',
      '[data-artifact-type="briefing_doc"]',
      '[aria-label*="Report" i]',
      '[aria-label*="Study Guide" i]',
      '[aria-label*="Briefing" i]',
      '[aria-label*="Blog" i]',
      '.report-content',
      '.markdown-body',
    ],
    textSignals: ['briefing doc', 'study guide', 'report', 'blog post'],
  },
  quiz: {
    selectors: [
      '[data-artifact-type="quiz"]',
      '[aria-label*="Quiz" i]',
      '.quiz-container',
      '[data-app-data]', // Quiz/flashcard interactive HTML
    ],
    textSignals: ['quiz', 'question'],
    // Distinguish from flashcards by checking for "quiz" in nearby text
    disambiguate: (el) => {
      const text = (el.closest('[aria-label]')?.getAttribute('aria-label') || el.textContent || '').toLowerCase();
      return text.includes('quiz') && !text.includes('flashcard');
    },
  },
  flashcards: {
    selectors: [
      '[data-artifact-type="flashcard"]',
      '[data-artifact-type="flashcards"]',
      '[aria-label*="Flashcard" i]',
      '.flashcard-container',
    ],
    textSignals: ['flashcard', 'flash card'],
  },
  infographic: {
    selectors: [
      '[data-artifact-type="infographic"]',
      '[aria-label*="Infographic" i]',
      '.infographic-container',
    ],
    textSignals: ['infographic'],
  },
  slide_deck: {
    selectors: [
      '[data-artifact-type="slide_deck"]',
      '[data-artifact-type="slides"]',
      '[aria-label*="Slide" i]',
      '.slide-viewer',
      '.slide-deck',
    ],
    textSignals: ['slide deck', 'slides', 'presentation'],
  },
  data_table: {
    selectors: [
      '[data-artifact-type="data_table"]',
      '[aria-label*="Data Table" i]',
      '.data-table-container',
    ],
    textSignals: ['data table'],
  },
  mind_map: {
    selectors: [
      '[data-artifact-type="mind_map"]',
      '[aria-label*="Mind Map" i]',
      '.mind-map-container',
    ],
    textSignals: ['mind map'],
  },
};

/**
 * Detect all artifacts visible in the NotebookLM page.
 *
 * Strategy:
 * 1. Find the Studio panel
 * 2. Look for artifact cards with type indicators
 * 3. Fall back to scanning for per-type selectors
 * 4. Include text selection if available
 *
 * @returns {{ type: string, title: string, artifactId: string|null, element: HTMLElement|null, contentType: string, icon: string }[]}
 */
export function detectArtifacts() {
  const detected = [];
  const seenTypes = new Set();

  // Strategy 1: Find artifact cards in Studio panel
  const studioPanel = findStudioPanel();
  if (studioPanel) {
    const cards = findArtifactCards(studioPanel);
    for (const card of cards) {
      if (card.type && !seenTypes.has(card.type + ':' + card.title)) {
        seenTypes.add(card.type + ':' + card.title);
        detected.push(card);
      }
    }
  }

  // Strategy 2: Scan full page for per-type selectors (catches open/visible artifacts)
  for (const [type, config] of Object.entries(TYPE_DETECTORS)) {
    if (detected.some(d => d.type === type)) continue; // Already found via cards

    for (const selector of config.selectors) {
      try {
        const el = document.querySelector(selector);
        if (!el) continue;

        // For quiz/flashcards with data-app-data, check disambiguator
        if (type === 'quiz' && config.disambiguate && !config.disambiguate(el)) continue;

        const title = extractTitle(el, type);
        if (title || el.textContent?.trim().length > 20) {
          detected.push({
            type,
            title: title || TYPE_ICONS[type] + ' ' + type.replace(/_/g, ' '),
            artifactId: extractArtifactId(el),
            element: el,
            contentType: CONTENT_TYPES[type],
            icon: TYPE_ICONS[type],
          });
          break;
        }
      } catch { /* selector invalid or element access error */ }
    }
  }

  // Strategy 3: Text-signal scanning in Studio panel
  if (studioPanel && detected.length === 0) {
    const allText = studioPanel.textContent?.toLowerCase() || '';
    for (const [type, config] of Object.entries(TYPE_DETECTORS)) {
      if (detected.some(d => d.type === type)) continue;
      for (const signal of config.textSignals) {
        if (allText.includes(signal)) {
          detected.push({
            type,
            title: TYPE_ICONS[type] + ' ' + signal.replace(/\b\w/g, c => c.toUpperCase()),
            artifactId: null,
            element: studioPanel,
            contentType: CONTENT_TYPES[type],
            icon: TYPE_ICONS[type],
          });
          break;
        }
      }
    }
  }

  // Always include selected text if available
  const selection = window.getSelection();
  if (selection && selection.toString().trim().length > 10) {
    detected.unshift({
      type: 'selected-text',
      title: '✂️ Selected Text (' + selection.toString().trim().length + ' chars)',
      artifactId: null,
      element: null,
      contentType: 'text',
      icon: '✂️',
    });
  }

  return detected;
}

/**
 * Find the Studio panel element.
 */
function findStudioPanel() {
  for (const selector of STUDIO_PANEL_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el && el.textContent?.trim().length > 10) return el;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Find artifact cards within the Studio panel.
 */
function findArtifactCards(panel) {
  const cards = [];

  // Try direct artifact card selectors
  for (const selector of ARTIFACT_CARD_SELECTORS) {
    try {
      const elements = panel.querySelectorAll(selector);
      for (const el of elements) {
        const type = detectCardType(el);
        const title = extractTitle(el, type);
        const id = el.dataset?.artifactId || extractArtifactId(el);
        if (type) {
          cards.push({
            type,
            title: title || TYPE_ICONS[type] + ' ' + type.replace(/_/g, ' '),
            artifactId: id,
            element: el,
            contentType: CONTENT_TYPES[type],
            icon: TYPE_ICONS[type],
          });
        }
      }
      if (cards.length > 0) break; // Found cards with this selector
    } catch { /* skip */ }
  }

  // Fallback: look for clickable items in the Studio that have type indicators
  if (cards.length === 0) {
    try {
      const buttons = panel.querySelectorAll('button, [role="button"], [tabindex="0"]');
      for (const btn of buttons) {
        const type = detectCardType(btn);
        if (type) {
          cards.push({
            type,
            title: extractTitle(btn, type) || TYPE_ICONS[type] + ' ' + type.replace(/_/g, ' '),
            artifactId: extractArtifactId(btn),
            element: btn,
            contentType: CONTENT_TYPES[type],
            icon: TYPE_ICONS[type],
          });
        }
      }
    } catch { /* skip */ }
  }

  return cards;
}

/**
 * Detect the artifact type from a card element's attributes and text.
 */
function detectCardType(el) {
  // Check data attributes
  const dataType = el.dataset?.artifactType || el.getAttribute('data-artifact-type') || '';
  if (dataType) {
    const normalized = dataType.toLowerCase().replace(/[- ]/g, '_');
    if (TYPE_DETECTORS[normalized]) return normalized;
    // Map common variants
    if (normalized.includes('audio')) return 'audio';
    if (normalized.includes('video')) return 'video';
    if (normalized.includes('report') || normalized.includes('briefing') || normalized.includes('study') || normalized.includes('blog')) return 'report';
    if (normalized.includes('quiz')) return 'quiz';
    if (normalized.includes('flashcard')) return 'flashcards';
    if (normalized.includes('infographic')) return 'infographic';
    if (normalized.includes('slide')) return 'slide_deck';
    if (normalized.includes('table') || normalized.includes('data')) return 'data_table';
    if (normalized.includes('mind') || normalized.includes('map')) return 'mind_map';
  }

  // Check aria-label
  const label = (el.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('audio') || label.includes('podcast')) return 'audio';
  if (label.includes('video')) return 'video';
  if (label.includes('report') || label.includes('briefing') || label.includes('study guide') || label.includes('blog')) return 'report';
  if (label.includes('quiz')) return 'quiz';
  if (label.includes('flashcard')) return 'flashcards';
  if (label.includes('infographic')) return 'infographic';
  if (label.includes('slide')) return 'slide_deck';
  if (label.includes('data table')) return 'data_table';
  if (label.includes('mind map')) return 'mind_map';

  // Check visible text (less reliable — only short text to avoid false positives)
  const text = (el.textContent || '').trim().toLowerCase().substring(0, 100);
  if (text.includes('audio overview')) return 'audio';
  if (text.includes('video overview')) return 'video';
  if (text.includes('slide deck')) return 'slide_deck';
  if (text.includes('infographic')) return 'infographic';
  if (text.includes('data table')) return 'data_table';
  if (text.includes('mind map')) return 'mind_map';

  return null;
}

/**
 * Extract a human-readable title from an artifact element.
 */
function extractTitle(el, type) {
  // Try heading elements
  const heading = el.querySelector('h1, h2, h3, h4, [role="heading"]');
  if (heading?.textContent?.trim()) return heading.textContent.trim().substring(0, 80);

  // Try aria-label
  const label = el.getAttribute('aria-label');
  if (label && label.length > 3 && label.length < 100) return label;

  // Try first meaningful text node
  const text = el.textContent?.trim();
  if (text && text.length > 3) return text.substring(0, 80);

  return null;
}

/**
 * Extract artifact ID from element or its ancestors.
 */
function extractArtifactId(el) {
  // Check data attributes
  const id = el.dataset?.artifactId || el.dataset?.id;
  if (id && /^[0-9a-f-]{36}$/i.test(id)) return id;

  // Check parent chain (max 5 levels)
  let current = el.parentElement;
  for (let i = 0; i < 5 && current; i++) {
    const parentId = current.dataset?.artifactId || current.dataset?.id;
    if (parentId && /^[0-9a-f-]{36}$/i.test(parentId)) return parentId;
    current = current.parentElement;
  }

  // Check href or links with UUIDs
  const link = el.querySelector('a[href]') || el.closest('a[href]');
  if (link) {
    const match = link.href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) return match[1];
  }

  return null;
}

export { TYPE_ICONS, CONTENT_TYPES, DETECTOR_VERSION };

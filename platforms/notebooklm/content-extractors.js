/**
 * NotebookLM Content Extractors — type-specific content extraction from DOM.
 *
 * Each extractor clones the element, strips UI chrome, and returns structured text.
 * Text artifacts return full content. Binary artifacts return metadata only.
 *
 * Security: All extracted text is sanitized before return (injection patterns,
 * directive tags, control characters stripped).
 */

const MAX_CONTENT_LENGTH = 100_000;
const PREVIEW_LENGTH = 2000;

// Injection/directive patterns to strip (subset of notebooklm-sanitizer.js)
const INJECTION_RE = /ignore\s+(all\s+)?previous\s+instructions?|disregard\s+(all\s+)?prior|override\s+(system|previous)\s+(prompt|instructions?)|you\s+are\s+now\s+a?\s*\w+|from\s+now\s+on,?\s+you\s+(are|will|must)/gi;
const DIRECTIVE_TAG_RE = /<\/?(?:system|instruction|prompt|role|override|inject|hidden)[^>]*>/gi;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitize(text) {
  if (!text) return '';
  return text
    .replace(CONTROL_CHARS_RE, '')
    .replace(DIRECTIVE_TAG_RE, '')
    .replace(INJECTION_RE, '[REDACTED]')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * Strip UI chrome from a cloned element.
 */
function stripChrome(clone) {
  const removeSelectors = [
    'button', '[role="button"]', '.action-bar', '.toolbar',
    'nav', 'header', 'footer', '.sidebar', '.navigation',
    '[aria-label*="close" i]', '[aria-label*="menu" i]',
    '.kyt-fab', '#kyt-nlm-panel-host', // our own panel
    'script', 'style', 'noscript',
  ];
  for (const sel of removeSelectors) {
    try {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    } catch { /* invalid selector */ }
  }
  return clone;
}

/**
 * Extract content based on artifact type.
 *
 * @param {string} type - Artifact type
 * @param {HTMLElement|null} element - DOM element to extract from
 * @returns {{ content: string, preview: string, charCount: number, isMetadata: boolean }}
 */
export function extractContent(type, element) {
  switch (type) {
    case 'selected-text': return extractSelectedText();
    case 'report': return extractTextArtifact(element, 'Report');
    case 'data_table': return extractDataTable(element);
    case 'mind_map': return extractMindMap(element);
    case 'quiz': return extractInteractive(element, 'Quiz');
    case 'flashcards': return extractInteractive(element, 'Flashcards');
    case 'audio': return extractBinaryMetadata(element, 'Audio');
    case 'video': return extractBinaryMetadata(element, 'Video');
    case 'slide_deck': return extractBinaryMetadata(element, 'Slide Deck');
    case 'infographic': return extractInfographicMetadata(element);
    default: return extractFallback(element);
  }
}

function extractSelectedText() {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  const sanitized = sanitize(text);
  return {
    content: sanitized.substring(0, MAX_CONTENT_LENGTH),
    preview: sanitized.substring(0, PREVIEW_LENGTH),
    charCount: sanitized.length,
    isMetadata: false,
  };
}

function extractTextArtifact(element, label) {
  if (!element) return emptyResult(label);

  const clone = element.cloneNode(true);
  stripChrome(clone);

  const text = clone.innerText?.trim() || '';
  const sanitized = sanitize(text);

  if (sanitized.length < 20) return emptyResult(label);

  return {
    content: sanitized.substring(0, MAX_CONTENT_LENGTH),
    preview: sanitized.substring(0, PREVIEW_LENGTH),
    charCount: sanitized.length,
    isMetadata: false,
  };
}

function extractDataTable(element) {
  if (!element) return emptyResult('Data Table');

  // Find the <table> element
  const table = element.tagName === 'TABLE' ? element : element.querySelector('table');
  if (table) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        cells.push(sanitize(cell.textContent?.trim() || ''));
      }
      rows.push(cells.join(' | '));
    }
    const content = rows.join('\n');
    return {
      content: content.substring(0, MAX_CONTENT_LENGTH),
      preview: content.substring(0, PREVIEW_LENGTH),
      charCount: content.length,
      isMetadata: false,
    };
  }

  // Fallback: extract as text
  return extractTextArtifact(element, 'Data Table');
}

function extractMindMap(element) {
  if (!element) return emptyResult('Mind Map');

  // Mind maps might have JSON in a data attribute
  const jsonEl = element.querySelector('[data-app-data]') || element.closest('[data-app-data]');
  if (jsonEl) {
    try {
      const raw = jsonEl.getAttribute('data-app-data');
      const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      const data = JSON.parse(decoded);
      const content = JSON.stringify(data, null, 2);
      return {
        content: content.substring(0, MAX_CONTENT_LENGTH),
        preview: formatMindMapPreview(data),
        charCount: content.length,
        isMetadata: false,
      };
    } catch { /* not valid JSON, fall through */ }
  }

  // Fallback: extract visible text
  return extractTextArtifact(element, 'Mind Map');
}

function formatMindMapPreview(data) {
  if (!data || typeof data !== 'object') return JSON.stringify(data).substring(0, PREVIEW_LENGTH);
  const lines = [];
  if (data.name) lines.push('Root: ' + data.name);
  if (Array.isArray(data.children)) {
    for (const child of data.children.slice(0, 5)) {
      const name = typeof child === 'object' ? child.name || '...' : String(child);
      lines.push('  - ' + name);
    }
    if (data.children.length > 5) lines.push('  ... (' + (data.children.length - 5) + ' more)');
  }
  return lines.join('\n') || JSON.stringify(data).substring(0, PREVIEW_LENGTH);
}

function extractInteractive(element, label) {
  if (!element) return emptyResult(label);

  // Quiz/Flashcards embed JSON in data-app-data
  const jsonEl = element.querySelector('[data-app-data]') || element.closest('[data-app-data]');
  if (jsonEl) {
    try {
      const raw = jsonEl.getAttribute('data-app-data');
      const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      const data = JSON.parse(decoded);
      const formatted = formatQuizMarkdown(data, label);
      return {
        content: formatted.substring(0, MAX_CONTENT_LENGTH),
        preview: formatted.substring(0, PREVIEW_LENGTH),
        charCount: formatted.length,
        isMetadata: false,
      };
    } catch { /* not valid JSON, fall through */ }
  }

  // Fallback: extract visible text (questions are usually visible)
  return extractTextArtifact(element, label);
}

function formatQuizMarkdown(data, label) {
  const lines = ['# ' + (data.title || label), ''];

  const questions = data.questions || data.cards || data.items || [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    lines.push(`## ${label === 'Flashcards' ? 'Card' : 'Question'} ${i + 1}`);

    if (q.question || q.front) {
      lines.push(q.question || q.front);
      lines.push('');
    }

    // Answer options (quiz)
    if (Array.isArray(q.answerOptions || q.options)) {
      for (const opt of (q.answerOptions || q.options)) {
        const marker = opt.isCorrect ? '[x]' : '[ ]';
        lines.push(`- ${marker} ${opt.text || opt.label || ''}`);
      }
    }

    // Back side (flashcards)
    if (q.answer || q.back) {
      lines.push('**Answer:** ' + (q.answer || q.back));
    }

    if (q.hint) lines.push('**Hint:** ' + q.hint);
    lines.push('');
  }

  return sanitize(lines.join('\n'));
}

function extractBinaryMetadata(element, label) {
  if (!element) return metadataResult(label, 'No element found');

  const title = element.getAttribute('aria-label')
    || element.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()
    || label;

  // Try to find duration for audio/video
  let duration = '';
  const timeEl = element.querySelector('time, [aria-label*="duration" i], .duration');
  if (timeEl) duration = timeEl.textContent?.trim() || '';

  const meta = [`Type: ${label}`, `Title: ${title}`];
  if (duration) meta.push(`Duration: ${duration}`);
  meta.push(`Status: Available in NotebookLM`);

  const content = meta.join('\n');
  return {
    content,
    preview: content,
    charCount: content.length,
    isMetadata: true,
  };
}

function extractInfographicMetadata(element) {
  if (!element) return metadataResult('Infographic', 'No element found');

  const title = element.getAttribute('aria-label') || 'Infographic';

  // Find the image
  const img = element.querySelector('img') || element.tagName === 'IMG' ? element : null;
  const src = img?.src || '';
  const width = img?.naturalWidth || img?.width || '';
  const height = img?.naturalHeight || img?.height || '';

  const meta = [`Type: Infographic`, `Title: ${title}`];
  if (width && height) meta.push(`Dimensions: ${width}x${height}`);
  if (src) meta.push(`Image URL: ${src.substring(0, 200)}`);
  meta.push(`Status: Available in NotebookLM`);

  const content = meta.join('\n');
  return {
    content,
    preview: content,
    charCount: content.length,
    isMetadata: true,
  };
}

function extractFallback(element) {
  if (!element) return emptyResult('Content');
  return extractTextArtifact(element, 'Content');
}

function emptyResult(label) {
  return {
    content: '',
    preview: `No ${label} content detected. Navigate to the artifact in NotebookLM first.`,
    charCount: 0,
    isMetadata: false,
  };
}

function metadataResult(label, note) {
  const content = `Type: ${label}\n${note}`;
  return {
    content,
    preview: content,
    charCount: content.length,
    isMetadata: true,
  };
}

export { sanitize, MAX_CONTENT_LENGTH, PREVIEW_LENGTH };

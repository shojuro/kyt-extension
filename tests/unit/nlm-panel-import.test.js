/**
 * Tests for NotebookLM "K" panel import — notes discovery, artifact extraction,
 * and content_type propagation.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Test: fetchNotesList response parsing
// ============================================================================

// Simulate the parsing logic from content.js fetchNotesList()
function parseNotesResponse(parsed) {
  if (!parsed || !Array.isArray(parsed)) return [];

  const notes = [];
  const entries = Array.isArray(parsed[0]) ? parsed[0] : parsed;

  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const id = typeof entry[0] === 'string' ? entry[0] : null;
    if (!id) continue;

    if (entry.length <= 3 && entry[2] === 2) continue;

    let title = 'Untitled';
    let contentStr = '';
    if (Array.isArray(entry[1])) {
      title = typeof entry[1][0] === 'string' ? entry[1][0] : 'Untitled';
      contentStr = typeof entry[1][1] === 'string' ? entry[1][1] : '';
    } else {
      title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';
      contentStr = typeof entry[2] === 'string' ? entry[2] : '';
    }

    let isMindMap = false;
    if (contentStr) {
      try {
        const obj = JSON.parse(contentStr);
        if (obj.children || obj.nodes) isMindMap = true;
      } catch { /* not JSON */ }
    }

    notes.push({
      id,
      title,
      content: contentStr,
      type: isMindMap ? 'mind_map' : 'note',
      contentType: 'text',
      icon: isMindMap ? '\u{1F9E0}' : '\u{1F4DD}',
      source: 'api',
    });
  }

  return notes;
}

describe('fetchNotesList parsing', () => {
  it('parses nested format [id, [title, content, ...]]', () => {
    const parsed = [[
      ['note-1', ['My Note Title', 'This is the note body content.', null, 0]],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'note-1');
    assert.equal(result[0].title, 'My Note Title');
    assert.equal(result[0].content, 'This is the note body content.');
    assert.equal(result[0].type, 'note');
  });

  it('parses flat format [id, title, content]', () => {
    const parsed = [[
      ['note-2', 'Flat Title', 'Flat content body.'],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'note-2');
    assert.equal(result[0].title, 'Flat Title');
    assert.equal(result[0].content, 'Flat content body.');
    assert.equal(result[0].type, 'note');
  });

  it('filters deleted notes (entry[2] === 2)', () => {
    const parsed = [[
      ['note-active', ['Active Note', 'content']],
      ['note-deleted', null, 2],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'note-active');
  });

  it('detects mind maps by JSON with children key', () => {
    const mindMapJson = JSON.stringify({ name: 'Root', children: [{ name: 'Child 1' }] });
    const parsed = [[
      ['mm-1', ['Mind Map Title', mindMapJson]],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'mind_map');
  });

  it('detects mind maps by JSON with nodes key', () => {
    const mindMapJson = JSON.stringify({ nodes: [{ id: 1, label: 'Node' }] });
    const parsed = [[
      ['mm-2', ['Node Map', mindMapJson]],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result[0].type, 'mind_map');
  });

  it('treats non-JSON content as regular note', () => {
    const parsed = [[
      ['note-3', ['Regular Note', '# Markdown heading\nSome text here']],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result[0].type, 'note');
    assert.equal(result[0].content, '# Markdown heading\nSome text here');
  });

  it('handles empty content', () => {
    const parsed = [[
      ['note-empty', ['Empty Note', '']],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, '');
  });

  it('returns empty array for null/invalid input', () => {
    assert.deepEqual(parseNotesResponse(null), []);
    assert.deepEqual(parseNotesResponse('not an array'), []);
    assert.deepEqual(parseNotesResponse([]), []);
  });

  it('handles multiple notes', () => {
    const parsed = [[
      ['n1', ['Note 1', 'Content 1']],
      ['n2', ['Note 2', 'Content 2']],
      ['n3', ['Note 3', 'Content 3']],
    ]];
    const result = parseNotesResponse(parsed);
    assert.equal(result.length, 3);
  });
});

// ============================================================================
// Test: extractTextFromArtifactData
// ============================================================================

function extractTextFromArtifactData(data) {
  if (!data) return null;

  if (typeof data === 'string') {
    if (data.includes('<') && data.includes('>')) {
      return data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return data;
  }

  if (Array.isArray(data)) {
    let longest = '';
    function walk(obj, depth) {
      if (depth > 8) return;
      if (typeof obj === 'string' && obj.length > longest.length && obj.length > 20) {
        longest = obj;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item, depth + 1);
      }
    }
    walk(data, 0);

    if (longest.length > 20) {
      if (longest.includes('<') && longest.includes('>')) {
        return longest.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      return longest;
    }
  }

  try {
    const json = JSON.stringify(data, null, 2);
    if (json.length > 20) return json;
  } catch { /* skip */ }

  return null;
}

describe('extractTextFromArtifactData', () => {
  it('returns plain text strings directly', () => {
    const text = 'This is a plain text artifact with more than 20 characters.';
    assert.equal(extractTextFromArtifactData(text), text);
  });

  it('strips HTML tags from string content', () => {
    const html = '<div><h1>Title</h1><p>Some content here</p></div>';
    const result = extractTextFromArtifactData(html);
    assert.ok(result.includes('Title'));
    assert.ok(result.includes('Some content here'));
    assert.ok(!result.includes('<div>'));
  });

  it('finds longest string in nested arrays', () => {
    const data = [null, ['short', [null, 'This is a much longer string that should be found by the walker']]];
    const result = extractTextFromArtifactData(data);
    assert.ok(result.includes('much longer string'));
  });

  it('strips HTML from nested array strings', () => {
    const data = [null, [null, '<div><p>Nested HTML content that is long enough</p></div>']];
    const result = extractTextFromArtifactData(data);
    assert.ok(result.includes('Nested HTML content'));
    assert.ok(!result.includes('<div>'));
  });

  it('returns null for null input', () => {
    assert.equal(extractTextFromArtifactData(null), null);
  });

  it('falls back to JSON for arrays with only short strings', () => {
    // No string >20 chars, so JSON.stringify fallback kicks in
    const result = extractTextFromArtifactData(['a', 'b', 'c']);
    assert.ok(result.includes('"a"'));
  });

  it('falls back to JSON for objects', () => {
    const data = { key: 'value', nested: { data: true } };
    const result = extractTextFromArtifactData(data);
    assert.ok(result.includes('key'));
    assert.ok(result.includes('value'));
  });
});

// ============================================================================
// Test: content_type validation and propagation
// ============================================================================

describe('content_type validation', () => {
  const VALID_CONTENT_TYPES = new Set(['conversation', 'note', 'research', 'journal', 'imported']);

  function validateContentType(messageData) {
    const rawContentType = messageData.contentType || messageData.content_type;
    return rawContentType && VALID_CONTENT_TYPES.has(rawContentType) ? rawContentType : undefined;
  }

  it('normalizes camelCase contentType to valid content_type', () => {
    assert.equal(validateContentType({ contentType: 'research' }), 'research');
    assert.equal(validateContentType({ contentType: 'note' }), 'note');
  });

  it('passes through snake_case content_type', () => {
    assert.equal(validateContentType({ content_type: 'research' }), 'research');
  });

  it('rejects invalid content_type values', () => {
    assert.equal(validateContentType({ contentType: 'invalid_type' }), undefined);
    assert.equal(validateContentType({ contentType: 'admin' }), undefined);
    assert.equal(validateContentType({ contentType: '' }), undefined);
  });

  it('returns undefined when no contentType present', () => {
    assert.equal(validateContentType({}), undefined);
    assert.equal(validateContentType({ other: 'field' }), undefined);
  });

  it('prefers camelCase over snake_case when both present', () => {
    assert.equal(validateContentType({ contentType: 'note', content_type: 'research' }), 'note');
  });
});

// ============================================================================
// Test: content_type propagation through conversation chunker
// ============================================================================

describe('content_type propagation in chunker', () => {
  function propagateContentType(msgs) {
    const allContentTypes = msgs.map(m => m.content_type).filter(Boolean);
    if (allContentTypes.length > 0 && new Set(allContentTypes).size === 1) {
      return allContentTypes[0];
    }
    return undefined;
  }

  it('propagates when all messages have same content_type', () => {
    const msgs = [
      { content_type: 'research' },
      { content_type: 'research' },
    ];
    assert.equal(propagateContentType(msgs), 'research');
  });

  it('returns undefined when messages have mixed content_types', () => {
    const msgs = [
      { content_type: 'research' },
      { content_type: 'note' },
    ];
    assert.equal(propagateContentType(msgs), undefined);
  });

  it('returns undefined when no messages have content_type', () => {
    const msgs = [{ role: 'user' }, { role: 'assistant' }];
    assert.equal(propagateContentType(msgs), undefined);
  });

  it('ignores messages without content_type in unanimity check', () => {
    const msgs = [
      { content_type: 'note' },
      { role: 'user' }, // no content_type
      { content_type: 'note' },
    ];
    assert.equal(propagateContentType(msgs), 'note');
  });
});

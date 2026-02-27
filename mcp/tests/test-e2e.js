/**
 * End-to-end tests that hit live Supabase.
 * Requires mcp/.env to be configured.
 */
import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryMode, setMemoryMode } from '../src/lib/config.js';
import { queryMemory } from '../src/tools/query-memory.js';
import { searchEntities } from '../src/tools/search-entities.js';
import { getPreferences } from '../src/tools/get-preferences.js';

// Ensure full mode for live tests
const originalMode = getMemoryMode();
setMemoryMode('full');

describe('E2E: query_memory', () => {
  test('searches for entity graph walks (known topic)', async () => {
    const result = await queryMemory({
      query: 'entity graph walks',
      topK: 3,
      useHyde: false,
    });
    console.log('  query_memory result:', result.content[0].text.substring(0, 200));
    assert.ok(!result.isError, 'should not error');
    assert.ok(result.content[0].text.length > 0, 'should return content');
  });
});

describe('E2E: search_entities', () => {
  test('searches for KYT entity', async () => {
    const result = await searchEntities({ query: 'KYT', limit: 3 });
    console.log('  search_entities result:', result.content[0].text.substring(0, 200));
    assert.ok(!result.isError, 'should not error');
  });
});

describe('E2E: get_preferences', () => {
  test('searches for any preference category', async () => {
    const result = await getPreferences({ category: 'language' });
    console.log('  get_preferences result:', result.content[0].text.substring(0, 200));
    assert.ok(!result.isError, 'should not error');
  });
});

// Restore mode
setMemoryMode(originalMode);

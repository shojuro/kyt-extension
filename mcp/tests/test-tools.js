import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { getMemoryMode, setMemoryMode } from '../src/lib/config.js';
import { findProjectDir } from '../src/lib/session-parser.js';
import { setMemoryMode as setMemoryModeTool } from '../src/tools/set-memory-mode.js';
import { queryMemory } from '../src/tools/query-memory.js';
import { saveNote } from '../src/tools/save-note.js';

describe('config', () => {
  test('getMemoryMode returns valid mode', () => {
    const mode = getMemoryMode();
    assert.ok(['full', 'clean_room', 'incognito'].includes(mode), `unexpected mode: ${mode}`);
  });

  test('setMemoryMode roundtrips', () => {
    const original = getMemoryMode();
    setMemoryMode('clean_room');
    assert.equal(getMemoryMode(), 'clean_room');
    setMemoryMode('incognito');
    assert.equal(getMemoryMode(), 'incognito');
    setMemoryMode(original);
    assert.equal(getMemoryMode(), original);
  });
});

describe('session-parser', () => {
  test('findProjectDir finds directories', () => {
    const dirs = findProjectDir();
    assert.ok(dirs === null || Array.isArray(dirs), 'should return null or array');
    if (dirs) {
      assert.ok(dirs.length > 0, 'should find at least one project dir');
      console.log(`  Found ${dirs.length} project directories`);
    }
  });
});

describe('set-memory-mode tool', () => {
  test('rejects invalid mode', async () => {
    const result = await setMemoryModeTool({ mode: 'invalid' });
    assert.ok(result.isError, 'should error on invalid mode');
    assert.ok(result.content[0].text.includes('must be one of'));
  });

  test('accepts valid mode and reports change', async () => {
    const original = getMemoryMode();
    const result = await setMemoryModeTool({ mode: 'clean_room' });
    assert.ok(!result.isError, 'should not error');
    assert.ok(result.content[0].text.includes('clean_room'));
    setMemoryMode(original);
  });
});

describe('query-memory tool (memory mode gate)', () => {
  test('blocks in incognito mode', async () => {
    const original = getMemoryMode();
    setMemoryMode('incognito');
    try {
      const result = await queryMemory({ query: 'test' });
      assert.ok(result.content[0].text.includes('incognito'));
    } finally {
      setMemoryMode(original);
    }
  });

  test('blocks in clean_room mode', async () => {
    const original = getMemoryMode();
    setMemoryMode('clean_room');
    try {
      const result = await queryMemory({ query: 'test' });
      assert.ok(result.content[0].text.includes('clean_room'));
    } finally {
      setMemoryMode(original);
    }
  });

  test('rejects empty query', async () => {
    const original = getMemoryMode();
    setMemoryMode('full');
    try {
      const result = await queryMemory({ query: '' });
      assert.ok(result.isError, 'should error on empty query');
    } finally {
      setMemoryMode(original);
    }
  });
});

describe('save-note tool (memory mode gate)', () => {
  test('blocks in incognito mode', async () => {
    const original = getMemoryMode();
    setMemoryMode('incognito');
    try {
      const result = await saveNote({ content: 'test note' });
      assert.ok(result.content[0].text.includes('incognito'));
    } finally {
      setMemoryMode(original);
    }
  });

  test('rejects empty content', async () => {
    const original = getMemoryMode();
    setMemoryMode('full');
    try {
      const result = await saveNote({ content: '' });
      assert.ok(result.isError);
    } finally {
      setMemoryMode(original);
    }
  });
});

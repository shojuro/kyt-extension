import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { parseSessionFile } from '../src/lib/session-parser.js';

const TMP_DIR = join(tmpdir(), 'kyt-parser-test-' + Date.now());

function writeJsonl(filename, lines) {
  const path = join(TMP_DIR, filename);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('extractTextContent — tool_use extraction', () => {
  before(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('captures Write to .md file', () => {
    const path = writeJsonl('write-md.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Plan updated.' },
            {
              type: 'tool_use',
              name: 'Write',
              input: {
                file_path: '/home/user/.claude/plans/my-plan.md',
                content: '# My Plan\n\n## Step 1\nDo the thing.\n\n## Step 2\nDo the other thing.',
              },
            },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.ok(turns[0].content.includes('[Written to my-plan.md]'), 'should include Written prefix');
    assert.ok(turns[0].content.includes('# My Plan'), 'should include plan content');
    assert.ok(turns[0].content.includes('Step 2'), 'should include full plan body');
    assert.ok(turns[0].content.includes('Plan updated.'), 'should include text block too');
  });

  test('captures Edit to .md file', () => {
    const path = writeJsonl('edit-md.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Updated the doc.' },
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: '/home/user/docs/architecture.md',
                old_string: 'old content',
                new_string: '## New Architecture\n\nWe use microservices now.',
              },
            },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.ok(turns[0].content.includes('[Edited architecture.md]'), 'should include Edited prefix');
    assert.ok(turns[0].content.includes('microservices'), 'should include new_string content');
  });

  test('skips Write to .js file (code noise)', () => {
    const path = writeJsonl('write-js.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:02:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Created the module.' },
            {
              type: 'tool_use',
              name: 'Write',
              input: {
                file_path: '/home/user/src/utils.js',
                content: 'export function foo() { return 42; }',
              },
            },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.ok(!turns[0].content.includes('foo()'), 'should NOT include .js content');
    assert.ok(!turns[0].content.includes('[Written to'), 'should NOT have Written prefix');
    assert.equal(turns[0].content, 'Created the module.');
  });

  test('skips Edit to .py file', () => {
    const path = writeJsonl('edit-py.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:03:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Fixed the function.' },
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: '/home/user/src/main.py',
                old_string: 'def old():',
                new_string: 'def new_and_improved():',
              },
            },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, 'Fixed the function.');
  });

  test('text-only messages still work', () => {
    const path = writeJsonl('text-only.jsonl', [
      {
        type: 'user',
        timestamp: '2026-03-01T00:04:00Z',
        message: {
          role: 'user',
          content: 'What is the architecture of this project?',
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:04:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The project uses a modular architecture with service workers.' },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].content, 'What is the architecture of this project?');
    assert.equal(turns[1].content, 'The project uses a modular architecture with service workers.');
  });

  test('skips Read/Bash/Grep tool_use blocks', () => {
    const path = writeJsonl('skip-tools.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:05:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the file.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/some/file.js' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo', path: '.' } },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, 'Let me check the file.');
  });

  test('assistant message with ONLY non-.md tool_use blocks is skipped (empty content)', () => {
    const path = writeJsonl('only-tools.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:06:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/some/file.js' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/app.ts', content: 'code' } },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0, 'should produce no turns when only non-.md tool_use blocks');
  });

  test('multiple .md writes in one message are all captured', () => {
    const path = writeJsonl('multi-md.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-03-01T00:07:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Created plan and updated docs.' },
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/plans/plan.md', content: '# Plan\nStep 1' },
            },
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/docs/README.md', old_string: 'old', new_string: '## Updated section' },
            },
          ],
        },
      },
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.ok(turns[0].content.includes('[Written to plan.md]'));
    assert.ok(turns[0].content.includes('[Edited README.md]'));
    assert.ok(turns[0].content.includes('# Plan'));
    assert.ok(turns[0].content.includes('## Updated section'));
  });

});

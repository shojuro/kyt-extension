/**
 * Security regression guard (audit finding C1, Nov 2025; closed Nov 2026).
 *
 * Content scripts share the DOM with the host page, so any window event listener that
 * forwards to chrome.storage or chrome.runtime.sendMessage hands those APIs to every
 * script on chatgpt.com / claude.ai / gemini.google.com. The old "test API bridge"
 * did exactly that and exposed the login session.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));
const contentScripts = [...new Set(manifest.content_scripts.flatMap(cs => cs.js || []))];

describe('content scripts expose no page-reachable extension bridge', () => {
  it('manifest lists content scripts to check', () => {
    expect(contentScripts.length).toBeGreaterThan(0);
  });

  it.each(contentScripts)('%s has no KYT_TEST_* event bridge', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf-8');
    expect(src).not.toMatch(/KYT_TEST_/);
  });

  it.each(contentScripts)('%s has no page event that takes storage keys or a raw runtime message', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf-8');
    // A listener that destructures { keys }, { items } or { message } from event.detail and
    // passes it to chrome.* is the bridge pattern, whatever the event is called.
    expect(src).not.toMatch(/const\s*\{[^}]*\b(keys|items)\b[^}]*\}\s*=\s*event\.detail[\s\S]{0,200}chrome\.storage/);
    expect(src).not.toMatch(/const\s*\{[^}]*\bmessage\b[^}]*\}\s*=\s*event\.detail[\s\S]{0,200}chrome\.runtime\.sendMessage\(message/);
  });
});

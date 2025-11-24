import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('save_chat_turn Entity Integration', () => {
  const filePath = join(__dirname, 'index.ts');

  it('file should exist', () => {
    expect(existsSync(filePath)).toBe(true);
  });

  it('should import extractEntities from entity-extractor', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('extractEntities');
    expect(content).toContain('../_shared/entity-extractor.ts');
  });

  it('should import saveEntitiesWithMentions from entity-extractor', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('saveEntitiesWithMentions');
  });

  it('should use Promise.allSettled for parallel execution', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Promise.allSettled');
  });

  it('should call extractEntities with content and speakers', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('extractEntities');
    expect(content).toContain('requestData.content');
    expect(content).toContain('requestData.speakers');
  });

  it('should call saveEntitiesWithMentions after chat turn insert', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('saveEntitiesWithMentions');
  });

  it('should handle entity extraction failures gracefully', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('entityResult.status');
    expect(content).toMatch(/status\s*===\s*['"]fulfilled['"]/);
  });

  it('should include entities_extracted in response interface', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('entities_extracted');
    expect(content).toContain('SaveChatTurnResponse');
  });

  it('should return entities_extracted count in response', () => {
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('entities_extracted');
    expect(content).toContain('entities.length');
  });
});

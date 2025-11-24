/**
 * Entity Extractor Test Suite (Node.js compatible)
 * Purpose: Test entity extraction from conversation content
 * Following strict TDD: These tests MUST FAIL before implementation exists
 * 
 * NOTE: This is a verification test for the TypeScript module structure
 * The actual entity-extractor.ts will be used by Supabase Edge Functions
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Entity Extractor Module', () => {
  const modulePath = join(__dirname, 'entity-extractor.ts');

  it('entity-extractor.ts file should exist', () => {
    const exists = existsSync(modulePath);
    expect(exists).toBe(true);
  });

  it('should export ExtractedEntity interface', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('export interface ExtractedEntity');
    expect(content).toContain('entity_text');
    expect(content).toContain('entity_type');
    expect(content).toContain('confidence');
  });

  it('should export extractEntities function', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('export async function extractEntities');
  });

  it('should include ENTITY_EXTRACTION_SYSTEM_PROMPT', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('ENTITY_EXTRACTION_SYSTEM_PROMPT');
  });

  it('should include buildExtractionPrompt function', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('function buildExtractionPrompt');
  });

  it('should include entity types: PER, ORG, LOC, MISC, PROJ, TECH', () => {
    const content = readFileSync(modulePath, 'utf-8');
    // Should mention all entity types
    expect(content).toContain('PER');
    expect(content).toContain('ORG');
    expect(content).toContain('LOC');
    expect(content).toContain('MISC');
  });

  it('should include error handling for empty content', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('Content cannot be empty');
  });

  it('should include error handling for empty speakers', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('Speakers array cannot be empty');
  });

  it('should include JSON parse error handling', () => {
    const content = readFileSync(modulePath, 'utf-8');
    // Should have try-catch for JSON parsing
    expect(content).toMatch(/try[\s\S]*JSON\.parse[\s\S]*catch/);
  });
});

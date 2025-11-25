/**
 * Tests for Synthetic Data Validation
 *
 * Tests validation functions for:
 * - NER (Named Entity Recognition)
 * - Entity Linking
 * - Reranking
 */

import { describe, it, expect } from 'vitest';
import {
  validateNERExample,
  validateLinkingExample,
  validateRerankingExample,
  batchValidate,
  assessQuality
} from '../scripts/lib/validation.js';

describe('NER Validation', () => {
  describe('Valid Examples', () => {
    it('should accept valid NER example with single entity', () => {
      const example = {
        text: 'John Smith works at Microsoft',
        entities: [
          { text: 'John Smith', start: 0, end: 10, label: 'PERSON' },
          { text: 'Microsoft', start: 20, end: 29, label: 'ORG' }
        ]
      };

      expect(validateNERExample(example)).toBe(true);
    });

    it('should accept valid NER example with multiple entities', () => {
      const example = {
        text: 'Apple CEO Tim Cook announced the iPhone 15 in September 2023',
        entities: [
          { text: 'Apple', start: 0, end: 5, label: 'ORG' },
          { text: 'Tim Cook', start: 10, end: 18, label: 'PERSON' },
          { text: 'iPhone 15', start: 33, end: 42, label: 'PRODUCT' },
          { text: 'September 2023', start: 46, end: 60, label: 'DATE' }
        ]
      };

      expect(validateNERExample(example)).toBe(true);
    });

    it('should accept valid NER example with no entities', () => {
      const example = {
        text: 'This is a simple sentence without any entities.',
        entities: []
      };

      expect(validateNERExample(example)).toBe(true);
    });
  });

  describe('Invalid Examples', () => {
    it('should reject example with missing text', () => {
      const example = {
        entities: [{ text: 'John', start: 0, end: 4, label: 'PERSON' }]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject example with empty text', () => {
      const example = {
        text: '',
        entities: []
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject example with missing entities array', () => {
      const example = {
        text: 'John works here'
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject entity with out-of-bounds span', () => {
      const example = {
        text: 'Short',
        entities: [
          { text: 'OutOfBounds', start: 0, end: 100, label: 'PERSON' }
        ]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject entity with start >= end', () => {
      const example = {
        text: 'John Smith works here',
        entities: [
          { text: 'John', start: 10, end: 0, label: 'PERSON' }
        ]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject entity with mismatched text', () => {
      const example = {
        text: 'John Smith works here',
        entities: [
          { text: 'Wrong Name', start: 0, end: 10, label: 'PERSON' }  // Should be 'John Smith'
        ]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject overlapping entity spans', () => {
      const example = {
        text: 'John Smith works at Microsoft',
        entities: [
          { text: 'John Smith', start: 0, end: 10, label: 'PERSON' },
          { text: 'Smith works', start: 5, end: 16, label: 'PERSON' }  // Overlaps!
        ]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject entity with invalid label', () => {
      const example = {
        text: 'John works here',
        entities: [
          { text: 'John', start: 0, end: 4, label: 'INVALID_LABEL' }
        ]
      };

      expect(validateNERExample(example)).toBe(false);
    });

    it('should reject null example', () => {
      expect(validateNERExample(null)).toBe(false);
    });
  });
});

describe('Entity Linking Validation', () => {
  describe('Valid Examples', () => {
    it('should accept valid linking example', () => {
      const example = {
        mention: 'Apple',
        entity: 'Apple Inc.',
        context: 'Apple announced new products today',
        relationship: 'same_as',
        confidence: 0.95
      };

      expect(validateLinkingExample(example)).toBe(true);
    });

    it('should accept linking example without optional fields', () => {
      const example = {
        mention: 'NYC',
        entity: 'New York City',
        context: 'I visited NYC last summer'
      };

      expect(validateLinkingExample(example)).toBe(true);
    });
  });

  describe('Invalid Examples', () => {
    it('should reject example with missing mention', () => {
      const example = {
        entity: 'Apple Inc.',
        context: 'Apple announced new products'
      };

      expect(validateLinkingExample(example)).toBe(false);
    });

    it('should reject example with missing entity', () => {
      const example = {
        mention: 'Apple',
        context: 'Apple announced new products'
      };

      expect(validateLinkingExample(example)).toBe(false);
    });

    it('should reject example with missing context', () => {
      const example = {
        mention: 'Apple',
        entity: 'Apple Inc.'
      };

      expect(validateLinkingExample(example)).toBe(false);
    });

    it('should reject when mention not in context', () => {
      const example = {
        mention: 'Microsoft',
        entity: 'Microsoft Corporation',
        context: 'Apple announced new products'  // Doesn't contain 'Microsoft'
      };

      expect(validateLinkingExample(example)).toBe(false);
    });

    it('should reject invalid relationship', () => {
      const example = {
        mention: 'Apple',
        entity: 'Apple Inc.',
        context: 'Apple announced new products',
        relationship: 'invalid_relationship'
      };

      expect(validateLinkingExample(example)).toBe(false);
    });

    it('should reject invalid confidence (out of range)', () => {
      const example = {
        mention: 'Apple',
        entity: 'Apple Inc.',
        context: 'Apple announced new products',
        confidence: 1.5  // Should be 0-1
      };

      expect(validateLinkingExample(example)).toBe(false);
    });
  });
});

describe('Reranking Validation', () => {
  describe('Valid Examples', () => {
    it('should accept valid reranking example', () => {
      const example = {
        query: 'What is machine learning?',
        passage: 'Machine learning is a subset of AI that enables systems to learn from data.',
        relevance: 3,
        reason: 'Directly answers the question'
      };

      expect(validateRerankingExample(example)).toBe(true);
    });

    it('should accept reranking example with fractional relevance', () => {
      const example = {
        query: 'Python programming',
        passage: 'Python is a popular programming language.',
        relevance: 0.85
      };

      expect(validateRerankingExample(example)).toBe(true);
    });
  });

  describe('Invalid Examples', () => {
    it('should reject example with missing query', () => {
      const example = {
        passage: 'Some text about AI',
        relevance: 2
      };

      expect(validateRerankingExample(example)).toBe(false);
    });

    it('should reject example with missing passage', () => {
      const example = {
        query: 'What is AI?',
        relevance: 2
      };

      expect(validateRerankingExample(example)).toBe(false);
    });

    it('should reject example with missing relevance', () => {
      const example = {
        query: 'What is AI?',
        passage: 'AI is artificial intelligence'
      };

      expect(validateRerankingExample(example)).toBe(false);
    });

    it('should reject relevance out of range (negative)', () => {
      const example = {
        query: 'What is AI?',
        passage: 'AI is artificial intelligence',
        relevance: -1
      };

      expect(validateRerankingExample(example)).toBe(false);
    });

    it('should reject relevance out of range (too high)', () => {
      const example = {
        query: 'What is AI?',
        passage: 'AI is artificial intelligence',
        relevance: 5  // Max is 3
      };

      expect(validateRerankingExample(example)).toBe(false);
    });
  });
});

describe('Batch Validation', () => {
  it('should validate multiple examples and report stats', () => {
    const examples = [
      { text: 'Valid example', entities: [] },
      { text: '', entities: [] },  // Invalid - empty text
      { text: 'Another valid', entities: [] },
      null  // Invalid - null
    ];

    const results = batchValidate(examples, validateNERExample);

    expect(results.total).toBe(4);
    expect(results.valid).toBe(2);
    expect(results.invalid).toBe(2);
    expect(results.passRate).toBe('50.0%');
    expect(results.errors).toHaveLength(2);
  });
});

describe('Quality Assessment', () => {
  it('should assess NER dataset quality', () => {
    const examples = [
      {
        text: 'John Smith works at Microsoft in Seattle',
        entities: [
          { text: 'John Smith', start: 0, end: 10, label: 'PERSON' },
          { text: 'Microsoft', start: 20, end: 29, label: 'ORG' },
          { text: 'Seattle', start: 33, end: 40, label: 'GPE' }
        ]
      },
      {
        text: 'Apple CEO Tim Cook announced new products',
        entities: [
          { text: 'Apple', start: 0, end: 5, label: 'ORG' },
          { text: 'Tim Cook', start: 10, end: 18, label: 'PERSON' }
        ]
      }
    ];

    const quality = assessQuality(examples, 'ner');

    expect(quality.total).toBe(2);
    expect(quality.valid).toBe(2);
    expect(quality.passRate).toBe('100.0%');
    expect(quality.avgTextLength).toBeGreaterThan(0);
    expect(quality.uniqueEntities).toBeGreaterThan(0);
    expect(quality.diversity).toBeTruthy();
  });

  it('should detect low quality dataset', () => {
    const examples = [
      { text: '', entities: [] },  // Invalid
      { text: 'Valid', entities: [] },
      null  // Invalid
    ];

    const quality = assessQuality(examples, 'ner');

    expect(quality.total).toBe(3);
    expect(quality.valid).toBe(1);
    expect(parseFloat(quality.passRate)).toBeLessThan(50);
  });
});

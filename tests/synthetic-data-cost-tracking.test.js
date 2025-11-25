/**
 * Tests for Dataset Writer and Cost Tracking
 *
 * Tests incremental saving, cost calculation, and progress monitoring
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatasetWriter } from '../scripts/lib/dataset-writer.js';
import fs from 'fs/promises';
import path from 'path';

describe('DatasetWriter', () => {
  let writer;
  let testOutputPath;
  let testCostPath;

  beforeEach(async () => {
    // Use temp paths for testing
    testOutputPath = path.join('data', 'test-dataset.json');
    testCostPath = path.join('data', 'test-cost-tracking.json');

    writer = new DatasetWriter({
      outputPath: testOutputPath,
      costTrackerPath: testCostPath,
      saveInterval: 3  // Save every 3 examples for faster testing
    });

    // Ensure data directory exists
    await fs.mkdir('data', { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test files
    try {
      await fs.unlink(testOutputPath);
      await fs.unlink(testCostPath);
      await fs.unlink(`${testOutputPath}.tmp`);
    } catch (error) {
      // Files may not exist, that's fine
    }
  });

  describe('Cost Calculation', () => {
    it('should calculate cost correctly with separate input/output tokens', async () => {
      const example = { text: 'Test example' };
      const tokensUsed = { input: 1000, output: 500 };

      await writer.addExample(example, tokensUsed);

      const stats = writer.getStats();

      // Expected: (1000/1M * $0.150) + (500/1M * $0.600) = $0.00015 + $0.0003 = $0.00045
      expect(stats.totalCostUSD).toBeCloseTo(0.00045, 4);
      expect(stats.inputTokens).toBe(1000);
      expect(stats.outputTokens).toBe(500);
    });

    it('should estimate token split when only total tokens provided', async () => {
      const example = { text: 'Test example' };
      const tokensUsed = 1000;  // Total only

      await writer.addExample(example, tokensUsed);

      const stats = writer.getStats();

      // Should estimate: 60% input (600), 40% output (400)
      expect(stats.inputTokens).toBe(600);
      expect(stats.outputTokens).toBe(400);
    });

    it('should accumulate costs across multiple examples', async () => {
      const examples = [
        { text: 'Example 1' },
        { text: 'Example 2' },
        { text: 'Example 3' }
      ];

      for (const example of examples) {
        await writer.addExample(example, { input: 500, output: 250 });
      }

      const stats = writer.getStats();

      // 3 examples * ((500/1M * $0.150) + (250/1M * $0.600))
      // = 3 * ($0.000075 + $0.00015) = 3 * $0.000225 = $0.000675
      expect(stats.totalCostUSD).toBeCloseTo(0.000675, 4);
      expect(stats.apiCalls).toBe(3);
      expect(stats.inputTokens).toBe(1500);
      expect(stats.outputTokens).toBe(750);
    });

    it('should calculate cost per example', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 1000, output: 500 });
      await writer.addExample({ text: 'Example 2' }, { input: 1000, output: 500 });

      const stats = writer.getStats();

      expect(stats.examplesGenerated).toBe(2);
      expect(stats.costPerExample).toBeCloseTo(0.00045, 4);
    });

    it('should handle zero cost per example when no examples', () => {
      const stats = writer.getStats();

      expect(stats.examplesGenerated).toBe(0);
      expect(stats.costPerExample).toBe(0);
    });
  });

  describe('Incremental Saving', () => {
    it('should save automatically when reaching save interval', async () => {
      // saveInterval is 3 for this test
      await writer.addExample({ text: 'Example 1' }, 100);
      await writer.addExample({ text: 'Example 2' }, 100);

      // Not saved yet (2 < 3)
      let fileExists = await fs.access(testOutputPath).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);

      // This should trigger save (3 examples)
      await writer.addExample({ text: 'Example 3' }, 100);

      fileExists = await fs.access(testOutputPath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      const data = await fs.readFile(testOutputPath, 'utf-8');
      const examples = JSON.parse(data);
      expect(examples).toHaveLength(3);
    });

    it('should save correctly at multiple intervals', async () => {
      // Add 6 examples (2 save intervals)
      for (let i = 1; i <= 6; i++) {
        await writer.addExample({ text: `Example ${i}` }, 100);
      }

      const data = await fs.readFile(testOutputPath, 'utf-8');
      const examples = JSON.parse(data);
      expect(examples).toHaveLength(6);
    });

    it('should not lose data between saves', async () => {
      await writer.addExample({ text: 'Example 1' }, 100);
      await writer.addExample({ text: 'Example 2' }, 100);
      await writer.addExample({ text: 'Example 3' }, 100);  // Triggers save

      await writer.addExample({ text: 'Example 4' }, 100);
      await writer.addExample({ text: 'Example 5' }, 100);

      // Manual save
      await writer.save();

      const data = await fs.readFile(testOutputPath, 'utf-8');
      const examples = JSON.parse(data);
      expect(examples).toHaveLength(5);
      expect(examples[4].text).toBe('Example 5');
    });
  });

  describe('Cost Tracking File', () => {
    it('should create cost tracking file on save', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 2' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 3' }, { input: 500, output: 250 });

      // Should trigger save
      const costFileExists = await fs.access(testCostPath).then(() => true).catch(() => false);
      expect(costFileExists).toBe(true);
    });

    it('should write correct cost tracking data', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 1000, output: 500 });
      await writer.addExample({ text: 'Example 2' }, { input: 1000, output: 500 });
      await writer.addExample({ text: 'Example 3' }, { input: 1000, output: 500 });

      const data = await fs.readFile(testCostPath, 'utf-8');
      const costData = JSON.parse(data);

      expect(costData.totalCostUSD).toBeCloseTo(0.00135, 4);
      expect(costData.apiCalls).toBe(3);
      expect(costData.examplesGenerated).toBe(3);
      expect(costData.costPerExample).toBeCloseTo(0.00045, 3);  // Looser precision due to rounding
      expect(costData.inputTokens).toBe(3000);
      expect(costData.outputTokens).toBe(1500);
      expect(costData.totalTokens).toBe(4500);
    });

    it('should include pricing information in cost tracking', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 2' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 3' }, { input: 500, output: 250 });

      const data = await fs.readFile(testCostPath, 'utf-8');
      const costData = JSON.parse(data);

      expect(costData.pricing).toBeDefined();
      expect(costData.pricing.inputCostPer1M).toBe(0.150);
      expect(costData.pricing.outputCostPer1M).toBe(0.600);
    });

    it('should include timestamp in cost tracking', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 2' }, { input: 500, output: 250 });
      await writer.addExample({ text: 'Example 3' }, { input: 500, output: 250 });

      const data = await fs.readFile(testCostPath, 'utf-8');
      const costData = JSON.parse(data);

      expect(costData.lastUpdated).toBeDefined();
      expect(new Date(costData.lastUpdated).toString()).not.toBe('Invalid Date');
    });
  });

  describe('Manual Save', () => {
    it('should allow manual save before reaching interval', async () => {
      await writer.addExample({ text: 'Example 1' }, 100);
      await writer.addExample({ text: 'Example 2' }, 100);

      // Only 2 examples, but manually save
      await writer.save();

      const data = await fs.readFile(testOutputPath, 'utf-8');
      const examples = JSON.parse(data);
      expect(examples).toHaveLength(2);
    });

    it('should update cost tracking on manual save', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 500, output: 250 });
      await writer.save();

      const data = await fs.readFile(testCostPath, 'utf-8');
      const costData = JSON.parse(data);

      expect(costData.examplesGenerated).toBe(1);
      expect(costData.totalCostUSD).toBeGreaterThan(0);
    });
  });

  describe('Atomic Writes', () => {
    it('should use temp file pattern for atomic writes', async () => {
      await writer.addExample({ text: 'Example 1' }, 100);
      await writer.addExample({ text: 'Example 2' }, 100);
      await writer.addExample({ text: 'Example 3' }, 100);

      // Final file should exist
      const finalExists = await fs.access(testOutputPath).then(() => true).catch(() => false);
      expect(finalExists).toBe(true);

      // Temp file should be cleaned up
      const tempExists = await fs.access(`${testOutputPath}.tmp`).then(() => true).catch(() => false);
      expect(tempExists).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should provide accurate statistics', async () => {
      const startTime = Date.now();

      await writer.addExample({ text: 'Example 1' }, { input: 1000, output: 500 });
      await writer.addExample({ text: 'Example 2' }, { input: 800, output: 400 });

      const stats = writer.getStats();

      expect(stats.examplesGenerated).toBe(2);
      expect(stats.apiCalls).toBe(2);
      expect(stats.inputTokens).toBe(1800);
      expect(stats.outputTokens).toBe(900);
      expect(stats.totalTokens).toBe(2700);
      expect(stats.totalCostUSD).toBeGreaterThan(0);
      expect(stats.costPerExample).toBeGreaterThan(0);
      expect(stats.lastSaveTime).toBeDefined();
    });

    it('should format last save time as ISO string', async () => {
      await writer.addExample({ text: 'Example 1' }, 100);
      await writer.save();

      const stats = writer.getStats();

      expect(stats.lastSaveTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('Count Property', () => {
    it('should return correct example count', async () => {
      expect(writer.count).toBe(0);

      await writer.addExample({ text: 'Example 1' }, 100);
      expect(writer.count).toBe(1);

      await writer.addExample({ text: 'Example 2' }, 100);
      expect(writer.count).toBe(2);
    });
  });

  describe('Get Examples', () => {
    it('should return all examples', async () => {
      const examples = [
        { text: 'Example 1' },
        { text: 'Example 2' },
        { text: 'Example 3' }
      ];

      for (const example of examples) {
        await writer.addExample(example, 100);
      }

      const retrieved = writer.getExamples();

      expect(retrieved).toHaveLength(3);
      expect(retrieved[0].text).toBe('Example 1');
      expect(retrieved[2].text).toBe('Example 3');
    });
  });

  describe('Clear Functionality', () => {
    it('should clear all examples and reset stats', async () => {
      await writer.addExample({ text: 'Example 1' }, { input: 1000, output: 500 });
      await writer.addExample({ text: 'Example 2' }, { input: 1000, output: 500 });

      expect(writer.count).toBe(2);

      writer.clear();

      expect(writer.count).toBe(0);
      const stats = writer.getStats();
      expect(stats.totalCostUSD).toBe(0);
      expect(stats.apiCalls).toBe(0);
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
    });

    it('should allow reuse after clear', async () => {
      await writer.addExample({ text: 'Example 1' }, 100);
      writer.clear();

      await writer.addExample({ text: 'Example 2' }, 100);

      expect(writer.count).toBe(1);
      expect(writer.getExamples()[0].text).toBe('Example 2');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing token usage gracefully', async () => {
      // This should still work with default estimation
      await writer.addExample({ text: 'Example 1' }, 0);

      const stats = writer.getStats();
      expect(stats.examplesGenerated).toBe(1);
      expect(stats.totalCostUSD).toBe(0);
    });
  });

  describe('Large-Scale Cost Tracking', () => {
    it('should accurately track costs for 100+ examples', async () => {
      // Simulate generating 100 examples
      for (let i = 0; i < 100; i++) {
        await writer.addExample(
          { text: `Example ${i + 1}` },
          { input: 500, output: 250 }
        );
      }

      const stats = writer.getStats();

      expect(stats.examplesGenerated).toBe(100);
      expect(stats.inputTokens).toBe(50000);
      expect(stats.outputTokens).toBe(25000);
      expect(stats.totalTokens).toBe(75000);

      // Expected: 100 * ((500/1M * $0.150) + (250/1M * $0.600))
      // = 100 * ($0.000075 + $0.00015) = 100 * $0.000225 = $0.0225
      expect(stats.totalCostUSD).toBeCloseTo(0.0225, 4);
      expect(stats.costPerExample).toBeCloseTo(0.000225, 4);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle typical NER generation workflow', async () => {
      // Simulate generating NER examples with varying token usage
      const tokenUsages = [
        { input: 450, output: 280 },
        { input: 520, output: 310 },
        { input: 380, output: 250 },
        { input: 600, output: 350 },
        { input: 490, output: 290 }
      ];

      for (let i = 0; i < tokenUsages.length; i++) {
        await writer.addExample(
          {
            text: `John Smith works at company ${i + 1}`,
            entities: [
              { text: 'John Smith', start: 0, end: 10, label: 'PERSON' }
            ]
          },
          tokenUsages[i]
        );
      }

      const stats = writer.getStats();

      expect(stats.examplesGenerated).toBe(5);
      expect(stats.apiCalls).toBe(5);
      expect(stats.totalCostUSD).toBeGreaterThan(0);

      // Verify examples were saved
      const examples = writer.getExamples();
      expect(examples).toHaveLength(5);
      expect(examples[0].entities).toBeDefined();
    });
  });
});

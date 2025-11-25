/**
 * Dataset Writer with Incremental Saving and Cost Tracking
 *
 * Provides:
 * - Incremental saves (every N examples) to prevent data loss
 * - Real-time cost tracking based on token usage
 * - Atomic writes to prevent file corruption
 * - Progress monitoring
 */

import fs from 'fs/promises';
import path from 'path';

export class DatasetWriter {
  constructor(options = {}) {
    this.outputPath = options.outputPath;
    this.costTrackerPath = options.costTrackerPath || 'data/cost_tracking.json';
    this.saveInterval = options.saveInterval || 50;  // Save every 50 examples

    // OpenAI pricing (GPT-4o-mini as of 2024)
    // https://openai.com/pricing
    this.inputCostPer1M = 0.150;   // $0.150 per 1M input tokens
    this.outputCostPer1M = 0.600;  // $0.600 per 1M output tokens

    // State
    this.examples = [];
    this.totalCost = 0.0;
    this.apiCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.lastSaveTime = Date.now();
  }

  /**
   * Add an example and track cost
   * @param {Object} example - Example data
   * @param {number} tokensUsed - Tokens used (object with input/output or total)
   */
  async addExample(example, tokensUsed) {
    // Parse token usage
    let inputTokens = 0;
    let outputTokens = 0;

    if (typeof tokensUsed === 'object') {
      inputTokens = tokensUsed.input || 0;
      outputTokens = tokensUsed.output || 0;
    } else {
      // Estimate: assume 60% input, 40% output
      inputTokens = Math.round(tokensUsed * 0.6);
      outputTokens = Math.round(tokensUsed * 0.4);
    }

    // Calculate cost
    const inputCost = (inputTokens / 1_000_000) * this.inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * this.outputCostPer1M;
    const exampleCost = inputCost + outputCost;

    // Update state
    this.examples.push(example);
    this.totalCost += exampleCost;
    this.apiCalls++;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;

    // Incremental save
    if (this.examples.length % this.saveInterval === 0) {
      await this.save();
    }
  }

  /**
   * Save dataset and cost tracking
   * Uses atomic write pattern to prevent corruption
   */
  async save() {
    const startTime = Date.now();

    try {
      // Ensure output directory exists
      const dir = path.dirname(this.outputPath);
      await fs.mkdir(dir, { recursive: true });

      // Atomic write: write to temp file, then rename
      const tempPath = `${this.outputPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.examples, null, 2));
      await fs.rename(tempPath, this.outputPath);

      // Update cost tracker
      await this._saveCostTracking();

      this.lastSaveTime = Date.now();

      const duration = Date.now() - startTime;
      console.log(`💾 Saved ${this.examples.length} examples (${duration}ms)`);

    } catch (error) {
      console.error('❌ Error saving dataset:', error.message);
      throw error;
    }
  }

  /**
   * Save cost tracking data
   * @private
   */
  async _saveCostTracking() {
    const costData = {
      totalCostUSD: parseFloat(this.totalCost.toFixed(4)),
      apiCalls: this.apiCalls,
      examplesGenerated: this.examples.length,
      costPerExample: parseFloat((this.totalCost / this.examples.length).toFixed(4)),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      pricing: {
        inputCostPer1M: this.inputCostPer1M,
        outputCostPer1M: this.outputCostPer1M
      },
      lastUpdated: new Date().toISOString()
    };

    try {
      // Ensure directory exists
      const dir = path.dirname(this.costTrackerPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(
        this.costTrackerPath,
        JSON.stringify(costData, null, 2)
      );
    } catch (error) {
      console.error('⚠️  Error saving cost tracking:', error.message);
      // Don't throw - cost tracking failure shouldn't stop generation
    }
  }

  /**
   * Get current progress and cost stats
   * @returns {Object}
   */
  getStats() {
    return {
      examplesGenerated: this.examples.length,
      totalCostUSD: parseFloat(this.totalCost.toFixed(4)),
      costPerExample: this.examples.length > 0
        ? parseFloat((this.totalCost / this.examples.length).toFixed(4))
        : 0,
      apiCalls: this.apiCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      lastSaveTime: new Date(this.lastSaveTime).toISOString()
    };
  }

  /**
   * Get examples count
   */
  get count() {
    return this.examples.length;
  }

  /**
   * Get all examples
   */
  getExamples() {
    return this.examples;
  }

  /**
   * Clear all examples (use with caution!)
   */
  clear() {
    this.examples = [];
    this.totalCost = 0.0;
    this.apiCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }
}

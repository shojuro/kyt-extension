/**
 * Reranking Dataset Generator
 *
 * Generates Reranking training examples using GPT-4o-mini
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { RateLimiter } from './lib/rate-limiter.js';
import { DeduplicationChecker } from './lib/deduplication.js';
import { DatasetWriter } from './lib/dataset-writer.js';
import { CheckpointManager } from './lib/checkpoint-manager.js';
import { validateRerankingExample } from './lib/validation.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate a single Reranking example using GPT-4o-mini
 */
async function generateRerankingExample(rateLimiter) {
  const prompt = `Generate a realistic Reranking training example in JSON format.

The example should contain:
1. "query": A user search query (5-15 words)
2. "passage": A text passage that may or may not be relevant (30-60 words)
3. "relevance": A score from 0-3:
   - 0: Not relevant at all
   - 1: Somewhat relevant (tangentially related)
   - 2: Relevant (answers part of the query)
   - 3: Highly relevant (directly answers the query)
4. "reason": Brief explanation of the relevance score (optional but recommended)

Requirements:
- Use diverse domains (tech, science, business, history, etc.)
- Include mix of relevance scores (not all 3s, not all 0s)
- Query should be natural (what a real user would search)
- Passage should be informative and well-written
- Relevance score should be accurate and justified

Return ONLY valid JSON, no explanations:
{
  "query": "...",
  "passage": "...",
  "relevance": 2,
  "reason": "..."
}`;

  await rateLimiter.acquireSlot(600);  // Estimate 600 tokens

  const response = await rateLimiter.retryWithBackoff(async () => {
    return await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 1.0,  // High diversity
      max_tokens: 500
    });
  });

  const content = response.choices[0].message.content.trim();

  // Extract JSON from response
  let jsonStr = content;
  if (content.startsWith('```')) {
    const match = content.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (match) {
      jsonStr = match[1];
    }
  }

  const example = JSON.parse(jsonStr);
  const tokensUsed = {
    input: response.usage.prompt_tokens,
    output: response.usage.completion_tokens
  };

  return { example, tokensUsed };
}

/**
 * Generate Reranking dataset
 */
export async function generateRerankingDataset(options = {}) {
  const {
    count = 100,
    outputPath = 'data/reranking-dataset.json',
    datasetName = 'reranking'
  } = options;

  console.log(`\n🎯 Generating Reranking Dataset`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Target: ${count} examples`);
  console.log(`Output: ${outputPath}\n`);

  // Initialize utilities
  const rateLimiter = new RateLimiter();
  const deduplicator = new DeduplicationChecker({ fuzzyThreshold: 0.90 });
  const writer = new DatasetWriter({
    outputPath,
    costTrackerPath: `data/${datasetName}-cost-tracking.json`,
    saveInterval: 50
  });
  const checkpoint = new CheckpointManager({
    datasetName,
    checkpointInterval: 100
  });

  // Try to resume from checkpoint
  const existingCheckpoint = await checkpoint.loadCheckpoint();
  if (existingCheckpoint) {
    checkpoint.completed = existingCheckpoint.completed;
    checkpoint.failed = existingCheckpoint.failed;
    checkpoint.results = existingCheckpoint.results;

    // Restore deduplication state
    for (const result of existingCheckpoint.results) {
      if (result.example) {
        // Deduplicate based on query+passage combination
        const combined = `${result.example.query}|${result.example.passage}`;
        deduplicator.isDuplicate(combined);
      }
    }

    console.log(`📂 Resumed from checkpoint: ${checkpoint.completed} completed, ${checkpoint.failed} failed\n`);
  }

  let generated = 0;
  let skipped = 0;

  try {
    while (writer.count < count) {
      try {
        const { example, tokensUsed } = await generateRerankingExample(rateLimiter);

        // Validate example
        if (!validateRerankingExample(example)) {
          console.log(`⚠️  Invalid example (failed validation)`);
          checkpoint.failed++;
          continue;
        }

        // Check for duplicates (using query+passage combination)
        const combined = `${example.query}|${example.passage}`;
        if (deduplicator.isDuplicate(combined)) {
          console.log(`⚠️  Duplicate example (skipping)`);
          skipped++;
          continue;
        }

        // Add to dataset
        await writer.addExample(example, tokensUsed);
        generated++;
        checkpoint.completed++;
        checkpoint.results.push({ example, tokensUsed });

        // Progress update
        if (generated % 10 === 0) {
          const stats = writer.getStats();
          const dupStats = deduplicator.getStats();
          console.log(`✅ Progress: ${writer.count}/${count} | Cost: $${stats.totalCostUSD} | Dups: ${dupStats.duplicateRate}`);
        }

        // Checkpoint
        if (checkpoint.shouldCheckpoint()) {
          await checkpoint.saveCheckpoint({
            completed: checkpoint.completed,
            failed: checkpoint.failed,
            results: checkpoint.results
          });
        }

      } catch (error) {
        console.error(`❌ Error generating example:`, error.message);
        checkpoint.failed++;

        if (checkpoint.failed > count * 0.1) {
          throw new Error(`Too many failures: ${checkpoint.failed}`);
        }
      }
    }

    // Final save
    await writer.save();
    await checkpoint.deleteCheckpoint();

    // Final stats
    const stats = writer.getStats();
    const dupStats = deduplicator.getStats();
    const rlStats = rateLimiter.getStats();

    console.log(`\n✨ Generation Complete!`);
    console.log(`═══════════════════════════════════════`);
    console.log(`Examples Generated: ${writer.count}`);
    console.log(`Duplicates Skipped: ${skipped}`);
    console.log(`Failed: ${checkpoint.failed}`);
    console.log(`Total Cost: $${stats.totalCostUSD}`);
    console.log(`Cost Per Example: $${stats.costPerExample}`);
    console.log(`Duplicate Rate: ${dupStats.duplicateRate}`);
    console.log(`API Calls: ${rlStats.totalRequests}`);
    console.log(`Retries: ${rlStats.retries}`);
    console.log(`Output: ${outputPath}\n`);

    return {
      success: true,
      count: writer.count,
      cost: stats.totalCostUSD,
      duplicates: skipped,
      failed: checkpoint.failed
    };

  } catch (error) {
    console.error(`\n❌ Fatal error:`, error);
    console.log(`💾 Progress saved to checkpoint\n`);

    return {
      success: false,
      error: error.message,
      count: writer.count,
      cost: writer.getStats().totalCostUSD
    };
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const count = parseInt(process.argv[2]) || 100;
  const outputPath = process.argv[3] || 'data/reranking-dataset.json';

  await generateRerankingDataset({ count, outputPath });
}

/**
 * Entity Linking Dataset Generator
 *
 * Generates Entity Linking training examples using GPT-4o-mini
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { RateLimiter } from './lib/rate-limiter.js';
import { DeduplicationChecker } from './lib/deduplication.js';
import { DatasetWriter } from './lib/dataset-writer.js';
import { CheckpointManager } from './lib/checkpoint-manager.js';
import { validateLinkingExample } from './lib/validation.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate a single Entity Linking example using GPT-4o-mini
 */
async function generateLinkingExample(rateLimiter) {
  const prompt = `Generate a realistic Entity Linking training example in JSON format.

The example should contain:
1. "mention": A short entity mention (e.g., "Apple", "NYC", "The Beatles")
2. "entity": The full canonical entity name (e.g., "Apple Inc.", "New York City", "The Beatles")
3. "context": A sentence containing the mention (20-40 words)
4. "relationship": One of: same_as, similar_to, related_to, part_of, instance_of
5. "confidence": A float between 0.0 and 1.0

Requirements:
- Mention must appear exactly in the context
- Use diverse domains (companies, people, places, products, etc.)
- Relationship should accurately describe mention-entity connection
- Context should provide clear disambiguating information
- Include ambiguous cases (e.g., "Apple" could be fruit or company)

Return ONLY valid JSON, no explanations:
{
  "mention": "...",
  "entity": "...",
  "context": "...",
  "relationship": "same_as",
  "confidence": 0.95
}`;

  await rateLimiter.acquireSlot(550);  // Estimate 550 tokens

  const response = await rateLimiter.retryWithBackoff(async () => {
    return await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 1.0,  // High diversity
      max_tokens: 400
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
 * Generate Entity Linking dataset
 */
export async function generateLinkingDataset(options = {}) {
  const {
    count = 100,
    outputPath = 'data/linking-dataset.json',
    datasetName = 'linking'
  } = options;

  console.log(`\n🔗 Generating Entity Linking Dataset`);
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
        deduplicator.isDuplicate(result.example.context);
      }
    }

    console.log(`📂 Resumed from checkpoint: ${checkpoint.completed} completed, ${checkpoint.failed} failed\n`);
  }

  let generated = 0;
  let skipped = 0;

  try {
    while (writer.count < count) {
      try {
        const { example, tokensUsed } = await generateLinkingExample(rateLimiter);

        // Validate example
        if (!validateLinkingExample(example)) {
          console.log(`⚠️  Invalid example (failed validation)`);
          checkpoint.failed++;
          continue;
        }

        // Check for duplicates
        if (deduplicator.isDuplicate(example.context)) {
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
  const outputPath = process.argv[3] || 'data/linking-dataset.json';

  await generateLinkingDataset({ count, outputPath });
}

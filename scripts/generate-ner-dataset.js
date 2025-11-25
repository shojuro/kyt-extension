/**
 * NER Dataset Generator
 *
 * Generates Named Entity Recognition training examples using GPT-4o-mini
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { RateLimiter } from './lib/rate-limiter.js';
import { DeduplicationChecker } from './lib/deduplication.js';
import { DatasetWriter } from './lib/dataset-writer.js';
import { CheckpointManager } from './lib/checkpoint-manager.js';
import { validateNERExample } from './lib/validation.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate a single NER example using GPT-4o-mini
 */
async function generateNERExample(rateLimiter) {
  const prompt = `Generate a realistic Named Entity Recognition training example in JSON format.

The example should contain:
1. A "text" field with a natural sentence (20-50 words)
2. An "entities" array with entity spans

Each entity should have:
- "text": the entity text exactly as it appears
- "start": character start position (0-indexed)
- "end": character end position (exclusive)
- "label": one of PERSON, ORG, GPE, DATE, TIME, MONEY, PERCENT, PRODUCT, EVENT, LOC, NORP, FAC, WORK_OF_ART

Requirements:
- Text should be diverse (news, business, tech, sports, entertainment, etc.)
- Include 2-5 entities per example
- Entities must not overlap
- Spans must be accurate (verify start/end match the text)
- Use real-world contexts and realistic names

Return ONLY valid JSON, no explanations:
{
  "text": "...",
  "entities": [
    {"text": "...", "start": 0, "end": 10, "label": "PERSON"},
    ...
  ]
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

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = content;
  if (content.startsWith('```')) {
    const match = content.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (match) {
      jsonStr = match[1];
    }
  }

  const example = JSON.parse(jsonStr);

  // Fix incorrect entity spans (GPT-4o-mini often gets positions wrong)
  fixEntitySpans(example);

  const tokensUsed = {
    input: response.usage.prompt_tokens,
    output: response.usage.completion_tokens
  };

  return { example, tokensUsed };
}

/**
 * Fix entity span positions by finding actual text locations
 * GPT-4o-mini often provides incorrect character positions
 */
function fixEntitySpans(example) {
  if (!example || !example.text || !Array.isArray(example.entities)) {
    return;
  }

  for (const entity of example.entities) {
    if (!entity.text) continue;

    // Find the actual position of this entity text in the source
    const actualStart = example.text.indexOf(entity.text);

    if (actualStart !== -1) {
      // Found the text - update spans
      entity.start = actualStart;
      entity.end = actualStart + entity.text.length;
    } else {
      // Try case-insensitive search
      const lowerText = example.text.toLowerCase();
      const lowerEntityText = entity.text.toLowerCase();
      const caseInsensitiveStart = lowerText.indexOf(lowerEntityText);

      if (caseInsensitiveStart !== -1) {
        // Found with case-insensitive search
        const actualText = example.text.substring(
          caseInsensitiveStart,
          caseInsensitiveStart + entity.text.length
        );
        entity.text = actualText;  // Update to match actual casing
        entity.start = caseInsensitiveStart;
        entity.end = caseInsensitiveStart + entity.text.length;
      }
      // If still not found, leave as-is (will fail validation)
    }
  }

  // Sort entities by start position
  example.entities.sort((a, b) => a.start - b.start);

  // Remove overlapping entities (keep first occurrence)
  const nonOverlapping = [];
  let lastEnd = -1;

  for (const entity of example.entities) {
    if (entity.start >= lastEnd) {
      nonOverlapping.push(entity);
      lastEnd = entity.end;
    }
  }

  example.entities = nonOverlapping;
}

/**
 * Generate NER dataset
 */
export async function generateNERDataset(options = {}) {
  const {
    count = 100,
    outputPath = 'data/ner-dataset.json',
    datasetName = 'ner'
  } = options;

  console.log(`\n🧬 Generating NER Dataset`);
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
        deduplicator.isDuplicate(result.example.text);
      }
    }

    console.log(`📂 Resumed from checkpoint: ${checkpoint.completed} completed, ${checkpoint.failed} failed\n`);
  }

  let generated = 0;
  let skipped = 0;

  try {
    while (writer.count < count) {
      try {
        const { example, tokensUsed } = await generateNERExample(rateLimiter);

        // Validate example
        if (!validateNERExample(example)) {
          console.log(`⚠️  Invalid example (failed validation)`);
          checkpoint.failed++;
          continue;
        }

        // Check for duplicates
        if (deduplicator.isDuplicate(example.text)) {
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
  const outputPath = process.argv[3] || 'data/ner-dataset.json';

  await generateNERDataset({ count, outputPath });
}

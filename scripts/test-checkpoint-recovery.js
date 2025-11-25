/**
 * Checkpoint Recovery Test
 *
 * Tests the checkpoint recovery system by:
 * 1. Generating data with small checkpoint interval
 * 2. Simulating a crash after checkpoint is created
 * 3. Restarting and verifying resumption from checkpoint
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs/promises';
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
 * Generate a single NER example
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

  await rateLimiter.acquireSlot(600);

  const response = await rateLimiter.retryWithBackoff(async () => {
    return await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 1.0,
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

  // Fix incorrect entity spans (same as generate-ner-dataset.js)
  fixEntitySpans(example);

  const tokensUsed = {
    input: response.usage.prompt_tokens,
    output: response.usage.completion_tokens
  };

  return { example, tokensUsed };
}

/**
 * Fix entity span positions
 */
function fixEntitySpans(example) {
  if (!example || !example.text || !Array.isArray(example.entities)) {
    return;
  }

  for (const entity of example.entities) {
    if (!entity.text) continue;

    const actualStart = example.text.indexOf(entity.text);

    if (actualStart !== -1) {
      entity.start = actualStart;
      entity.end = actualStart + entity.text.length;
    } else {
      const lowerText = example.text.toLowerCase();
      const lowerEntityText = entity.text.toLowerCase();
      const caseInsensitiveStart = lowerText.indexOf(lowerEntityText);

      if (caseInsensitiveStart !== -1) {
        const actualText = example.text.substring(
          caseInsensitiveStart,
          caseInsensitiveStart + entity.text.length
        );
        entity.text = actualText;
        entity.start = caseInsensitiveStart;
        entity.end = caseInsensitiveStart + entity.text.length;
      }
    }
  }

  example.entities.sort((a, b) => a.start - b.start);

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
 * Test checkpoint recovery
 */
async function testCheckpointRecovery() {
  const count = 20;
  const outputPath = 'data/checkpoint-recovery-test.json';
  const datasetName = 'checkpoint-recovery-test';

  console.log(`\n🧪 Checkpoint Recovery Test`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Target: ${count} examples`);
  console.log(`Checkpoint Interval: 5 examples`);
  console.log(`Output: ${outputPath}\n`);

  // Initialize utilities with SMALL checkpoint interval for testing
  const rateLimiter = new RateLimiter();
  const deduplicator = new DeduplicationChecker({ fuzzyThreshold: 0.90 });
  const writer = new DatasetWriter({
    outputPath,
    costTrackerPath: `data/${datasetName}-cost-tracking.json`,
    saveInterval: 50
  });
  const checkpoint = new CheckpointManager({
    datasetName,
    checkpointInterval: 5  // SMALL interval for testing
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

    console.log(`📂 RESUMED from checkpoint: ${checkpoint.completed} completed, ${checkpoint.failed} failed\n`);
  } else {
    console.log(`📝 Starting fresh (no checkpoint found)\n`);
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
        if (generated % 5 === 0) {
          const stats = writer.getStats();
          console.log(`✅ Progress: ${writer.count}/${count} | Cost: $${stats.totalCostUSD}`);
        }

        // Checkpoint (every 5 examples)
        if (checkpoint.shouldCheckpoint()) {
          await checkpoint.saveCheckpoint({
            completed: checkpoint.completed,
            failed: checkpoint.failed,
            results: checkpoint.results
          });
          console.log(`💾 Checkpoint saved at ${checkpoint.completed} examples\n`);
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

    console.log(`\n✨ Test Complete!`);
    console.log(`═══════════════════════════════════════`);
    console.log(`Examples Generated: ${writer.count}`);
    console.log(`Duplicates Skipped: ${skipped}`);
    console.log(`Failed: ${checkpoint.failed}`);
    console.log(`Total Cost: $${stats.totalCostUSD}`);
    console.log(`Output: ${outputPath}\n`);

    return {
      success: true,
      count: writer.count,
      cost: stats.totalCostUSD
    };

  } catch (error) {
    console.error(`\n❌ Fatal error:`, error);
    console.log(`💾 Progress saved to checkpoint\n`);

    return {
      success: false,
      error: error.message,
      count: writer.count
    };
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  await testCheckpointRecovery();
}

/**
 * Debug NER Generation
 *
 * Generate one NER example and show exactly what GPT-4o-mini produces
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { validateNERExample } from './lib/validation.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

console.log('Generating NER example...\n');

const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: prompt }],
  temperature: 1.0,
  max_tokens: 500
});

const content = response.choices[0].message.content.trim();

console.log('=== RAW RESPONSE ===');
console.log(content);
console.log('\n=== PARSED JSON ===');

// Extract JSON from response
let jsonStr = content;
if (content.startsWith('```')) {
  const match = content.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match) {
    jsonStr = match[1];
    console.log('(Extracted from code block)');
  }
}

try {
  const example = JSON.parse(jsonStr);
  console.log(JSON.stringify(example, null, 2));

  console.log('\n=== FIXING SPANS ===');

  // Fix spans (same function from generate-ner-dataset.js)
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

  fixEntitySpans(example);
  console.log(JSON.stringify(example, null, 2));

  console.log('\n=== VALIDATION AFTER FIX ===');
  const isValid = validateNERExample(example);
  console.log(`Valid: ${isValid}`);

  if (!isValid) {
    console.log('\n=== VALIDATION DETAILS ===');

    // Check basic structure
    if (!example || !example.text || !Array.isArray(example.entities)) {
      console.log('❌ Missing required fields (text or entities)');
    } else {
      console.log(`✅ Has text field: "${example.text}"`);
      console.log(`✅ Has entities array: ${example.entities.length} entities`);

      // Check each entity
      for (let i = 0; i < example.entities.length; i++) {
        const entity = example.entities[i];
        console.log(`\nEntity ${i + 1}:`);
        console.log(`  Text: "${entity.text}"`);
        console.log(`  Start: ${entity.start}, End: ${entity.end}`);
        console.log(`  Label: ${entity.label}`);

        // Check span validity
        if (entity.start >= entity.end) {
          console.log(`  ❌ Invalid span: start (${entity.start}) >= end (${entity.end})`);
        }

        if (entity.start < 0 || entity.end > example.text.length) {
          console.log(`  ❌ Span out of bounds: text length is ${example.text.length}`);
        }

        // Check text match
        const spanText = example.text.substring(entity.start, entity.end);
        if (spanText !== entity.text) {
          console.log(`  ❌ Text mismatch:`);
          console.log(`     Expected: "${entity.text}"`);
          console.log(`     Got: "${spanText}"`);
        } else {
          console.log(`  ✅ Span matches text`);
        }

        // Check label
        const validLabels = ['PERSON', 'ORG', 'GPE', 'DATE', 'TIME', 'MONEY', 'PERCENT', 'PRODUCT', 'EVENT', 'LOC', 'NORP', 'FAC', 'WORK_OF_ART'];
        if (!validLabels.includes(entity.label)) {
          console.log(`  ❌ Invalid label: ${entity.label}`);
        } else {
          console.log(`  ✅ Valid label`);
        }
      }

      // Check for overlaps
      const sortedEntities = [...example.entities].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sortedEntities.length - 1; i++) {
        if (sortedEntities[i].end > sortedEntities[i + 1].start) {
          console.log(`\n❌ Overlapping entities found:`);
          console.log(`   Entity ${i + 1}: ${sortedEntities[i].start}-${sortedEntities[i].end}`);
          console.log(`   Entity ${i + 2}: ${sortedEntities[i + 1].start}-${sortedEntities[i + 1].end}`);
        }
      }
    }
  }

} catch (error) {
  console.error('Error parsing JSON:', error.message);
  console.error('\nTrying to extract JSON string:');
  console.error(jsonStr);
}

console.log('\n=== TOKEN USAGE ===');
console.log(`Input: ${response.usage.prompt_tokens}`);
console.log(`Output: ${response.usage.completion_tokens}`);
console.log(`Total: ${response.usage.total_tokens}`);

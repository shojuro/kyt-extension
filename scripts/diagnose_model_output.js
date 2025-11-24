/**
 * Diagnostic script to investigate model output format
 *
 * This will help us understand:
 * 1. What the model actually returns
 * 2. Whether different inputs produce different outputs
 * 3. What fields are available in the result
 * 4. Whether the issue is input format or output parsing
 */

import { pipeline } from '@xenova/transformers';

async function diagnose() {
  console.log('===================================');
  console.log('Model Output Diagnostic');
  console.log('===================================\n');

  // Load the model
  console.log('Loading model: Xenova/bge-reranker-base...');
  const startLoad = Date.now();

  const classifier = await pipeline('text-classification', 'Xenova/bge-reranker-base', {
    quantized: true
  });

  console.log(`Model loaded in ${Date.now() - startLoad}ms\n`);

  // Test cases with clearly different relevance
  const testCases = [
    {
      query: "machine learning",
      docs: [
        "Machine learning is a subset of artificial intelligence",  // HIGHLY RELEVANT
        "The weather today is sunny",  // IRRELEVANT
        "Python is a programming language used for ML"  // SOMEWHAT RELEVANT
      ]
    },
    {
      query: "cooking pasta",
      docs: [
        "Boil water and add salt before cooking pasta",  // HIGHLY RELEVANT
        "The capital of France is Paris",  // IRRELEVANT
        "Italian cuisine includes many pasta dishes"  // SOMEWHAT RELEVANT
      ]
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Query: "${testCase.query}"`);
    console.log('='.repeat(60));

    for (let i = 0; i < testCase.docs.length; i++) {
      const doc = testCase.docs[i];
      const input = `${testCase.query} ${doc}`;

      console.log(`\nDocument ${i + 1}: "${doc.slice(0, 50)}..."`);
      console.log('-'.repeat(60));

      try {
        // Test 1: Default pipeline call
        const result1 = await classifier(input);
        console.log('Result (default):', JSON.stringify(result1, null, 2));

        // Test 2: With topk parameter
        const result2 = await classifier(input, { topk: null });
        console.log('Result (topk: null):', JSON.stringify(result2, null, 2));

        // Test 3: Check if there's a logits property
        if (result1[0]?.score !== undefined) {
          console.log(`Extracted score: ${result1[0].score}`);
        }

      } catch (error) {
        console.error('Error:', error.message);
      }
    }
  }

  // Test 4: Try with explicit tokenizer input
  console.log('\n\n' + '='.repeat(60));
  console.log('Testing with different input formats');
  console.log('='.repeat(60));

  const query = "How do I cook pasta";
  const doc = "Boil water, add salt, cook pasta for 8-10 minutes";

  const formats = [
    { name: 'Concatenated', input: `${query} ${doc}` },
    { name: 'With [SEP]', input: `${query} [SEP] ${doc}` },
    { name: 'Array format', input: [query, doc] },
  ];

  for (const format of formats) {
    console.log(`\nFormat: ${format.name}`);
    console.log(`Input: ${JSON.stringify(format.input)}`);
    try {
      const result = await classifier(format.input);
      console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('Error:', error.message);
    }
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('Diagnostic Complete');
  console.log('='.repeat(60));
}

diagnose().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

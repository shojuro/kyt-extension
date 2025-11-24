import { AutoModel, AutoTokenizer } from '@xenova/transformers';

async function testRawModel() {
  console.log('Loading model and tokenizer...');

  const modelName = 'Xenova/bge-reranker-base';
  const model = await AutoModel.from_pretrained(modelName);
  const tokenizer = await AutoTokenizer.from_pretrained(modelName);

  console.log('Model loaded:', model.constructor.name);
  console.log();

  // Test with query-document pair
  const testCases = [
    {
      query: "machine learning",
      doc: "Machine learning is a subset of AI",
      expectedRelevance: "HIGH"
    },
    {
      query: "machine learning",
      doc: "The weather is sunny today",
      expectedRelevance: "LOW"
    }
  ];

  for (const testCase of testCases) {
    console.log(`Query: "${testCase.query}"`);
    console.log(`Document: "${testCase.doc}"`);
    console.log(`Expected: ${testCase.expectedRelevance}`);
    console.log('-'.repeat(60));

    // Tokenize
    const inputs = await tokenizer(`${testCase.query} ${testCase.doc}`, {
      padding: true,
      truncation: true,
      return_tensors: 'pt'
    });

    console.log('Input IDs shape:', inputs.input_ids.dims);

    // Forward pass
    const outputs = await model(inputs);

    console.log('Model outputs:');
    console.log('- Keys:', Object.keys(outputs));

    if (outputs.last_hidden_state) {
      console.log('- Last hidden state shape:', outputs.last_hidden_state.dims);
    }

    if (outputs.logits) {
      console.log('- Logits shape:', outputs.logits.dims);
      const logits = outputs.logits.data;
      console.log('- Raw logit value:', logits[0]);

      // Apply sigmoid
      const sigmoid = 1 / (1 + Math.exp(-logits[0]));
      console.log('- Sigmoid score:', sigmoid.toFixed(4));
    } else {
      console.log('- No logits found!');
    }

    console.log();
  }
}

testRawModel().catch(console.error);

/**
 * Validation Functions for Synthetic Training Data
 *
 * Validates three types of datasets:
 * 1. NER (Named Entity Recognition) - Text with entity spans
 * 2. Entity Linking - Entity mention pairs with relationships
 * 3. Reranking - Query-passage relevance pairs
 */

/**
 * Validate NER example
 * @param {Object} example - NER example to validate
 * @returns {boolean} - True if valid
 */
export function validateNERExample(example) {
  try {
    // Required fields
    if (!example || typeof example !== 'object') {
      return false;
    }

    if (!example.text || typeof example.text !== 'string' || example.text.length === 0) {
      return false;
    }

    if (!Array.isArray(example.entities)) {
      return false;
    }

    // Validate each entity
    for (const entity of example.entities) {
      // Required entity fields
      if (!entity.text || typeof entity.text !== 'string') {
        return false;
      }

      if (typeof entity.start !== 'number' || typeof entity.end !== 'number') {
        return false;
      }

      if (!entity.label || typeof entity.label !== 'string') {
        return false;
      }

      // Start must be before end
      if (entity.start >= entity.end) {
        return false;
      }

      // Entity span must be within text bounds
      if (entity.start < 0 || entity.end > example.text.length) {
        return false;
      }

      // Entity text must match the span in the original text
      const spanText = example.text.substring(entity.start, entity.end);
      if (spanText !== entity.text) {
        return false;
      }

      // Valid entity labels
      const validLabels = ['PERSON', 'ORG', 'GPE', 'DATE', 'TIME', 'MONEY', 'PERCENT',
                          'PRODUCT', 'EVENT', 'LOC', 'NORP', 'FAC', 'WORK_OF_ART'];
      if (!validLabels.includes(entity.label)) {
        return false;
      }
    }

    // Check for overlapping entity spans
    const sortedEntities = [...example.entities].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sortedEntities.length - 1; i++) {
      if (sortedEntities[i].end > sortedEntities[i + 1].start) {
        return false;  // Overlapping entities
      }
    }

    return true;

  } catch (error) {
    return false;
  }
}

/**
 * Validate Entity Linking example
 * @param {Object} example - Entity linking example to validate
 * @returns {boolean} - True if valid
 */
export function validateLinkingExample(example) {
  try {
    // Required fields
    if (!example || typeof example !== 'object') {
      return false;
    }

    if (!example.mention || typeof example.mention !== 'string' || example.mention.length === 0) {
      return false;
    }

    if (!example.entity || typeof example.entity !== 'string' || example.entity.length === 0) {
      return false;
    }

    if (!example.context || typeof example.context !== 'string' || example.context.length === 0) {
      return false;
    }

    // Context should contain the mention
    if (!example.context.includes(example.mention)) {
      return false;
    }

    // Relationship should be valid if present
    if (example.relationship) {
      const validRelationships = ['same_as', 'similar_to', 'related_to', 'part_of', 'instance_of'];
      if (!validRelationships.includes(example.relationship)) {
        return false;
      }
    }

    // Confidence should be between 0 and 1 if present
    if (example.confidence !== undefined) {
      if (typeof example.confidence !== 'number' ||
          example.confidence < 0 ||
          example.confidence > 1) {
        return false;
      }
    }

    return true;

  } catch (error) {
    return false;
  }
}

/**
 * Validate Reranking example
 * @param {Object} example - Reranking example to validate
 * @returns {boolean} - True if valid
 */
export function validateRerankingExample(example) {
  try {
    // Required fields
    if (!example || typeof example !== 'object') {
      return false;
    }

    if (!example.query || typeof example.query !== 'string' || example.query.length === 0) {
      return false;
    }

    if (!example.passage || typeof example.passage !== 'string' || example.passage.length === 0) {
      return false;
    }

    if (typeof example.relevance !== 'number') {
      return false;
    }

    // Relevance should be between 0 and 1 (or 0-3 for ratings)
    if (example.relevance < 0 || example.relevance > 3) {
      return false;
    }

    // Optional: reason should be string if present
    if (example.reason !== undefined) {
      if (typeof example.reason !== 'string') {
        return false;
      }
    }

    return true;

  } catch (error) {
    return false;
  }
}

/**
 * Batch validate examples
 * @param {Array} examples - Array of examples
 * @param {Function} validator - Validation function
 * @returns {Object} - Validation results
 */
export function batchValidate(examples, validator) {
  const results = {
    total: examples.length,
    valid: 0,
    invalid: 0,
    passRate: 0,
    errors: []
  };

  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];
    const isValid = validator(example);

    if (isValid) {
      results.valid++;
    } else {
      results.invalid++;
      results.errors.push({
        index: i,
        example: JSON.stringify(example).substring(0, 100) + '...'
      });
    }
  }

  results.passRate = results.total > 0
    ? (results.valid / results.total * 100).toFixed(1) + '%'
    : '0.0%';

  return results;
}

/**
 * Quality assessment for generated dataset
 * @param {Array} examples - Array of examples
 * @param {string} datasetType - Type: 'ner', 'linking', or 'reranking'
 * @returns {Object} - Quality metrics
 */
export function assessQuality(examples, datasetType) {
  // Select validator
  let validator;
  if (datasetType === 'ner') {
    validator = validateNERExample;
  } else if (datasetType === 'linking') {
    validator = validateLinkingExample;
  } else if (datasetType === 'reranking') {
    validator = validateRerankingExample;
  } else {
    throw new Error(`Unknown dataset type: ${datasetType}`);
  }

  // Batch validate
  const validation = batchValidate(examples, validator);

  // Additional quality metrics
  const textLengths = examples
    .filter(e => e !== null && e !== undefined)  // Filter out null/undefined examples first
    .map(e => {
      if (datasetType === 'ner') return e.text?.length || 0;
      if (datasetType === 'linking') return e.context?.length || 0;
      if (datasetType === 'reranking') return e.passage?.length || 0;
      return 0;
    })
    .filter(len => len > 0);

  const avgLength = textLengths.length > 0
    ? Math.round(textLengths.reduce((a, b) => a + b, 0) / textLengths.length)
    : 0;

  // Count unique entities/mentions/queries
  let uniqueCount = 0;
  const validExamples = examples.filter(e => e !== null && e !== undefined);

  if (datasetType === 'ner' && validExamples.length > 0) {
    const allEntities = validExamples.flatMap(e => e.entities?.map(ent => ent.text) || []);
    uniqueCount = new Set(allEntities).size;
  } else if (datasetType === 'linking' && validExamples.length > 0) {
    const allMentions = validExamples.map(e => e.mention).filter(m => m !== undefined);
    uniqueCount = new Set(allMentions).size;
  } else if (datasetType === 'reranking' && validExamples.length > 0) {
    const allQueries = validExamples.map(e => e.query).filter(q => q !== undefined);
    uniqueCount = new Set(allQueries).size;
  }

  return {
    ...validation,
    avgTextLength: avgLength,
    uniqueEntities: uniqueCount,
    diversity: uniqueCount > 0
      ? (uniqueCount / examples.length * 100).toFixed(1) + '%'
      : '0.0%'
  };
}

/**
 * @typedef {'chatgpt' | 'claude'} Platform
 */

/**
 * @typedef {Object} ImportConfig
 * @property {Platform} platform
 * @property {number} maxAgeDays
 * @property {number} batchSize
 * @property {number} batchDelayMs
 * @property {string} userId
 * @property {boolean} [forceReimport]
 */

/**
 * @typedef {Object} ImportProgress
 * @property {string} importId
 * @property {string} userId
 * @property {Platform} platform
 * @property {'pending' | 'in_progress' | 'completed' | 'failed'} status
 * @property {number} conversationsTotal
 * @property {number} conversationsProcessed
 * @property {number} messagesImported
 * @property {number} messagesSkipped
 * @property {string|null} lastConversationId
 * @property {number} estimatedCostUsd
 * @property {string|null} startedAt
 * @property {string|null} errorMessage
 * @property {number} [currentBatch]
 * @property {number} [totalBatches]
 * @property {number} [estimatedTimeRemaining]
 */

/**
 * @typedef {Object} ImportResult
 * @property {boolean} success
 * @property {number} messagesImported
 * @property {number} messagesSkipped
 * @property {number} duplicatesFound
 * @property {Object|null} dateRange
 * @property {Date} dateRange.oldest
 * @property {Date} dateRange.newest
 * @property {number} [processingTimeMs]
 * @property {number} [estimatedCost]
 * @property {string[]} [errors]
 * @property {boolean} [alreadyImported]
 * @property {Object} [previousImport]
 * @property {string} previousImport.importedAt
 * @property {number} previousImport.messageCount
 */

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} conversationId
 * @property {string} conversationTitle
 * @property {string} content
 * @property {'user' | 'assistant'} role
 * @property {number} timestamp
 * @property {Platform} platform
 * @property {string} [model]
 */

export const Types = {};

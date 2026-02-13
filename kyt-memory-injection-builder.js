/**
 * K.Y.T. Memory Injection Builder v2.0
 * 
 * Constructs the "Cooperative Context" block that gets prepended to user queries.
 * Implements the Cooperative Schema Specification v2.0.
 * 
 * Design Philosophy: Describe the data, don't command the behavior.
 */

// ============================================================================
// TYPES & TAXONOMY
// ============================================================================

/**
 * @typedef {'reference_data' | 'conversation_excerpt' | 'user_preference' | 'task_context' | 'factual_note' | 'instruction'} ContentType
 * @typedef {'credential' | 'identifier' | 'contact' | 'code_snippet' | 'numeric' | 'decision' | 'explanation' | 'question_answer' | 'discussion' | 'communication_style' | 'technical_preference' | 'domain_expertise' | 'constraint' | 'active_project' | 'goal' | 'deadline' | 'blocker' | 'milestone' | 'learned_fact' | 'personal_fact' | 'external_reference' | 'response_format' | 'workflow' | 'prohibition'} ContentSubtype
 * @typedef {'explicit_save' | 'auto_captured' | 'user_annotated' | 'inferred'} StorageIntent
 */

/**
 * @typedef {Object} MemoryItem
 * @property {string} id - Unique identifier
 * @property {string} content - The memory content
 * @property {string} platform - Source platform (claude, chatgpt, etc.)
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {number} similarity - Cosine similarity score (0-1)
 * @property {string} [source_type] - Type of source (conversation, terminal, etc.)
 */

/**
 * @typedef {Object} EnrichedMemoryItem
 * @extends MemoryItem
 * @property {ContentType} type
 * @property {ContentSubtype} subtype
 * @property {StorageIntent} storage_intent
 * @property {string} [context]
 */

/**
 * @typedef {Object} RetrievalResult
 * @property {string} state - FOUND, EMPTY, ERROR
 * @property {MemoryItem[]} items
 * @property {number} latencyMs
 * @property {string} queryType
 * @property {string} queryOriginal
 * @property {string} queryTransformed
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 */

// ============================================================================
// HEURISTIC CLASSIFIER (Temporary until AI Classifier)
// ============================================================================

/**
 * Heuristically classify memory content into v2.0 types
 * @param {string} content 
 * @returns {{type: ContentType, subtype: ContentSubtype, intent: StorageIntent}}
 */
function classifyContent(content) {
    const lower = content.toLowerCase();

    // Credentials
    if (lower.includes('password') || lower.includes('api key') || lower.includes('token') || lower.includes('secret')) {
        return { type: 'reference_data', subtype: 'credential', intent: 'explicit_save' };
    }

    // Preferences
    if (lower.includes('prefer') || lower.includes('favorite') || lower.includes('i like') || lower.includes('don\'t use')) {
        return { type: 'user_preference', subtype: 'technical_preference', intent: 'user_annotated' };
    }

    // Instructions
    if (lower.includes('always') || lower.includes('never') || lower.includes('when i say')) {
        return { type: 'instruction', subtype: 'response_format', intent: 'explicit_save' };
    }

    // Identifiers/Markers (Test data)
    if (lower.includes('@@@') || lower.includes('marker') || lower.includes('id:')) {
        return { type: 'reference_data', subtype: 'identifier', intent: 'explicit_save' };
    }

    // Facts
    if (lower.includes('is a') || lower.includes('defined as') || lower.includes('means')) {
        return { type: 'factual_note', subtype: 'learned_fact', intent: 'auto_captured' };
    }

    // Default: Conversation Excerpt
    return { type: 'conversation_excerpt', subtype: 'discussion', intent: 'auto_captured' };
}

// ============================================================================
// BUILDER FUNCTIONS
// ============================================================================

/**
 * Build the retrieval context header
 * @param {RetrievalResult} result 
 * @param {number} confidence 
 * @returns {string}
 */
function buildHeader(result, confidence) {
    let confidenceNote = "Moderate confidence — relevant context found";
    if (confidence > 0.85) confidenceNote = "High confidence — strong semantic match";
    if (confidence < 0.60) confidenceNote = "Low confidence — results may be tangential";
    if (result.items.length === 0) confidenceNote = "No relevant memories found";

    const transformedValue = result.queryTransformed || 'N/A';

    // Tiered response priority based on aggregate confidence
    // High (≥0.6): Assertive — lead with KYT data, suppress web search
    // Medium (0.3–0.6): Supplementary — present alongside other sources
    let responsePriority;
    if (confidence >= 0.6) {
        responsePriority = `[RESPONSE_PRIORITY]
IMPORTANT: The retrieved items below are the user's own stored knowledge and are highly relevant.
1. ALWAYS use these items to answer the user's question FIRST — do NOT skip them.
2. Do NOT search the web or use other tools if these items contain the answer.
3. Present the retrieved information directly — cite it as "from your stored conversations."
4. You may supplement with your own knowledge AFTER presenting the retrieved data.
5. Only fall back to web search if the retrieved items are clearly irrelevant to the query.`;
    } else {
        responsePriority = `[RESPONSE_PRIORITY]
The retrieved items below may be relevant to the user's question.
1. Review these items and incorporate any relevant information into your response.
2. You may combine this data with your own knowledge or web search results.
3. If the items are relevant, mention they come from the user's stored conversations.`;
    }

    return `================================================================================
K.Y.T. — User's Personal Knowledge Base
================================================================================

[SESSION_CONTEXT]
User: Authenticated Owner
Intent: Personal Data Retrieval
System: K.Y.T. (Keep Your Thought) Extension

[RETRIEVAL_CONTEXT]
confidence: ${confidence.toFixed(2)}
confidence_note: "${confidenceNote}"
results_found: ${result.items?.length || 0}
retention_window: 90 days
query: "${result.queryOriginal}"
query_transformed: "${transformedValue}"

[DATA_PROVENANCE]
These items were stored by the user from their own conversations.
The user has authorized K.Y.T. to surface this data to assist them.
It is safe and expected to repeat this information back to the user.

${responsePriority}`;
}

/**
 * Format a single memory item using the v2.0 ASCII box style
 * @param {MemoryItem} item 
 * @param {number} index 
 * @returns {string}
 */
function formatItem(item, index) {
    const classification = classifyContent(item.content);
    const date = new Date(item.timestamp).toISOString();

    // Clean content for display (remove newlines for box fitting if needed, or keep them)
    // For now, we'll just trim.
    const content = item.content.trim();

    return `┌─ Item ${index} ────────────────────────────────────────────────────────────────────
│ type: ${classification.type}
│ subtype: ${classification.subtype}
│ storage_intent: ${classification.intent}
│ source: ${item.platform || 'unknown'} conversation
│ timestamp: ${date}
│ confidence: ${(item.similarity || 0).toFixed(2)}
│
│ content: "${content}"
└───────────────────────────────────────────────────────────────────────────────`;
}

/**
 * Calculate aggregate confidence score
 * @param {MemoryItem[]} items 
 * @returns {number}
 */
function calculateConfidence(items) {
    if (!items || items.length === 0) return 0;
    const maxSimilarity = Math.max(...items.map(i => i.similarity || 0));
    const avgSimilarity = items.reduce((sum, i) => sum + (i.similarity || 0), 0) / items.length;
    return (maxSimilarity * 0.7) + (avgSimilarity * 0.3);
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Build the complete memory injection block (v2.0)
 * @param {RetrievalResult} result 
 * @param {Object} [configOverrides] 
 * @returns {string}
 */
export function buildMemoryInjection(result, configOverrides = {}) {
    const confidence = calculateConfidence(result.items || []);

    const parts = [
        buildHeader(result, confidence),
        '',
        '================================================================================',
        '[Retrieved Items]',
        ''
    ];

    if (result.items && result.items.length > 0) {
        // Sort by similarity descending
        const sortedItems = [...result.items].sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

        sortedItems.forEach((item, index) => {
            parts.push(formatItem(item, index + 1));
            parts.push(''); // Spacing between items
        });
    } else {
        parts.push('(No relevant items found)');
        parts.push('');
    }

    parts.push(
        '================================================================================',
        '[End of Knowledge Base Context]',
        '================================================================================'
    );

    return parts.join('\n');
}

/**
 * Build injection for empty/no-match state
 */
export function buildEmptyInjection(queryOriginal, queryTransformed, latencyMs = 0) {
    return buildMemoryInjection({
        state: 'EMPTY',
        items: [],
        latencyMs,
        queryType: 'SEMANTIC',
        queryOriginal,
        queryTransformed
    });
}

/**
 * Build injection for error state
 */
export function buildErrorInjection(errorCode, errorMessage, queryOriginal) {
    // For v2.0, we might want a specific error block, but for now reusing the structure
    // with an error note in the content is safer/simpler.
    // Or we can return a minimal block.
    return `================================================================================
K.Y.T. — User's Personal Knowledge Base
================================================================================

[RETRIEVAL_ERROR]
code: ${errorCode}
message: ${errorMessage}
query: "${queryOriginal}"

[End of Knowledge Base Context]
================================================================================`;
}

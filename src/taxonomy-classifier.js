/**
 * K.Y.T. Taxonomy Classifier
 * 
 * Heuristically classifies memory content into v2.0 types.
 * Used for:
 * 1. Formatting injection blocks (visuals)
 * 2. Reranking logic (boosting facts over chatter)
 */

/**
 * @typedef {'reference_data' | 'conversation_excerpt' | 'user_preference' | 'task_context' | 'factual_note' | 'instruction'} ContentType
 * @typedef {'credential' | 'identifier' | 'contact' | 'code_snippet' | 'numeric' | 'decision' | 'explanation' | 'question_answer' | 'discussion' | 'communication_style' | 'technical_preference' | 'domain_expertise' | 'constraint' | 'active_project' | 'goal' | 'deadline' | 'blocker' | 'milestone' | 'learned_fact' | 'personal_fact' | 'external_reference' | 'response_format' | 'workflow' | 'prohibition'} ContentSubtype
 * @typedef {'explicit_save' | 'auto_captured' | 'user_annotated' | 'inferred'} StorageIntent
 */

/**
 * Heuristically classify memory content into v2.0 types
 * @param {string} content 
 * @returns {{type: ContentType, subtype: ContentSubtype, intent: StorageIntent}}
 */
export function classifyContent(content) {
    const lower = content.toLowerCase();
    const trimmed = content.trim();

    // Question guard — questions are not preferences/instructions (P2 fix)
    if (trimmed.endsWith('?') || /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember)\b/i.test(trimmed)) {
        return { type: 'conversation_excerpt', subtype: 'question_answer', intent: 'auto_captured' };
    }

    // Credentials (High Priority)
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

    // Facts (Improved detection)
    // Matches: "X is Y", "defined as", "means", "consists of"
    if (lower.includes(' is ') || lower.includes('defined as') || lower.includes('means') || lower.includes('consists of')) {
        return { type: 'factual_note', subtype: 'learned_fact', intent: 'auto_captured' };
    }

    // Default: Conversation Excerpt
    return { type: 'conversation_excerpt', subtype: 'discussion', intent: 'auto_captured' };
}

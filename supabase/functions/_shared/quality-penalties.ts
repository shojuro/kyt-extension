/**
 * Quality Penalties — Server-side retrieval quality filters
 *
 * Ported from src/context-retrieval.js + src/assistant-quality-detector.js
 * to unify retrieval quality between Chrome extension and MCP consumers.
 *
 * Applied AFTER reranking, BEFORE confidence filter in the pipeline:
 *   ... rerank → quality penalties → confidence filter → top-K
 *
 * All penalties operate on `rerank_score` (the primary score post-reranking).
 */

import { Logger } from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

interface ScoredCandidate {
    id: string;
    content: string;
    rerank_score: number;
    platform?: string;
    role?: string;
    speakers?: string[];
    created_at?: string;
    timestamp?: string;
    msg_timestamp?: string;
    [key: string]: any;
}

export interface QualityPenaltyOptions {
    /** The user's original search query */
    query: string;
    /** Whether user is asking about KYT/extension (skip meta penalty) */
    queryIsAboutKYT?: boolean;
    /** Whether user is asking about retrieval diagnostics (skip diagnostic penalty) */
    queryIsAboutRetrieval?: boolean;
    /** Target platform extracted from query (for platform penalty — already handled separately) */
    targetPlatform?: string | null;
    /** Request ID for logging */
    requestId?: string;
}

// ============================================================================
// Pattern Constants (ported from src/context-retrieval.js)
// ============================================================================

/**
 * Claude Code tooling artifacts — hard drop.
 * These are system/tooling messages ingested from Claude Code sessions
 * that have zero information value for retrieval.
 */
const CLAUDE_CODE_ARTIFACT_PATTERNS: RegExp[] = [
    /^<(?:local-command-caveat|command-name|command-message|command-args|system-reminder|task-notification|antml:)/,
    /^Prompt is too long$/,
    /^Let me (?:search|try|check|look) (?:your|a|for|if|what)/i,
    /^(?:Let me|I'll) (?:read|load|find|run|open|search) /i,
    /^(?:Found|No|Searching|Looking|Checking|Loading)\b.{0,30}$/,
    /^Tool (?:loaded|result|called)/i,
];

/**
 * Raw JSON metadata — hard drop.
 * ChatGPT audio asset pointer JSON and similar API metadata that leaked
 * through before client-side filtering was added. Already in DB.
 */
const RAW_JSON_METADATA_PATTERNS: RegExp[] = [
    /\"content_type\"\s*:\s*\"[^"]*asset_pointer/,
    /\"expiry_datetime\"\s*:/,
    /\"frames_asset_pointers\"\s*:/,
];

/**
 * Substance scoring thresholds and patterns.
 * Replaces the old blunt LOW_INFO filter (< 40 chars, < 4 words) which
 * would incorrectly drop "I love Molly" (3 words, deeply personal).
 */
const SUBSTANCE_SHORT_THRESHOLD = 80;   // chars
const SUBSTANCE_MEDIUM_THRESHOLD = 200; // chars

/** High-substance patterns — content worth keeping even if short */
const HIGH_SUBSTANCE_PATTERNS: RegExp[] = [
    /\bI\s+(?:love|hate|prefer|miss|need|want|wish|adore|despise)\b/i,
    /\bI\s+(?:decided|chose|picked|committed|resolved|quit|started|stopped)\b/i,
    /\bI'?m\s+(?:scared|grateful|thankful|afraid|proud|ashamed|excited|worried|anxious|happy|sad)\b/i,
    /\bmy\s+(?:wife|husband|partner|dad|mom|father|mother|son|daughter|brother|sister|friend|dog|cat|family)\b/i,
    /\b(?:favorite|favourite|best|worst)\b/i,
    /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/,  // Named entity heuristic (2+ capitalized words)
    /\b(?:always|never)\s+\w+/i,
    /\b(?:diagnosed|prescription|medication|therapy|treatment)\b/i,
];

/** Low-substance patterns — meta-conversational filler */
const LOW_SUBSTANCE_PATTERNS: RegExp[] = [
    /^(?:thoughts|sounds?\s+good|agreed|exactly|right|correct|yeah|yep|nope|sure|ok(?:ay)?|got\s+it|makes?\s+sense|fair\s+enough|understood|noted|interesting|cool|nice|great|perfect|alright|fine|absolutely|definitely|certainly|indeed|precisely)\b[.!?]*$/i,
    /\b(?:let\s+me|running|deploying|checking|loading|processing|building|compiling|installing)\b/i,
    /\bthoughts\b.*\bshare\s+them\b/i,
    /^(?:mhm|hmm|hm|uh-?huh|mm-?hmm)[.!?]*$/i,
    /^[A-Z][a-z]+\s+(?:plan|option|choice|step|note|idea|thought)[.!?]*$/i,  // "Dev plan.", "Clear option."
];

/** Meta-conversation patterns: KYT/extension operational chatter */
const KYT_META_PATTERNS: RegExp[] = [
    /\bK\.?Y\.?T\.?\b.*\b(extension|plugin|add-?on)\b.*\b(working|broken|not working|crash|error|bug|fix|debug)\b/i,
    /\b(extension|memory system|knowledge base)\b.*\b(broken|not working|crash|paused|down|error)\b/i,
    /\bchrome\.?(runtime|storage|extension)\b.*\b(error|bug|crash|fail|broken|terminat|restart|debug)\b/i,
    /\bservice worker\b.*\b(terminat|restart|error|log|crash|fail)\b/i,
    /\bKYT_(?:MESSAGE|CONTEXT|BRIDGE|DEBUG)\b/,
];

/** Skip meta-penalty when query is genuinely about KYT/extension */
const KYT_QUERY_PATTERNS: RegExp[] = [
    /\bK\.?Y\.?T\.?\b/i,
    /\b(extension|chrome extension)\b.*\b(model|support|need|use|feature|work)/i,
    /\bservice worker\b/i,
];

/** Retrieval-diagnostic patterns: meta-echo about pipeline behavior (23 regexes) */
const RETRIEVAL_DIAGNOSTIC_PATTERNS: RegExp[] = [
    // Original 12: mechanical pipeline vocabulary
    /\b(query|retrieval|search)\s+(failed|returned|missed|found nothing)\b/i,
    /\bconfidence\s+(was|of|at)\s+0\.\d+\b/i,
    /\b(semantic|vector)\s+anchor/i,
    /\bfalse\s+fire\b/i,
    /\bburned\s+a\s+retrieval\s+cycle\b/i,
    /\b(meta-?echo|echo\s+problem)\b/i,
    /\bretrieval\s+(failure|gap|quality|pipeline)\b/i,
    /\bintent\s+classif(ier|ication)\s+(would|should|could|will)\b/i,
    /\b(confidence|match)\s+threshold\b.*\b0\.\d+\b/i,
    /\b(scored|scoring)\s+(at|with)\s+0\.\d+\b/i,
    /\bpipeline\s+(fires|fired|should\s+(not\s+)?fire|didn't\s+fire)\b/i,
    /\bwasted\s+retrieval\s+cycle\b/i,
    // 11 new: natural-language diagnostic analysis
    /\bretrieved\s+item\b.*\b(useful|thin|relevant|partial|incomplete|sufficient)\b/i,
    /\b(single\s+)?chunk\s+(is\s+a\s+)?(pointer|fragment|partial|slice)\b/i,
    /\binjection\s+(quality|accuracy|completeness|coverage)\b/i,
    /\bprovenance\s+(chain|trail|path)\b/i,
    /\b0\.\d{2}\s+(single-?item|item|result|confidence)\b/i,
    /\b(cross-?session|multi-?day|distributed)\s+(answer|content|result|retrieval)\b/i,
    /\bwhat\s+the\s+(pipeline|system|retrieval|search)\s+(returned|found|missed|surfaced)\b/i,
    /\b(low|high|medium|weak|strong)-?confidence\s+(result|item|match|retrieval)s?\b/i,
    /\bK\.?Y\.?T\.?\s+(performed|did|ran|executed|triggered)\s+a?\s*(retrieval|search|query|lookup)\b/i,
    /\banswer\s+(isn'?t|wasn'?t|is\s+not|was\s+not)\s+in\s+(one|a\s+single)\s+(place|chunk|item|turn)\b/i,
    /\b(pipeline|retrieval)\s+(returned|surfaced|pulled|fetched)\s+\d+\s+(item|result|chunk|match)/i,
];

/** Skip diagnostic penalty when user genuinely asks about retrieval */
const RETRIEVAL_QUERY_PATTERNS: RegExp[] = [
    /\bretrieval\s+(failures?|issues?|problems?|quality)\b/i,
    /\b(query|search)\s+(failures?|diagnostics?|analysis)\b/i,
    /\bwhat\s+(went\s+wrong|failed)\s+with\s+(the\s+)?(search|retrieval|query)\b/i,
];

/** Deflection patterns — ported from src/assistant-quality-detector.js */
const DEFLECTION_PATTERNS: RegExp[] = [
    /i don'?t have access to/i,
    /i don'?t have (?:any )?(?:information|data|records?) (?:about|on|regarding)/i,
    /i (?:can'?t|cannot|am unable to) (?:access|retrieve|find|locate|look up)/i,
    /i (?:can'?t|cannot) (?:help|assist) (?:with|you with) that/i,
    /i'?m (?:not able|unable) to (?:access|retrieve|find|provide)/i,
    /i'?m not (?:really |entirely |exactly )?sure (?:really |entirely |exactly )?(?:what|how|if|about|which|when|where|why)/i,
    /i don'?t (?:know|recall|remember) (?:what|the|any|about)/i,
    /i don'?t have (?:enough|sufficient) (?:context|information)/i,
    /there'?s no (?:\w+ )?(?:record|information|data|mention|answer|preference) (?:of|about|for|regarding)/i,
    /i (?:couldn'?t|could not) find (?:any|specific|that)/i,
    /could you (?:please )?(?:clarify|elaborate|explain|provide|share|tell me|give me)/i,
    /can you (?:please )?(?:clarify|elaborate|explain|provide|share|tell me|give me)/i,
    /(?:would|could) you (?:mind|like to) (?:providing|sharing|telling)/i,
    /what (?:do you mean|exactly|specifically) (?:by|about|when)/i,
    /i(?:'d| would) need (?:more|additional|further) (?:context|information|details)/i,
    /unfortunately,? i (?:can'?t|cannot|don'?t|am not able)/i,
    /i'?m (?:sorry|afraid),? (?:but )?i (?:don'?t|can'?t|cannot)/i,
    /that(?:'s| is) (?:beyond|outside) (?:my|what i)/i,
    /i (?:have no|lack) (?:way|ability|means) to/i,
    /as an ai,? i (?:don'?t|can'?t|cannot)/i,
    /(?:no|zero) (?:(?:answer|preference|record|information|data) (?:or )?)+(?:was |has been |were )(?:\w+ )?(?:captured|stored|recorded|saved|found)/i,
    /(?:don'?t|doesn'?t|do not|does not) have (?:a |an |any )?(?:direct )?(?:answer|record|information|data|preference) (?:about|for|regarding|on)/i,
    /only contains? the question/i,
    /(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)/i,
    /the only (?:item|entry|result|thing|match|record)s? (?:found|retrieved|returned|available) (?:is|are|was|were) (?:the )?(?:query|question) itself/i,
    /rather than (?:an? )?(?:actual|real|stored|specific) (?:answer|response|preference|record)/i,
    /stored (?:data|conversations?|items?) (?:still )?(?:don'?t|doesn'?t|do not|does not) have/i,
    /found (?:a |the )?(?:previous |earlier )?conversation.{0,40}?but (?:unfortunately )?(?:no|without|not)/i,
    /(?:stored|retrieved) (?:\w+ )*(?:only|just) (?:captures?|contains?|shows?|includes?)/i,
    /(?:details?|answer|list|information|data) (?:wasn'?t|weren'?t|(?:was|were) not) (?:fully )?(?:captured|stored|recorded|saved|included)/i,
    /don'?t have (?:your|the|a) (?:\w+ )*(?:answer|list|response|details?)\b/i,
    /(?:not|without) (?:the|an?) (?:actual|full|complete|specific) (?:answer|list|response|details?|data)/i,
    /(?:gaps?|blanks?) with (?:guesses?|inferred|generated|fabricated)/i,
    /(?:didn'?t|did not) (?:surface|return|find|include|pull up|produce|retrieve)\b/i,
    /(?:isn'?t|is not|wasn'?t|was not) in (?:what )?.{0,40}?(?:returned|surfaced|retrieved|found|stored)\b/i,
    /\b(?:K\.?Y\.?T\.?|the (?:extension|system|tool|memory))\b.{0,30}?(?:didn'?t|did not|couldn'?t|could not) (?:surface|capture|find|retrieve|return|include|pull up)\b/i,
];

/** Echo patterns: assistant paraphrases without adding info */
const ASST_ECHO_PATTERNS: RegExp[] = [
    /(?:so |it (?:sounds|seems) like )you(?:'re| are) (?:asking|looking for|wondering|trying to)/i,
    /(?:so |it (?:sounds|seems) like )you (?:want|need) (?:to know|information|help with)/i,
    /you'?re asking (?:about|whether|if|how)/i,
    /(?:let me (?:understand|make sure)|just to (?:clarify|confirm)):? (?:you|so you|are you)/i,
    /(?:if i understand (?:correctly|you right)),? you/i,
];

/** Stored-data echo patterns (from context-retrieval.js meta block) */
const STORED_DATA_ECHO_PATTERNS: RegExp[] = [
    /\byou (?:said|mentioned|noted|discussed|talked about|asked about|brought up)\b/i,
    /\bfrom your (?:stored|previous|earlier) conversations?\b/i,
    /\bKYT (?:picked it up|captured|found|retrieved|surfaced)\b/i,
    /\bthat was captured from\b/i,
    /\bfrom (?:a|your) (?:chatgpt|claude) conversation\b/i,
    /\b(?:your |the )?stored (?:data|conversations?|items?|records?|entries|knowledge)\b/i,
    /\b(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)\b/i,
];

/** Bare question detection */
const INTERROGATIVE_RE = /^(what|who|where|when|why|how|which|is|are|was|were|do|does|did|can|could|would|will|shall|should|have|has|had|tell me|remind me|do you know|do you remember|list|name|give|show|find|get|provide|suggest|recommend|describe|explain|identify|compare|summarize|rank|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;

/** Recursion guard markers */
const INJECTION_HEADERS = [
    "K.Y.T. MEMORY INJECTION PROTOCOL",
    "K.Y.T. — User's Personal Knowledge Base",
];
const INJECTION_ARTIFACTS = [
    "[RETRIEVAL_CONTEXT]",
    "[SESSION_CONTEXT]",
    "[DATA_PROVENANCE]",
    "[Retrieved Items]",
];
const NESTED_MARKERS = [
    "[Memory Context",
    "[Query Optimized",
];

// ============================================================================
// Penalty Functions
// ============================================================================

/**
 * Detect deflection in content and return confidence.
 * Ported from src/assistant-quality-detector.js:detectDeflection()
 */
function detectDeflection(content: string, role: string): { isDeflection: boolean; confidence: number; reason: string | null } {
    if (role !== 'assistant') {
        return { isDeflection: false, confidence: 0, reason: null };
    }
    if (!content || content.trim().length === 0) {
        return { isDeflection: false, confidence: 0, reason: null };
    }

    const length = content.length;
    const isShort = length < 200;
    const isLong = length > 400;
    const openingWindow = 150;

    const matches: Array<{ category: string; index: number }> = [];

    for (const pattern of DEFLECTION_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
            matches.push({ category: 'deflection', index: match.index });
        }
    }
    for (const pattern of ASST_ECHO_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
            matches.push({ category: 'echo', index: match.index });
        }
    }

    if (matches.length === 0) {
        return { isDeflection: false, confidence: 0, reason: null };
    }

    const allInOpening = isLong && matches.every(m => m.index < openingWindow);

    let confidence: number;
    let reason: string;

    if (allInOpening) {
        confidence = 0.30;
        reason = `opening-only hedge (${matches.length} pattern(s) in first ${openingWindow} chars of ${length}-char message)`;
    } else if (isShort) {
        confidence = 0.95;
        reason = `short deflection (${length} chars, ${matches.length} pattern(s): ${matches[0].category})`;
    } else if (matches.length >= 2) {
        confidence = 0.85;
        reason = `multiple patterns (${matches.length}: ${[...new Set(matches.map(m => m.category))].join('+')})`;
    } else {
        confidence = 0.65;
        reason = `single ${matches[0].category} pattern in ${length}-char message`;
    }

    return { isDeflection: true, confidence, reason };
}

/**
 * Extract assistant blocks from mixed-role content.
 * Some chat_turns contain "User: ... Assistant: ..." concatenated text.
 */
function extractAssistantBlocks(content: string): { text: string; isAssistant: boolean } {
    const asstBlocks: string[] = [];
    const re = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
        asstBlocks.push(m[1].trim());
    }
    if (asstBlocks.length > 0) {
        return { text: asstBlocks.join('\n'), isAssistant: true };
    }
    return { text: content, isAssistant: false };
}

/**
 * 1. Deflection penalty (0.145x–0.73x)
 * Penalizes assistant messages that deflect instead of answering.
 * High-confidence deflections (≥0.85) are hard-dropped.
 */
function applyDeflectionPenalty(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    for (const item of items) {
        let deflectionContent = item.content;
        let deflectionRole = item.role || (item.speakers?.[0]) || 'unknown';

        // Extract assistant blocks from mixed content
        if (deflectionRole !== 'assistant' && item.content) {
            const extracted = extractAssistantBlocks(item.content);
            if (extracted.isAssistant) {
                deflectionContent = extracted.text;
                deflectionRole = 'assistant';
            } else if (deflectionRole === 'unknown') {
                deflectionRole = 'assistant';
            }
        }

        const check = detectDeflection(deflectionContent, deflectionRole);
        if (check.isDeflection && check.confidence > 0) {
            const multiplier = 1 - (check.confidence * 0.9);
            const before = item.rerank_score;
            item.rerank_score *= multiplier;
            Logger.info(`Deflection penalty: ${check.reason} | score ${before.toFixed(3)} → ${item.rerank_score.toFixed(3)}`, { requestId });
            if (check.confidence >= 0.85) {
                (item as any)._deflectionDropped = true;
            }
        }
    }

    // Hard-drop high-confidence deflections
    return items.filter(item => !(item as any)._deflectionDropped);
}

/**
 * 2. Meta-conversation penalty (0.3x)
 * Penalizes KYT/extension operational chatter unless query is about KYT.
 */
function applyMetaConversationPenalty(items: ScoredCandidate[], query: string, requestId?: string): void {
    const queryIsAboutKYT = KYT_QUERY_PATTERNS.some(p => p.test(query));
    if (queryIsAboutKYT) {
        Logger.info("Meta-conversation penalty SKIPPED: query is about KYT/extension", { requestId });
        return;
    }

    for (const item of items) {
        const content = item.content || '';
        if (KYT_META_PATTERNS.some(p => p.test(content))) {
            const before = item.rerank_score;
            item.rerank_score *= 0.3;
            Logger.info(`Meta-conversation penalty: score ${before.toFixed(3)} → ${item.rerank_score.toFixed(3)}`, { requestId });
        }
    }
}

/**
 * 3. Diagnostic penalty (0.5x)
 * Penalizes retrieval-diagnostic conversations to prevent meta-echo.
 */
function applyDiagnosticPenalty(items: ScoredCandidate[], query: string, requestId?: string): void {
    const queryIsAboutRetrieval = RETRIEVAL_QUERY_PATTERNS.some(p => p.test(query));
    if (queryIsAboutRetrieval) {
        Logger.info("Diagnostic penalty SKIPPED: query is about retrieval analysis", { requestId });
        return;
    }

    for (const item of items) {
        const content = item.content || '';
        if (RETRIEVAL_DIAGNOSTIC_PATTERNS.some(p => p.test(content))) {
            const before = item.rerank_score;
            item.rerank_score *= 0.5;
            Logger.info(`Diagnostic penalty: score ${before.toFixed(3)} → ${item.rerank_score.toFixed(3)}`, { requestId });
        }
    }
}

/**
 * 4. Echo penalty (0.5x–0.9x)
 * Penalizes assistant messages that echo stored data back without substance.
 */
function applyStoredDataEchoPenalty(items: ScoredCandidate[], requestId?: string): void {
    for (const item of items) {
        const content = item.content || '';

        // Determine if this is an assistant message
        let echoContent = content;
        let echoIsAssistant = (item.role === 'assistant') || (item.speakers?.[0] === 'assistant');

        if (!echoIsAssistant) {
            const extracted = extractAssistantBlocks(content);
            if (extracted.isAssistant) {
                echoContent = extracted.text;
                echoIsAssistant = true;
            } else if (item.role === 'unknown' || !item.role) {
                echoIsAssistant = true;
            }
        }

        if (!echoIsAssistant) continue;

        if (STORED_DATA_ECHO_PATTERNS.some(p => p.test(echoContent))) {
            const echoLen = echoContent.length;
            const penalty = echoLen < 300 ? 0.50
                          : echoLen < 800 ? 0.70
                          : 0.90;
            const before = item.rerank_score;
            item.rerank_score *= penalty;
            Logger.info(`Echo penalty (${echoLen < 300 ? 'short' : echoLen < 800 ? 'medium' : 'long'}): score ${before.toFixed(3)} → ${item.rerank_score.toFixed(3)} (${echoLen} chars, ${penalty}x)`, { requestId });
        }
    }
}

/**
 * 5. Bare question filter (hard drop)
 * Drops short content that's just a question (no answer substance).
 */
function filterBareQuestions(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        const content = (item.content || '').trim();
        if (content.length < 120 && !/\bAssistant:/i.test(content)) {
            if (content.endsWith('?') || INTERROGATIVE_RE.test(content)) {
                Logger.info(`Bare question filter: dropped "${content.substring(0, 60)}..."`, { requestId });
                return false;
            }
        }
        return true;
    });
}

/**
 * 6. Recursion guard (hard drop)
 * Drops items containing KYT injection protocol headers/artifacts.
 */
function applyRecursionGuard(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        const content = item.content || '';
        const hasHeader = INJECTION_HEADERS.some(h => content.includes(h));
        const hasArtifact = INJECTION_ARTIFACTS.some(a => content.includes(a));
        const hasNested = NESTED_MARKERS.some(m => content.includes(m));
        const isPolluted = hasHeader || hasArtifact || hasNested;
        if (isPolluted) {
            Logger.warn(`Recursion guard: dropped polluted item (ID: ${item.id})`, { requestId });
        }
        return !isPolluted;
    });
}

/**
 * 7. Recency multiplier
 * Mild time-based boost (15% weight) with 30-day half-life.
 * Helps newer memories compete with semantically richer older ones.
 */
function applyRecencyMultiplier(items: ScoredCandidate[], requestId?: string): void {
    if (items.length <= 1) return;

    const HALF_LIFE_DAYS = 30;
    const now = Date.now();

    for (const item of items) {
        const ts = item.created_at || item.timestamp || item.msg_timestamp;
        if (!ts) continue;
        const itemTime = new Date(ts).getTime();
        if (isNaN(itemTime)) continue;
        const daysSince = Math.max(0, (now - itemTime) / 86400000);
        const recencyMultiplier = Math.exp(-daysSince / HALF_LIFE_DAYS);
        // Blend: 85% original score + 15% recency-adjusted score
        item.rerank_score = item.rerank_score * 0.85 + item.rerank_score * recencyMultiplier * 0.15;
    }

    Logger.info(`Recency multiplier applied to ${items.length} results (half-life: ${HALF_LIFE_DAYS}d)`, { requestId });
}

/**
 * 8. Meta flag filter (hard drop)
 * Drops items explicitly flagged as meta-conversation by the database.
 */
function filterMetaFlagged(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        if ((item as any).meta === true) {
            Logger.warn(`Meta flag filter: dropped meta item (ID: ${item.id})`, { requestId });
            return false;
        }
        return true;
    });
}

/**
 * 9. Claude Code artifact filter (hard drop)
 * Drops ingested Claude Code system/tooling messages that have zero
 * information value: XML protocol tags, short system responses, tool output.
 */
function filterClaudeCodeArtifacts(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        const content = (item.content || '').trim();
        if (CLAUDE_CODE_ARTIFACT_PATTERNS.some(p => p.test(content))) {
            Logger.info(`Claude Code artifact filter: dropped "${content.substring(0, 50)}..."`, { requestId });
            return false;
        }
        return true;
    });
}

/**
 * 10. Raw JSON metadata filter (hard drop)
 * Drops ChatGPT audio asset pointer JSON and similar API metadata
 * that was captured before client-side filtering existed.
 */
function filterRawJsonMetadata(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        const content = (item.content || '').trim();
        // Guard: only run regex on content containing '{' (raw JSON or prefixed with User:/Assistant:)
        if (!content.includes('{')) return true;
        if (RAW_JSON_METADATA_PATTERNS.some(p => p.test(content))) {
            Logger.info(`Raw JSON metadata filter: dropped "${content.substring(0, 60)}..."`, { requestId });
            return false;
        }
        return true;
    });
}

/**
 * 11. Substance scorer (drop/penalty)
 * Replaces the old blunt low-info filter. Uses DB-computed impact_score
 * and intimacy_level when available, falls back to regex heuristics.
 *
 * - Short (≤ 80 chars): high substance → keep; low substance or < 3 words → drop
 * - Medium (81-200 chars): low substance without high substance → 0.5x penalty
 * - Long (> 200 chars): always pass through
 */
function applySubstancePenalty(items: ScoredCandidate[], requestId?: string): ScoredCandidate[] {
    return items.filter(item => {
        const content = (item.content || '').trim();
        if (content.length === 0) {
            Logger.info(`Substance filter: dropped empty content`, { requestId });
            return false;
        }

        const len = content.length;

        // Long content always passes
        if (len > SUBSTANCE_MEDIUM_THRESHOLD) return true;

        const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
        const impactScore = (item as any).impact_score as number | undefined;
        const intimacyLevel = (item as any).intimacy_level as number | undefined;

        const hasHighSubstance = HIGH_SUBSTANCE_PATTERNS.some(p => p.test(content));
        const hasLowSubstance = LOW_SUBSTANCE_PATTERNS.some(p => p.test(content));

        // Layer 1: DB scores (when available)
        if (impactScore != null && intimacyLevel != null) {
            if (intimacyLevel >= 2 || impactScore >= 50) {
                // High personal significance — boost short content, always keep
                if (len <= SUBSTANCE_SHORT_THRESHOLD) {
                    item.rerank_score *= 1.2;
                    Logger.info(`Substance boost: "${content.substring(0, 40)}..." (impact=${impactScore}, intimacy=${intimacyLevel})`, { requestId });
                }
                return true;
            }
            if (intimacyLevel === 0 && impactScore < 10 && len <= SUBSTANCE_SHORT_THRESHOLD) {
                // Low personal significance + short — check regex override, else drop if too few words
                if (hasHighSubstance) return true;
                if (wordCount < 4) {
                    Logger.info(`Substance filter (DB): dropped "${content}" (impact=${impactScore}, intimacy=${intimacyLevel}, ${wordCount} words)`, { requestId });
                    return false;
                }
            }
        }

        // Layer 2: Regex heuristics (null DB scores or ambiguous)
        if (len <= SUBSTANCE_SHORT_THRESHOLD) {
            if (hasHighSubstance) return true;
            if (hasLowSubstance || wordCount < 3) {
                Logger.info(`Substance filter: dropped "${content}" (${wordCount} words, ${len} chars, lowSubstance=${hasLowSubstance})`, { requestId });
                return false;
            }
            return true;
        }

        // Medium range (81-200 chars)
        if (hasLowSubstance && !hasHighSubstance) {
            const before = item.rerank_score;
            item.rerank_score *= 0.5;
            Logger.info(`Substance penalty: "${content.substring(0, 50)}..." score ${before.toFixed(3)} → ${item.rerank_score.toFixed(3)}`, { requestId });
        }

        return true;
    });
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Apply all quality penalties to reranked results.
 *
 * Order matters:
 * 1. Recursion guard (hard drop polluted items first)
 * 2. Meta flag filter (hard drop DB-flagged meta items)
 * 3. Claude Code artifact filter (hard drop tooling noise)
 * 4. Raw JSON metadata filter (hard drop audio asset pointers)
 * 5. Substance scorer (drop/penalty — replaces old low-info filter)
 * 6. Deflection penalty + hard drop (0.145x–0.73x)
 * 7. Meta-conversation penalty (0.3x)
 * 8. Diagnostic penalty (0.5x)
 * 9. Echo penalty (0.5x–0.9x)
 * 10. Bare question filter (hard drop)
 * 11. Recency multiplier (mild time boost)
 *
 * @returns Filtered items with adjusted rerank_scores
 */
export function applyQualityPenalties(
    items: ScoredCandidate[],
    options: QualityPenaltyOptions,
): ScoredCandidate[] {
    if (items.length === 0) return items;

    const { query, requestId } = options;
    const startCount = items.length;

    // Hard drops first
    let result = applyRecursionGuard(items, requestId);
    result = filterMetaFlagged(result, requestId);
    result = filterClaudeCodeArtifacts(result, requestId);
    result = filterRawJsonMetadata(result, requestId);
    result = applySubstancePenalty(result, requestId);
    result = applyDeflectionPenalty(result, requestId);

    // Score penalties (mutate in place)
    applyMetaConversationPenalty(result, query, requestId);
    applyDiagnosticPenalty(result, query, requestId);
    applyStoredDataEchoPenalty(result, requestId);

    // More hard drops
    result = filterBareQuestions(result, requestId);

    // Recency boost (mutate in place)
    applyRecencyMultiplier(result, requestId);

    // Re-sort by adjusted scores
    result.sort((a, b) => b.rerank_score - a.rerank_score);

    if (result.length < startCount) {
        Logger.info(`Quality penalties: ${startCount} → ${result.length} items (${startCount - result.length} dropped)`, { requestId });
    }

    return result;
}

// ============================================================================
// Exports for Testing
// ============================================================================

export const __testing__ = {
    detectDeflection,
    extractAssistantBlocks,
    applyDeflectionPenalty,
    applyMetaConversationPenalty,
    applyDiagnosticPenalty,
    applyStoredDataEchoPenalty,
    filterBareQuestions,
    applyRecursionGuard,
    applyRecencyMultiplier,
    filterMetaFlagged,
    filterClaudeCodeArtifacts,
    filterRawJsonMetadata,
    applySubstancePenalty,
    CLAUDE_CODE_ARTIFACT_PATTERNS,
    RAW_JSON_METADATA_PATTERNS,
    HIGH_SUBSTANCE_PATTERNS,
    LOW_SUBSTANCE_PATTERNS,
    KYT_META_PATTERNS,
    KYT_QUERY_PATTERNS,
    RETRIEVAL_DIAGNOSTIC_PATTERNS,
    RETRIEVAL_QUERY_PATTERNS,
    DEFLECTION_PATTERNS,
    ASST_ECHO_PATTERNS,
    STORED_DATA_ECHO_PATTERNS,
};

import { describe, it, expect } from 'vitest';

// ============================================================================
// Claude Code artifact patterns (extracted from quality-penalties.ts)
// ============================================================================
const CLAUDE_CODE_ARTIFACT_PATTERNS = [
    /^<(?:local-command-caveat|command-name|command-message|command-args|system-reminder|task-notification|antml:)/,
    /^Prompt is too long$/,
    /^Let me (?:search|try|check|look) (?:your|a|for|if|what)/i,
    /^(?:Let me|I'll) (?:read|load|find|run|open|search) /i,
    /^(?:Found|No|Searching|Looking|Checking|Loading)\b.{0,30}$/,
    /^Tool (?:loaded|result|called)/i,
];

function isClaudeCodeArtifact(content) {
    const trimmed = content.trim();
    return CLAUDE_CODE_ARTIFACT_PATTERNS.some(p => p.test(trimmed));
}

// ============================================================================
// Low-information-density filter (extracted from quality-penalties.ts)
// ============================================================================
const LOW_INFO_MAX_CHARS = 40;
const LOW_INFO_MIN_WORDS = 4;

function isLowInformationDensity(content) {
    const trimmed = content.trim();
    if (trimmed.length <= LOW_INFO_MAX_CHARS) {
        const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
        return wordCount < LOW_INFO_MIN_WORDS;
    }
    return false;
}

// ============================================================================
// Tests
// ============================================================================

describe('Claude Code artifact filter', () => {
    it('drops XML protocol tags', () => {
        expect(isClaudeCodeArtifact('<local-command-caveat>Caveat: The messages below...</local-command-caveat>')).toBe(true);
        expect(isClaudeCodeArtifact('<command-name>/clear</command-name>')).toBe(true);
        expect(isClaudeCodeArtifact('<system-reminder>Some reminder text</system-reminder>')).toBe(true);
        expect(isClaudeCodeArtifact('<task-notification><task-id>abc</task-id></task-notification>')).toBe(true);
    });

    it('drops "Prompt is too long"', () => {
        expect(isClaudeCodeArtifact('Prompt is too long')).toBe(true);
    });

    it('drops short system responses', () => {
        expect(isClaudeCodeArtifact('Let me search your conversation history for that.')).toBe(true);
        expect(isClaudeCodeArtifact('Let me try a broader search with different phrasing.')).toBe(true);
        expect(isClaudeCodeArtifact('Let me check what\'s already been done.')).toBe(true);
        expect(isClaudeCodeArtifact("I'll read the file first.")).toBe(true);
        expect(isClaudeCodeArtifact("I'll search for that pattern.")).toBe(true);
        expect(isClaudeCodeArtifact('Tool loaded.')).toBe(true);
        expect(isClaudeCodeArtifact('Found 3 results.')).toBe(true);
        expect(isClaudeCodeArtifact('No matches found')).toBe(true);
        expect(isClaudeCodeArtifact('Loading the tool')).toBe(true);
    });

    it('keeps substantive assistant responses', () => {
        expect(isClaudeCodeArtifact('Python is a great language for web development because of Django and Flask frameworks.')).toBe(false);
        expect(isClaudeCodeArtifact('The service worker lifecycle in MV3 has three main phases: install, activate, and fetch.')).toBe(false);
        expect(isClaudeCodeArtifact('I prefer React over Angular because of its component model and ecosystem.')).toBe(false);
    });

    it('keeps user messages that start with "Let me"', () => {
        // "Let me tell you about my experience with Python" is substantive
        expect(isClaudeCodeArtifact('Let me tell you about my experience with Python and how it changed my workflow.')).toBe(false);
    });

    it('keeps content that starts with non-artifact XML', () => {
        expect(isClaudeCodeArtifact('<div>Some HTML content</div>')).toBe(false);
        expect(isClaudeCodeArtifact('<p>A paragraph of text</p>')).toBe(false);
    });
});

describe('Low-information-density filter', () => {
    it('drops ultra-short filler', () => {
        expect(isLowInformationDensity('Mhm.')).toBe(true);
        expect(isLowInformationDensity('Dev plan.')).toBe(true);
        expect(isLowInformationDensity('Clear option')).toBe(true);
        expect(isLowInformationDensity('Sounds good.')).toBe(true);
        expect(isLowInformationDensity('yes')).toBe(true);
        expect(isLowInformationDensity('OK')).toBe(true);
    });

    it('keeps short but meaningful content (4+ words)', () => {
        expect(isLowInformationDensity('I prefer Python over JavaScript')).toBe(false);
        expect(isLowInformationDensity('The API key expired')).toBe(false);
        expect(isLowInformationDensity('Use Django for this')).toBe(false);
    });

    it('keeps anything over 40 chars regardless of word count', () => {
        expect(isLowInformationDensity('This is a much longer message that contains real information about a topic.')).toBe(false);
    });

    it('handles empty and whitespace content', () => {
        expect(isLowInformationDensity('')).toBe(true);
        expect(isLowInformationDensity('   ')).toBe(true);
    });
});

describe('Combined filter behavior on real test failures', () => {
    const testCases = [
        { content: 'Let me search your conversation history for that.', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: 'Prompt is too long', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: '<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: 'Dev plan.', shouldDrop: true, reason: 'Low-info' },
        { content: 'Thoughts. If you have any share them.', shouldDrop: false, reason: 'Short but 7 words' },
        { content: 'This is the result in both ChatGPT and Claude.', shouldDrop: false, reason: 'Substantive cross-platform note' },
    ];

    for (const tc of testCases) {
        it(`${tc.shouldDrop ? 'drops' : 'keeps'}: "${tc.content.substring(0, 50)}..." (${tc.reason})`, () => {
            const dropped = isClaudeCodeArtifact(tc.content) || isLowInformationDensity(tc.content);
            expect(dropped).toBe(tc.shouldDrop);
        });
    }
});

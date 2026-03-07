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
// Raw JSON metadata filter (extracted from quality-penalties.ts)
// ============================================================================
const RAW_JSON_METADATA_PATTERNS = [
    /\"content_type\"\s*:\s*\"[^"]*asset_pointer/,
    /\"expiry_datetime\"\s*:/,
    /\"frames_asset_pointers\"\s*:/,
];

function isRawJsonMetadata(content) {
    const trimmed = content.trim();
    if (!trimmed.includes('{')) return false;
    return RAW_JSON_METADATA_PATTERNS.some(p => p.test(trimmed));
}

// ============================================================================
// Substance scorer (extracted from quality-penalties.ts)
// ============================================================================
const SUBSTANCE_SHORT_THRESHOLD = 80;
const SUBSTANCE_MEDIUM_THRESHOLD = 200;

const HIGH_SUBSTANCE_PATTERNS = [
    /\bI\s+(?:love|hate|prefer|miss|need|want|wish|adore|despise)\b/i,
    /\bI\s+(?:decided|chose|picked|committed|resolved|quit|started|stopped)\b/i,
    /\bI'?m\s+(?:scared|grateful|thankful|afraid|proud|ashamed|excited|worried|anxious|happy|sad)\b/i,
    /\bmy\s+(?:wife|husband|partner|dad|mom|father|mother|son|daughter|brother|sister|friend|dog|cat|family)\b/i,
    /\b(?:favorite|favourite|best|worst)\b/i,
    /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/,
    /\b(?:always|never)\s+\w+/i,
    /\b(?:diagnosed|prescription|medication|therapy|treatment)\b/i,
];

const LOW_SUBSTANCE_PATTERNS = [
    /^(?:thoughts|sounds?\s+good|agreed|exactly|right|correct|yeah|yep|nope|sure|ok(?:ay)?|got\s+it|makes?\s+sense|fair\s+enough|understood|noted|interesting|cool|nice|great|perfect|alright|fine|absolutely|definitely|certainly|indeed|precisely)\b[.!?]*$/i,
    /\b(?:let\s+me|running|deploying|checking|loading|processing|building|compiling|installing)\b/i,
    /\bthoughts\b.*\bshare\s+them\b/i,
    /^(?:mhm|hmm|hm|uh-?huh|mm-?hmm)[.!?]*$/i,
    /^[A-Z][a-z]+\s+(?:plan|option|choice|step|note|idea|thought)[.!?]*$/i,
];

/**
 * Mirrors the substance scorer logic from quality-penalties.ts.
 * Returns { drop, penalty } where drop=true means hard-dropped,
 * penalty is a multiplier (< 1.0 means penalized).
 */
function evaluateSubstance(content, { impactScore, intimacyLevel } = {}) {
    const trimmed = content.trim();
    if (trimmed.length === 0) return { drop: true, penalty: 0 };

    const len = trimmed.length;
    if (len > SUBSTANCE_MEDIUM_THRESHOLD) return { drop: false, penalty: 1.0 };

    const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
    const hasHigh = HIGH_SUBSTANCE_PATTERNS.some(p => p.test(trimmed));
    const hasLow = LOW_SUBSTANCE_PATTERNS.some(p => p.test(trimmed));

    // Layer 1: DB scores
    if (impactScore != null && intimacyLevel != null) {
        if (intimacyLevel >= 2 || impactScore >= 50) {
            return { drop: false, penalty: 1.2 };
        }
        if (intimacyLevel === 0 && impactScore < 10 && len <= SUBSTANCE_SHORT_THRESHOLD) {
            if (hasHigh) return { drop: false, penalty: 1.0 };
            if (wordCount < 4) return { drop: true, penalty: 0 };
        }
    }

    // Layer 2: Regex heuristics
    if (len <= SUBSTANCE_SHORT_THRESHOLD) {
        if (hasHigh) return { drop: false, penalty: 1.0 };
        if (hasLow || wordCount < 3) return { drop: true, penalty: 0 };
        return { drop: false, penalty: 1.0 };
    }

    // Medium range
    if (hasLow && !hasHigh) return { drop: false, penalty: 0.5 };
    return { drop: false, penalty: 1.0 };
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
        expect(isClaudeCodeArtifact('Let me tell you about my experience with Python and how it changed my workflow.')).toBe(false);
    });

    it('keeps content that starts with non-artifact XML', () => {
        expect(isClaudeCodeArtifact('<div>Some HTML content</div>')).toBe(false);
        expect(isClaudeCodeArtifact('<p>A paragraph of text</p>')).toBe(false);
    });
});

describe('Raw JSON metadata filter', () => {
    it('drops ChatGPT audio asset pointer JSON', () => {
        const audioJson = '{"expiry_datetime":"2026-03-01T00:00:00Z","content_type":"real_time_user_audio_video_asset_pointer","asset_pointer":"file-abc123"}';
        expect(isRawJsonMetadata(audioJson)).toBe(true);
    });

    it('drops audio_asset_pointer without expiry', () => {
        const noExpiry = '{"content_type":"audio_asset_pointer","asset_pointer":"file-xyz"}';
        expect(isRawJsonMetadata(noExpiry)).toBe(true);
    });

    it('drops frames_asset_pointers metadata', () => {
        const frames = '{"frames_asset_pointers":["file-a","file-b"],"content_type":"video"}';
        expect(isRawJsonMetadata(frames)).toBe(true);
    });

    it('drops User:-prefixed audio asset pointer JSON', () => {
        const prefixed = 'User: {"content_type":"audio_transcription","text":"hello"}\n{"expiry_datetime":"2026-09-03","content_type":"real_time_user_audio_video_asset_pointer","asset_pointer":"file-abc"}';
        expect(isRawJsonMetadata(prefixed)).toBe(true);
    });

    it('keeps normal text mentioning "content_type"', () => {
        expect(isRawJsonMetadata('The content_type field should be set to application/json')).toBe(false);
    });

    it('keeps normal conversation text', () => {
        expect(isRawJsonMetadata('I was thinking about the asset pointer architecture today.')).toBe(false);
    });

    it('keeps JSON that is not metadata', () => {
        expect(isRawJsonMetadata('{"name":"John","age":30}')).toBe(false);
    });
});

describe('Substance scorer', () => {
    describe('high-substance short content (kept)', () => {
        it('keeps "I love Molly" (first-person emotion)', () => {
            const { drop } = evaluateSubstance('I love Molly');
            expect(drop).toBe(false);
        });

        it('keeps "I miss my dad" (vulnerability + relationship)', () => {
            const { drop } = evaluateSubstance('I miss my dad');
            expect(drop).toBe(false);
        });

        it('keeps "My favorite is Django" (preference)', () => {
            const { drop } = evaluateSubstance('My favorite is Django');
            expect(drop).toBe(false);
        });

        it('keeps "I decided to quit" (decision language)', () => {
            const { drop } = evaluateSubstance('I decided to quit');
            expect(drop).toBe(false);
        });

        it('keeps "I\'m scared of flying" (vulnerability)', () => {
            const { drop } = evaluateSubstance("I'm scared of flying");
            expect(drop).toBe(false);
        });

        it('keeps "my wife loves sushi" (relationship + preference)', () => {
            const { drop } = evaluateSubstance('my wife loves sushi');
            expect(drop).toBe(false);
        });
    });

    describe('low-substance short content (dropped)', () => {
        it('drops "Dev plan." (procedural filler)', () => {
            const { drop } = evaluateSubstance('Dev plan.');
            expect(drop).toBe(true);
        });

        it('drops "Mhm." (bare acknowledgment)', () => {
            const { drop } = evaluateSubstance('Mhm.');
            expect(drop).toBe(true);
        });

        it('drops "OK" (bare acknowledgment)', () => {
            const { drop } = evaluateSubstance('OK');
            expect(drop).toBe(true);
        });

        it('drops "yes" (bare acknowledgment)', () => {
            const { drop } = evaluateSubstance('yes');
            expect(drop).toBe(true);
        });

        it('drops "Sounds good." (acknowledgment)', () => {
            const { drop } = evaluateSubstance('Sounds good.');
            expect(drop).toBe(true);
        });

        it('drops "Thoughts. If you have any share them." (meta filler)', () => {
            const { drop } = evaluateSubstance('Thoughts. If you have any share them.');
            expect(drop).toBe(true);
        });
    });

    describe('medium-length content', () => {
        it('penalizes medium-length low-substance content', () => {
            // 81-200 chars, matches low-substance but not high-substance
            const medium = 'Let me check on that and get back to you with the results. I will be running the tests shortly and deploying soon.';
            const { drop, penalty } = evaluateSubstance(medium);
            expect(drop).toBe(false);
            expect(penalty).toBe(0.5);
        });

        it('keeps medium-length high-substance content at full score', () => {
            const medium = 'I love how Python handles list comprehensions. My favorite feature is the walrus operator introduced in 3.8.';
            const { drop, penalty } = evaluateSubstance(medium);
            expect(drop).toBe(false);
            expect(penalty).toBe(1.0);
        });
    });

    describe('long content', () => {
        it('keeps anything over 200 chars regardless of substance', () => {
            const long = 'Sounds good. '.repeat(20); // low substance but long
            const { drop, penalty } = evaluateSubstance(long);
            expect(drop).toBe(false);
            expect(penalty).toBe(1.0);
        });
    });

    describe('DB score integration', () => {
        it('boosts high-intimacy short content', () => {
            const { drop, penalty } = evaluateSubstance('Hey', { intimacyLevel: 2, impactScore: 5 });
            expect(drop).toBe(false);
            expect(penalty).toBe(1.2);
        });

        it('boosts high-impact short content', () => {
            const { drop, penalty } = evaluateSubstance('Lost job', { intimacyLevel: 1, impactScore: 60 });
            expect(drop).toBe(false);
            expect(penalty).toBe(1.2);
        });

        it('drops low-impact low-intimacy short filler', () => {
            const { drop } = evaluateSubstance('OK', { intimacyLevel: 0, impactScore: 2 });
            expect(drop).toBe(true);
        });

        it('keeps low-impact short content with high-substance regex match', () => {
            const { drop } = evaluateSubstance('I love it', { intimacyLevel: 0, impactScore: 5 });
            expect(drop).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('drops empty content', () => {
            expect(evaluateSubstance('').drop).toBe(true);
        });

        it('drops whitespace-only content', () => {
            expect(evaluateSubstance('   ').drop).toBe(true);
        });
    });
});

describe('Combined filter behavior on real test failures', () => {
    const testCases = [
        { content: 'Let me search your conversation history for that.', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: 'Prompt is too long', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: '<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>', shouldDrop: true, reason: 'Claude Code artifact' },
        { content: 'Dev plan.', shouldDrop: true, reason: 'Low substance filler' },
        { content: 'Thoughts. If you have any share them.', shouldDrop: true, reason: 'Meta filler (low substance)' },
        { content: 'I love Molly', shouldDrop: false, reason: 'High substance (first-person emotion)' },
        { content: 'This is the result in both ChatGPT and Claude.', shouldDrop: false, reason: 'Substantive cross-platform note' },
        { content: '{"expiry_datetime":"2026-03-01","content_type":"real_time_user_audio_video_asset_pointer","asset_pointer":"file-abc"}', shouldDrop: true, reason: 'Raw JSON audio metadata' },
    ];

    for (const tc of testCases) {
        it(`${tc.shouldDrop ? 'drops' : 'keeps'}: "${tc.content.substring(0, 50)}..." (${tc.reason})`, () => {
            const dropped = isClaudeCodeArtifact(tc.content)
                || isRawJsonMetadata(tc.content)
                || evaluateSubstance(tc.content).drop;
            expect(dropped).toBe(tc.shouldDrop);
        });
    }
});

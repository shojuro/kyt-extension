/**
 * Memory cards (supabase/functions/_shared/memory-cards.ts).
 *
 * Regression for 2026-11-14: "What is K.Y.T.?" found nothing usable. The
 * definition sits inside turns of 4,000 to 27,000 characters, the entity table
 * holds 20+ records for the name with no description, and voice dictation
 * spells project names several ways.
 */
import { describe, it, expect } from 'vitest';
import {
    squash,
    editDistance,
    isSpellingVariant,
    planCards,
    evidencePattern,
    cleanSnippet,
    evidenceFingerprint,
    buildCardUserPrompt,
    parseCardReply,
    queryAliasKeys,
    pickCards,
    queryAsksAbout,
    cardContent,
    cardToResult,
    isCardStale,
    CARD_SOURCE,
} from '../../supabase/functions/_shared/memory-cards.ts';

/** Convert a PostgreSQL word-boundary pattern to a JS one for testing. */
const toJs = (p) => new RegExp(p.replace(/\\m|\\M/g, '\\b'), 'i');

describe('squash and spelling variants', () => {
    it('squashes names to letters and digits', () => {
        expect(squash('K.Y.T.')).toBe('kyt');
        expect(squash('Claude Code')).toBe('claudecode');
        expect(squash(null)).toBe('');
    });

    it('measures edit distance with a cut-off', () => {
        expect(editDistance('cleophis', 'cleopas')).toBe(2);
        expect(editDistance('cleophis', 'cleopatra')).toBe(3);
    });

    it('treats voice-dictation spellings as one name', () => {
        for (const v of ['cleopas', 'cleofis', 'cleopis']) expect(isSpellingVariant('cleophis', v)).toBe(true);
    });

    it('keeps different names apart', () => {
        expect(isSpellingVariant('cleophis', 'cleopatra')).toBe(false);
        expect(isSpellingVariant('claude', 'clause')).toBe(false);
        expect(isSpellingVariant('kyt', 'kit')).toBe(false);
        expect(isSpellingVariant('gemini', 'germany')).toBe(false);
    });
});

describe('planCards', () => {
    const groups = [
        { k: 'kyt', n: 1696, name: 'K.Y.T.', type: 'MISC' },
        { k: 'gemini', n: 772, name: 'Gemini', type: 'TECH' },
        { k: 'webdevelopment', n: 330, name: 'web development', type: 'TOPIC' },
        { k: 'cleophis', n: 12, name: 'Cleophis', type: 'PROJECT' },
        { k: 'cleopas', n: 1, name: 'Cleopas', type: 'PROJECT' },
        { k: 'cleopatra', n: 8, name: 'Cleopatra', type: 'PERSON' },
        { k: 'homepenguinproject', n: 40, name: '/home/penguin/project', type: 'MISC' },
        { k: 'rare', n: 2, name: 'Rare', type: 'TECH' },
    ];

    it('picks the most mentioned named things and skips topics, paths and rare names', () => {
        const keys = planCards(groups).map((p) => p.key);
        expect(keys).toEqual(['kyt', 'gemini', 'cleophis']);
    });

    it('folds a rarer spelling into the main one', () => {
        const cleo = planCards(groups).find((p) => p.key === 'cleophis');
        expect(cleo.aliases).toEqual(['cleophis', 'cleopas']);
        expect(cleo.aliasNames).toEqual(['Cleophis', 'Cleopas']);
        expect(cleo.mentionCount).toBe(13);
    });

    it('puts pinned names first with their aliases and note', () => {
        const plans = planCards(groups, [
            { name: 'Cleophis', aliases: ['Cleopas', 'CleoFis', 'Cleopis'], note: 'On-device tutors.' },
            { name: 'K.Y.T.', aliases: ['KYT', 'Kit'] },
        ]);
        expect(plans[0]).toMatchObject({ key: 'cleophis', pinned: true, note: 'On-device tutors.' });
        expect(plans[0].aliases).toEqual(['cleophis', 'cleopas', 'cleofis', 'cleopis']);
        expect(plans[1].aliases).toEqual(['kyt', 'kit']);
        expect(plans.filter((p) => p.key === 'kyt')).toHaveLength(1);
        expect(plans.filter((p) => p.key === 'cleophis')).toHaveLength(1);
    });

    it('respects the automatic limit', () => {
        expect(planCards(groups, [], { maxAuto: 1 }).map((p) => p.key)).toEqual(['kyt']);
    });
});

describe('evidencePattern', () => {
    it('matches an acronym with or without dots', () => {
        const re = toJs(evidencePattern({ key: 'kyt', aliasNames: ['K.Y.T.', 'KYT', 'Kit'] }));
        expect(re.test('I am working on K.Y.T. right now')).toBe(true);
        expect(re.test('the KYT extension')).toBe(true);
        expect(re.test('sky tower')).toBe(false);
    });

    it('leaves out short everyday aliases', () => {
        const re = toJs(evidencePattern({ key: 'kyt', aliasNames: ['K.Y.T.', 'Kit'] }));
        expect(re.test('a first aid kit')).toBe(false);
    });

    it('matches every spelling of a longer name as a whole word', () => {
        const re = toJs(evidencePattern({ key: 'cleophis', aliasNames: ['Cleophis', 'Cleopas', 'CleoFis'] }));
        expect(re.test('marrying Cleopas and K.Y.T.')).toBe(true);
        expect(re.test('enter cleofis now')).toBe(true);
        expect(re.test('Cleopatra')).toBe(false);
    });

    it('escapes regex characters and joins multi-word names', () => {
        const p = evidencePattern({ key: 'c', aliasNames: ['C++ (new)'] });
        expect(p).toContain('C\\+\\+');
        expect(toJs(evidencePattern({ key: 'claudecode', aliasNames: ['Claude Code'] })).test('in Claude  Code today')).toBe(true);
    });

    it('returns null when no usable spelling is left', () => {
        expect(evidencePattern({ key: 'x', aliasNames: ['.'] })).toBeNull();
    });
});

describe('cleanSnippet', () => {
    it('removes context that K.Y.T. itself injected into a stored prompt', () => {
        const stored = "(For context: I've talked about things like this before. - \"wrong guess...\" I'm sharing these so you have the full picture of where I'm coming from.) K.Y.T. is my memory layer.";
        expect(cleanSnippet(stored)).toBe('K.Y.T. is my memory layer.');
    });

    it('removes the nothing-found note and collapses whitespace', () => {
        const stored = '(K.Y.T. memory check: I searched and found nothing relevant. tell me you don\'t have it on record instead of guessing.)\n\nWhat   is\nthis?';
        expect(cleanSnippet(stored)).toBe('What is this?');
    });

    it('caps the length', () => {
        expect(cleanSnippet('a'.repeat(5000))).toHaveLength(1200);
    });
});

describe('prompt and reply', () => {
    const plan = { name: 'K.Y.T.', aliasNames: ['K.Y.T.', 'KYT'], note: 'K.Y.T. stands for Keep Your Thoughts.' };

    it('lists excerpts oldest first with dates, and the note as authoritative', () => {
        const prompt = buildCardUserPrompt(plan, [
            { id: 'b', created_at: '2026-03-01T10:00:00', snippet: 'newer' },
            { id: 'a', created_at: '2025-12-01T10:00:00', snippet: 'older' },
        ]);
        expect(prompt.indexOf('[2025-12-01] older')).toBeLessThan(prompt.indexOf('[2026-03-01] newer'));
        expect(prompt).toContain('User note (authoritative): K.Y.T. stands for Keep Your Thoughts.');
        expect(prompt).toContain('Spellings: K.Y.T., KYT');
    });

    it('accepts a well-formed reply', () => {
        const card = parseCardReply({
            status: 'ready', kind: 'project',
            description: 'K.Y.T. (Keep Your Thoughts) is my cross-platform memory layer.',
            key_facts: ['It carries memory between Claude, ChatGPT and Gemini.', 7, ''],
        });
        expect(card).toEqual({
            status: 'ready', kind: 'project',
            description: 'K.Y.T. (Keep Your Thoughts) is my cross-platform memory layer.',
            keyFacts: ['It carries memory between Claude, ChatGPT and Gemini.'],
        });
    });

    it('treats an insufficient, empty or malformed reply as insufficient', () => {
        expect(parseCardReply({ status: 'insufficient' }).status).toBe('insufficient');
        expect(parseCardReply({ status: 'ready', description: 'too short' }).status).toBe('insufficient');
        expect(parseCardReply(null).status).toBe('insufficient');
        expect(parseCardReply('text').status).toBe('insufficient');
    });

    it('fingerprints evidence independent of order, and changes with the note', () => {
        const a = evidenceFingerprint([{ id: '1' }, { id: '2' }], null);
        expect(evidenceFingerprint([{ id: '2' }, { id: '1' }], null)).toBe(a);
        expect(evidenceFingerprint([{ id: '1' }, { id: '2' }], 'note')).not.toBe(a);
        expect(evidenceFingerprint([{ id: '1' }], null)).not.toBe(a);
    });
});

describe('search-time lookup', () => {
    it('finds names in a question, however they are punctuated', () => {
        expect(queryAliasKeys('What is K.Y.T.?')).toContain('kyt');
        expect(queryAliasKeys('what is cleophis?')).toContain('cleophis');
        expect(queryAliasKeys("What's Cleopas's purpose?")).toContain('cleopas');
        expect(queryAliasKeys('how does claude code handle it')).toContain('claudecode');
    });

    it('counts a short name only when written as a name', () => {
        expect(queryAliasKeys('where is my first aid kit')).not.toContain('kit');
        expect(queryAliasKeys('How is Kit coming along?')).toContain('kit');
        expect(queryAliasKeys('what is KYT')).toContain('kyt');
    });

    const rows = [
        { id: '1', card_key: 'kyt', name: 'K.Y.T.', aliases: ['kyt', 'kit'], description: 'My memory layer.', key_facts: ['It spans three assistants.'], user_note: 'K.Y.T. stands for Keep Your Thoughts.', mention_count: 1696, latest_evidence_at: '2026-11-13T16:35:00Z', built_at: '2026-11-14T05:00:00Z' },
        { id: '2', card_key: 'cleophis', name: 'Cleophis', aliases: ['cleophis', 'cleopas'], description: 'On-device tutors.', key_facts: [], user_note: null, mention_count: 13, latest_evidence_at: null, built_at: '2026-11-14T05:00:00Z' },
        { id: '3', card_key: 'gemini', name: 'Gemini', aliases: ['gemini'], description: 'An assistant I use.', key_facts: [], user_note: null, mention_count: 772, latest_evidence_at: null, built_at: null },
        { id: '4', card_key: 'empty', name: 'Empty', aliases: ['empty'], description: null, key_facts: [], user_note: null, mention_count: 5, latest_evidence_at: null, built_at: null },
    ];

    it('picks the cards named in the query, at most two', () => {
        expect(pickCards(rows, queryAliasKeys('What is K.Y.T.?')).map((r) => r.id)).toEqual(['1']);
        expect(pickCards(rows, queryAliasKeys('marry Cleopas with KYT and Gemini')).map((r) => r.id)).toEqual(['2', '3']);
        expect(pickCards(rows, queryAliasKeys('what is the weather'))).toEqual([]);
        expect(pickCards(rows, ['empty'])).toEqual([]);
    });

    it('gives automatic cards only to questions about the thing or my own past; pinned cards always', () => {
        expect(queryAsksAbout('What is K.Y.T.?')).toBe(true);
        expect(queryAsksAbout('tell me about Gemini')).toBe(true);
        expect(queryAsksAbout('why do we use Supabase?')).toBe(true);
        expect(queryAsksAbout('write a Gemini prompt for a poem')).toBe(false);
        const pinnedRows = rows.map((r) => ({ ...r, pinned: r.id === '1' }));
        const keys = queryAliasKeys('write a Gemini prompt mentioning KYT');
        expect(pickCards(pinnedRows, keys, 2, false).map((r) => r.id)).toEqual(['1']);
        expect(pickCards(pinnedRows, keys, 2, true).map((r) => r.id)).toEqual(['3', '1']);
    });

    it('formats a card with the user note first', () => {
        expect(cardContent(rows[0])).toBe('K.Y.T.: K.Y.T. stands for Keep Your Thoughts. My memory layer. It spans three assistants.');
        expect(cardContent({ ...rows[0], description: 'x'.repeat(2000) }).length).toBe(700);
    });

    it('does not repeat itself and never stops mid-sentence', () => {
        const text = cardContent({
            name: 'K.Y.T.',
            user_note: 'K.Y.T. stands for Keep Your Thoughts.',
            description: 'K.Y.T. (Keep Your Thoughts) is a personal memory extension I built.',
            key_facts: [
                'K.Y.T. stands for Keep Your Thoughts, and I built it as a memory extension.',
                'It runs as a Chrome extension backed by Supabase.',
                ...Array.from({ length: 12 }, (_, i) => `Separate point number${i} concerns topic${i} alone here.`),
            ],
        });
        expect(text.match(/Keep Your Thoughts/g)).toHaveLength(1);
        expect(text).toContain('Chrome extension backed by Supabase.');
        expect(text.length).toBeLessThanOrEqual(700);
        expect(text.endsWith('.')).toBe(true);
    });

    it('returns a card as a top-scored search result', () => {
        const r = cardToResult(rows[0]);
        expect(r).toMatchObject({ id: '1', source: CARD_SOURCE, memory_card: true, speakers: ['user'], created_at: '2026-11-13T16:35:00Z' });
        expect(r.cross_encoder_score).toBeGreaterThan(0.9);
    });
});

describe('isCardStale', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    const plan = { mentionCount: 100, note: null, aliases: ['kyt'] };
    const fresh = { card_key: 'kyt', status: 'ready', mention_count: 100, built_at: '2026-11-10T00:00:00Z', user_note: null, aliases: ['kyt'] };

    it('builds a missing card and leaves a fresh one alone', () => {
        expect(isCardStale(undefined, plan, now)).toBe(true);
        expect(isCardStale(fresh, plan, now)).toBe(false);
        expect(isCardStale({ ...fresh, status: 'insufficient' }, plan, now)).toBe(false);
    });

    it('rebuilds on force, a new note, a new spelling, many new mentions or old age', () => {
        expect(isCardStale(fresh, plan, now, true)).toBe(true);
        expect(isCardStale(fresh, { ...plan, note: 'new' }, now)).toBe(true);
        expect(isCardStale(fresh, { ...plan, aliases: ['kyt', 'kit'] }, now)).toBe(true);
        expect(isCardStale(fresh, { ...plan, mentionCount: 130 }, now)).toBe(true);
        expect(isCardStale(fresh, { ...plan, mentionCount: 104 }, now)).toBe(false);
        expect(isCardStale({ ...fresh, built_at: '2026-09-01T00:00:00Z' }, plan, now)).toBe(true);
        expect(isCardStale({ ...fresh, status: 'pending', built_at: null }, plan, now)).toBe(true);
    });
});

/**
 * Sections of long turns (supabase/functions/_shared/turn-sections.ts).
 *
 * Regression for 2026-11-14: a 28,565-character reply with 28 headings was
 * stored as one block with one embedding. Asked to "take the list of problems
 * you gave me and rank it", the assistant could not get the list back.
 */
import { describe, it, expect } from 'vitest';
import {
    splitIntoSections,
    sectionEmbedText,
    contentFingerprint,
    selectSections,
    turnsWantingOutline,
    sectionToResult,
    mergeSectionResults,
    MIN_TURN_CHARS,
    MAX_SECTION_CHARS,
    MAX_SECTIONS_PER_TURN,
} from '../../supabase/functions/_shared/turn-sections.ts';

const para = (label, chars = 500) => `${label} ` + 'memory layer and tutoring model work together. '.repeat(Math.ceil(chars / 47)).slice(0, chars);

const longReply = [
    'The two projects are **Cleophis and K.Y.T.** ' + para('Intro', 600),
    '# 1. Understanding the two projects',
    '## Cleophis — the intelligence layer',
    para('Cleophis is the tutor.', 900),
    '## K.Y.T. — the memory layer',
    para('K.Y.T. keeps context.', 900),
    '# 6. The blind spots I think you are missing',
    '## Blind spot 1: Confusing memory with intelligence',
    para('Remembering a struggle is not understanding it.', 1700),
    para('Second paragraph of blind spot one.', 1200),
    '## Blind spot 2: Student privacy',
    para('Children need more than encryption.', 800),
    '```js\nconst a = 1;\n\nconst b = 2;\n```',
].join('\n\n');

describe('splitIntoSections', () => {
    it('leaves short turns alone', () => {
        expect(splitIntoSections('short')).toEqual([]);
        expect(splitIntoSections('x'.repeat(MIN_TURN_CHARS - 1))).toEqual([]);
        expect(splitIntoSections(null)).toEqual([]);
    });

    it('splits at headings and carries the heading path', () => {
        const sections = splitIntoSections(longReply).filter((s) => s.kind === 'section');
        const headings = sections.map((s) => s.heading);
        expect(headings).toContain('1. Understanding the two projects > Cleophis — the intelligence layer');
        expect(headings).toContain('6. The blind spots I think you are missing > Blind spot 2: Student privacy');
        expect(sections.map((s) => s.index)).toEqual(sections.map((_, i) => i));
    });

    it('splits one long heading section into several parts under the same heading', () => {
        const parts = splitIntoSections(longReply)
            .filter((s) => s.heading.endsWith('Blind spot 1: Confusing memory with intelligence'));
        expect(parts.length).toBeGreaterThanOrEqual(2);
    });

    it('never makes a section longer than the cap and loses no text', () => {
        const sections = splitIntoSections(longReply).filter((s) => s.kind === 'section');
        for (const s of sections) expect(s.content.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
        const joined = sections.map((s) => s.content).join(' ');
        for (const marker of ['Intro', 'Cleophis is the tutor.', 'Second paragraph of blind spot one.', 'Children need more than encryption.']) {
            expect(joined).toContain(marker);
        }
    });

    it('keeps a fenced code block in one piece', () => {
        const sections = splitIntoSections(longReply);
        expect(sections.some((s) => s.content.includes('const a = 1;\n\nconst b = 2;'))).toBe(true);
    });

    it('writes an outline listing every heading, first', () => {
        const [outline] = splitIntoSections(longReply);
        expect(outline).toMatchObject({ kind: 'outline', index: -1 });
        expect(outline.content).toContain('- 6. The blind spots I think you are missing');
        expect(outline.content).toContain('Blind spot 1: Confusing memory with intelligence');
        expect(outline.content).toContain('Blind spot 2: Student privacy');
        expect(outline.content.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    });

    it('treats a line that is all bold as a heading', () => {
        const text = ['**First part**', para('a', 1400), '**Second part**', para('b', 1400), '**Third part**', para('c', 1400)].join('\n\n');
        const sections = splitIntoSections(text);
        expect(sections.filter((s) => s.kind === 'section').map((s) => s.heading)).toEqual(['First part', 'Second part', 'Third part']);
        expect(sections[0].kind).toBe('outline');
    });

    it('splits text with no headings by paragraphs, with no outline', () => {
        const text = Array.from({ length: 8 }, (_, i) => para(`Paragraph ${i}.`, 700)).join('\n\n');
        const sections = splitIntoSections(text);
        expect(sections.every((s) => s.kind === 'section' && s.heading === '')).toBe(true);
        expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('handles one giant paragraph and a huge turn within the limits', () => {
        const giant = splitIntoSections('word '.repeat(4000));
        expect(giant.length).toBeGreaterThan(1);
        for (const s of giant) expect(s.content.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
        const huge = splitIntoSections(Array.from({ length: 400 }, (_, i) => para(`P${i}.`, 600)).join('\n\n'));
        expect(huge.length).toBeLessThanOrEqual(MAX_SECTIONS_PER_TURN + 1);
    });
});

describe('embedding text and fingerprint', () => {
    it('leads with the heading path, or says it is an outline', () => {
        expect(sectionEmbedText({ kind: 'section', heading: 'A > B', content: 'body' })).toBe('A > B\nbody');
        expect(sectionEmbedText({ kind: 'section', heading: '', content: 'body' })).toBe('body');
        expect(sectionEmbedText({ kind: 'outline', heading: 'Outline', content: '- A' })).toMatch(/^Outline of a long message/);
    });

    it('changes when the content changes', () => {
        expect(contentFingerprint('abc')).toBe(contentFingerprint('abc'));
        expect(contentFingerprint('abc')).not.toBe(contentFingerprint('abd'));
    });
});

describe('search-time selection', () => {
    const hit = (id, turn, similarity, kind = 'section') => ({
        id, turn_id: turn, kind, section_index: 0, heading: `H-${id}`, content: `content ${id}`,
        similarity, platform: 'chatgpt', speakers: ['assistant'], created_at: '2026-11-14T06:38:58Z',
    });

    it('keeps at most two sections per turn, best turn first, and drops hits under the floor', () => {
        const picked = selectSections([hit('a', 't1', 0.66), hit('b', 't1', 0.65), hit('c', 't1', 0.64), hit('d', 't2', 0.71), hit('e', 't3', 0.41)]);
        expect(picked.map((h) => h.id)).toEqual(['d', 'a', 'b']);
        expect(selectSections([hit('x', 't1', 0.54)])).toEqual([]);
    });

    it('drops sections that are not close to the best one (the 2026-11-14 search)', () => {
        const picked = selectSections([
            hit('right', 'reply', 0.727),
            hit('n1', 'pasted-doc', 0.620), hit('n2', 'pasted-doc', 0.615), hit('n3', 'pasted-doc', 0.600), hit('n4', 'other', 0.581),
        ]);
        expect(picked.map((h) => h.id)).toEqual(['right']);
    });

    it('asks for the outline of a turn whose single section matched strongly', () => {
        expect(turnsWantingOutline(selectSections([hit('right', 'reply', 0.727)]))).toEqual(['reply']);
        expect(turnsWantingOutline(selectSections([hit('weak', 'reply', 0.60)]))).toEqual([]);
    });

    it('puts a matching outline ahead of its turn\'s sections', () => {
        const picked = selectSections([hit('a', 't1', 0.62), hit('o', 't1', 0.58, 'outline')]);
        expect(picked.map((h) => h.id)).toEqual(['o', 'a']);
    });

    it('asks for the outline of a turn with two matching sections', () => {
        const picked = selectSections([hit('a', 't1', 0.62), hit('b', 't1', 0.60), hit('d', 't2', 0.64)]);
        expect(turnsWantingOutline(picked)).toEqual(['t1']);
        expect(turnsWantingOutline(selectSections([hit('a', 't1', 0.62), hit('b', 't1', 0.6), hit('o', 't1', 0.58, 'outline')]))).toEqual([]);
    });

    it('shapes a section as a search result that keeps the speaker', () => {
        const r = sectionToResult(hit('a', 't1', 0.62));
        expect(r).toMatchObject({ id: 'a', turn_id: 't1', section: true, speakers: ['assistant'], cross_encoder_score: 0.62 });
        expect(r.content).toBe('[H-a]\ncontent a');
        expect(sectionToResult(hit('o', 't1', 0.6, 'outline')).content).toMatch(/^\[Outline of the whole message\]/);
    });

    it('puts sections first, adds fetched outlines, and drops the whole turn they came from', () => {
        const turns = [{ id: 't1', content: 'whole turn one' }, { id: 't9', content: 'another turn' }];
        const selected = selectSections([hit('a', 't1', 0.62), hit('b', 't1', 0.58)]);
        const merged = mergeSectionResults(turns, selected, [hit('o', 't1', 0, 'outline')]);
        expect(merged.map((r) => r.id)).toEqual(['o', 'a', 'b', 't9']);
        expect(merged[0].cross_encoder_score).toBe(0.62); // a fetched outline takes its section's score
    });

    it('returns the turn results unchanged when no section matched', () => {
        const turns = [{ id: 't1', content: 'x' }];
        expect(mergeSectionResults(turns, [])).toEqual(turns);
    });
});

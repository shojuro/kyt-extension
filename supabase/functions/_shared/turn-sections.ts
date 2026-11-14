// Sections of long turns: a long reply is split at its headings and
// paragraphs, each part gets its own embedding, and search returns the part
// that answers the question instead of the opening lines.
//
// Why (2026-11-14): a 28,565-character reply was stored as one block with one
// embedding. "Take the list of blind spots you gave me and rank it" matched it
// weakly, and when a long turn did match, only its first lines were injected.
// 3,263 of 21,940 stored turns are over 3,000 characters.
//
// Pure module (no Deno or network imports): tests/unit/turn-sections.test.js.

/** Turns shorter than this are not split: one embedding describes them well enough. */
export const MIN_TURN_CHARS = 3000;
/** Aim for sections of about this size. */
export const TARGET_SECTION_CHARS = 1500;
/** No section is longer than this. */
export const MAX_SECTION_CHARS = 2400;
/** Sections smaller than this are joined to a neighbour. */
export const MIN_SECTION_CHARS = 300;
export const MAX_SECTIONS_PER_TURN = 60;
/** An outline is written when a turn has at least this many headings. */
export const MIN_HEADINGS_FOR_OUTLINE = 3;
/** Version of the splitting rules, stored with each turn so a rule change can trigger a re-split. */
// 2: sentence splitting no longer drops text around dots inside words.
export const SECTIONS_VERSION = 2;

export interface Section {
    /** 0-based position among the content sections; -1 for the outline. */
    index: number;
    kind: "section" | "outline";
    /** Heading path, e.g. "6. The blind spots > Blind spot 1". Empty when the text has no headings. */
    heading: string;
    content: string;
}

interface Block {
    path: string[];
    /** Heading level that opened this block (0 = text before any heading). */
    level: number;
    paragraphs: string[];
}

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// A short line that is entirely bold, standing alone, is used as a heading by
// assistants that do not write "#" headings.
const BOLD_HEADING_RE = /^\*\*([^*\n]{3,90})\*\*:?\s*$/;

function cleanHeading(text: string): string {
    return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Split text into heading-led blocks of paragraphs. Fenced code is kept whole. */
function toBlocks(text: string): Block[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks: Block[] = [{ path: [], level: 0, paragraphs: [] }];
    const stack: { level: number; title: string }[] = [];
    let paragraph: string[] = [];
    let inFence = false;

    const flushParagraph = () => {
        const joined = paragraph.join("\n").trim();
        if (joined) blocks[blocks.length - 1].paragraphs.push(joined);
        paragraph = [];
    };

    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            paragraph.push(line);
            continue;
        }
        if (inFence) {
            paragraph.push(line);
            continue;
        }
        const md = MD_HEADING_RE.exec(line);
        const bold = md ? null : BOLD_HEADING_RE.exec(line.trim());
        if (md || bold) {
            flushParagraph();
            const level = md ? md[1].length : 7; // bold lines rank below every "#" heading
            const title = cleanHeading(md ? md[2] : bold![1]);
            while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
            stack.push({ level, title });
            blocks.push({ path: stack.map((s) => s.title), level, paragraphs: [] });
            continue;
        }
        if (line.trim() === "") flushParagraph();
        else paragraph.push(line);
    }
    flushParagraph();
    return blocks;
}

/**
 * Sentences of a paragraph, each with its trailing spaces, covering every
 * character. One pass: a sentence ends at ".", "!" or "?" followed by white
 * space, or at a line break. A dot inside "notes.txt" or "3.5" ends nothing.
 * (A pattern did this before; on a 30,000-character line it took seconds and
 * dropped the text around such dots.)
 */
function splitSentences(paragraph: string): string[] {
    const out: string[] = [];
    let start = 0;
    let i = 0;
    const n = paragraph.length;
    const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r";
    while (i < n) {
        const c = paragraph[i];
        const endsSentence = (c === "." || c === "!" || c === "?") && (i + 1 >= n || isSpace(paragraph[i + 1]));
        if (endsSentence || c === "\n") {
            i++;
            while (i < n && isSpace(paragraph[i])) i++;
            out.push(paragraph.slice(start, i));
            start = i;
        } else {
            i++;
        }
    }
    if (start < n) out.push(paragraph.slice(start));
    return out.length > 0 ? out : [paragraph];
}

/** Cut one over-long paragraph into pieces at sentence ends (or hard, when there are none). */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
    if (paragraph.length <= maxChars) return [paragraph];
    const pieces: string[] = [];
    const sentences = splitSentences(paragraph);
    let current = "";
    for (const sentence of sentences) {
        if (current.length + sentence.length > maxChars && current) {
            pieces.push(current.trim());
            current = "";
        }
        if (sentence.length > maxChars) {
            for (let i = 0; i < sentence.length; i += maxChars) pieces.push(sentence.slice(i, i + maxChars).trim());
            continue;
        }
        current += sentence;
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces.filter((p) => p.length > 0);
}

function firstSentence(text: string, maxChars = 140): string {
    const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#-]+/g, " ").replace(/\s+/g, " ").trim();
    const match = /^.*?[.!?](?=\s|$)/.exec(flat);
    const sentence = (match ? match[0] : flat).trim();
    return sentence.length > maxChars ? sentence.slice(0, maxChars - 1).trimEnd() + "…" : sentence;
}

/** A list of the turn's headings with the first sentence under each, or null when it has too few. */
function buildOutline(blocks: Block[]): string | null {
    const headed = blocks.filter((b) => b.path.length > 0);
    if (headed.length < MIN_HEADINGS_FOR_OUTLINE) return null;
    const render = (maxLevel: number, withSentence: boolean): string =>
        headed
            .filter((b) => b.level <= maxLevel)
            .map((b) => {
                const indent = "  ".repeat(Math.max(0, b.path.length - 1));
                const title = b.path[b.path.length - 1];
                const lead = withSentence && b.paragraphs.length > 0 ? firstSentence(b.paragraphs[0]) : "";
                return `${indent}- ${title}${lead ? `: ${lead}` : ""}`;
            })
            .join("\n");
    // Prefer everything; drop the sentences, then the deeper headings, to fit.
    for (const [maxLevel, withSentence] of [[7, true], [7, false], [3, false], [2, false], [1, false]] as const) {
        const text = render(maxLevel, withSentence);
        if (text.length > 0 && text.length <= MAX_SECTION_CHARS) return text;
    }
    return render(1, false).slice(0, MAX_SECTION_CHARS) || null;
}

/**
 * Split a long turn into sections (plus an outline when it has headings).
 * Returns [] for a turn that is short enough to stand as one piece.
 */
export function splitIntoSections(content: unknown): Section[] {
    const text = typeof content === "string" ? content.trim() : "";
    if (text.length < MIN_TURN_CHARS) return [];

    const blocks = toBlocks(text);
    // Very long turns get proportionally larger sections, up to the cap.
    const target = Math.min(
        MAX_SECTION_CHARS,
        Math.max(TARGET_SECTION_CHARS, Math.ceil(text.length / (MAX_SECTIONS_PER_TURN - 10))),
    );

    let pieces: { heading: string; content: string }[] = [];
    for (const block of blocks) {
        const heading = block.path.join(" > ").slice(0, 200);
        let current = "";
        const flush = () => {
            if (current.trim()) pieces.push({ heading, content: current.trim() });
            current = "";
        };
        if (block.paragraphs.length === 0 && heading) {
            // A heading with nothing under it (its text sits under sub-headings).
            continue;
        }
        for (const paragraph of block.paragraphs) {
            for (const part of splitLongParagraph(paragraph, MAX_SECTION_CHARS)) {
                if (current && current.length + part.length + 2 > target) flush();
                current = current ? `${current}\n\n${part}` : part;
            }
        }
        flush();
    }

    // Join sections that are too small to mean much on their own to the next one.
    const merged: { heading: string; content: string }[] = [];
    for (const piece of pieces) {
        const prev = merged[merged.length - 1];
        if (prev && prev.content.length < MIN_SECTION_CHARS &&
            prev.content.length + piece.content.length + 2 <= MAX_SECTION_CHARS) {
            const label = prev.heading && prev.heading !== piece.heading
                ? `${prev.heading.split(" > ").pop()}\n`
                : "";
            merged[merged.length - 1] = {
                heading: piece.heading || prev.heading,
                content: `${label}${prev.content}\n\n${piece.content}`.slice(0, MAX_SECTION_CHARS),
            };
        } else {
            merged.push(piece);
        }
    }
    pieces = merged.slice(0, MAX_SECTIONS_PER_TURN);
    if (pieces.length < 2) return [];

    const sections: Section[] = pieces.map((p, index) => ({ index, kind: "section", heading: p.heading, content: p.content }));
    const outline = buildOutline(blocks);
    if (outline) sections.unshift({ index: -1, kind: "outline", heading: "Outline", content: outline });
    return sections;
}

/** Text that is embedded for a section: its heading path, then its content. */
export function sectionEmbedText(section: Pick<Section, "kind" | "heading" | "content">): string {
    const lead = section.kind === "outline" ? "Outline of a long message, its headings and main points:" : section.heading;
    return `${lead ? `${lead}\n` : ""}${section.content}`.slice(0, 3000);
}

/** Fingerprint of a turn's content, so a changed turn is split again. */
export function contentFingerprint(content: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
        h ^= content.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${content.length}:${h.toString(16)}`;
}

// ── Using sections at search time ───────────────────────────────────────────

export interface SectionHit {
    id: string;
    turn_id: string;
    kind: "section" | "outline";
    section_index: number;
    heading: string | null;
    content: string;
    similarity: number;
    platform: string | null;
    speakers: string[] | null;
    created_at: string;
}

// How close a section must be to the query. First live search, 2026-11-14,
// "the list you gave me about the two projects I want to marry together": the
// right reply's section scored 0.727; sections of an unrelated pasted document
// scored 0.620, 0.615, 0.600 and 0.581 and filled three of the four slots.
// So besides a floor, a section must be close to the best one. These numbers
// rest on that one search; re-check them as test questions are added.
/** Floor: no section below this is returned. */
export const SECTION_MIN_SIMILARITY = 0.55;
/** A section must be within this much of the best section. */
export const SECTION_TOP_GAP = 0.08;
/** A section this close to the query brings its turn's outline with it. */
export const OUTLINE_SIMILARITY = 0.65;
export const MAX_SECTION_RESULTS = 4;
const MAX_SECTIONS_PER_TURN_RESULT = 2;

/**
 * Choose which section hits to return, best turn first: those above the
 * floor and close to the best hit. A turn contributes its two best sections;
 * see turnsWantingOutline for when its outline is added.
 */
/** How hits are judged: a floor, how close to the best hit, and when to add the outline. */
export interface SelectionRule {
    floor: number;
    /** Lowest score kept, given the best score. */
    bar: (top: number) => number;
    outline: number;
}

/** Scores are embedding similarity. Used only when the reranker is unavailable. */
export const SIMILARITY_RULE: SelectionRule = {
    floor: SECTION_MIN_SIMILARITY,
    bar: (top) => top - SECTION_TOP_GAP,
    outline: OUTLINE_SIMILARITY,
};

/** Candidates fetched by similarity and handed to the reranker. */
// Fewer, shorter texts: 16 texts of 2,000 characters timed out at 10 s on the
// Hugging Face inference provider (2026-11-14).
export const SECTION_CANDIDATES = 8;
export const SECTION_CANDIDATE_SIMILARITY = 0.5;
/**
 * Scores are the cross-encoder's (0 to 1), which reads the question and the
 * section together. Similarity alone put an unrelated pasted document at
 * 0.615 on 2026-11-14 with the right reply nowhere. First values, logged on
 * every search ("Sections matched") so they can be set from real searches.
 */
export const RERANK_RULE: SelectionRule = {
    floor: 0.3,
    bar: (top) => top * 0.5,
    outline: 0.5,
};

/** Hits scored by the reranker instead of by similarity; best first. */
export function applyRerankScores(hits: SectionHit[], scores: { index: number; score: number }[]): SectionHit[] {
    const out: SectionHit[] = [];
    for (const { index, score } of scores ?? []) {
        const hit = hits[index];
        if (hit && Number.isFinite(score)) out.push({ ...hit, similarity: score });
    }
    return out.sort((a, b) => b.similarity - a.similarity);
}

export const SECTION_RERANK_CHARS = 1200;

/** Text of a section as the reranker reads it. */
export function sectionRerankText(hit: Pick<SectionHit, "kind" | "heading" | "content">): string {
    return sectionEmbedText(hit as Pick<Section, "kind" | "heading" | "content">).slice(0, SECTION_RERANK_CHARS);
}

export function selectSections(hits: SectionHit[], max = MAX_SECTION_RESULTS, rule: SelectionRule = SIMILARITY_RULE): SectionHit[] {
    const byTurn = new Map<string, SectionHit[]>();
    const sortedHits = [...hits].sort((a, b) => b.similarity - a.similarity);
    const bar = Math.max(rule.floor, rule.bar(sortedHits[0]?.similarity ?? 0));
    for (const hit of sortedHits) {
        if (!(hit.similarity >= bar)) continue;
        if (!byTurn.has(hit.turn_id)) byTurn.set(hit.turn_id, []);
        byTurn.get(hit.turn_id)!.push(hit);
    }
    const out: SectionHit[] = [];
    for (const turnHits of byTurn.values()) {
        const outline = turnHits.find((h) => h.kind === "outline");
        const parts = turnHits.filter((h) => h.kind === "section").slice(0, MAX_SECTIONS_PER_TURN_RESULT);
        for (const hit of [...(outline ? [outline] : []), ...parts]) {
            if (out.length < max) out.push(hit);
        }
    }
    return out;
}

/**
 * Turns whose outline should be fetched: two or more of their sections
 * matched, or one matched strongly, and the outline is not already among the
 * hits. The outline is the map of the whole message, which is what "the list
 * you gave me" asks for.
 */
export function turnsWantingOutline(selected: SectionHit[], rule: SelectionRule = SIMILARITY_RULE): string[] {
    const count = new Map<string, number>();
    const best = new Map<string, number>();
    const hasOutline = new Set<string>();
    for (const hit of selected) {
        if (hit.kind === "outline") {
            hasOutline.add(hit.turn_id);
            continue;
        }
        count.set(hit.turn_id, (count.get(hit.turn_id) ?? 0) + 1);
        best.set(hit.turn_id, Math.max(best.get(hit.turn_id) ?? 0, hit.similarity));
    }
    return [...count.entries()]
        .filter(([id, n]) => !hasOutline.has(id) && (n >= 2 || (best.get(id) ?? 0) >= rule.outline))
        .map(([id]) => id);
}

/** A section shaped like a search result. */
export function sectionToResult(hit: SectionHit): Record<string, unknown> {
    const heading = hit.kind === "outline" ? "Outline of the whole message" : (hit.heading ?? "");
    return {
        id: hit.id,
        turn_id: hit.turn_id,
        content: `${heading ? `[${heading}]\n` : ""}${hit.content}`,
        platform: hit.platform ?? "unknown",
        speakers: hit.speakers ?? [],
        created_at: hit.created_at,
        cross_encoder_score: hit.similarity,
        rerank_score: hit.similarity,
        weighted_score: hit.similarity,
        section: true,
        section_kind: hit.kind,
    };
}

/**
 * Put section results ahead of whole-turn results and drop a whole turn when
 * one of its sections is already there (the section is the better excerpt).
 * Outlines lead their turn's sections.
 */
export function mergeSectionResults<T extends { id?: unknown }>(
    turnResults: T[],
    selected: SectionHit[],
    outlines: SectionHit[] = [],
    max = MAX_SECTION_RESULTS,
): Array<T | Record<string, unknown>> {
    const ordered: SectionHit[] = [];
    const seenTurns = new Set<string>();
    for (const hit of selected) {
        if (!seenTurns.has(hit.turn_id)) {
            seenTurns.add(hit.turn_id);
            const outline = outlines.find((o) => o.turn_id === hit.turn_id);
            // A fetched outline was not scored against the query; it rides on
            // the score of the section that brought it in.
            if (outline && !selected.some((s) => s.id === outline.id)) {
                ordered.push({ ...outline, similarity: hit.similarity });
            }
        }
        ordered.push(hit);
    }
    const sectionItems = ordered.slice(0, max + outlines.length).map(sectionToResult);
    const covered = new Set(ordered.map((h) => h.turn_id));
    return [...sectionItems, ...turnResults.filter((r) => !covered.has(String(r?.id)))];
}

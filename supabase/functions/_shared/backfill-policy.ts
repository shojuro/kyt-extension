// What backfill_entities does with a turn that failed. Pure module (no remote
// imports) so it can be unit-tested outside Deno: tests/unit/backfill-policy.test.js.

/** Billed attempts a turn gets before it is marked processed with a failure. */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/** Consecutive API failures after which a run stops calling the API. */
export const MAX_CONSECUTIVE_API_FAILURES = 3;

export type FailureKind =
    /** The API answered and billed, but the reply was a refusal, cut off, or not JSON. */
    | "reply_unusable"
    /** The API returned an HTTP error: key, billing, request shape, rate limit, outage. */
    | "api_status"
    /** Timeout, network error, anything unrecognised. May have been billed. */
    | "transient"
    /** Extraction worked, saving its result did not. */
    | "save_error";

export function classifyExtractionError(err: unknown): FailureKind {
    const e = err as { name?: string; message?: string } | null | undefined;
    if (e?.name === "AnthropicReplyError") return "reply_unusable";
    if (typeof e?.message === "string" && /API Error: \d{3}\b/.test(e.message)) return "api_status";
    return "transient";
}

const METADATA_KEY = "entity_extraction";

function asObject(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function record(metadata: unknown): Record<string, any> {
    return asObject(asObject(metadata)[METADATA_KEY]);
}

/**
 * Short fingerprint of a turn's content (cyrb53 hash plus length). It only has
 * to tell two versions of the same turn apart, not resist an attacker.
 */
export function contentFingerprint(content: string): string {
    const text = String(content ?? "");
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${text.length}:${hash.toString(16)}`;
}

/**
 * True when this exact content was already extracted, or given up on. The
 * extension upserts every chunk of a conversation on each sync with
 * entities_extracted=false, so a pending flag alone does not mean there is
 * new work: only changed content does.
 */
export function isSettled(metadata: unknown, content: string): boolean {
    const rec = record(metadata);
    return (rec.status === "done" || rec.status === "failed") &&
        rec.content_fp === contentFingerprint(content);
}

/** Failed attempts recorded in chat_turns.metadata, 0 when none. */
export function readAttempts(metadata: unknown): number {
    const attempts = record(metadata).attempts;
    return Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
}

/**
 * Copy of `metadata` with one more failed attempt recorded for the content
 * with fingerprint `fp`. Other keys are kept. The count starts again when the
 * content changed.
 */
export function withFailedAttempt(
    metadata: unknown,
    kind: FailureKind,
    message: string,
    nowIso: string,
    fp: string,
): Record<string, any> {
    const rec = record(metadata);
    const previous = rec.content_fp === fp ? readAttempts(metadata) : 0;
    return {
        ...asObject(metadata),
        [METADATA_KEY]: {
            status: "retry",
            content_fp: fp,
            attempts: previous + 1,
            last_failure: kind,
            last_error: String(message ?? "").slice(0, 200),
            last_failed_at: nowIso,
        },
    };
}

/** Copy of `metadata` recording that the turn was given up on (after withFailedAttempt). */
export function withGivenUp(metadata: unknown, nowIso: string): Record<string, any> {
    return {
        ...asObject(metadata),
        [METADATA_KEY]: { ...record(metadata), status: "failed", given_up_at: nowIso },
    };
}

/** Copy of `metadata` recording a successful extraction of the content with fingerprint `fp`. */
export function withExtracted(metadata: unknown, fp: string, nowIso: string): Record<string, any> {
    return {
        ...asObject(metadata),
        [METADATA_KEY]: { status: "done", content_fp: fp, attempts: 0, extracted_at: nowIso },
    };
}

export type FailureAction = "mark_failed" | "retry_later";

/**
 * @param attempts failed attempts including this one, or null when the count
 *                 could not be stored (then nothing is given up on by count).
 */
export function decideFailureAction(kind: FailureKind, attempts: number | null): FailureAction {
    // Billed, and the same turn would most likely produce the same reply again.
    if (kind === "reply_unusable") return "mark_failed";
    // Not about the turn: a bad key or a rejected parameter would otherwise mark
    // every pending turn as failed. The run stops instead (shouldAbortRun).
    if (kind === "api_status") return "retry_later";
    if (attempts !== null && attempts >= MAX_EXTRACTION_ATTEMPTS) return "mark_failed";
    return "retry_later";
}

/** Rows to fetch next, given the caller's limit and the rows already attempted in this run. */
export function nextFetchSize(limit: number, attempted: number, chunkSize: number): number {
    return Math.max(0, Math.min(chunkSize, limit - attempted));
}

export function hasTimeBudget(startedAtMs: number, nowMs: number, budgetMs: number): boolean {
    return nowMs - startedAtMs < budgetMs;
}

export function shouldAbortRun(consecutiveApiFailures: number): boolean {
    return consecutiveApiFailures >= MAX_CONSECUTIVE_API_FAILURES;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Value for PostgREST `.not("id", "in", ...)`. Ids go into the filter string, so they must be UUIDs. */
export function notInFilter(ids: string[]): string {
    for (const id of ids) {
        if (typeof id !== "string" || !UUID_RE.test(id)) {
            throw new Error(`notInFilter: not a UUID: ${String(id).slice(0, 40)}`);
        }
    }
    return `(${ids.join(",")})`;
}

/** Where a run has got to in the newest-first scan of chat_turns. */
export interface FetchCursor {
    /** created_at of the oldest row fetched so far; null before the first chunk. */
    createdAt: string | null;
    /** Ids already fetched that share exactly that created_at (rows of one bulk insert do). */
    idsAtCursor: string[];
}

/**
 * Cursor after fetching `rows` (ordered created_at descending). The next query
 * asks for created_at <= cursor.createdAt and id not in cursor.idsAtCursor, so
 * a row that stays pending (failed, or force_reextract) is not fetched again in
 * the same run, and the exclusion list stays short.
 */
export function advanceCursor(
    cursor: FetchCursor,
    rows: Array<{ id: string; created_at: string }>,
): FetchCursor {
    if (rows.length === 0) return cursor;
    const last = rows[rows.length - 1].created_at;
    const carried = cursor.createdAt === last ? cursor.idsAtCursor : [];
    return {
        createdAt: last,
        idsAtCursor: [...carried, ...rows.filter((r) => r.created_at === last).map((r) => r.id)],
    };
}

/**
 * Recall test set: validation and scoring. Pure, no network, no file access.
 * Tests: tests/unit/recall-eval.test.js. Runners: src/recall-eval-runner.js (inside the
 * extension, with the signed-in session) and validation/recall-eval/run.mjs (service key).
 *
 * A set is a list of questions a user really asks, each with the stored turns
 * that hold the answer. A question passes when the search returns at least
 * one of those turns (or a section of one), or, for a question with no stored
 * answer, when it returns nothing.
 */

export const KINDS = ['reply', 'own-statement', 'definition', 'whole-list', 'cross-platform', 'none'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Problems with a set, as readable strings. Empty when the set is usable. */
export function validateSet(set) {
  const problems = [];
  if (!set || typeof set !== 'object' || !Array.isArray(set.questions)) return ['set has no "questions" list'];
  const seen = new Set();
  set.questions.forEach((q, i) => {
    const where = `question ${i + 1}${q?.id ? ` (${q.id})` : ''}`;
    if (!q || typeof q !== 'object') { problems.push(`${where}: not an object`); return; }
    if (typeof q.id !== 'string' || !q.id) problems.push(`${where}: missing id`);
    else if (seen.has(q.id)) problems.push(`${where}: duplicate id`);
    else seen.add(q.id);
    if (typeof q.question !== 'string' || q.question.trim().length < 5) problems.push(`${where}: missing question text`);
    if (!KINDS.includes(q.kind)) problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    const ids = q.expect?.any_turn_ids;
    const cards = q.expect?.any_card_keys;
    const none = q.expect?.none === true;
    const hasIds = Array.isArray(ids) && ids.length > 0;
    const hasCards = Array.isArray(cards) && cards.length > 0;
    if (none && (hasIds || hasCards)) problems.push(`${where}: expects nothing and something at once`);
    if (!none && !hasIds && !hasCards) problems.push(`${where}: no expected turn ids or card keys (use expect.none for "nothing stored")`);
    if (hasIds && ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) problems.push(`${where}: expected turn ids must be UUIDs`);
    if ((q.kind === 'none') !== none) problems.push(`${where}: kind "none" and expect.none must go together`);
  });
  return problems;
}

const idsOf = (result) => [result?.id, result?.turn_id, result?.message_id].filter((v) => typeof v === 'string');
const cardKeyOf = (result) => (result?.source === 'memory_card' ? String(result.card_key ?? result.id ?? '') : null);

/**
 * Score one question against the results the search returned (best first).
 * `skipped` means the client decided not to search at all.
 */
export function scoreQuestion(question, results, { skipped = false } = {}) {
  const list = Array.isArray(results) ? results : [];
  const expect = question.expect ?? {};
  if (expect.none === true) {
    return { id: question.id, kind: question.kind, pass: list.length === 0, returned: list.length, rank: null, skipped, wanted: 'nothing' };
  }
  const wantIds = new Set(expect.any_turn_ids ?? []);
  const wantCards = new Set((expect.any_card_keys ?? []).map(String));
  let rank = null;
  list.forEach((result, i) => {
    if (rank !== null) return;
    const card = cardKeyOf(result);
    if (idsOf(result).some((id) => wantIds.has(id)) || (card !== null && wantCards.has(card))) rank = i + 1;
  });
  return { id: question.id, kind: question.kind, pass: rank !== null, returned: list.length, rank, skipped, wanted: 'answer' };
}

/** Totals over scored questions, overall and per kind. */
export function summarise(scores) {
  const tally = (rows) => {
    const answers = rows.filter((r) => r.wanted === 'answer');
    const nothing = rows.filter((r) => r.wanted === 'nothing');
    const ranks = answers.filter((r) => r.pass).map((r) => r.rank);
    return {
      questions: rows.length,
      passed: rows.filter((r) => r.pass).length,
      answer_found: `${answers.filter((r) => r.pass).length}/${answers.length}`,
      found_in_top_3: `${ranks.filter((r) => r <= 3).length}/${answers.length}`,
      correctly_empty: `${nothing.filter((r) => r.pass).length}/${nothing.length}`,
      not_searched: rows.filter((r) => r.skipped).length,
      avg_items_returned: rows.length ? Number((rows.reduce((n, r) => n + r.returned, 0) / rows.length).toFixed(1)) : 0,
    };
  };
  const byKind = {};
  for (const kind of new Set(scores.map((s) => s.kind))) byKind[kind] = tally(scores.filter((s) => s.kind === kind));
  return { overall: tally(scores), by_kind: byKind };
}

/** Questions whose outcome differs between two runs, by id. */
export function compareRuns(before, after) {
  const prior = new Map((before ?? []).map((s) => [s.id, s]));
  const fixed = [];
  const broken = [];
  for (const now of after ?? []) {
    const was = prior.get(now.id);
    if (!was) continue;
    if (!was.pass && now.pass) fixed.push(now.id);
    if (was.pass && !now.pass) broken.push(now.id);
  }
  return { fixed, broken };
}

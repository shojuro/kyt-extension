/**
 * Run a recall test set through the extension's own pipeline: the same
 * classification, search, filtering and cap a real message gets. Runs with
 * the signed-in session, so no service key is needed.
 *
 * The caller supplies the pipeline pieces, which keeps this testable:
 *   classify(text)            -> { intent, confidenceThreshold, reason, scores }
 *   escalate(text, c)         -> classification after the second layer
 *   getContext(text, config)  -> { items: [...] }
 *
 * Tests: tests/unit/recall-eval-runner.test.js.
 */
import { validateSet, scoreQuestion, summarise, compareRuns } from './recall-eval-lib.js';

export const RECALL_LAST_RUN_KEY = 'kyt_recall_last_run';

/** Settings a real message would be searched with, from its classification. */
export function configFor(classification, platform) {
  const config = { platform };
  if (classification?.confidenceThreshold) config.confidenceThreshold = classification.confidenceThreshold;
  const technical = classification?.reason?.startsWith('technical_') || (classification?.scores?.codeSignal >= 0.5);
  if (technical) config.queryType = 'technical';
  return config;
}

export async function runRecallSet(set, deps, options = {}) {
  const problems = validateSet(set);
  if (problems.length > 0) return { ok: false, problems };
  const { limit = set.questions.length, platform = 'claude', previous = null, onProgress = () => {} } = options;
  const scores = [];
  for (const q of set.questions.slice(0, limit)) {
    const started = Date.now();
    let row;
    try {
      let classification = deps.classify(q.question);
      if (classification.intent === 'PASSIVE' && deps.escalate) classification = await deps.escalate(q.question, classification);
      if (classification.intent === 'SKIP') {
        row = { ...scoreQuestion(q, [], { skipped: true }), intent: classification.reason };
      } else {
        const data = await deps.getContext(q.question, configFor(classification, platform));
        row = { ...scoreQuestion(q, data?.items ?? []), intent: classification.reason };
      }
    } catch (e) {
      row = { ...scoreQuestion(q, []), error: String(e?.message ?? e).slice(0, 120) };
      row.pass = false;
    }
    row.ms = Date.now() - started;
    scores.push(row);
    onProgress(row);
  }
  const out = { ok: true, ran_at: new Date().toISOString(), label: options.label ?? null, summary: summarise(scores), scores };
  if (previous?.scores) out.against_previous = compareRuns(previous.scores, scores);
  return out;
}

/**
 * Runs the build_memory_cards edge function until every card is written.
 *
 * The function handles a few cards per call and reports how many are left.
 * This loop repeats the call, and stops as soon as a call makes no progress,
 * so a failing model or database can never turn into an endless paid loop.
 *
 * @param {(name: string, body: object, opts: object) => Promise<object>} call  callEdgeFunction
 * @param {{pins?: Array<{name: string, aliases?: string[], note?: string}>, force?: boolean,
 *          limit?: number, maxAuto?: number, dryRun?: boolean}} [options]
 * @param {{maxRuns?: number, log?: Function, now?: () => Date}} [control]
 * @returns {Promise<object>} totals across runs
 */
let inFlight = null;

/**
 * One build at a time. On 2026-11-14 a second loop started while the first
 * was running and about 95 cards were written (and paid for) twice. A dry run
 * writes nothing and is not held back.
 */
export function buildMemoryCards(call, options = {}, control = {}) {
  if (options.dryRun) return runBuild(call, options, control);
  if (inFlight) {
    (control.log || console.log)('🗂️ Memory cards: a build is already running; not starting a second one.');
    return inFlight;
  }
  inFlight = runBuild(call, options, control).finally(() => { inFlight = null; });
  return inFlight;
}

async function runBuild(call, options = {}, control = {}) {
  const { maxRuns = 40, log = console.log, now = () => new Date() } = control;
  const body = {};
  if (Array.isArray(options.pins) && options.pins.length > 0) body.pins = options.pins;
  if (typeof options.limit === 'number') body.limit = options.limit;
  if (typeof options.maxAuto === 'number') body.max_auto = options.maxAuto;
  // "Rewrite everything" is sent as a cut-off time, not a flag: a card rewritten
  // by an earlier call of this loop is newer than the cut-off and is left alone.
  if (options.force) body.rebuild_before = now().toISOString();

  if (options.dryRun) {
    return call('build_memory_cards', { ...body, dry_run: true }, { timeoutMs: 60000 });
  }

  const totals = { success: true, runs: 0, built: 0, insufficient: 0, unchanged: 0, failed: 0, model_calls: 0, remaining: null, stopped: null };
  for (let run = 0; run < maxRuns; run++) {
    let result;
    try {
      result = await call('build_memory_cards', body, { timeoutMs: 140000 });
    } catch (err) {
      totals.success = false;
      totals.error = err?.message || String(err);
      break;
    }
    if (!result || result.success === false) {
      totals.success = false;
      totals.error = result?.error || 'build_memory_cards failed';
      break;
    }
    totals.runs++;
    for (const key of ['built', 'insufficient', 'unchanged', 'failed', 'model_calls']) {
      totals[key] += Number(result[key]) || 0;
    }
    totals.remaining = Number(result.remaining) || 0;
    const progress = (Number(result.built) || 0) + (Number(result.insufficient) || 0) + (Number(result.unchanged) || 0);
    log(`🗂️ Memory cards: run ${totals.runs}: ${result.built} written, ${result.insufficient} without enough to say, ${result.unchanged} unchanged, ${result.failed} failed, ${totals.remaining} left`);
    if (totals.remaining <= 0) break;
    if (progress === 0) {
      totals.stopped = result.stopped || 'no_progress';
      break;
    }
    if (run === maxRuns - 1) totals.stopped = 'max_runs';
  }
  return totals;
}

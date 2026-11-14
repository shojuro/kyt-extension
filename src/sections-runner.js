/**
 * Runs the backfill_sections edge function until every long turn is split.
 *
 * The function handles a batch of turns per call and reports how many are
 * left. This loop repeats the call and stops as soon as a call makes no
 * progress or reports that it had to stop, so an embedding outage cannot turn
 * into an endless loop. Only one loop runs at a time (the timer and a manual
 * run would otherwise split the same turns twice).
 *
 * @param {(name: string, body: object, opts: object) => Promise<object>} call  callEdgeFunction
 * @param {{limit?: number}} [options]
 * @param {{maxRuns?: number, log?: Function}} [control]
 * @returns {Promise<object>} totals across runs
 */
let inFlight = null;

export function backfillSections(call, options = {}, control = {}) {
  if (inFlight) {
    (control.log || console.log)('✂️ Sections: a run is already going; not starting a second one.');
    return inFlight;
  }
  inFlight = runBackfill(call, options, control).finally(() => { inFlight = null; });
  return inFlight;
}

async function runBackfill(call, options, control) {
  const { maxRuns = 300, log = console.log } = control;
  const body = {};
  if (typeof options.limit === 'number') body.limit = options.limit;

  const totals = { success: true, runs: 0, processed: 0, sectioned: 0, sections_written: 0, failed: 0, remaining: null, stopped: null };
  for (let run = 0; run < maxRuns; run++) {
    let result;
    try {
      result = await call('backfill_sections', body, { timeoutMs: 140000 });
    } catch (err) {
      totals.success = false;
      totals.error = err?.message || String(err);
      break;
    }
    if (!result || result.success === false) {
      totals.success = false;
      totals.error = result?.error || 'backfill_sections failed';
      break;
    }
    totals.runs++;
    for (const key of ['processed', 'sectioned', 'sections_written', 'failed']) {
      totals[key] += Number(result[key]) || 0;
    }
    totals.remaining = result.remaining == null ? null : Number(result.remaining);
    log(`✂️ Sections: run ${totals.runs}: ${result.processed} turns, ${result.sections_written} sections, ${result.failed} failed, ${totals.remaining ?? '?'} turns left`);
    if (totals.remaining === 0) break;
    // "time_budget" just means the call ran out of time; anything else is a real stop.
    if (result.stopped && result.stopped !== 'time_budget') {
      totals.stopped = result.stopped;
      break;
    }
    if ((Number(result.processed) || 0) === 0) {
      totals.stopped = 'no_progress';
      break;
    }
    if (run === maxRuns - 1) totals.stopped = 'max_runs';
  }
  return totals;
}

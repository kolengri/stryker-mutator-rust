import os from 'node:os';
import { commonTokens, declareFactoryPlugin, PluginKind } from '@stryker-mutator/api/plugin';
import { CampaignEta, formatEta } from './eta.js';
import { loadEtaCompatibility } from './eta-compat.js';
import { etaErrorMessage, invokeEtaCallback } from './eta-errors.js';

// Loaded only when the opt-in reporter module is requested.
const compatibility = await loadEtaCompatibility();

/** A public Reporter, usable as a value plugin in an explicitly supplied campaign. */
export function createEtaReporter({ campaign, scopeId = 'run', onEstimate, onEvent, write, intervalMs = 1000, concurrency, checkers = [], allowEmpty = false, dryRunOnly = false, beginScope = true, clock = () => performance.now() } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('ETA intervalMs must be nonnegative');
  for (const [name, callback] of Object.entries({ onEstimate, onEvent, write })) {
    if (callback != null && typeof callback !== 'function') throw new TypeError(`ETA ${name} must be a function`);
  }
  campaign ??= new CampaignEta({ scopes: [{ id: scopeId }] });
  const parallelism = os.availableParallelism();
  const configured = typeof concurrency === 'number' ? concurrency : typeof concurrency === 'string' && /^(100|[1-9]?[0-9])%$/.test(concurrency)
    ? Math.max(1, Math.round(parallelism * parseInt(concurrency, 10) / 100)) : parallelism > 4 ? parallelism - 1 : parallelism;
  if (!Number.isInteger(configured) || configured < 1 || configured > 4096) throw new TypeError('ETA concurrency must resolve to 1 through 4096');
  let capacity = checkers.length ? Math.max(1, Math.floor(configured / 2)) : configured;
  let checking = checkers.length > 0;
  let baseline;
  let planReady = false;
  let lastEmission = -Infinity;
  let failed = false;
  let closed = false;
  let timer;
  const jobs = new Map();
  const completed = new Set();
  const ready = new Set();
  const dispose = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(timer);
    jobs.clear(); completed.clear(); ready.clear();
  };
  const notify = (callback, value) => {
    if (failed || closed) return;
    try { invokeEtaCallback(callback, value); }
    catch (error) { observer.failure(error, callback); }
  };
  const emit = (force = false) => {
    const now = clock();
    if (!force && now - lastEmission < intervalMs) return;
    lastEmission = now;
    const estimate = campaign.snapshot();
    for (const [callback, value] of [[onEstimate, estimate], [write, formatEta(estimate)]]) {
      notify(callback, value);
    }
  };
  const record = (event) => {
    const recorded = campaign.record({ ...event, scopeId });
    notify(onEvent, recorded);
  };
  const observer = {
    failure(error, callback) {
      if (failed) return;
      failed = true;
      dispose();
      const message = etaErrorMessage(error);
      try { campaign.record({ type: 'degrade', scopeId, reason: `ETA observation failed: ${message}` }); } catch { /* Scope may already be complete. */ }
      if (callback !== write) {
        try { invokeEtaCallback(write, `ETA unavailable: ${message}`); } catch { /* Advisory callback only. */ }
      }
    },
    ready(worker) {
      ready.add(worker);
      if (planReady) updateCapacity();
    },
    capacity(runners) {
      capacity = runners;
      checking = false;
      if (planReady) updateCapacity();
    },
    start(id) {
      if (!jobs.has(id)) return;
      record({ type: 'start', jobId: id });
      emit();
    },
    finish(id, attempts, timedOut) {
      if (!jobs.has(id)) return;
      record({ type: 'finish', jobId: id, attempts, timedOut });
      completed.add(id);
      emit();
    },
  };
  const unmeasured = () => [ ...(checking ? ['checker processing time unmeasured'] : []), ...(ready.size < capacity ? ['cold worker initialization unmeasured'] : []) ];
  const updateCapacity = () => record({ type: 'capacity', runners: Math.min(capacity, ready.size), unmeasuredWork: unmeasured() });
  const unsubscribe = compatibility.subscribe(observer);
  // Campaign/configuration failures still escape; observer failures are isolated
  // by notify from their first invocation, after the valid begin is recorded.
  try { if (beginScope) record({ type: 'begin' }); if (!failed) emit(true); } catch (error) { dispose(); throw error; }
  if (!closed && (write || onEstimate) && intervalMs > 0) {
    timer = setInterval(() => { try { emit(); } catch (error) { observer.failure(error); } }, Math.max(10, intervalMs));
    timer.unref();
  }
  const reporter = {
    onDryRunCompleted(event) {
      baseline = event;
      // Core exits before planning/reportAll/wrapUp in these successful paths.
      if (dryRunOnly || (allowEmpty && event.result?.tests.length === 0)) {
        record({ type: 'plan', plan: { jobs: [], runners: 0, baselineMs: event.timing.net + event.timing.overhead } });
        record({ type: 'end' });
        emit(true);
        dispose();
      }
    },
    onMutationTestingPlanReady({ mutantPlans }) {
      // This is the actual post-diff plan, not mutation candidates or import reachability.
      const runnable = mutantPlans.filter((p) => p.plan === 'Run' && p.runOptions.testFilter?.length !== 0)
        .toSorted((a, b) => Number(a.runOptions.reloadEnvironment) - Number(b.runOptions.reloadEnvironment));
      for (const p of runnable) {
        const overhead = baseline?.timing.overhead;
        // Command runs start a process every time. SDK runner overhead is also
        // charged conservatively until actual end-to-end observations replace it.
        jobs.set(p.mutant.id, { id: p.mutant.id, baselineMs: Number.isFinite(p.netTime) && Number.isFinite(overhead) ? p.netTime + overhead : null,
          timeoutMs: p.runOptions.timeout, reload: p.runOptions.reloadEnvironment });
      }
      record({ type: 'plan', plan: { jobs: [...jobs.values()], runners: Math.min(capacity, ready.size), baselineMs: baseline ? baseline.timing.net + baseline.timing.overhead : null,
        unmeasuredWork: unmeasured(),
        notes: ['actual Core 10 post-diff runnable plan', 'preparation measured from the scope begin event', 'wall duration includes reload, timeout and recovery', ...(checkers.length ? ['checker processing time is unmeasured; effective runner capacity refines as checkers release'] : [])] } });
      planReady = true;
      emit(true);
    },
    onMutantTested({ id }) {
      if (!jobs.has(id) || completed.has(id)) return;
      // A checker can turn a planned run into an early result. Do not train a
      // zero-duration test sample from that notification.
      record({ type: 'finish', jobId: id, sample: false });
      completed.add(id);
      emit();
    },
    onMutationTestReportReady() {
      record({ type: 'end' });
      emit(true);
    },
    wrapUp: dispose,
    dispose,
  };
  return Object.fromEntries(Object.entries(reporter).map(([name, method]) => [name, (...args) => {
    if ((failed || closed) && name !== 'wrapUp' && name !== 'dispose') return;
    try { return method(...args); } catch (error) { observer.failure(error); }
  }]));
}

function reporter(options, logger, injector) {
  // injectFunction does not register its return value for disposal. A resolved
  // factory provider does, and is disposed with this actual Stryker run's owner.
  return injector.provideFactory('strykerRustEtaReporter', () => createEtaReporter({
    concurrency: options.concurrency, checkers: options.checkers, allowEmpty: options.allowEmpty, dryRunOnly: options.dryRunOnly,
    intervalMs: 10_000, write: (line) => logger.info(line),
  })).resolve('strykerRustEtaReporter');
}
reporter.inject = [commonTokens.options, commonTokens.logger, commonTokens.injector];
export const strykerPlugins = [declareFactoryPlugin(PluginKind.Reporter, 'rust-eta', reporter)];

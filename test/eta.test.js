import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CampaignEta, createEtaIdentity, formatEta } from '../lib/eta.js';
import { createEtaReporter } from '../lib/eta-reporter.js';
import { RetryRejectedDecorator } from '../node_modules/@stryker-mutator/core/dist/src/test-runner/retry-rejected-decorator.js';
import { ConcurrencyTokenProvider } from '../node_modules/@stryker-mutator/core/dist/src/concurrent/concurrency-token-provider.js';

const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;

test('public ETA identity changes with every required input and never invokes accessors', () => {
  const components = { sources: 'source digest', tests: 'test digest', configuration: 'config digest', lockfile: 'lock digest', runtime: 'Bun 1.4.3 darwin arm64', engine: 'Rust/Core 10 command' };
  const identity = createEtaIdentity(components);
  assert.match(identity, /^[a-f0-9]{64}$/);
  for (const key of Object.keys(components)) assert.notEqual(createEtaIdentity({ ...components, [key]: `${components[key]} changed` }), identity);
  assert.throws(() => createEtaIdentity({ ...components, runtime: '' }), /required/);
  let reads = 0;
  assert.throws(() => createEtaIdentity({ ...components, get runtime() { reads++; return 'secret'; } }));
  assert.equal(reads, 0);
});

test('public ETA separates measured work from unknown campaign scopes and ignores bad history', () => {
  const eta = new CampaignEta({ scopes: [{ id: 'one' }, { id: 'not-discovered' }], history: { garbage: true } });
  assert.equal(eta.snapshot().state, 'unknown');
  assert.equal(formatEta(eta.snapshot()), 'ETA unknown: total unknown');
  eta.record({ type: 'begin', scopeId: 'one', atMs: 0 });
  eta.record({ type: 'plan', scopeId: 'one', atMs: 10, plan: { jobs: [{ id: '1', baselineMs: 100 }], runners: 1 } });
  const e = eta.snapshot(10);
  assert.equal(e.state, 'partial');
  assert.equal(e.remainingMs, null);
  assert.equal(e.knownRemainingMs, 100);
  assert.match(e.provenance.history[0], /malformed/);
  assert.match(formatEta(e), /total unknown/);
  eta.record({ type: 'start', scopeId: 'one', jobId: '1', atMs: 10 });
  assert.equal(eta.snapshot(60).scopes[0].runningJobs, 1);
  eta.record({ type: 'finish', scopeId: 'one', jobId: '1', atMs: 110 });
  eta.record({ type: 'end', scopeId: 'one', atMs: 110 });
  assert.equal(eta.snapshot(110).state, 'partial');
  assert.throws(() => eta.snapshot(Infinity), /time/);
});

test('matching history refines a new actual plan without borrowing unknown scopes or storing test input', () => {
  const identity = createEtaIdentity({ sources: 's', tests: 't', configuration: 'c', lockfile: 'l', runtime: 'r', engine: 'e' });
  const first = new CampaignEta({ scopes: [{ id: 'one', identity }] });
  first.record({ type: 'begin', scopeId: 'one', atMs: 0 });
  first.record({ type: 'plan', scopeId: 'one', atMs: 10, plan: { jobs: [{ id: 'job', baselineMs: 100 }], runners: 1 } });
  first.record({ type: 'finish', scopeId: 'one', jobId: 'job', atMs: 35, durationMs: 25, attempts: 2, timedOut: true });
  const history = first.history(1000);
  const second = new CampaignEta({ scopes: [{ id: 'one', identity }], history, nowUnixMs: 1001 });
  second.record({ type: 'begin', scopeId: 'one', atMs: 0 });
  second.record({ type: 'plan', scopeId: 'one', atMs: 10, plan: { jobs: [{ id: 'new-job', baselineMs: 200 }], runners: 1 } });
  assert.equal(second.snapshot(10).remainingMs, 50);
  assert.equal(second.snapshot(10).scopes[0].provenance.matchingHistorySamples, 1);
  assert.equal(JSON.stringify(history).includes('new-job'), false);
  assert.equal(JSON.stringify(history).includes('job'), false);
});

const logger = { info() {}, debug() {} };
const dryRun = { timing: { net: 10, overhead: 5 }, capabilities: { reloadEnvironment: true } };
const runPlan = (id) => ({ plan: 'Run', mutant: { id }, netTime: 10, runOptions: { timeout: 100, reloadEnvironment: false } });

test('pinned lifecycle captures real retry attempts including exhaustion without altering results', async () => {
  const campaign = new CampaignEta({ scopes: [{ id: 'retry' }] });
  const remote = new CampaignEta({ scopes: [{ id: 'retry' }] });
  const forwarded = [];
  const reporter = createEtaReporter({ campaign, scopeId: 'retry', concurrency: 1, onEvent: (event) => {
    forwarded.push(event);
    // Forwarding via IPC uses parent arrival time and the measured wall duration.
    remote.record({ ...event, atMs: undefined });
  } });
  try {
    let executions = 0;
    const worker = new RetryRejectedDecorator(logger, () => ({
      async init() {}, async dispose() {},
      async mutantRun({ activeMutant: { id } }) {
        executions++;
        if (id === 'exhausted' || executions === 1) throw new Error('fixture crash');
        return { status: 'survived', nrOfTests: 1 };
      },
    }));
    await worker.init();
    reporter.onDryRunCompleted(dryRun);
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('retry'), runPlan('exhausted')] });
    assert.equal((await worker.mutantRun({ activeMutant: { id: 'retry' } })).status, 'survived');
    reporter.onMutantTested({ id: 'retry' });
    const exhausted = await worker.mutantRun({ activeMutant: { id: 'exhausted' } });
    assert.equal(exhausted.status, 'error');
    assert.match(exhausted.errorMessage, /fixture crash/);
    assert.equal(executions, 4);
    const scope = campaign.snapshot().scopes[0];
    assert.equal(scope.completedJobs, 2);
    assert.equal(scope.provenance.currentSamples, 2);
    assert.equal(scope.provenance.retryAttempts, 2, 'final recovery is not an executed attempt');
    assert.equal(remote.snapshot().scopes[0].completedJobs, 2);
    assert.equal(remote.snapshot().scopes[0].provenance.retryAttempts, 2);
    assert.ok(forwarded.filter((event) => event.type === 'finish').every((event) => event.durationMs >= 0 && event.atMs >= 0));
  } finally { reporter.wrapUp(); }
});

test('checker sharing and cold initialization keep ETA partial until capacity is actually ready', async () => {
  const campaign = new CampaignEta({ scopes: [{ id: 'check' }] });
  const reporter = createEtaReporter({ campaign, scopeId: 'check', concurrency: 4, checkers: ['typescript'] });
  const workers = Array.from({ length: 4 }, () => new RetryRejectedDecorator(logger, () => ({ async init() {} })));
  const provider = new ConcurrencyTokenProvider({ concurrency: 4, checkers: ['typescript'] }, logger);
  try {
    await workers[0].init(); await workers[1].init();
    reporter.onDryRunCompleted(dryRun);
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('a'),runPlan('b'),runPlan('c'),runPlan('d')] });
    assert.equal(campaign.snapshot().state, 'partial');
    assert.equal(campaign.snapshot().scopes[0].effectiveRunners, 2);
    provider.freeCheckers();
    assert.equal(campaign.snapshot().state, 'partial');
    await workers[2].init(); await workers[3].init();
    assert.equal(campaign.snapshot().state, 'estimated');
    assert.equal(campaign.snapshot().scopes[0].effectiveRunners, 4);
  } finally { provider.dispose(); reporter.wrapUp(); }
});

test('an observer failure degrades ETA while retaining the original mutation result', async () => {
  const campaign = new CampaignEta({ scopes: [{ id: 'failure' }] });
  let snapshots = 0;
  const reporter = createEtaReporter({ campaign, scopeId: 'failure', concurrency: 1, intervalMs: 0,
    onEstimate() { if (++snapshots === 3) throw new Error('observer broke'); } });
  try {
    const expected = { status: 'survived', nrOfTests: 1 };
    const worker = new RetryRejectedDecorator(logger, () => ({ async init() {}, async mutantRun() { return expected; } }));
    await worker.init();
    reporter.onDryRunCompleted(dryRun);
    reporter.onMutationTestingPlanReady({ mutantPlans: [runPlan('a')] });
    assert.strictEqual(await worker.mutantRun({ activeMutant: { id: 'a' } }), expected);
    assert.equal(campaign.snapshot().state, 'partial');
  } finally { reporter.wrapUp(); }
});

test('successful empty and dry-run-only paths complete and release the optional reporter', () => {
  for (const options of [{ allowEmpty: true }, { dryRunOnly: true }]) {
    const campaign = new CampaignEta({ scopes: [{ id: 'empty' }] });
    const reporter = createEtaReporter({ campaign, scopeId: 'empty', ...options });
    reporter.onDryRunCompleted({ ...dryRun, result: { tests: [] } });
    assert.equal(campaign.snapshot().state, 'complete');
    reporter.wrapUp();
  }
});

test('small actual Node/Bun compatibility and native fixture preserve keyed mutation reports', { timeout: 120_000 }, (t) => {
  if (!bunAvailable) t.diagnostic('Bun unavailable; Node/native fixture contracts still run');
  mkdirSync('artifacts/eta-release', { recursive: true });
  const receipts = [];
  for (const [runtime, modes] of [[process.execPath, ['compat', 'native', 'sdk']], ...(bunAvailable ? [['bun', ['compat']]] : [])]) {
    for (const mode of modes) {
      const results = [];
      for (const enabled of ['off', 'on']) {
        const result = spawnSync(runtime, ['test/fixtures/eta-run.js', mode, enabled], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CARGO_BUILD_JOBS: '1' } });
        assert.equal(result.status, 0, `${runtime} ${mode} ${enabled}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
        const line = result.stdout.split('\n').find((line) => line.startsWith('ETA_FIXTURE:'));
        assert.ok(line, result.stdout);
        const receipt = JSON.parse(line.slice('ETA_FIXTURE:'.length));
        results.push(receipt); receipts.push(receipt);
      }
      assert.deepEqual(results[1].identities, results[0].identities, `${runtime} ${mode}: ETA changed identities/replacements/statuses`);
    }
  }
  writeFileSync('artifacts/eta-release/fixture-receipts.json', JSON.stringify(receipts, null, 2));
});

test('opt-in native CLI and built-in Node/Bun reporter show ETA and retain JSON reports', { timeout: 60_000 }, (t) => {
  if (!bunAvailable) t.diagnostic('Bun unavailable; Node/native CLI contracts still run');
  const receipts = [];
  for (const [runtime, native] of [[process.execPath, true], [process.execPath, false], ...(bunAvailable ? [['bun', false]] : [])]) {
    const cwd = resolve(`artifacts/eta-release/cli-${native ? 'native' : 'compat'}-${runtime === 'bun' ? 'bun' : 'node'}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
    writeFileSync(join(cwd, 'add.js'), 'export function add(a,b){return a+b;}');
    writeFileSync(join(cwd, 'test.mjs'), "import assert from 'node:assert/strict';import {add} from './add.js';assert.equal(add(2,3),5);");
    writeFileSync(join(cwd, 'stryker.config.json'), JSON.stringify({ testRunner: 'command',
      plugins: native ? [] : [pathToFileURL(resolve('lib/eta-reporter.js')).href], appendPlugins: [], checkers: [],
      reporters: native ? ['json'] : ['json', 'rust-eta'], jsonReporter: { fileName: 'mutation.json' },
      mutate: ['add.js'], concurrency: 1, coverageAnalysis: 'off', cleanTempDir: 'always', logLevel: 'info',
      commandRunner: { command: `"${runtime}" test.mjs` },
    }));
    const result = spawnSync(runtime, [resolve('bin/stryker-rust.js'), 'run'], { cwd, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, STRYKER_RUST_COORDINATOR_ENGINE: native ? 'native' : 'upstream', STRYKER_RUST_ETA: '1' } });
    assert.equal(result.status, 0, `${runtime} native=${native}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /ETA unknown/);
    assert.match(output, /ETA complete/);
    const report = JSON.parse(readFileSync(join(cwd, 'mutation.json'), 'utf8'));
    const mutants = Object.values(report.files).flatMap((file) => file.mutants);
    assert.equal(mutants.length, 2);
    assert.ok(mutants.every((mutant) => mutant.status === 'Killed'));
    receipts.push({ runtime, native, mutants: mutants.length, output });
  }
  writeFileSync('artifacts/eta-release/cli-receipts.json', JSON.stringify(receipts, null, 2));
});

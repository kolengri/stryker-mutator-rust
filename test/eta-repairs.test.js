import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { CampaignEta } from '../lib/eta.js';
import { createEtaReporter } from '../lib/eta-reporter.js';
import { runNativeMutationTest } from '../lib/runtime.js';
import { RetryRejectedDecorator } from '../node_modules/@stryker-mutator/core/dist/src/test-runner/retry-rejected-decorator.js';
import { assertProcessStopped } from './helpers.js';

const artifacts = resolve('artifacts/eta-release/repairs-r1');
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0;
const logger = { info() {}, debug() {} };
const hostile = { get message() { throw null; }, [Symbol.toPrimitive]() { throw undefined; } };

test('each first reporter callback failure is quarantined before execution and never replayed', async () => {
  for (const name of ['onEvent', 'onEstimate', 'write']) {
    let calls = 0;
    const campaign = new CampaignEta({ scopes: [{ id: 'first' }] });
    const reporter = createEtaReporter({ campaign, scopeId: 'first', [name]() { calls++; throw hostile; } });
    try {
      const expected = { status: 'survived', nrOfTests: 1 };
      let executions = 0;
      const worker = new RetryRejectedDecorator(logger, () => ({ async init() {}, async mutantRun() { executions++; return expected; } }));
      await worker.init();
      reporter.onDryRunCompleted({ timing: { net: 10, overhead: 0 } });
      reporter.onMutationTestingPlanReady({ mutantPlans: [{ plan: 'Run', mutant: { id: 'a' }, netTime: 10, runOptions: { timeout: 100 } }] });
      assert.strictEqual(await worker.mutantRun({ activeMutant: { id: 'a' } }), expected);
      assert.equal(executions, 1);
      assert.equal(calls, 1, `${name} must not be retried as error reporting`);
      assert.notEqual(campaign.snapshot().state, 'complete');
      // First failure has already released the subscription, before manual cleanup.
      const next = createEtaReporter();
      next.dispose();
    } finally { reporter.dispose(); reporter.wrapUp(); }
  }
});

test('reporter configuration and campaign errors still throw and release any acquired owner', () => {
  assert.throws(() => createEtaReporter({ intervalMs: -1 }), /intervalMs/);
  assert.throws(() => createEtaReporter({ concurrency: 0 }), /concurrency/);
  assert.throws(() => createEtaReporter({ onEstimate: 1 }), /onEstimate/);
  const campaign = new CampaignEta({ scopes: [{ id: 'existing' }] });
  assert.throws(() => createEtaReporter({ campaign, scopeId: 'missing' }), /Unknown ETA scope/);
  const next = createEtaReporter();
  next.dispose();
});

test('first asynchronous observer rejection is consumed without aborting reporter construction', async () => {
  const reporter = createEtaReporter({ onEstimate: () => Promise.reject(undefined) });
  reporter.dispose();
  await delay(0); // Let Node's unhandled-rejection detection observe the promise.
});

test('actual built-in reporter belongs to its Stryker injector after failed and early runs', { timeout: 45_000 }, async (t) => {
  const receipts = [];
  for (const runtime of [process.execPath, ...(bunAvailable ? ['bun'] : [])]) {
    const result = spawnSync(runtime, ['test/fixtures/eta-owner-recovery.js'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${runtime}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    const line = result.stdout.split('\n').find((line) => line.startsWith('ETA_OWNER:'));
    assert.ok(line, result.stdout);
    receipts.push(JSON.parse(line.slice('ETA_OWNER:'.length)));
  }
  if (!bunAvailable) t.diagnostic('Bun unavailable; actual Node owner recovery still runs');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'owner-receipts.json'), JSON.stringify(receipts, null, 2));
});

async function nativeProject(t) {
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, 'native-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'test.mjs'), 'process.exitCode = 0;');
  await writeFile(join(cwd, 'stryker.config.json'), JSON.stringify({
    testRunner: 'command', plugins: [], appendPlugins: [], checkers: [], coverageAnalysis: 'off',
    mutate: [], allowEmpty: true, reporters: [], cleanTempDir: 'always', logLevel: 'off',
    commandRunner: { command: `"${process.execPath}" test.mjs` }, concurrency: 1,
  }));
  return cwd;
}

test('native observers isolate arbitrary thrown values on first and final callbacks', { timeout: 25_000 }, async (t) => {
  const cwd = await nativeProject(t);
  const expected = await runNativeMutationTest({ cwd });
  assert.equal(expected.supported, true);
  const receipts = [];
  for (const [label, value] of [['null', null], ['undefined', undefined], ['hostile error-like object', hostile]]) {
    for (const phase of ['initial', 'final']) {
      const campaign = new CampaignEta({ scopes: [{ id: 'native' }] });
      let calls = 0;
      const result = await runNativeMutationTest({ cwd }, { eta: { campaign, scopeId: 'native', intervalMs: 10,
        onEstimate(estimate) { calls++; if ((phase === 'initial' && calls === 1) || (phase === 'final' && estimate.state === 'complete')) throw value; },
      } });
      assert.deepEqual(result.mutants, expected.mutants);
      assert.equal(result.exitCode, expected.exitCode);
      assert.equal(result.eta.state, 'complete');
      assert.equal(typeof result.etaError, 'string');
      assert.ok(result.etaError.length > 0);
      receipts.push({ label, phase, error: result.etaError, completed: result.eta.state });
    }
  }
  const campaign = new CampaignEta({ scopes: [{ id: 'async' }] });
  const result = await runNativeMutationTest({ cwd }, { eta: { campaign, scopeId: 'async', onEstimate: () => Promise.reject(null) } });
  assert.match(result.etaError, /synchronous/);
  await delay(0);
  await writeFile(join(artifacts, 'native-callback-receipts.json'), JSON.stringify(receipts, null, 2));
});

test('actual native Bun on/off runs preserve ordered identities, replacements and statuses', { timeout: 45_000, skip: !bunAvailable }, async () => {
  const receipts = [];
  for (const enabled of ['off', 'on']) {
    const result = spawnSync('bun', ['test/fixtures/eta-run.js', 'native', enabled], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    const line = result.stdout.split('\n').find((line) => line.startsWith('ETA_FIXTURE:'));
    assert.ok(line, result.stdout);
    receipts.push(JSON.parse(line.slice('ETA_FIXTURE:'.length)));
  }
  assert.deepEqual(receipts[1].orderedIdentities, receipts[0].orderedIdentities);
  assert.equal(receipts[1].orderedIdentities.length, 2);
  await writeFile(join(artifacts, 'native-bun-receipts.json'), JSON.stringify(receipts, null, 2));
});

test('cancellation with ETA and throwing interval callbacks preserves reason and child cleanup', { timeout: 20_000, skip: process.platform === 'win32' }, async (t) => {
  for (const enabled of [false, true]) {
    const cwd = await nativeProject(t);
    const pidFile = join(cwd, 'pids.json');
    await writeFile(join(cwd, 'test.mjs'), `
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`);
    const controller = new AbortController();
    const reason = new Error('ETA cancellation fixture');
    const campaign = new CampaignEta({ scopes: [{ id: 'cancel' }] });
    let calls = 0;
    const pending = runNativeMutationTest({ cwd }, { signal: controller.signal,
      ...(enabled ? { eta: { campaign, scopeId: 'cancel', intervalMs: 10, onEstimate() { calls++; throw calls === 1 ? null : hostile; } } } : {}),
    }).then((value) => ({ value }), (error) => ({ error }));
    let pids;
    let settled;
    try {
      const deadline = AbortSignal.timeout(5000);
      while (!pids || (enabled && calls < 2)) {
        deadline.throwIfAborted();
        try { pids = JSON.parse(await readFile(pidFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (!pids || (enabled && calls < 2)) await delay(10, undefined, { signal: deadline });
      }
    } finally { controller.abort(reason); settled = await pending; }
    assert.strictEqual(settled.error, reason);
    assert.equal(pids.length, 2);
    for (const pid of pids) assertProcessStopped(pid);
    assert.ok(!(await readdir(cwd)).includes('.stryker-tmp'));
    if (enabled) {
      assert.notEqual(campaign.snapshot().state, 'complete');
      const stopped = calls;
      await delay(30);
      assert.equal(calls, stopped, 'ETA interval must stop with native ownership');
    }
  }
});

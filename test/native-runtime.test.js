import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runNativeMutationTest } from '../lib/runtime.js';
import { assertProcessStopped } from './helpers.js';

async function project(t, script = '') {
  const suffix = process.platform === 'win32' ? ' Windows spaces & paths' : '';
  const directory = resolve('artifacts/native-runtime/public-api', `${process.pid}-${randomUUID()}${suffix}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'test.mjs'), script);
  await writeFile(join(directory, 'stryker.config.json'), JSON.stringify({
    testRunner: 'command', plugins: [], appendPlugins: [], checkers: [], coverageAnalysis: 'off',
    commandRunner: { command: `${quote(process.execPath)} test.mjs` },
    mutate: [], allowEmpty: true, reporters: [], cleanTempDir: 'always', logLevel: 'off',
  }));
  return directory;
}

const quote = (value) => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;

test('public native pre-abort preserves the reason without running a command or creating a sandbox', async (t) => {
  const cwd = await project(t, "throw new Error('must not execute');");
  const controller = new AbortController();
  const reason = new Error('cancelled before enqueue');
  controller.abort(reason);
  await assert.rejects(runNativeMutationTest({ cwd }, { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual((await readdir(cwd)).sort(), ['package.json', 'stryker.config.json', 'test.mjs']);
});

test('public native requests do not invoke configuration accessors', async () => {
  let reads = 0;
  const request = Object.defineProperty({}, 'cwd', { enumerable: true, get() { reads++; return process.cwd(); } });
  await assert.rejects(runNativeMutationTest(request), /plain JSON/);
  assert.equal(reads, 0);
});

test('public unsupported preflight never starts user code or creates reports and sandboxes', async (t) => {
  const cwd = await project(t, "throw new Error('must not execute');");
  const result = await runNativeMutationTest({ cwd, overrides: { reporters: ['unimplemented-reporter'] } });
  assert.equal(result.supported, false);
  assert.equal(typeof result.reason, 'string');
  assert.deepEqual((await readdir(cwd)).sort(), ['package.json', 'stryker.config.json', 'test.mjs']);
});

if (process.platform !== 'win32') {
  test('public abort keeps Node responsive and settles after descendants stop and sandbox cleanup finishes', { timeout: 15000 }, async (t) => {
    const cwd = await project(t);
    const pidFile = join(cwd, 'children.json');
    await writeFile(join(cwd, 'test.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const reason = new Error('public cancellation reason');
    const pending = runNativeMutationTest({ cwd }, { signal: controller.signal });
    // Observe the rejection immediately, including if startup unexpectedly fails.
    const settled = pending.then((value) => ({ value }), (error) => ({ error }));
    const started = performance.now();
    let pids;
    let result;
    try {
      while (performance.now() - started < 10000) {
        try {
          pids = JSON.parse(await readFile(pidFile, 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(10);
      }
      assert.equal(pids?.length, 2, 'Node must keep handling timers/files while Rust runs the baseline');
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0), 'Both command processes must have started');
      const sibling = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      try {
        assert.deepEqual(await once(sibling, 'close', { signal: AbortSignal.timeout(5000) }), [0, null], 'Tokio must preserve Node child-process completion');
      } finally {
        if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGKILL');
      }
    } finally {
      controller.abort(reason);
      result = await settled;
    }
    assert.equal(result.error, reason, 'AbortSignal reason is preserved after native cleanup');
    assert.ok(!(await readdir(cwd)).includes('.stryker-tmp'), 'Promise settled before sandbox cleanup');
    for (const pid of pids) assertProcessStopped(pid);
    const recovered = await runNativeMutationTest({ cwd, overrides: { commandRunner: { command: ':' } } });
    assert.equal(recovered.supported, true);
    assert.equal(recovered.stats.coordinator, 'rust');
    assert.equal(recovered.stats.commandStarts, 1);
  });
}

if (process.platform === 'win32') {
  test('public Windows abort awaits root and grandchildren exit and junction cleanup while preserving dependency targets', { timeout: 20000 }, async (t) => {
    const cwd = await project(t);
    const sentinel = join(cwd, 'node_modules', 'original-sentinel');
    await mkdir(join(cwd, 'node_modules'));
    await writeFile(sentinel, 'dependency target must survive');
    const pidFile = join(cwd, 'children.json');
    const branch = `
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([Number(process.argv[1]), process.pid, leaf.pid]));
setInterval(() => {}, 1000);
`;
    await writeFile(join(cwd, 'test.mjs'), `
import {spawn} from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(branch)}, String(process.pid)], {stdio:'ignore'});
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const reason = new Error('Windows public cancellation reason');
    const settled = runNativeMutationTest({ cwd }, { signal: controller.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    let pids;
    let result;
    try {
      const started = performance.now();
      while (performance.now() - started < 12000) {
        try {
          pids = JSON.parse(await readFile(pidFile, 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(10);
      }
      assert.equal(pids?.length, 3, 'Root, child and grandchild must start while Node remains responsive');
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    } finally {
      controller.abort(reason);
      result = await settled;
    }
    assert.equal(result.error, reason, 'AbortSignal reason follows native tree and sandbox cleanup');
    assert.ok(!(await readdir(cwd)).includes('.stryker-tmp'), 'Promise settled before junction/sandbox cleanup');
    assert.equal(await readFile(sentinel, 'utf8'), 'dependency target must survive');
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', `Process ${pid} remains active after settlement`);
    }
    const recovered = await runNativeMutationTest({ cwd, overrides: { commandRunner: { command: 'exit /B 0' } } });
    assert.equal(recovered.supported, true);
    assert.equal(recovered.stats.coordinator, 'rust');
    assert.equal(recovered.stats.commandStarts, 1);
    assert.equal(await readFile(sentinel, 'utf8'), 'dependency target must survive');
  });
}


// These guards run in fresh real processes: this test file's module cache must
// not hide an SDK import from the native JSON command boundary.
const lazyRoot = fileURLToPath(new URL('../', import.meta.url));
const lazyArtifacts = join(lazyRoot, 'artifacts/caller-config-handshake/lazy-json');
const lazyRequire = createRequire(import.meta.url);

async function lazyProcess(t, name, args, options) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  await writeFile(join(lazyArtifacts, `${name}.log`), output);
  return { exit, output };
}

test('native JSON command CLI, public wrapper and readiness keep upstream core/API/util outside the graph', { timeout: 60000 }, async (t) => {
  await mkdir(lazyArtifacts, { recursive: true });
  const cwd = await mkdtemp(join(lazyArtifacts, 'json-project-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await cp(join(lazyRoot, 'fixtures/native-command'), cwd, { recursive: true });
  const source = await readFile(join(cwd, 'src/calculator.js'), 'utf8');
  const guard = join(lazyArtifacts, 'forbid-json-sdk.mjs');
  const helperURL = new URL('../lib/config-compat.js', import.meta.url).href;
  await writeFile(guard, `import { registerHooks } from 'node:module';
const packages = ['@stryker-mutator/core', '@stryker-mutator/api', '@stryker-mutator/util'];
registerHooks({ resolve(specifier, context, nextResolve) {
  if (packages.some(name => specifier === name || specifier.startsWith(name + '/'))) {
    throw new Error('Unnecessary native JSON dependency: ' + specifier);
  }
  const result = nextResolve(specifier, context);
  const url = decodeURIComponent(result.url).replaceAll('\\\\', '/');
  if (result.url === ${JSON.stringify(helperURL)} || packages.some(name => url.includes('/' + name + '/'))) {
    throw new Error('Unnecessary native JSON dependency URL: ' + result.url);
  }
  return result;
} });
`);
  const guarded = {
    ...process.env,
    STRYKER_RUST_COORDINATOR_ENGINE: 'native', STRYKER_RUST_DIAGNOSTICS: '1',
    // Inherited by baseline/mutant Node children as well as the caller.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guard).href}`.trim(),
  };
  const negative = await lazyProcess(t, 'guard-negative-control', ['--input-type=module', '-e', "await import('@stryker-mutator/api/core')"], { cwd, env: guarded });
  assert.notEqual(negative.exit.code, 0);
  assert.match(negative.output, /Unnecessary native JSON dependency/);
  const ready = await lazyProcess(t, 'guarded-readiness', [join(lazyRoot, 'bin/stryker-rust.js'), '--rust-info'], { cwd, env: guarded });
  assert.deepEqual(ready.exit, { code: 0, signal: null }, ready.output);
  assert.equal(JSON.parse(ready.output).nativeCoordinator, true);

  const publicEntry = join(lazyArtifacts, 'public-json.mjs');
  await writeFile(publicEntry, `import assert from 'node:assert/strict';
import { runNativeMutationTest } from ${JSON.stringify(new URL('../lib/runtime.js', import.meta.url).href)};
const result = await runNativeMutationTest();
assert.equal(result.supported, true, result.reason);
assert.equal(result.stats.coordinator, 'rust');
assert.equal(result.stats.compatibilityCalls, 0);
console.log(JSON.stringify(result.stats));
`);
  const upstream = join(dirname(lazyRequire.resolve('@stryker-mutator/core/package.json')), 'bin/stryker.js');
  const canonical = report => ({ ...report, files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
    ...file, mutants: [...file.mutants].sort((a, b) => a.id.localeCompare(b.id)),
  }])) });
  const reports = [];
  for (const [name, entry, env] of [
    ['json-upstream', upstream, { ...process.env, STRYKER_RUST_COORDINATOR_ENGINE: 'upstream' }],
    ['json-native-cli', join(lazyRoot, 'bin/stryker-rust.js'), guarded],
    ['json-native-public', publicEntry, guarded],
  ]) {
    await rm(join(cwd, 'reports'), { recursive: true, force: true });
    const result = await lazyProcess(t, name, [entry, 'run'], { cwd, env });
    assert.deepEqual(result.exit, { code: 0, signal: null }, result.output);
    const report = JSON.parse(await readFile(join(cwd, 'reports/mutation.json'), 'utf8'));
    await writeFile(join(lazyArtifacts, `${name}.json`), JSON.stringify(report, null, 2));
    reports.push(canonical(report));
    assert.equal(await readFile(join(cwd, 'src/calculator.js'), 'utf8'), source);
    if (name !== 'json-upstream') assert.match(result.output, /"coordinator":"rust"/);
  }
  assert.deepEqual(reports[1], reports[0]);
  assert.deepEqual(reports[2], reports[0]);
  const mutants = Object.values(reports[0].files).flatMap(file => file.mutants);
  assert.ok(mutants.some(mutant => mutant.status === 'Killed'));
  assert.ok(mutants.some(mutant => mutant.status === 'Survived'));
  await writeFile(join(lazyArtifacts, 'json-graph-receipt.json'), JSON.stringify({ reportsEqual: true, guardedCLI: true, guardedPublicWrapper: true, guardedReadiness: true, descendantsGuarded: true, negativeControlRejected: true, mutants: mutants.length, sourcePreserved: true, timingClaim: 'None' }, null, 2));
});

test('abort during a real helper dependency import retains ownership and skips user config after settlement', { timeout: 15000 }, async (t) => {
  await mkdir(lazyArtifacts, { recursive: true });
  const cwd = await mkdtemp(join(lazyArtifacts, 'helper-abort-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = {
    testRunner: 'command', plugins: [], appendPlugins: [], checkers: [], coverageAnalysis: 'off',
    commandRunner: { command: `${quote(process.execPath)} -e ""` },
    mutate: [], allowEmpty: true, reporters: [], cleanTempDir: 'always', logLevel: 'off',
  };
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'stryker.config.json'), JSON.stringify(options));
  await writeFile(join(cwd, 'user.mjs'), `globalThis.lazyUserConfigEvaluated = true; export default ${JSON.stringify(options)};`);
  const gate = join(lazyArtifacts, 'helper-dependency-gate.mjs');
  await writeFile(gate, `globalThis.lazyHelperDependencyPending = true;
await new Promise(resolve => { globalThis.releaseLazyHelperDependency = resolve; });
`);
  const caller = join(lazyArtifacts, 'helper-abort-caller.mjs');
  await writeFile(caller, `import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Evaluate the real pinned SDK source under its original URL and cache identity.
// Append only a test TLA dependency; no source/exports are replaced by a mock.
const hook = registerHooks({ load(url, context, nextLoad) {
  const actual = nextLoad(url, context);
  if (!decodeURIComponent(url).endsWith('/@stryker-mutator/api/dist/src/core/stryker-options-schema.js')) return actual;
  const source = typeof actual.source === 'string' ? actual.source : Buffer.from(actual.source).toString('utf8');
  return { ...actual, source: source + '\\nawait import(' + ${JSON.stringify(JSON.stringify(pathToFileURL(gate).href))} + ');' };
} });
const { runNativeMutationTest } = await import(${JSON.stringify(new URL('../lib/runtime.js', import.meta.url).href)});
const controller = new AbortController();
const reason = new Error('cancel while helper dependencies load');
let settled = false;
const pending = runNativeMutationTest({ args: ['user.mjs'] }, { signal: controller.signal })
  .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
try {
  while (!globalThis.lazyHelperDependencyPending) {
    assert.equal(settled, false, 'Executable preparation must request its helper dependency');
    await new Promise(setImmediate);
  }
  controller.abort(reason);
  await assert.rejects(runNativeMutationTest(), /exclusive native run ownership/);
  await new Promise(setImmediate);
  assert.equal(settled, false, 'Import cancellation must not release ownership before helper settlement');
  assert.equal(globalThis.lazyUserConfigEvaluated, undefined);
} finally { globalThis.releaseLazyHelperDependency?.(); }
assert.equal((await pending).error, reason);
assert.equal(globalThis.lazyUserConfigEvaluated, undefined, 'Abort after helper dependency import must skip user config');
hook.deregister();
const recovered = await runNativeMutationTest();
assert.equal(recovered.supported, true, recovered.reason);
assert.equal(recovered.stats.coordinator, 'rust');
console.log(JSON.stringify({ helperImportAwaited: true, ownershipHeldUntilSettlement: true, userConfigSkipped: true, cancellationReasonPreserved: true, jsonRecovered: true }));
`);
  const result = await lazyProcess(t, 'helper-import-abort', [caller], { cwd });
  assert.deepEqual(result.exit, { code: 0, signal: null }, result.output);
  assert.match(result.output, /"userConfigSkipped":true/);
});

test('concurrent JSON worker runs capture distinct caller env copies and preserve main environment', { timeout: 15000 }, async (t) => {
  const { Worker } = await import('node:worker_threads');
  const previous = process.env.CCE_JSON_MAIN;
  process.env.CCE_JSON_MAIN = 'main-only';
  t.after(() => { if (previous === undefined) delete process.env.CCE_JSON_MAIN; else process.env.CCE_JSON_MAIN = previous; });
  const workers = [];
  for (const id of ['json-a', 'json-b']) {
    const cwd = await project(t, `
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.CCE_JSON_VALUE, ${JSON.stringify(id)});
assert.equal(process.env.CCE_JSON_MAIN, undefined);
const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`if(process.env.CCE_JSON_VALUE!==${JSON.stringify(id)}||'CCE_JSON_MAIN' in process.env) process.exit(4);`)}]);
assert.equal(child.status, 0);
await new Promise(resolve => setTimeout(resolve, 50));
`);
    const worker = new Worker(`
const {parentPort,workerData} = require('node:worker_threads');
process.env.CCE_JSON_VALUE=workerData.id; delete process.env.CCE_JSON_MAIN;
import(workerData.url).then(async ({runNativeMutationTest})=>{
  parentPort.postMessage({ready:true});
  await new Promise(resolve=>parentPort.once('message',resolve));
  try {parentPort.postMessage({result:await runNativeMutationTest({cwd:workerData.cwd})});}
  catch(error) {parentPort.postMessage({error:error.stack});}
});`, { eval: true, workerData: { id, cwd, url: new URL('../lib/runtime.js', import.meta.url).href } });
    t.after(() => worker.terminate());
    const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true);
    workers.push(worker);
  }
  const pending = workers.map(worker => once(worker, 'message'));
  for (const worker of workers) worker.postMessage('run');
  for (const [message] of await Promise.all(pending)) {
    assert.equal(message.error, undefined);
    assert.equal(message.result.supported, true, message.result.reason);
    assert.equal(message.result.stats.commandStarts, 1);
  }
  assert.equal(process.env.CCE_JSON_MAIN, 'main-only');
});

// Investigation only: this deliberately incomplete collector must never select mutants.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadNative, platformTarget } from '../lib/native.js';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.notEqual(process.platform, 'win32', 'These investigation probes use the existing POSIX command-runner contract');
const artifactRoot = resolve(root, process.env.STRYKER_RUST_BUN_ARTIFACTS ?? 'artifacts/native-runtime/bun-union/probes');
const owned = relative(join(root, 'artifacts', 'native-runtime', 'bun-union'), artifactRoot);
assert.ok(owned && !owned.startsWith('..') && !isAbsolute(owned), 'Use an owned bun-union artifact subdirectory');
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, 'run-'));
let requestedBun = process.env.BUN_BIN;
if (!requestedBun) {
  const located = spawnSync('bun', ['--no-env-file', '--print', 'process.execPath'], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(located.error);
  assert.equal(located.status, 0, located.stderr);
  requestedBun = located.stdout.trim();
}
assert.ok(isAbsolute(requestedBun), 'BUN_BIN or Bun process.execPath must be absolute');
const bun = realpathSync(requestedBun);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const probeConfigDirectory = join(artifacts, 'home');
mkdirSync(probeConfigDirectory, { recursive: true });
const environment = { ...process.env, HOME: probeConfigDirectory, XDG_CONFIG_HOME: probeConfigDirectory };
const excludedEnvironmentKeys = ['BUN_OPTIONS', 'NODE_OPTIONS', 'BUN_INSPECT_PRELOAD', 'BUN_TEST_DRAIN_EVENT_LOOP', '__STRYKER_ACTIVE_MUTANT__'];
for (const key of excludedEnvironmentKeys) delete environment[key];
const controlledEnvironmentKeys = ['HOME', 'XDG_CONFIG_HOME', ...excludedEnvironmentKeys];
const controlledEnvironment = Object.fromEntries(controlledEnvironmentKeys.map((key) => [key, environment[key] ?? null]));
write(join(artifacts, 'environment.json'), controlledEnvironment);
function tool(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: environment, ...options });
  assert.ifError(result.error);
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}
const revision = tool(bun, ['--revision']);
assert.equal(revision.status, 0);
assert.equal(revision.stdout.trim(), '1.4.3+c6da4a4d3', 'This proof is specific to Bun c6da4a4d3010e5553438c60f6bd76d981976867c');
const source = 'function answer() { return 20 + 22; }\nglobalThis.answer = answer;\n';
const instrumented = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files: [{ name: 'subject.js', content: source, mutate: true }], options: {} })));
assert.equal(instrumented.supported, true, JSON.stringify(instrumented));
const ids = instrumented.result.mutants.map((mutant) => mutant.id);
assert.equal(ids.length, 2, 'The proof must retain both its BlockStatement and ArithmeticOperator mutations');
write(join(artifacts, 'instrumentation.json'), instrumented);
const collector = `import { afterAll } from 'bun:test';
import { writeFileSync } from 'node:fs';
afterAll(() => {
  if (process.env.PROBE_SENTINEL === '1') {
    process.prependListener('exit', function ownedSentinel() {
      writeFileSync(process.env.PROBE_CONTROL, JSON.stringify({version:1, invalid:'exit listeners executed'}));
    });
  }
  writeFileSync(process.env.PROBE_PAYLOAD, JSON.stringify({version:1, scope:'wholeSuiteUnion', complete:true,
    counts:Object.entries(globalThis.__stryker__?.mutantCoverage?.static ?? {}),
    perTestKeys:Object.keys(globalThis.__stryker__?.mutantCoverage?.perTest ?? {})}));
});\n`;
const xmlInspector = `import json, sys, xml.etree.ElementTree as ET
from pathlib import Path
p=Path(sys.argv[1])
if not p.exists():
 print(json.dumps({'exists':False}));sys.exit(0)
r=ET.parse(p).getroot()
cases=list(r.iter('testcase'))
def reconciled(element):
 entries=list(element.iter('testcase'))
 counts={'tests':len(entries),'failures':len(list(element.iter('failure'))),
  'errors':len(list(element.iter('error'))),'skipped':len(list(element.iter('skipped')))}
 return all(int(element.attrib.get(key,0))==value for key,value in counts.items())
print(json.dumps({'exists':True,'validXml':True,'root':r.tag,'attributes':r.attrib,
 'testcases':len(cases),'failures':len(list(r.iter('failure'))),'errors':len(list(r.iter('error'))),
 'skipped':len(list(r.iter('skipped'))),'suites':[x.attrib for x in r.iter('testsuite')],
 'countAccounting':reconciled(r) and all(reconciled(s) for s in r.iter('testsuite'))}))
`;
const results = [];
function probe(name, test, { files = {}, before = [], after = [], env = {}, expectedExit = 0 } = {}) {
  // Unique, fresh paths for every run; user output is retained only as diagnostics.
  const directory = join(artifacts, name);
  mkdirSync(directory, { recursive: false });
  write(join(directory, 'bunfig.toml'), '');
  write(join(directory, 'package.json'), '{"type":"module"}\n');
  write(join(directory, 'subject.js'), instrumented.result.files[0].content);
  write(join(directory, 'collector.mjs'), collector);
  write(join(directory, 'test.test.js'), test);
  for (const [file, content] of Object.entries(files)) write(join(directory, file), content);
  const payload = join(directory, 'coverage.json');
  const control = join(directory, 'control.json');
  const junit = join(directory, 'junit.xml');
  const args = ['--no-env-file', 'test', '--config', join(directory, 'bunfig.toml'), ...before,
    '--preload', join(directory, 'collector.mjs'), ...after, '--reporter=junit', '--reporter-outfile', junit, './test.test.js'];
  const run = tool(bun, args, { cwd: directory, env: { ...environment, PROBE_PAYLOAD: payload, PROBE_CONTROL: control, ...env } });
  write(join(directory, 'stdout.log'), run.stdout);
  write(join(directory, 'stderr.log'), run.stderr);
  write(join(directory, 'invocation.json'), { executable: bun, args, env, controlledEnvironment, ...run });
  assert.equal(run.signal, null, `${name}: ${run.stderr}`);
  assert.equal(run.status, expectedExit, `${name}: ${run.stderr}`);
  const inspect = tool('python3', ['-c', xmlInspector, junit]);
  assert.equal(inspect.status, 0, inspect.stderr);
  const jsonIfPresent = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const result = { name, status: run.status, junit: JSON.parse(inspect.stdout), payload: jsonIfPresent(payload), control: jsonIfPresent(control),
    realm: jsonIfPresent(join(directory, 'realm.json')), late: jsonIfPresent(join(directory, 'late.json')) };
  results.push(result);
  write(join(directory, 'evidence.json'), result);
  return result;
}
const ordinary = `import { test, expect } from 'bun:test';
test('passes', () => expect(true).toBe(true));
test.skip('retained skip', () => { throw new Error('must stay skipped'); });\n`;
const empty = probe('unused', ordinary);
assert.deepEqual(empty.payload.counts, []);
assert.equal(empty.junit.testcases, 2);
assert.equal(empty.junit.skipped, 1);
const covered = probe('covered', `import { test, expect } from 'bun:test';
import './subject.js';
test('covers answer', () => expect(globalThis.answer()).toBe(42));\n`);
assert.deepEqual(covered.payload.counts.map(([id]) => id).sort(), [...ids].sort());

const vmTest = `import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
test('covers answer in another realm', () => {
  const context = { process: { env: process.env } };
  const value = runInNewContext(readFileSync('./subject.js', 'utf8') + '\\nanswer()', context);
  writeFileSync('./realm.json', JSON.stringify({value, counts:Object.entries(context.__stryker__?.mutantCoverage?.static ?? {})}));
  expect(value).toBe(42);
});\n`;
const vm = probe('vm-covered', vmTest, { env: { PROBE_SENTINEL: '1' } });
assert.deepEqual(vm.payload.counts, []);
assert.equal(vm.control, null);
assert.equal(vm.junit.failures + vm.junit.errors, 0);
assert.equal(vm.junit.countAccounting, true);
assert.deepEqual(vm.realm.counts.map(([id]) => id).sort(), [...ids].sort());

const workerTest = `import { test, expect } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
test('covers answer in a worker', async () => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  await worker.terminate();
  writeFileSync('./realm.json', JSON.stringify(result));
  expect(result.value).toBe(42);
});\n`;
const workerFiles = { 'worker.mjs': `import { parentPort } from 'node:worker_threads';
import './subject.js';
parentPort.postMessage({value:globalThis.answer(), counts:Object.entries(globalThis.__stryker__?.mutantCoverage?.static ?? {})});\n` };
const worker = probe('worker-covered', workerTest, { files: workerFiles });
assert.deepEqual(worker.payload.counts, []);
assert.equal(worker.junit.countAccounting, true);
assert.deepEqual(worker.realm.counts.map(([id]) => id).sort(), [...ids].sort());

function assertExpectedValueFailure(output, received) {
  const diagnostic = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.doesNotMatch(diagnostic, /TypeError:/, diagnostic);
  assert.match(diagnostic, /error: expect\(received\)\.toBe\(expected\)/);
  assert.match(diagnostic, /Expected: 42\s/);
  assert.ok(diagnostic.includes(`Received: ${received}\n`), diagnostic);
  assert.match(diagnostic, /\(fail\) covers answer in (?:another realm|a worker)/);
}
const block = instrumented.result.mutants.find((mutant) => mutant.mutatorName === 'BlockStatement');
assert.ok(block, 'Exercise the Worker diagnostic with an active empty function body');
const workerBlock = probe('worker-block-assertion', workerTest, {
  files: workerFiles, env: { __STRYKER_ACTIVE_MUTANT__: block.id }, expectedExit: 1,
});
assert.deepEqual(workerBlock.realm.counts, []);
assertExpectedValueFailure(readFileSync(join(artifacts, 'worker-block-assertion', 'stderr.log'), 'utf8'), 'undefined');

const hook = `import { afterAll } from 'bun:test';
import './subject.js';
afterAll(() => { if (globalThis.answer() !== 42) throw new Error('teardown mutation'); });\n`;
const ordered = probe('preload-teardown', ordinary, { files: { 'user.mjs': hook }, before: ['--preload', './user.mjs'] });
assert.deepEqual(ordered.payload.counts.map(([id]) => id).sort(), [...ids].sort());
const alias = probe('alias-teardown-after-collector', ordinary, { files: { 'user.mjs': hook }, before: ['--import', './user.mjs'] });
assert.deepEqual(alias.payload.counts, []);
assert.equal(alias.junit.failures + alias.junit.errors, 0);

const exitSetup = `import './subject.js';
import { writeFileSync } from 'node:fs';
process.on('exit', () => {
  const value = globalThis.answer();
  writeFileSync('./late.json', JSON.stringify({value, counts:Object.entries(globalThis.__stryker__.mutantCoverage.static)}));
  if (value !== 42) process.exitCode = 17;
});\n`;
const skippedExit = probe('default-exit-listeners-skipped', `${exitSetup}\n${ordinary}`, { env: { PROBE_SENTINEL: '1' } });
assert.equal(skippedExit.control, null);
assert.equal(skippedExit.late, null);
const nodeTest = `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
test('node mode', () => assert.equal(1, 1));\n`;
for (const [name, body, env] of [
  ['node-test-late-exit', `${exitSetup}\n${nodeTest}`, {}],
  ['drain-late-exit', `${exitSetup}\n${ordinary}`, { BUN_TEST_DRAIN_EVENT_LOOP: '1' }],
]) {
  const late = probe(name, body, { env: { PROBE_SENTINEL: '1', ...env } });
  assert.deepEqual(late.payload.counts, []);
  assert.equal(late.control.invalid, 'exit listeners executed');
  assert.equal(late.late.value, 42);
}
for (const sentinel of ['0', '1']) {
  const custom = probe(`custom-exit-code-sentinel-${sentinel}`, `import { test } from 'node:test';
test('custom exit code', () => { process.on('exit', () => { process.exitCode = 7; }); });\n`, {
    env: { PROBE_SENTINEL: sentinel }, expectedExit: 7,
  });
  assert.equal(custom.junit.validXml, true);
  assert.equal(custom.control?.invalid ?? null, sentinel === '1' ? 'exit listeners executed' : null);
}
const removedBeforeCollector = probe('remove-listeners-before-collector', `import { test } from 'node:test';
test('removes listeners before the collector', () => { process.removeAllListeners('exit'); });\n`, { env: { PROBE_SENTINEL: '1' } });
assert.equal(removedBeforeCollector.control.invalid, 'exit listeners executed');
const removalHook = `import { afterAll } from 'bun:test';
import './subject.js';
import { writeFileSync } from 'node:fs';
afterAll(() => {
  process.removeAllListeners('exit');
  process.on('exit', () => {
    const value = globalThis.answer();
    writeFileSync('./late.json', JSON.stringify({value, counts:Object.entries(globalThis.__stryker__.mutantCoverage.static)}));
    if (value !== 42) process.exitCode = 17;
  });
});\n`;
const removed = probe('alias-removes-sentinel', nodeTest, { files: { 'user.mjs': removalHook }, before: ['--import', './user.mjs'], env: { PROBE_SENTINEL: '1' } });
assert.deepEqual(removed.payload.counts, []);
assert.equal(removed.control, null);
assert.equal(removed.late.value, 42);
assert.deepEqual(removed.late.counts.map(([id]) => id).sort(), [...ids].sort());

for (const [name, body] of [
  ['early-exit-file', `process.exit(0);\n${ordinary}`],
  ['early-exit-beforeAll', `import { beforeAll } from 'bun:test'; beforeAll(() => process.exit(0));\n${ordinary}`],
  ['early-exit-test', `import { test } from 'bun:test'; test('early', () => process.exit(0));\n`],
]) {
  const early = probe(name, body);
  assert.equal(early.junit.exists, false);
  assert.equal(early.payload, null);
}
const bail = probe('bail-partial', `import { test, expect } from 'bun:test';
test('fails', () => expect(1).toBe(2));
test('never reached', () => expect(true).toBe(true));\n`, { before: ['--bail=1'], expectedExit: 1 });
assert.equal(bail.junit.validXml, true);
assert.equal(bail.junit.testcases, 1);
assert.equal(bail.payload, null);
const unhandled = probe('unhandled-between-tests', `import { test, afterAll, expect } from 'bun:test';
test('passes', () => expect(1).toBe(1));
afterAll(() => { Promise.reject(new Error('unhandled between tests')); });\n`, { expectedExit: 1 });
assert.equal(unhandled.junit.validXml, true);

// Confirm the apparent "uncovered" VM mutations actually kill tests through the
// existing Rust execute-all path. This is not a competing coordinator.
const nativeProject = join(artifacts, 'rust-command-vm');
mkdirSync(nativeProject);
write(join(nativeProject, 'subject.js'), source);
write(join(nativeProject, 'test.test.js'), vmTest);
write(join(nativeProject, 'package.json'), '{"type":"module"}\n');
write(join(nativeProject, 'bunfig.toml'), '');
assert.ok(!/[\0\r\n']/.test(bun), 'Proof executable must admit simple POSIX shell quoting');
const nativeRequest = { cwd: nativeProject, overrides: {
  testRunner: 'command', plugins: [], coverageAnalysis: 'off', mutate: ['subject.js'],
  commandRunner: { command: `'${bun}' --no-env-file test --config ./bunfig.toml ./test.test.js` },
  reporters: [], concurrency: 1, timeoutMS: 5000, timeoutFactor: 0, cleanTempDir: 'always', logLevel: 'off',
} };
const requestPath = join(nativeProject, 'request.json');
const resultPath = join(nativeProject, 'result.json');
const childEnvironmentPath = join(nativeProject, 'environment.json');
const nativeDriver = join(artifacts, 'run-native.mjs');
write(requestPath, nativeRequest);
write(nativeDriver, `import { readFileSync, writeFileSync } from 'node:fs';
import { runNativeMutationTest } from ${JSON.stringify(pathToFileURL(join(root, 'lib/runtime.js')).href)};
const [requestPath, resultPath, environmentPath] = process.argv.slice(2);
const environment = Object.fromEntries(${JSON.stringify(controlledEnvironmentKeys)}.map((key) => [key, process.env[key] ?? null]));
writeFileSync(environmentPath, JSON.stringify(environment, null, 2));
const result = await runNativeMutationTest(JSON.parse(readFileSync(requestPath, 'utf8')));
writeFileSync(resultPath, JSON.stringify(result, null, 2));
`);
const nativeArgs = [nativeDriver, requestPath, resultPath, childEnvironmentPath];
const nativeRun = tool(process.execPath, nativeArgs, { cwd: nativeProject, env: environment });
write(join(nativeProject, 'stdout.log'), nativeRun.stdout);
write(join(nativeProject, 'stderr.log'), nativeRun.stderr);
write(join(nativeProject, 'invocation.json'), { executable: process.execPath, args: nativeArgs, cwd: nativeProject, controlledEnvironment, ...nativeRun });
assert.equal(nativeRun.signal, null, nativeRun.stderr);
assert.equal(nativeRun.status, 0, nativeRun.stderr);
assert.deepEqual(JSON.parse(readFileSync(childEnvironmentPath, 'utf8')), controlledEnvironment);
const native = JSON.parse(readFileSync(resultPath, 'utf8'));
assert.equal(native.supported, true, native.reason);
assert.equal(native.stats.coordinator, 'rust');
assert.equal(native.stats.compatibilityCalls, 0);
assert.equal(native.stats.commandStarts, ids.length + 1);
assert.equal(native.mutants.length, ids.length);
assert.ok(native.mutants.every((mutant) => mutant.status === 'Killed'), JSON.stringify(native.mutants));
const expectedReceived = { BlockStatement: 'undefined', ArithmeticOperator: '-2' };
const businessFailures = native.mutants.map((mutant) => {
  const received = expectedReceived[mutant.mutatorName];
  assert.ok(received, `Unexpected proof mutation: ${mutant.mutatorName}`);
  assertExpectedValueFailure(mutant.statusReason, received);
  return { id: mutant.id, mutatorName: mutant.mutatorName, expected: 42, received, assertionFailure: true, diagnosticTypeError: false };
});
write(join(nativeProject, 'business-failures.json'), businessFailures);
write(join(artifacts, 'summary.json'), { optimizationShipped: false, revision: revision.stdout.trim(), ids, results,
  rustExecuteAll: { commandStarts: native.stats.commandStarts, statuses: native.mutants.map(({ id, status }) => ({ id, status })), businessFailures,
    controlledEnvironmentVerified: true } });
const hashedFiles = ['src/instrument.rs', 'src/runtime.rs', 'src/runtime/config.rs', 'src/runtime/process.rs', 'src/runtime/project.rs', 'scripts/bun-union-proof.js', `native/stryker-rust.${platformTarget()}.node`];
write(join(artifacts, 'manifest.json'), { head: tool('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
  bun, bunRevision: revision.stdout.trim(), bunSha256: hash(readFileSync(bun)),
  files: Object.fromEntries(hashedFiles.map((file) => [file, hash(readFileSync(join(root, file)))])) });
console.log(`Proved two unsafe absence cases and retained ${results.length} Bun probe receipts. No coverage optimization was installed.`);
console.log(`Rust execute-all: ${native.mutants.length} Killed, ${native.stats.commandStarts} command starts.`);
console.log(artifacts);

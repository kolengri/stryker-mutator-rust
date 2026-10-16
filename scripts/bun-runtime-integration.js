import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeBunReport, reassembleUpstreamBunReport } from './bun-report.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const fixture = process.argv[2] ?? 'bun-js';
assert.ok(['bun-js', 'bun-ts'].includes(fixture), 'Use bun-js or bun-ts');
const artifacts = resolve(root, process.env.STRYKER_RUST_BUN_ARTIFACTS ?? `artifacts/native-runtime/bun-primary/integration-${fixture}`);
const owned = relative(join(root, 'artifacts'), artifacts);
assert.ok(owned && owned !== '..' && !owned.startsWith('..') && !isAbsolute(owned), 'Integration artifacts must have their own directory under artifacts/');
const project = join(artifacts, 'project');
await mkdir(artifacts, { recursive: true });

async function run(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let output = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; output += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; output += chunk; });
  const exit = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => done({ code, signal }));
  });
  return { exit, stdout, stderr, output };
}

let requestedBun = process.env.BUN_BIN;
const binaryResolution = requestedBun ? 'BUN_BIN' : 'PATH via Bun process.execPath';
if (!requestedBun) {
  let located;
  try {
    located = await run('bun', ['--print', 'process.execPath']);
  } catch (error) {
    throw new Error('Bun is unavailable on PATH; install Bun 1.4.3 or set BUN_BIN to its absolute executable', { cause: error });
  }
  await writeFile(join(artifacts, 'bun-path-resolution.log'), located.output);
  assert.deepEqual(located.exit, { code: 0, signal: null }, located.output);
  requestedBun = located.stdout.trim();
}
assert.ok(isAbsolute(requestedBun), 'BUN_BIN or Bun process.execPath must identify an absolute executable');
const bun = await realpath(requestedBun);
await access(bun, constants.X_OK);
const version = await run(bun, ['--version']);
await writeFile(join(artifacts, 'bun-version.log'), version.output);
assert.deepEqual(version.exit, { code: 0, signal: null });
assert.equal(version.stdout.trim(), '1.4.3', 'Both arms must use the pinned Bun release');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bunHash = hash(await readFile(bun));
const extension = fixture === 'bun-js' ? 'js' : 'ts';
const inputNames = ['package.json', 'stryker.config.json', `src/calculator.${extension}`, `test/calculator.test.${extension}`];
async function inputHashes(directory) {
  return Object.fromEntries(await Promise.all(inputNames.map(async (name) => [name, hash(await readFile(join(directory, name)))])));
}
const original = join(root, 'fixtures', fixture);
const originalHashes = await inputHashes(original);
await rm(project, { recursive: true, force: true });
await cp(original, project, { recursive: true, filter: (source) => !['reports', '.stryker-tmp'].includes(source.split(/[\\/]/).at(-1)) });
const quote = (value) => {
  if (process.platform === 'win32') {
    assert.ok(!/["%!\r\n\0]/.test(value), 'This Bun executable path cannot be safely quoted for cmd.exe');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
};
const configPath = join(project, 'stryker.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.commandRunner.command = `${quote(bun)} --no-env-file test ./test/calculator.test.${extension}`;
await writeFile(configPath, JSON.stringify(config, null, 2));
const projectHashes = await inputHashes(project);
const upstream = resolve(require.resolve('@stryker-mutator/core/package.json'), '../bin/stryker.js');
const commandRunnerSource = resolve(upstream, '../../dist/src/test-runner/command-test-runner.js');
const commandRunnerHash = hash(await readFile(commandRunnerSource));
const apiUrl = pathToFileURL(require.resolve('@stryker-mutator/api/core')).href;
const { INSTRUMENTER_CONSTANTS } = await import(apiUrl);
const captureDirectory = join(artifacts, 'upstream-chunks');
await rm(captureDirectory, { recursive: true, force: true });
await mkdir(captureDirectory);
const captureTap = join(artifacts, 'capture-upstream-chunks.mjs');
await writeFile(captureTap, `// Evidence tap only: preserve exec return values, events and upstream source.
if (!process.versions.bun) {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { writeFileSync } = await import('node:fs');
  const { isAbsolute, join, relative, resolve } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { INSTRUMENTER_CONSTANTS } = await import(${JSON.stringify(apiUrl)});
  const { observeUpstreamBunCommand } = await import(${JSON.stringify(new URL('./bun-command-capture.js', import.meta.url).href)});
  const command = ${JSON.stringify(config.commandRunner.command)};
  const temporary = ${JSON.stringify(resolve(project, config.tempDirName ?? '.stryker-tmp'))};
  const directory = ${JSON.stringify(captureDirectory)};
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const originalExec = childProcess.exec;
  let sequence = 0;
  childProcess.exec = function (actualCommand, ...args) {
    const options = args[0];
    const cwd = typeof options?.cwd === 'string' ? resolve(options.cwd) : '';
    const observed = actualCommand === command && isAbsolute(cwd)
      && /^sandbox-[A-Za-z0-9]+$/.test(relative(temporary, cwd));
    const child = Reflect.apply(originalExec, this, [actualCommand, ...args]);
    if (!observed) return child;
    const environment = options.env ?? process.env;
    const variable = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
    const filename = join(directory, process.pid + '-' + child.pid + '-' + sequence++ + '.json');
    const capture = observeUpstreamBunCommand(child, {
      command: actualCommand, cwd,
      activeMutantVariable: variable, activeMutantId: environment[variable] ?? null,
      node: { executable: process.execPath, entry: process.argv[1], argvSha256: digest(process.argv) },
      // Record environment identity without storing any unrelated environment values.
      environmentKeysSha256: digest(Object.keys(environment).sort()),
      spawnargs: child.spawnargs, parentPid: process.pid, pid: child.pid,
    }, (complete) => writeFileSync(filename, JSON.stringify(complete)));
    // A command that never reaches both stream closes leaves explicit incomplete evidence.
    writeFileSync(filename, JSON.stringify(capture), { flag: 'wx' });
    return child;
  };
  syncBuiltinESMExports();
}
`);
async function captureSnapshot() {
  return Promise.all((await readdir(captureDirectory)).sort().map(async (name) => ({ name, sha256: hash(await readFile(join(captureDirectory, name))) })));
}
const importGuard = join(artifacts, 'forbid-upstream.mjs');
await writeFile(importGuard, `// Bun executes only the explicit fixture command; Node coordinators/descendants are guarded.
if (!process.versions.bun) {
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@stryker-mutator/core' || specifier.startsWith('@stryker-mutator/core/')) throw new Error('Native Bun run imported upstream core: ' + specifier);
    const result = nextResolve(specifier, context);
    if (/\\/@stryker-mutator\\/core\\/dist\\//.test(result.url)) throw new Error('Native Bun run loaded upstream core: ' + result.url);
    return result;
  } });
}
`);
const reports = [];
let nativeProof;
let upstreamCaptures;
let upstreamCaptureSnapshot;
for (const [name, entry, native] of [
  ['upstream', upstream, false],
  ['native', join(root, 'bin/stryker-rust.js'), true],
]) {
  await rm(join(project, 'reports'), { recursive: true, force: true });
  const result = await run(process.execPath, [entry, 'run'], {
    cwd: project,
    env: {
      ...process.env,
      STRYKER_RUST_COORDINATOR_ENGINE: native ? 'native' : 'upstream',
      STRYKER_RUST_DIAGNOSTICS: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(native ? importGuard : captureTap).href}`.trim(),
    },
  });
  await Promise.all([
    writeFile(join(artifacts, `${name}.log`), result.output),
    writeFile(join(artifacts, `${name}.stdout.log`), result.stdout),
    writeFile(join(artifacts, `${name}.stderr.log`), result.stderr),
    writeFile(join(artifacts, `${name}.exit.json`), JSON.stringify(result.exit)),
  ]);
  assert.deepEqual(result.exit, { code: 0, signal: null }, `${name}: ${result.output}`);
  const bytes = await readFile(join(project, 'reports/mutation.json'));
  await writeFile(join(artifacts, `${name}.json`), bytes);
  const report = JSON.parse(bytes);
  let corrected = report;
  if (!native) {
    upstreamCaptureSnapshot = await captureSnapshot();
    upstreamCaptures = await Promise.all(upstreamCaptureSnapshot.map(async ({ name }) => JSON.parse(await readFile(join(captureDirectory, name), 'utf8'))));
    corrected = reassembleUpstreamBunReport(report, upstreamCaptures, { activeMutantVariable: INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE });
    await writeFile(join(artifacts, 'upstream.corrected.json'), JSON.stringify(corrected, null, 2));
  } else {
    assert.deepEqual(await captureSnapshot(), upstreamCaptureSnapshot, 'Native arm must not produce or change upstream chunk captures');
  }
  const normalized = normalizeBunReport(corrected);
  await writeFile(join(artifacts, `${name}.normalized.json`), JSON.stringify(normalized, null, 2));
  reports.push(normalized);
  assert.deepEqual(await inputHashes(project), projectHashes, `${name} changed an original project input`);
  assert.deepEqual(await inputHashes(original), originalHashes, `${name} changed the repository fixture`);
  await assert.rejects(access(join(project, '.stryker-tmp')), { code: 'ENOENT' }, `${name} left a sandbox`);
  assert.equal(hash(await readFile(commandRunnerSource)), commandRunnerHash, `${name} changed installed upstream CommandTestRunner source`);
  if (native) {
    const match = result.output.match(/\[stryker-rust\] (\{[^\n]+\})/);
    assert.ok(match, 'Native Rust stage proof is required');
    nativeProof = JSON.parse(match[1]);
  }
}
assert.deepEqual(reports[1], reports[0], 'Complete Bun reports must match after proven upstream capture corrections, declared diagnostic formatting normalization and outer mutant sorting');
const mutants = Object.values(reports[1].files).flatMap((file) => file.mutants);
assert.ok(mutants.some((mutant) => mutant.status === 'Killed'));
assert.ok(mutants.some((mutant) => mutant.status === 'Survived'));
assert.ok(mutants.some((mutant) => mutant.mutatorName === 'BooleanLiteral' && mutant.status === 'Killed'), 'Bun must test startup initialization');
assert.equal(nativeProof.coordinator, 'rust');
assert.equal(nativeProof.nativeInstrumentationBatches, 1);
assert.equal(nativeProof.nativePlanningBatches, 1);
assert.equal(nativeProof.nativePlannedMutants, mutants.length);
assert.equal(nativeProof.commandStarts, mutants.length + 1);
assert.equal(nativeProof.compatibilityCalls, 0, 'Bun command execution must not use a Node SDK worker');
assert.equal(nativeProof.maximumConcurrency, 2);
assert.equal(hash(await readFile(bun)), bunHash, 'Bun binary changed between arms');
const receipt = {
  fixture,
  bun: { executable: bun, binaryResolution, version: version.stdout.trim(), sha256: bunHash },
  reportsEqual: true,
  comparison: 'Every report field retained, including statusReason; outer mutant completion order sorted',
  diagnosticNormalizations: ['SGR color sequences', 'known fixture pass/fail elapsed suffixes without separator whitespace', 'Bun Ran summary elapsed suffix', 'random sandbox leaf only in owned stack and GitHub annotation paths'],
  upstreamChunkCorrection: {
    rawReasonsExactlyMatched: true,
    completeStdioDrains: true,
    captures: upstreamCaptureSnapshot,
    commands: upstreamCaptures.length,
    correctedKilledReasons: mutants.filter((mutant) => mutant.status === 'Killed').length,
    nativeCaptureChanges: 0,
    activeMutantVariable: INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
    commandRunnerSource: { path: commandRunnerSource, sha256: commandRunnerHash, unchanged: true },
    lateOutputCommands: upstreamCaptures.filter((capture) => capture.exitChunkCount < capture.chunks.length).map((capture) => capture.activeMutantId),
    completion: 'Actual stdout and stderr EOF/close; child process status sampled at stdio close must equal exit status; child close event recorded when available',
    method: 'For every Killed reason verify exit-prefix chunks.join(os.EOL) exactly, then compare complete drained chunks.join(\'\') from the same upstream command without changing original chunk characters or upstream results',
  },
  rawReportsAndStreamsRetained: true,
  mutants: mutants.length,
  statuses: Object.fromEntries([...new Set(mutants.map((mutant) => mutant.status))].map((status) => [status, mutants.filter((mutant) => mutant.status === status).length])),
  nativeProof,
  nodeCoordinatorAndDescendantCoreImportGuard: true,
  nodeSdkWorkers: 0,
  originalHashes,
  projectHashes,
  sourcesPreserved: true,
  sandboxesCleaned: true,
  timingClaim: 'None: functional comparison, not a benchmark',
};
await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));

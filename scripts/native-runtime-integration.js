import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const fixture = process.argv[2] ?? 'command';
const fixtures = { command: 'native-command', mocha: 'native' };
if (!Object.hasOwn(fixtures, fixture)) throw new Error('Use command or mocha');
const artifacts = resolve(root, process.env.STRYKER_RUST_NATIVE_ARTIFACTS ?? `artifacts/native-runtime/integration${fixture === 'command' ? '' : `-${fixture}`}`);
const project = join(artifacts, 'project');
await mkdir(artifacts, { recursive: true });
await rm(project, { recursive: true, force: true });
await cp(join(root, 'fixtures', fixtures[fixture]), project, { recursive: true });

// A passing native run must not import upstream execution code even transiently.
const importGuard = join(artifacts, 'forbid-upstream.mjs');
await writeFile(importGuard, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@stryker-mutator/core' || specifier.startsWith('@stryker-mutator/core/')) throw new Error('Native run imported upstream core: ' + specifier);
  const result = nextResolve(specifier, context);
  if (/\\/@stryker-mutator\\/core\\/dist\\//.test(result.url)) throw new Error('Native run loaded upstream core: ' + result.url);
  return result;
} });\n`);

const sourcePath = join(project, 'src/calculator.js');
const source = await readFile(sourcePath, 'utf8');
const canonical = (report) => ({
  ...report,
  files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
    ...file,
    mutants: [...file.mutants].sort((a, b) => a.id.localeCompare(b.id)),
  }])),
});
const reports = [];
const nativeProof = [];
const upstream = resolve(require.resolve('@stryker-mutator/core/package.json'), '../bin/stryker.js');
for (const [name, entry, native] of [
  ['upstream', upstream, false],
  ['native', join(root, 'bin/stryker-rust.js'), true],
]) {
  await rm(join(project, 'reports'), { recursive: true, force: true });
  let output = '';
  const child = spawn(process.execPath, [entry, 'run'], {
    cwd: project,
    env: {
      ...process.env,
      STRYKER_RUST_COORDINATOR_ENGINE: native ? 'native' : 'upstream',
      STRYKER_RUST_DIAGNOSTICS: '1',
      // Cover the coordinator and its Node descendants, including plugin workers.
      NODE_OPTIONS: native ? `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(importGuard).href}`.trim() : process.env.NODE_OPTIONS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exit = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => done({ code, signal }));
  });
  await writeFile(join(artifacts, `${name}.log`), output);
  assert.deepEqual(exit, { code: 0, signal: null }, `${name}: ${output}`);
  const report = JSON.parse(await readFile(join(project, 'reports/mutation.json'), 'utf8'));
  await writeFile(join(artifacts, `${name}.json`), JSON.stringify(report, null, 2));
  reports.push(canonical(report));
  assert.equal(await readFile(sourcePath, 'utf8'), source, 'The original source must remain unchanged');
  if (native) {
    const match = output.match(/\[stryker-rust\] (\{[^\n]+\})/);
    assert.ok(match, 'Native coordinator diagnostics are required');
    const proof = JSON.parse(match[1]);
    assert.equal(proof.coordinator, 'rust');
    nativeProof.push(proof);
  }
}
assert.deepEqual(reports[1], reports[0], 'Only outer asynchronous mutant completion order may differ');
const mutants = Object.values(reports[1].files).flatMap((file) => file.mutants);
assert.ok(mutants.some((mutant) => mutant.status === 'Killed'));
assert.ok(mutants.some((mutant) => mutant.status === (fixture === 'command' ? 'Survived' : 'NoCoverage')));
assert.equal(nativeProof[0].nativeInstrumentationBatches, 1);
assert.equal(nativeProof[0].nativePlanningBatches, 1);
assert.equal(nativeProof[0].nativePlannedMutants, mutants.length);
if (fixture === 'command') {
  assert.equal(nativeProof[0].commandStarts, mutants.length + 1);
  assert.equal(nativeProof[0].compatibilityCalls, 0);
} else {
  assert.equal(nativeProof[0].nativeCoverageBatches, 1);
  assert.ok(nativeProof[0].compatibilityCalls > 0);
}
assert.ok(nativeProof[0].maximumConcurrency > 1, 'The native fixture must exercise concurrent scheduling');
const receipt = {
  fixture,
  reportsEqual: true,
  comparison: 'Complete JSON reports; only mutant completion order canonicalized',
  mutants: mutants.length,
  nativeProof,
  upstreamCoreImportGuard: true,
  sourcePreserved: true,
  timingClaim: 'None: these are functional smoke runs, not a benchmark',
};
await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));

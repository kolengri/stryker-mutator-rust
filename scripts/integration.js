import { spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { normalizeReport } from './report.js';

const require = createRequire(import.meta.url);
const root = resolve('.');
const fixture = process.argv[2] || 'basic';
if (!['basic', 'native', 'vitest'].includes(fixture)) throw new Error('Unknown fixture');
const directory = resolve(process.env.STRYKER_RUST_INTEGRATION_ARTIFACTS ?? 'artifacts/verification', `integration-${fixture}`);
await mkdir(directory, { recursive: true });
const working = join(directory, 'project');
await rm(working, { recursive: true, force: true });
await cp(resolve(`fixtures/${fixture}`), working, { recursive: true });
await rm(join(directory, 'cache'), { recursive: true, force: true });
const before = await readFile(join(working, 'src/calculator.js'), 'utf8');
const upstream = resolve(require.resolve('@stryker-mutator/core/package.json'), '../bin/stryker.js');
const accelerated = resolve('bin/stryker-rust.js');
const results = [];
const fullReports = [];
const stats = [];
const coreNativeProof = [];
for (const [label, entry] of [['upstream', upstream], ['cold', accelerated], ['warm', accelerated]]) {
  const started = performance.now();
  let log = '';
  const child = spawn(process.execPath, [entry, 'run'], { cwd: working, env: { ...process.env, STRYKER_RUST_ENGINE: fixture === 'native' ? 'native' : 'auto', STRYKER_RUST_CORE_ENGINE: 'native', STRYKER_RUST_CACHE_DIR: join(directory, 'cache'), STRYKER_RUST_DIAGNOSTICS: '1' } });
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  await writeFile(join(directory, `${label}.log`), log);
  assert.equal(code, 0, `${label}: ${log}`);
  if (label !== 'upstream') {
    const diagnostic = log.match(/\[stryker-rust\] (\{[^\n]+\})/);
    assert.ok(diagnostic, 'core native execution must have diagnostics');
    const { core } = JSON.parse(diagnostic[1]);
    assert.deepEqual(core.nativeCoreStages, ['coverage', 'planning']);
    assert.equal(core.nativeCoverageBatches, 1);
    assert.equal(core.nativePlanningBatches, 1);
    assert.equal(core.javascriptCoverageFallbacks, 0);
    assert.equal(core.javascriptPlanningFallbacks, 0);
    assert.equal(core.nativeErrors, 0);
    coreNativeProof.push({ label, ...core });
  }
  if (fixture === 'native' && label === 'cold') {
    const diagnostic = log.match(/\[stryker-rust\] (\{[^\n]+\})/);
    assert.ok(diagnostic, 'native execution must have diagnostics');
    const nativeStats = JSON.parse(diagnostic[1]);
    assert.equal(nativeStats.nativeBatches, 1, 'native fixture must run Rust');
    assert.equal(nativeStats.fallbackBatches, 0, 'fallback cannot prove native parity');
  }
  const report = JSON.parse(await readFile(join(working, 'reports/mutation.json'), 'utf8'));
  if (label !== 'upstream') assert.equal(coreNativeProof.at(-1).nativePlannedMutants, Object.values(report.files).flatMap((file) => file.mutants).length);
  await writeFile(join(directory, `${label}.json`), JSON.stringify(report, null, 2));
  assert.equal(await readFile(join(working, 'src/calculator.js'), 'utf8'), before, 'source tree modified');
  results.push(normalizeReport(report));
  // Preserve every field; only asynchronous mutant completion order differs.
  fullReports.push({ ...report, files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
    ...file, mutants: [...file.mutants].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  }])) });
  stats.push({ label, durationMs: performance.now() - started, mutants: Object.values(report.files).flatMap((f) => f.mutants).length });
}
assert.deepEqual(results[1], results[0]);
assert.deepEqual(results[2], results[0]);
assert.deepEqual(fullReports[1], fullReports[0]);
assert.deepEqual(fullReports[2], fullReports[0]);
const all = Object.values(results[0]).flatMap((f) => f.mutants);
assert.ok(all.some((m) => m.status === 'Killed'));
assert.ok(all.some((m) => m.status === 'NoCoverage'));
assert.ok(all.some((m) => m.static === true));
await writeFile(join(directory, 'summary.json'), JSON.stringify({ comparison: `${fixture}, perTest; single runs are smoke evidence, not a speed benchmark`, stats }, null, 2));
await writeFile(join(directory, 'core-nativeproof.json'), JSON.stringify({ fixture, reportsEqual: true, comparison: 'Full reports; only mutant completion order canonicalized', runs: coreNativeProof }, null, 2));
console.log(JSON.stringify(stats, null, 2));

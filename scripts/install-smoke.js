import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const archive = resolve(process.argv[2] || 'artifacts/package/local/stryker-mutator-rust-0.1.0.tgz');
const output = resolve('artifacts/verification/install');
const directory = join(output, 'consumer');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await cp(resolve('fixtures/native'), directory, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout + result.stderr;
}
const installation = run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, '@stryker-mutator/mocha-runner@10.0.0', 'mocha@11'], { shell: process.platform === 'win32' });
await writeFile(join(output, 'install.log'), installation);
const info = run(process.execPath, [join(directory, 'node_modules/stryker-mutator-rust/bin/stryker-rust.js'), '--rust-info']);
assert.equal(JSON.parse(info).available, true);
assert.equal(JSON.parse(info).nativeInstrumentation, true);
assert.equal(JSON.parse(info).nativeCoordinator, true);
const execution = run(process.execPath, [join(directory, 'node_modules/stryker-mutator-rust/bin/stryker-rust.js'), 'run'], { env: { ...process.env, STRYKER_RUST_ENGINE: 'native', STRYKER_RUST_DIAGNOSTICS: '1' } });
await writeFile(join(output, 'run.log'), execution);
assert.match(execution, /"nativeBatches":1/);
const report = JSON.parse(await readFile(join(directory, 'reports/mutation.json'), 'utf8'));
const mutants = Object.values(report.files).flatMap((file) => file.mutants);
assert.equal(mutants.length, 10);
assert.ok(mutants.some((mutant) => mutant.status === 'Killed'));
let nativeCoordinator;
if (process.platform !== 'win32') {
  const nativeExecution = run(process.execPath, [join(directory, 'node_modules/stryker-mutator-rust/bin/stryker-rust.js'), 'run'], {
    env: { ...process.env, STRYKER_RUST_COORDINATOR_ENGINE: 'native', STRYKER_RUST_DIAGNOSTICS: '1' },
  });
  await writeFile(join(output, 'native-run.log'), nativeExecution);
  const match = nativeExecution.match(/\[stryker-rust\] (\{[^\n]+\})/);
  assert.ok(match, 'Installed package must expose native coordinator diagnostics');
  nativeCoordinator = JSON.parse(match[1]);
  assert.equal(nativeCoordinator.coordinator, 'rust');
  assert.equal(nativeCoordinator.nativePlannedMutants, mutants.length);
  const nativeReport = JSON.parse(await readFile(join(directory, 'reports/mutation.json'), 'utf8'));
  const canonical = (value) => ({ ...value, files: Object.fromEntries(Object.entries(value.files).map(([name, file]) => [name, {
    ...file, mutants: [...file.mutants].sort((a, b) => a.id.localeCompare(b.id)),
  }])) });
  assert.deepEqual(canonical(nativeReport), canonical(report), 'Installed native and legacy reports must match');
}
const result = { archive, ignoreScripts: true, native: JSON.parse(info), mutants: mutants.length, nativeCoordinator };
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ archive, installed: true, native: true, mutants: mutants.length, nativeCoordinator: Boolean(nativeCoordinator) }));

import { spawnSync } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import assert from 'node:assert/strict';
import { normalizeReport } from './report.js';

const output = resolve('artifacts/benchmark/e2e');
const project = join(output, 'project');
await mkdir(output, { recursive: true });
await rm(project, { force: true, recursive: true });
await cp(resolve('fixtures/native'), project, { recursive: true });
const source = 'export const startup = true;\n' + Array.from({ length: 100 }, (_, i) =>
  `export function f${i}(a,b) { if (a > b) { return a + b; } return a - b; }`).join('\n');
await writeFile(join(project, 'src/calculator.js'), source);
await writeFile(join(project, 'test/calculator.test.js'), `import assert from 'node:assert/strict';
import * as calculator from '../src/calculator.js';
describe('generated numeric module', () => {
  it('loads the static initializer', () => assert.equal(calculator.startup, true));
  for (let i = 0; i < 100; i++) it('function ' + i, () => {
    assert.equal(calculator['f' + i](4, 2), 6);
    assert.equal(calculator['f' + i](1, 3), -2);
  });
});`);
const require = createRequire(import.meta.url);
const entries = {
  upstream: resolve(require.resolve('@stryker-mutator/core/package.json'), '../bin/stryker.js'),
  rust: resolve('bin/stryker-rust.js'),
};
let expected;
const samples = [];
for (let round = 0; round < 7; round++) {
  for (const mode of round % 2 ? ['rust', 'upstream'] : ['upstream', 'rust']) {
    const start = performance.now();
    const run = spawnSync(process.execPath, [entries[mode], 'run'], {
      cwd: project, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, STRYKER_RUST_CACHE: '0', STRYKER_RUST_ENGINE: 'native', STRYKER_RUST_DIAGNOSTICS: '1' },
    });
    const durationMs = performance.now() - start;
    await writeFile(join(output, `${round}-${mode}.log`), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    if (mode === 'rust') assert.match(run.stdout + run.stderr, /"nativeBatches":1/);
    assert.equal(await readFile(join(project, 'src/calculator.js'), 'utf8'), source);
    const report = JSON.parse(await readFile(join(project, 'reports/mutation.json'), 'utf8'));
    const normalized = normalizeReport(report);
    if (expected) assert.deepEqual(normalized, expected);
    else expected = normalized;
    await writeFile(join(output, `${round}-${mode}.json`), JSON.stringify(report));
    samples.push({ round, mode, durationMs, mutants: Object.values(report.files).flatMap((file) => file.mutants).length });
  }
}
const summary = Object.fromEntries(Object.keys(entries).map((mode) => {
  const values = samples.filter((sample) => sample.mode === mode).map((sample) => sample.durationMs).sort((a,b) => a-b);
  return [mode, { medianMs: values[3], minMs: values[0], maxMs: values.at(-1), samples: values.length }];
}));
await writeFile(join(output, 'summary.json'), JSON.stringify({
  scope: 'full CLI processes through worker disposal and report completion; synthetic 100-function module; no persistent or incremental cache; real Mocha, perTest, concurrency=2; identical results required',
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model },
  memory: 'not measured', summary, samples,
}, null, 2));
console.log(JSON.stringify(summary, null, 2));

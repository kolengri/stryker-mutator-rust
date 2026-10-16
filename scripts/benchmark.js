import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from '../test/helpers.js';

const output = resolve('artifacts/benchmark');
const fixture = resolve('artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/perf/benchmark-big.ts');
if (process.argv[2] === '--child') {
  const engine = process.argv[3];
  const cacheDir = process.argv[4];
  const dataset = process.argv[5];
  const source = dataset === 'native'
    ? Array.from({ length: 200 }, (_, i) => `function f${i}(a,b) { if (a > b) { return a + b; } return a - b; }`).join('\n')
    : await readFile(fixture, 'utf8');
  const files = [{ name: dataset === 'native' ? resolve('numeric.js') : fixture, content: source, mutate: true }];
  const baseline = new Instrumenter(logger);
  const candidate = createInstrumenter(logger, { cacheDir });
  if (engine !== 'upstream') await rm(cacheDir, { recursive: true, force: true });
  if (engine === 'warm') await candidate.instrument(files, options);
  const start = performance.now();
  const result = await (engine === 'upstream' ? baseline : candidate).instrument(files, options);
  const durationMs = performance.now() - start;
  // Run the oracle after timing: warming Babel first unfairly changes the baseline.
  const expected = engine === 'upstream' ? result : await baseline.instrument(files, options);
  assert.deepEqual(result.mutants, expected.mutants);
  if (dataset === 'native') {
    new vm.Script(result.files[0].content);
    if (engine !== 'upstream') assert.equal(candidate.stats.nativeBatches, 1, 'must benchmark native instrumentation');
  } else assert.deepEqual(result, expected);
  console.log(JSON.stringify({ dataset, engine, durationMs, mutants: result.mutants.length, cache: candidate.stats }));
} else {
  await mkdir(output, { recursive: true });
  const samples = [];
  // Interleave modes; each sample has a new Node process. Only warm mode is primed.
  const modes = ['upstream', 'cold', 'warm'];
  for (const dataset of ['native', 'upstream-corpus']) for (let i = 0; i < 7; i++) {
    for (let j = 0; j < modes.length; j++) {
      const mode = modes[(i + j) % modes.length];
      const result = spawnSync(process.execPath, [resolve('scripts/benchmark.js'), '--child', mode, join(output, `cache-${dataset}-${i}-${mode}`), dataset], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      samples.push(JSON.parse(result.stdout.trim()));
    }
  }
  const summary = Object.fromEntries(['native', 'upstream-corpus'].map((dataset) => [dataset, Object.fromEntries(modes.map((mode) => {
    const values = samples.filter((s) => s.engine === mode && s.dataset === dataset).map((s) => s.durationMs).sort((a,b) => a-b);
    return [mode, { medianMs: values[Math.floor(values.length / 2)], minMs: values[0], maxMs: values.at(-1), samples: values.length }];
  }))]));
  const report = {
    scope: 'instrumentation only, not end-to-end; independent fresh Node processes; cold cache absent; warm cache primed outside timing; oracle after timing; module import/startup excluded',
    fixture, upstream: '10.0.0', nativeInstrumentation: 'native dataset only; upstream-corpus uses compatibility fallback',
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus()[0].model }, summary, samples,
  };
  await writeFile(join(output, 'instrumentation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

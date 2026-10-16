import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from '../test/helpers.js';
import { loadNative } from '../lib/native.js';

const upstream = resolve(process.env.STRYKER_UPSTREAM || 'artifacts/upstream/stryker-js');
const source = join(upstream, 'packages/instrumenter/testResources/instrumenter');
const output = resolve('artifacts/verification/corpus');
await mkdir(output, { recursive: true });
await rm(join(output, 'cache'), { recursive: true, force: true });
const baseline = new Instrumenter(logger);
assert.equal(typeof loadNative().instrumentBatch, 'function', 'Build the native addon before checking the corpus');
const cached = createInstrumenter(logger, { cacheDir: join(output, 'cache'), engine: 'upstream' });
const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
const results = [];
async function visit(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:[cm]?js|jsx|[cm]?ts|tsx|vue|html?|svelte)$/.test(entry.name)) {
      const files = [{ name: path, content: await readFile(path, 'utf8'), mutate: true }];
      const config = { ...options, ...(entry.name === 'flow-typed.js' ? { plugins: ['flow'] } : {}) };
      let expected, failure;
      try { expected = await baseline.instrument(files, config); } catch (error) { failure = error; }
      const nativeBefore = automatic.stats.nativeBatches;
      if (failure) {
        // Invalid parser fixtures and resources requiring context must fail identically.
        await assert.rejects(cached.instrument(files, config), (error) => error.message === failure.message);
        await assert.rejects(automatic.instrument(files, config), (error) =>
          error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
        results.push({ file: relative(source, path), outcome: 'matching-error', backend: 'fallback', message: failure.message });
      } else {
        assert.deepEqual(await cached.instrument(files, config), expected, path);
        assert.deepEqual(await cached.instrument(files, config), expected, path);
        const actual = await automatic.instrument(files, config);
        assert.deepEqual(actual.mutants, expected.mutants, `${path}: automatic ordered mutant records`);
        const native = automatic.stats.nativeBatches > nativeBefore;
        if (!native) assert.deepEqual(actual, expected, `${path}: automatic fallback result`);
        else assert.deepEqual(actual.files.map(({ name }) => name), expected.files.map(({ name }) => name));
        results.push({ file: relative(source, path), outcome: 'exact-match', backend: native ? 'native' : 'fallback', mutants: expected.mutants.length });
      }
    }
  }
}
await visit(source);
assert.equal(automatic.stats.nativeErrors, 0, 'Unexpected native failures must not hide behind fallback');
assert.equal(automatic.stats.nativeBatches + automatic.stats.fallbackBatches, results.length);
const report = { upstream: '10.0.0', comparison: 'Exact compatibility/cache results plus automatic ordered mutant records; native runtime parity is checked separately', files: results.length, stats: cached.stats, automaticStats: automatic.stats, results };
await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ files: report.files, matchingErrors: results.filter((r) => r.outcome === 'matching-error').length, stats: report.stats, automaticStats: report.automaticStats }));

import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from '../test/helpers.js';

const upstream = resolve(process.env.STRYKER_UPSTREAM || 'artifacts/upstream/stryker-js');
const source = join(upstream, 'packages/instrumenter/testResources/instrumenter');
const output = resolve('artifacts/verification/corpus');
await mkdir(output, { recursive: true });
await rm(join(output, 'cache'), { recursive: true, force: true });
const baseline = new Instrumenter(logger);
const cached = createInstrumenter(logger, { cacheDir: join(output, 'cache'), engine: 'upstream' });
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
      if (failure) {
        // Invalid parser fixtures and resources requiring context must fail identically.
        await assert.rejects(cached.instrument(files, config), (error) => error.message === failure.message);
        results.push({ file: relative(source, path), outcome: 'matching-error', message: failure.message });
      } else {
        assert.deepEqual(await cached.instrument(files, config), expected, path);
        assert.deepEqual(await cached.instrument(files, config), expected, path);
        results.push({ file: relative(source, path), outcome: 'exact-match', mutants: expected.mutants.length });
      }
    }
  }
}
await visit(source);
const report = { upstream: '10.0.0', comparison: 'upstream vs compatibility/cache path; not native instrumentation parity', files: results.length, stats: cached.stats, results };
await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ files: report.files, matchingErrors: results.filter((r) => r.outcome === 'matching-error').length, stats: report.stats }));

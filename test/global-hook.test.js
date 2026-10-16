import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { installAcceleration, createInstrumenter } from '../lib/index.js';
import { logger, options } from './helpers.js';

test('global hook preserves custom constructor pipelines and isolated instrumenters', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'stryker-rust-hook-'));
  t.after(() => rm(cacheDir, { force: true, recursive: true }));
  let prints = 0;
  const custom = new Instrumenter(logger, undefined, () => { prints++; return 'custom output'; });
  const files = [{ name: 'sample.js', content: 'function add(a,b) { return a + b; }', mutate: true }];
  const expected = await custom.instrument(files, options);
  const cache = installAcceleration({ cacheDir });
  assert.equal(installAcceleration(), cache, 'installation must be idempotent');
  assert.deepEqual(await custom.instrument(files, options), expected);
  assert.deepEqual(await custom.instrument(files, options), expected);
  assert.equal(prints, 3, 'custom pipeline must run on every invocation');
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.stats.bypasses, 2);
  const isolated = createInstrumenter(logger, { cache: false, engine: 'native' });
  await isolated.instrument(files, options);
  assert.equal(isolated.stats.nativeBatches, 1);
});

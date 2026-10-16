import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter, InstrumentationCache } from '../lib/index.js';
import { createBackend } from '../lib/backend.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const files = (count = 2) => Array.from({ length: count }, (_, index) => ({
  name: `/threads-fixture/file-${index}.ts`, content: `export const flag${index} = true;`, mutate: true,
}));
const serial = (reason) => ({ threadsUsed: 1, spawnedThreads: 0, parallelFiles: 0, serialRecoveries: 0,
  ...(reason === undefined ? {} : { reason }) });
const initial = (configuredThreads) => ({ configuredThreads, parallelBatches: 0, serialBatches: 0,
  serialRecoveries: 0, lastThreadsUsed: 0, lastSpawnedThreads: 0, lastParallelFiles: 0 });
const success = (request, execution) => ({ supported: true, result: { files: request.files, mutants: [] },
  ...(execution === undefined ? {} : { execution }) });

function stub(t, respond) {
  const binding = loadNative();
  const original = binding.instrumentBatch;
  const requests = [];
  binding.instrumentBatch = (input) => {
    const request = JSON.parse(input);
    requests.push(request);
    const response = respond(request);
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
  t.after(() => { binding.instrumentBatch = original; });
  return requests;
}

async function environment(value, action) {
  const previous = process.env.STRYKER_RUST_THREADS;
  try {
    if (value === undefined) delete process.env.STRYKER_RUST_THREADS;
    else process.env.STRYKER_RUST_THREADS = value;
    return await action();
  } finally {
    if (previous === undefined) delete process.env.STRYKER_RUST_THREADS;
    else process.env.STRYKER_RUST_THREADS = previous;
  }
}

function child(body, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { Instrumenter } from '@stryker-mutator/instrumenter';
    import { installAcceleration, createInstrumenter, InstrumentationCache } from './lib/index.js';
    import { loadNative } from './lib/native.js';
    import { TestCoverage, MutantTestPlanner, originalFrom, originalMakePlan } from './test/native-core-helpers.js';
    import { logger, options } from './test/helpers.js';
    ${body}
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STRYKER_RUST_THREADS: '', ...env } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('thread settings use explicit option, then captured decimal environment, then auto', async (t) => {
  const requests = stub(t, request => success(request, serial()));
  for (const [value, supplied, expected] of [
    [undefined, {}, undefined], ['', {}, undefined], ['3', {}, 3], ['0002', {}, 2],
    ['3', { instrumentationThreads: undefined }, 3], ['invalid', { instrumentationThreads: 1 }, 1],
    ['2', { instrumentationThreads: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER],
  ]) {
    await environment(value, async () => {
      const sut = createInstrumenter(logger, { cache: false, engine: 'native', ...supplied });
      assert.equal(sut.instrumentationStats.configuredThreads, expected);
      process.env.STRYKER_RUST_THREADS = '9';
      await sut.instrument(files(), options);
      assert.deepEqual(requests.at(-1), { files: files(), options, ...(expected === undefined ? {} : { execution: { threads: expected } }) });
      assert.equal(Object.hasOwn(requests.at(-1).options, 'instrumentationThreads'), false);
    });
  }
});

test('invalid thread settings throw before installing instrumentation or core hooks', () => {
  child(`
    for (const value of [0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, 2n, {}, []]) {
      assert.throws(() => installAcceleration({ instrumentationThreads: value, coreEngine: 'native' }), TypeError);
      assert.throws(() => createInstrumenter(logger, { instrumentationThreads: value }), TypeError);
      assert.throws(() => new InstrumentationCache({ instrumentationThreads: value }), TypeError);
    }
    for (const value of ['0', '-1', '1.5', '1e2', '0x10', '+2', 'Infinity', 'NaN', ' 2 ', '9007199254740992', 'auto']) {
      process.env.STRYKER_RUST_THREADS = value;
      assert.throws(() => installAcceleration({ coreEngine: 'native' }), TypeError);
    }
    assert.equal(TestCoverage.from, originalFrom);
    assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
    assert.equal(Object.hasOwn(Instrumenter.prototype, Symbol.for('stryker-mutator-rust.instrumenter.v1')), false);
    assert.equal(Object.hasOwn(TestCoverage, Symbol.for('stryker-mutator-rust.core.v1')), false);
    assert.equal(Object.hasOwn(MutantTestPlanner, Symbol.for('stryker-mutator-rust.core.v1')), false);
  `);
});

test('thread accessors execute once before final mutation-target preflight', () => {
  for (const coreEngine of ['auto', 'native']) {
    for (const sabotage of [
      'Object.preventExtensions(Instrumenter.prototype);',
      `Object.defineProperty(Instrumenter.prototype, 'instrument', { writable: false });`,
    ]) {
      child(`
        const before = Instrumenter.prototype.instrument;
        let reads = 0;
        assert.throws(() => installAcceleration({ coreEngine: '${coreEngine}', get instrumentationThreads() {
          reads++;
          ${sabotage}
          return 2;
        } }), /Instrumenter hook/);
        assert.equal(reads, 1);
        assert.equal(Instrumenter.prototype.instrument, before);
        assert.equal(TestCoverage.from, originalFrom);
        assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
        assert.equal(Object.hasOwn(Instrumenter.prototype, Symbol.for('stryker-mutator-rust.instrumenter.v1')), false);
        assert.equal(Object.hasOwn(TestCoverage, Symbol.for('stryker-mutator-rust.core.v1')), false);
        assert.equal(Object.hasOwn(MutantTestPlanner, Symbol.for('stryker-mutator-rust.core.v1')), false);
      `);
    }
  }
  child(`
    const boom = new Error('thread accessor failed');
    let reads = 0;
    assert.throws(() => installAcceleration({ get instrumentationThreads() { reads++; throw boom; } }), error => error === boom);
    assert.equal(reads, 1);
    assert.equal(TestCoverage.from, originalFrom);
    assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
  `);
});

test('isolated and installed settings capture threads once while retaining existing live engine resolution', async (t) => {
  let reads = 0;
  const settings = { cache: false, engine: 'native', get instrumentationThreads() { reads++; return reads === 1 ? 2 : 0; } };
  const requests = stub(t, request => success(request, serial()));
  const sut = createInstrumenter(logger, settings);
  await sut.instrument(files(), options);
  await sut.instrument(files(), options);
  assert.equal(reads, 1);
  assert.deepEqual(requests.map(request => request.execution), [{ threads: 2 }, { threads: 2 }]);
  child(`
    let engine = 'auto', engineReads = 0, threadReads = 0;
    const requests = [];
    loadNative().instrumentBatch = input => {
      const request = JSON.parse(input); requests.push(request);
      return JSON.stringify({ supported: true, result: { files: request.files, mutants: [] } });
    };
    const cache = installAcceleration({ cache: false, coreEngine: 'upstream',
      get engine() { engineReads++; return engine; },
      get instrumentationThreads() { threadReads++; return 2; } });
    assert.equal(engineReads, 1);
    engine = 'native'; process.env.STRYKER_RUST_THREADS = '7';
    const batch = [{ name: 'settings.ts', mutate: true, content: 'const flag=true;' }];
    await new Instrumenter(logger).instrument(batch, options);
    engine = 'upstream';
    await new Instrumenter(logger).instrument(batch, options);
    assert.equal(threadReads, 1);
    assert.equal(engineReads, 3);
    assert.deepEqual(requests.map(request => request.execution), [{ threads: 2 }]);
    assert.equal(cache.stats.nativeBatches, 1);
    assert.equal(cache.stats.fallbackBatches, 1);
    assert.equal(cache.instrumentationStats.serialBatches, 1);
  `);
});

test('same-package and structural duplicate installations preserve first threads without reading new settings', () => {
  child(`
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const directory = pathToFileURL(process.cwd() + '/lib/');
    const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
    const rewrite = (text, cacheURL) => text.replace(/from ['"]([^'"]+)['"]/g, (match, specifier) => {
      const url = specifier === './cache.js' && cacheURL ? cacheURL
        : specifier.startsWith('.') ? new URL(specifier, directory).href : import.meta.resolve(specifier);
      return 'from ' + JSON.stringify(url);
    });
    const cacheURL = dataURL(rewrite(await readFile(new URL('cache.js', directory), 'utf8')));
    const copy = await import(dataURL(rewrite(await readFile(new URL('index.js', directory), 'utf8'), cacheURL)));
    assert.notEqual(copy.InstrumentationCache, InstrumentationCache);
    const first = installAcceleration({ instrumentationThreads: 2, coreEngine: 'upstream', cache: false });
    const hook = Instrumenter.prototype.instrument;
    const later = { get instrumentationThreads() { throw new Error('duplicate options must not run'); } };
    process.env.STRYKER_RUST_THREADS = 'invalid';
    assert.equal(installAcceleration(later), first);
    assert.equal(copy.installAcceleration(later), first);
    assert.equal(installAcceleration({ instrumentationThreads: 0 }), first);
    assert.equal(first.instrumentationStats.configuredThreads, 2);
    assert.equal(Instrumenter.prototype.instrument, hook);
  `);
});

test('successful metadata updates separate execution counters using actual participants', async (t) => {
  let execution = { threadsUsed: 2, spawnedThreads: 3, parallelFiles: 4, serialRecoveries: 0, reason: 'parallel work' };
  stub(t, request => success(request, execution));
  const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: 4 });
  assert.deepEqual(sut.instrumentationStats, initial(4));
  const result = await sut.instrument(files(4), options);
  assert.deepEqual(Object.keys(result), ['files', 'mutants']);
  assert.deepEqual(sut.instrumentationStats, { ...initial(4), parallelBatches: 1,
    lastThreadsUsed: 2, lastSpawnedThreads: 3, lastParallelFiles: 4, lastReason: 'parallel work' });
  execution = { threadsUsed: 1, spawnedThreads: 3, parallelFiles: 0, serialRecoveries: 1, reason: 'resource recovery' };
  await sut.instrument(files(4), options);
  assert.equal(sut.instrumentationStats.serialBatches, 1);
  assert.equal(sut.instrumentationStats.serialRecoveries, 1);
  execution = { threadsUsed: 1, spawnedThreads: 1, parallelFiles: 4, serialRecoveries: 0 };
  await sut.instrument(files(4), options);
  assert.equal(sut.instrumentationStats.parallelBatches, 1, 'settings/spawned workers alone never claim parallel execution');
  assert.equal(sut.instrumentationStats.serialBatches, 2);
  assert.equal(sut.instrumentationStats.lastThreadsUsed, 1);
  assert.equal(Object.hasOwn(sut.instrumentationStats, 'lastReason'), false);
  assert.deepEqual(Object.keys(sut.stats), ['hits', 'misses', 'bypasses', 'errors', 'nativeBatches', 'fallbackBatches', 'nativeErrors']);
  assert.ok(Object.values(sut.stats).every(value => typeof value === 'number'));
});

test('legacy responses retain exact results and record serial information without invented concurrency', async (t) => {
  const actualNative = loadNative().instrumentBatch;
  let nativeFiles;
  stub(t, request => {
    const response = JSON.parse(actualNative(JSON.stringify(request)));
    nativeFiles = response.result.files;
    delete response.execution;
    return response;
  });
  const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: 4 });
  const actual = await sut.instrument(files(), options);
  assert.deepEqual(actual, { files: nativeFiles, mutants: (await new Instrumenter(logger).instrument(files(), options)).mutants });
  assert.deepEqual(sut.instrumentationStats, { ...initial(4), serialBatches: 1, lastThreadsUsed: 1,
    lastReason: 'Native execution information unavailable (legacy addon)' });
  await sut.instrument([], options);
  assert.equal(sut.instrumentationStats.serialBatches, 2);
  assert.equal(sut.instrumentationStats.lastThreadsUsed, 0);
});

test('malformed execution metadata fails atomically and invokes upstream at most once', async (t) => {
  let response;
  stub(t, () => response);
  const invalid = [null, [], {}, { ...serial(), extra: 1 }, { ...serial(), reason: null }, { ...serial(), threadsUsed: null },
    { ...serial(), threadsUsed: 0 }, { ...serial(), threadsUsed: 3 }, { ...serial(), spawnedThreads: 2 },
    { ...serial(), spawnedThreads: -1 }, { ...serial(), parallelFiles: 3 }, { ...serial(), serialRecoveries: 2 },
    { ...serial(), threadsUsed: 1.5 }, { ...serial(), spawnedThreads: Number.MAX_SAFE_INTEGER + 1 },
    { ...serial(), threadsUsed: 2, parallelFiles: 2 },
    { ...serial(), threadsUsed: 2, spawnedThreads: 1 },
    { ...serial(), parallelFiles: 2 },
    { ...serial(), threadsUsed: 2, spawnedThreads: 1, parallelFiles: 2, serialRecoveries: 1 },
  ];
  for (const engine of ['auto', 'native']) {
    for (const execution of invalid) {
      response = success({ files: files() }, execution);
      // Missing execution is legacy-compatible; an explicitly absent counter is not.
      if (execution && Object.keys(execution).length === 0) response.execution = { ...serial(), threadsUsed: undefined };
      const cache = new InstrumentationCache({ cache: false, instrumentationThreads: 4 });
      let calls = 0;
      const expected = { files: [], mutants: [], upstream: true };
      const backend = createBackend(() => { calls++; return expected; }, { engine }, cache.stats, cache.instrumentationStats, 4);
      if (engine === 'native') await assert.rejects(backend(files(), options), /Invalid native execution metadata/);
      else assert.equal(await backend(files(), options), expected);
      assert.equal(calls, engine === 'auto' ? 1 : 0);
      assert.equal(cache.stats.nativeErrors, 1);
      assert.equal(cache.stats.nativeBatches, 0);
      assert.equal(cache.stats.fallbackBatches, engine === 'auto' ? 1 : 0);
      assert.deepEqual(cache.instrumentationStats, initial(4));
    }
  }
  response = JSON.stringify(success({ files: files() }, serial())).replace('"spawnedThreads":0', '"spawnedThreads":-0');
  const cache = new InstrumentationCache({ cache: false });
  const boom = new Error('upstream callback failed');
  let calls = 0;
  const backend = createBackend(() => { calls++; throw boom; }, { engine: 'auto' }, cache.stats, cache.instrumentationStats);
  await assert.rejects(backend(files(), options), error => error === boom);
  assert.equal(calls, 1);
  assert.deepEqual(cache.instrumentationStats, initial(undefined));
  for (const misplaced of [false, true]) {
    const cache = new InstrumentationCache({ cache: false, instrumentationThreads: 1 });
    response = success({ files: files() }, { threadsUsed: 2, spawnedThreads: 1, parallelFiles: 2, serialRecoveries: 0 });
    if (misplaced) { response.result.execution = response.execution; delete response.execution; }
    const backend = createBackend(() => { throw new Error('forced native must not fall back'); }, { engine: 'native' }, cache.stats, cache.instrumentationStats, 1);
    await assert.rejects(backend(files(), options), /Invalid native (?:execution metadata|instrumenter response)/);
    assert.equal(cache.stats.nativeErrors, 1);
    assert.equal(cache.stats.fallbackBatches, 0);
    assert.deepEqual(cache.instrumentationStats, initial(1));
  }
});

test('unsupported responses and empty/single-file metadata do not overstate execution', async (t) => {
  let respond = request => ({ supported: false, reason: 'unsupported fixture', execution: { threadsUsed: 2, spawnedThreads: 1, parallelFiles: 2, serialRecoveries: 0 } });
  stub(t, request => respond(request));
  const sut = createInstrumenter(logger, { cache: false, engine: 'auto', instrumentationThreads: 4 });
  assert.deepEqual(await sut.instrument(files(), options), await new Instrumenter(logger).instrument(files(), options));
  assert.deepEqual(sut.instrumentationStats, initial(4));
  assert.equal(sut.stats.fallbackBatches, 1);
  assert.equal(sut.stats.nativeErrors, 0);
  respond = request => success(request, { threadsUsed: 0, spawnedThreads: 0, parallelFiles: 0, serialRecoveries: 0, reason: 'empty' });
  await sut.instrument([], options);
  assert.equal(sut.instrumentationStats.lastThreadsUsed, 0);
  respond = request => success(request, serial('single-file'));
  await sut.instrument(files(1), options);
  assert.equal(sut.instrumentationStats.serialBatches, 2);
  assert.equal(sut.instrumentationStats.lastThreadsUsed, 1);
});

test('threads never enter cache identity and cache hits leave execution counters unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stryker-thread-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = stub(t, request => success(request, serial('reference serial')));
  const one = createInstrumenter(logger, { cacheDir: directory, engine: 'native', instrumentationThreads: 1 });
  const many = createInstrumenter(logger, { cacheDir: directory, engine: 'native', instrumentationThreads: 4 });
  const output = await one.instrument(files(), options);
  const before = structuredClone(one.instrumentationStats);
  assert.deepEqual(await one.instrument(files(), options), output);
  assert.deepEqual(one.instrumentationStats, before);
  assert.deepEqual(await many.instrument(files(), options), output);
  assert.deepEqual(many.instrumentationStats, initial(4));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].execution, { threads: 1 });
  assert.equal(one.stats.misses, 1);
  assert.equal(one.stats.hits, 1);
  assert.equal(many.stats.hits, 1);
  assert.equal(many.stats.misses, 0);
  assert.equal(many.stats.nativeBatches, 0);
});

test('CLI diagnostics report instrumentation separately from the seven cache counters', () => {
  const result = spawnSync(process.execPath, ['bin/stryker-rust.js', '--version'], { cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, STRYKER_RUST_THREADS: '2', STRYKER_RUST_CORE_ENGINE: 'upstream', STRYKER_RUST_DIAGNOSTICS: '1' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stderr.split('\n').find(line => line.startsWith('[stryker-rust] '));
  assert.ok(line, result.stderr);
  const { instrumentation, core, ...cache } = JSON.parse(line.slice('[stryker-rust] '.length));
  assert.deepEqual(instrumentation, initial(2));
  assert.equal(core.engine, 'upstream');
  assert.deepEqual(Object.keys(cache), ['hits', 'misses', 'bypasses', 'errors', 'nativeBatches', 'fallbackBatches', 'nativeErrors']);
});

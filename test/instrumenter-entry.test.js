import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prelude = `
  import assert from 'node:assert/strict';
  import { registerHooks } from 'node:module';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { logger, options } from './test/helpers.js';
  const files = [
    { name: '/entry-fixture/one.ts', content: 'export const one = true;', mutate: true },
    { name: '/entry-fixture/two.ts', content: 'export const two = false;', mutate: true },
  ];
`;

function child(body, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + body], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, STRYKER_RUST_ENGINE: 'auto', STRYKER_RUST_THREADS: '', STRYKER_RUST_CACHE: '1', ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const coreGuard = `
  function guardedResolve(specifier, context, next) {
    if (specifier === '@stryker-mutator/core' || specifier.startsWith('@stryker-mutator/core/')) {
      throw new Error('Forbidden core import: ' + specifier);
    }
    const result = next(specifier, context);
    if (decodeURIComponent(result.url).includes('/@stryker-mutator/core/')) {
      throw new Error('Forbidden core URL: ' + result.url);
    }
    return result;
  }
`;

// Observe the real pinned constructor without replacing its class, pipeline or exports.
const observeConstructor = `
  globalThis.entryInstances = [];
  globalThis.entryEvaluations = 0;
  function observe(url, context, next) {
    const actual = next(url, context);
    if (!decodeURIComponent(url).endsWith('/@stryker-mutator/instrumenter/dist/src/instrumenter.js')) return actual;
    const source = typeof actual.source === 'string' ? actual.source : Buffer.from(actual.source).toString('utf8');
    assert.equal(source.split('this.logger = logger;').length, 2, 'pinned constructor observation site');
    return { ...actual, source: 'globalThis.entryEvaluations++;\\n' + source.replace('this.logger = logger;',
      'globalThis.entryInstances.push(this); this.logger = logger;') };
  }
`;

test('fresh strict native calls and cache hits exclude both upstream packages with the real addon', () => {
  child(`
    const forbidden = ['@stryker-mutator/instrumenter', '@stryker-mutator/core'];
    registerHooks({ resolve(specifier, context, next) {
      if (forbidden.some(name => specifier === name || specifier.startsWith(name + '/'))) {
        throw new Error('Forbidden upstream import: ' + specifier);
      }
      const result = next(specifier, context);
      if (forbidden.some(name => decodeURIComponent(result.url).includes('/' + name + '/'))) {
        throw new Error('Forbidden upstream URL: ' + result.url);
      }
      return result;
    } });
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const uncached = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: 2 });
    assert.equal(typeof uncached.then, 'undefined', 'factory stays synchronous');
    const expected = await uncached.instrument(files, options);
    assert.ok(expected.mutants.length > 0);
    assert.equal(uncached.stats.nativeBatches, 1);
    assert.equal(uncached.stats.fallbackBatches, 0);
    assert.equal(uncached.stats.nativeErrors, 0);
    const cacheDir = await mkdtemp(join(tmpdir(), 'stryker-entry-native-'));
    try {
      const events = [];
      const cached = createInstrumenter(logger, { cacheDir, engine: 'native', instrumentationThreads: 1, onEvent: event => events.push(event) });
      assert.deepEqual(await cached.instrument(files, options), expected);
      const execution = { ...cached.instrumentationStats };
      assert.deepEqual(await cached.instrument(files, options), expected);
      assert.deepEqual(cached.instrumentationStats, execution, 'cache hits do not record native execution');
      assert.deepEqual(cached.stats, { hits: 1, misses: 1, bypasses: 0, errors: 0, nativeBatches: 1, fallbackBatches: 0, nativeErrors: 0 });
      assert.deepEqual(events, [{ type: 'misses', reason: undefined }, { type: 'hits', reason: undefined }]);
    } finally { await rm(cacheDir, { recursive: true, force: true }); }
    const unsupported = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(unsupported.instrument([{ name: 'pipeline.js', content: 'const result = 1 |> increment;', mutate: true }],
      { ...options, plugins: [['pipelineOperator', { proposal: 'fsharp' }]] }), /Native instrumentation unsupported/);
    assert.equal(unsupported.stats.fallbackBatches, 0);
    for (const specifier of forbidden) await assert.rejects(import(specifier), /Forbidden upstream import/, 'guard negative control');
  `);
});

test('concurrent first auto fallbacks initialize one real upstream instance per factory without core', () => {
  child(coreGuard + observeConstructor + `
    registerHooks({ resolve: guardedResolve, load: observe });
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const sut = createInstrumenter(logger, { cache: false });
    assert.equal(entryEvaluations, 0);
    await sut.instrument(files, options);
    assert.equal(entryInstances.length, 0, 'native-only calls never construct upstream');
    const unsupported = [{ name: 'pipeline.js', content: 'const increment = value => value + 1; const result = 1 |> increment;', mutate: true }];
    const config = { ...options, plugins: [['pipelineOperator', { proposal: 'fsharp' }]] };
    const results = await Promise.all(Array.from({ length: 4 }, () => sut.instrument(unsupported, config)));
    assert.equal(entryEvaluations, 1);
    assert.equal(entryInstances.length, 1);
    assert.equal(entryInstances[0].logger, logger);
    assert.equal(sut.stats.nativeBatches, 1);
    assert.equal(sut.stats.fallbackBatches, 4);
    const other = createInstrumenter(logger, { cache: false, engine: 'upstream' });
    assert.deepEqual(await other.instrument(unsupported, config), results[0]);
    assert.equal(entryInstances.length, 2, 'factories do not share mutable upstream state');
    const { Instrumenter } = await import('@stryker-mutator/instrumenter');
    const expected = await new Instrumenter(logger).instrument(unsupported, config);
    for (const result of results) assert.deepEqual(result, expected);
    const failure = new Error('actual print pipeline failure');
    entryInstances[0]._print = () => { throw failure; };
    await assert.rejects(sut.instrument(unsupported, config), error => error === failure);
    assert.equal(sut.stats.fallbackBatches, 5);
    assert.equal(entryInstances.length, 3, 'a failed pipeline does not reconstruct fallback');
  `);
});

test('fallback retains custom ignorers, logger calls, complete results and upstream parse failures', () => {
  child(coreGuard + `
    registerHooks({ resolve: guardedResolve });
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const { Instrumenter } = await import('@stryker-mutator/instrumenter');
    const calls = () => {
      const events = [];
      return { events, logger: { ...logger, isDebugEnabled: () => true,
        debug: (...args) => events.push(['debug', ...args]),
        info: (...args) => events.push(['info', ...args]),
        warn: (...args) => events.push(['warn', ...args]) } };
    };
    const actualLog = calls(), expectedLog = calls();
    let visits = 0;
    const config = { ...options, ignorers: [{ shouldIgnore(path) {
      visits++;
      return path.isBooleanLiteral() ? 'custom boolean policy' : undefined;
    } }] };
    const sut = createInstrumenter(actualLog.logger, { cache: false });
    const expected = await new Instrumenter(expectedLog.logger).instrument(files, config);
    const expectedVisits = visits;
    assert.deepEqual(await sut.instrument(files, config), expected);
    assert.equal(visits, expectedVisits * 2);
    assert.deepEqual(actualLog.events, expectedLog.events);
    assert.ok(expected.mutants.some(mutant => mutant.statusReason === 'custom boolean policy'));
    const invalid = [{ name: 'invalid.js', content: 'const = ;', mutate: true }];
    const rejected = async promise => {
      let failure;
      try { await promise; } catch (error) { failure = error; }
      assert.ok(failure, 'expected upstream failure');
      return failure;
    };
    const shape = error => ({ name: error.name, message: error.message.split(/\\n\\s+at /)[0],
      ...(error.cause ? { cause: shape(error.cause) } : {}) });
    assert.deepEqual(shape(await rejected(sut.instrument(invalid, options))),
      shape(await rejected(new Instrumenter(logger).instrument(invalid, options))));
    const failure = new Error('logger method failure');
    const broken = createInstrumenter({ ...logger, debug() { throw failure; } }, { cache: false, engine: 'upstream' });
    await assert.rejects(broken.instrument(files, options), error => error === failure);
    assert.equal(broken.stats.nativeErrors, 0);
    assert.equal(broken.stats.fallbackBatches, 1);
  `);
});

test('upstream mode is lazy and memoizes an initialization rejection without hiding its identity', () => {
  child(`
    let attempts = 0;
    const failure = new Error('upstream import failed');
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@stryker-mutator/instrumenter') { attempts++; throw failure; }
      if (specifier === '@stryker-mutator/core') throw new Error('Unexpected core import');
      return next(specifier, context);
    } });
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const sut = createInstrumenter(logger, { cache: false, engine: 'upstream' });
    assert.equal(attempts, 0);
    const settled = await Promise.allSettled([sut.instrument(files, options), sut.instrument(files, options)]);
    for (const result of settled) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, failure); }
    await assert.rejects(sut.instrument(files, options), error => error === failure);
    assert.equal(attempts, 1);
    assert.equal(sut.stats.fallbackBatches, 3);
    assert.equal(sut.stats.nativeErrors, 0);
  `);
});

test('a missing native addon preserves auto fallback and strict native rejection policies', () => {
  child(coreGuard + observeConstructor + `
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('../native/stryker-rust.') || /^stryker-mutator-rust-(darwin|linux|win32)-/.test(specifier)) {
        throw new Error('test native addon unavailable');
      }
      return guardedResolve(specifier, context, next);
    }, load: observe });
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const native = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(native.instrument(files, options), error => error instanceof AggregateError && /No compatible Rust binding/.test(error.message));
    assert.equal(entryInstances.length, 0);
    assert.equal(native.stats.nativeErrors, 1);
    assert.equal(native.stats.fallbackBatches, 0);
    const auto = createInstrumenter(logger, { cache: false });
    const result = await auto.instrument(files, options);
    assert.equal(entryInstances.length, 1);
    const { Instrumenter } = await import('@stryker-mutator/instrumenter');
    assert.deepEqual(result, await new Instrumenter(logger).instrument(files, options));
    assert.equal(auto.stats.nativeErrors, 1);
    assert.equal(auto.stats.fallbackBatches, 1);
  `);
});

for (const installation of ['before', 'after']) {
  test(`installation ${installation} factory creation preserves the original hook and isolated counters`, () => {
    child(`
      const { Instrumenter } = await import('@stryker-mutator/instrumenter');
      const { Stryker: UpstreamStryker } = await import('@stryker-mutator/core');
      const { installAcceleration, createInstrumenter: legacy, Stryker } = await import('./lib/index.js');
      const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
      assert.equal(Object.getPrototypeOf(Stryker), UpstreamStryker);
      class Derived extends Stryker {}
      assert.ok(Derived.prototype instanceof UpstreamStryker);
      const original = Instrumenter.prototype.instrument;
      const install = () => installAcceleration({ cache: false, engine: 'native', coreEngine: 'upstream', instrumentationThreads: 2 });
      let installed;
      if (${JSON.stringify(installation)} === 'before') installed = install();
      const events = [], legacyEvents = [];
      const settings = { cache: false, engine: 'auto', instrumentationThreads: 2 };
      const sut = createInstrumenter(logger, { ...settings, onEvent: event => events.push(event) });
      const expected = legacy(logger, { ...settings, onEvent: event => legacyEvents.push(event) });
      const forceFallback = { ...options, ignorers: [{ shouldIgnore() {} }] };
      if (${JSON.stringify(installation)} === 'after') {
        // Also keep an already initialized fallback across installation.
        const initialized = createInstrumenter(logger, { cache: false, engine: 'upstream' });
        await initialized.instrument(files, options);
        installed = install();
        await initialized.instrument(files, options);
        assert.equal(initialized.stats.fallbackBatches, 2);
      }
      const marker = Symbol.for('stryker-mutator-rust.instrumenter.v1');
      const record = Instrumenter.prototype[marker];
      const hook = Instrumenter.prototype.instrument;
      assert.equal(record.original, original);
      for (const config of [options, forceFallback]) assert.deepEqual(await sut.instrument(files, config), await expected.instrument(files, config));
      assert.deepEqual(sut.stats, expected.stats);
      assert.deepEqual(sut.instrumentationStats, expected.instrumentationStats);
      assert.deepEqual(events, legacyEvents);
      assert.equal(sut.stats.nativeBatches, 1);
      assert.equal(sut.stats.fallbackBatches, 1);
      assert.ok(Object.values(installed.stats).every(value => value === 0), 'factory fallback must never enter the installed hook');
      assert.equal(Instrumenter.prototype.instrument, hook);
      assert.equal(Instrumenter.prototype[marker], record);
      assert.equal(installAcceleration(), installed);
    `);
  });
}

test('cache events, thread capture, validation and statistics match the existing factory', () => {
  child(`
    const { createInstrumenter } = await import('stryker-mutator-rust/instrumenter');
    const { createInstrumenter: legacy } = await import('./lib/index.js');
    const cacheDir = await mkdtemp(join(tmpdir(), 'stryker-entry-contract-'));
    try {
      const snapshots = [];
      for (const [index, factory] of [createInstrumenter, legacy].entries()) {
        const events = [];
        let reads = 0;
        process.env.STRYKER_RUST_THREADS = '1';
        const sut = factory(logger, { cacheDir: join(cacheDir, String(index)), engine: 'native',
          get instrumentationThreads() { reads++; return 2; }, onEvent(event) { events.push(event); throw new Error('observer failure'); } });
        process.env.STRYKER_RUST_THREADS = '3';
        const result = await sut.instrument(files, options);
        assert.deepEqual(await sut.instrument(files, options), result);
        assert.equal(reads, 1);
        assert.equal(sut.instrumentationStats.configuredThreads, 2);
        snapshots.push({ result, stats: sut.stats, instrumentationStats: sut.instrumentationStats, events });
        assert.throws(() => factory(logger, { engine: 'invalid' }), /engine must be/);
        assert.throws(() => factory(logger, { instrumentationThreads: 0 }), /positive safe integer/);
        const captured = factory(logger, { cache: false, engine: 'native' });
        process.env.STRYKER_RUST_THREADS = '7';
        assert.equal(captured.instrumentationStats.configuredThreads, 3);
        await captured.instrument(files, options);
        assert.equal(captured.instrumentationStats.configuredThreads, 3);
      }
      assert.deepEqual(snapshots[0], snapshots[1]);
    } finally { await rm(cacheDir, { recursive: true, force: true }); }
  `);
});

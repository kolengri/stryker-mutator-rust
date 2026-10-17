import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { cacheEligibility, nativeEligibility, serializePlain } from '../lib/cache.js';
import { logger, options } from './helpers.js';

const files = [{ name: '/fixture/values.ts', content: 'export function add(a: number,b: number) { return (a + b)! satisfies number; }', mutate: true }];

async function context(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stryker-rust-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sut: createInstrumenter(logger, { cacheDir: directory, engine: 'upstream' }) };
}

test('HTML Vue and Svelte native eligibility shares per-call parser checks while result caching stays ineligible', async (t) => {
  const { directory } = await context(t);
  const batch = [{ name: join(directory, 'source.html'), content: '<script>const flag=true;</script>', mutate: true }];
  assert.equal(await cacheEligibility(batch, options), false);
  assert.equal(await nativeEligibility(batch, options), true);
  for (const extension of ['vue', 'VUE', 'svelte', 'SVELTE']) {
    const vue = [{ ...batch[0], name: join(directory, `source.${extension}`) }];
    assert.equal(await nativeEligibility(vue, options), true);
    assert.equal(await cacheEligibility(vue, options), false);
  }
  for (const extension of ['astro']) {
    const framework = [{ ...batch[0], name: join(directory, `source.${extension}`) }];
    assert.equal(await nativeEligibility(framework, options), false);
    assert.equal(await cacheEligibility(framework, options), false);
  }
  assert.equal(await nativeEligibility(batch, { ...options, ignorers: [{}] }), false);
  assert.equal(await nativeEligibility(batch, { ...options, excludedMutations: null }), false);
  const config = join(directory, '.babelrc');
  await writeFile(config, '{}');
  assert.equal(await nativeEligibility(batch, options), false, 'observe newly created Babel configuration');
  assert.equal(await nativeEligibility([{ ...batch[0], name: join(directory, 'source.svelte') }], options), false);
  await rm(config);
  assert.equal(await nativeEligibility(batch, options), true, 'observe removed Babel configuration without memoization');
  assert.equal(await nativeEligibility([{ ...batch[0], name: join(directory, 'source.svelte') }], options), true);
  await writeFile(join(directory, 'package.json'), '{"babel":{}}');
  assert.equal(await nativeEligibility(batch, options), false);
  await writeFile(join(directory, 'package.json'), '{broken');
  await assert.rejects(nativeEligibility(batch, options), SyntaxError, 'preserve filesystem/configuration errors');
  assert.equal(await cacheEligibility(batch, options), false, 'HTML result-cache gate still exits before filesystem checks');
});

test('repeated HTML Vue Svelte native calls bypass result caching with exact bytes counters and events', async (t) => {
  const { directory } = await context(t);
  for (const extension of ['html', 'htm', 'vue', 'svelte']) {
    const batch = [{ name: `cache-source.${extension}`, content: '<script>function calc(){return 1+2;}</script>', mutate: true }];
    const events = [];
    const sut = createInstrumenter(logger, { cacheDir: directory, engine: 'native', onEvent: event => events.push(event) });
    const first = await sut.instrument(batch, options);
    assert.deepEqual(first.mutants, (await new Instrumenter(logger).instrument(batch, options)).mutants);
    assert.deepEqual(await sut.instrument(batch, options), first);
    assert.deepEqual(sut.stats, { hits: 0, misses: 0, bypasses: 2, errors: 0, nativeBatches: 2, fallbackBatches: 0, nativeErrors: 0 });
    assert.deepEqual(events, Array.from({ length: 2 }, () => ({ type: 'bypasses', reason: 'external parser configuration or ignorer' })));
  }
  assert.deepEqual(await readdir(directory), [], 'container output never enters the result cache');
});

test('HTML auto fallback preserves dynamic Babel effects and custom ignorer invocations', async (t) => {
  const { directory } = await context(t);
  const countFile = join(directory, 'count.txt');
  const configFile = join(directory, 'babel.config.cjs');
  await writeFile(join(directory, 'package.json'), '{"private":true}');
  await writeFile(configFile, `const fs=require('node:fs');module.exports=api=>{api.cache(false);fs.appendFileSync(${JSON.stringify(countFile)},'x');return {};};`);
  const batch = [{ name: join(directory, 'source.html'), content: '<script>const flag=true;</script>', mutate: true }];
  const sut = createInstrumenter(logger, { cacheDir: join(directory, 'cache'), engine: 'auto' });
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    await sut.instrument(batch, options);
    await sut.instrument(batch, options);
  } finally { process.chdir(previousCwd); }
  assert.equal(await readFile(countFile, 'utf8'), 'xx');
  assert.equal(sut.stats.nativeBatches, 0);
  assert.equal(sut.stats.fallbackBatches, 2);
  assert.equal(sut.stats.bypasses, 2);
  await rm(configFile);
  let calls = 0;
  const config = { ...options, ignorers: [{ shouldIgnore() { calls++; } }] };
  const ignored = createInstrumenter(logger, { cacheDir: join(directory, 'cache'), engine: 'auto' });
  await ignored.instrument(batch, config);
  const first = calls;
  await ignored.instrument(batch, config);
  assert.ok(first > 0);
  assert.equal(calls, first * 2);
  assert.equal(ignored.stats.nativeBatches, 0);
  assert.equal(ignored.stats.fallbackBatches, 2);
  assert.equal(ignored.stats.bypasses, 2);
});

for (const extension of ['vue', 'svelte']) test(`${extension} auto fallback preserves dynamic Babel effects and custom ignorer invocations`, async (t) => {
  const { directory } = await context(t);
  const countFile = join(directory, 'count.txt');
  const configFile = join(directory, 'babel.config.cjs');
  await writeFile(join(directory, 'package.json'), '{"private":true}');
  await writeFile(configFile, `const fs=require('node:fs');module.exports=api=>{api.cache(false);fs.appendFileSync(${JSON.stringify(countFile)},'x');return {};};`);
  const batch = [{ name: join(directory, `source.${extension}`), content: '<script>const flag=true;</script>', mutate: true }];
  const sut = createInstrumenter(logger, { cacheDir: join(directory, 'cache'), engine: 'auto' });
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    await sut.instrument(batch, options);
    await sut.instrument(batch, options);
  } finally { process.chdir(previousCwd); }
  assert.equal(await readFile(countFile, 'utf8'), 'xx');
  assert.equal(sut.stats.nativeBatches, 0);
  assert.equal(sut.stats.fallbackBatches, 2);
  assert.equal(sut.stats.bypasses, 2);
  await rm(configFile);
  let calls = 0;
  const config = { ...options, ignorers: [{ shouldIgnore() { calls++; } }] };
  const ignored = createInstrumenter(logger, { cacheDir: join(directory, 'cache'), engine: 'auto' });
  await ignored.instrument(batch, config);
  const first = calls;
  await ignored.instrument(batch, config);
  assert.ok(first > 0);
  assert.equal(calls, first * 2);
  assert.equal(ignored.stats.nativeBatches, 0);
  assert.equal(ignored.stats.fallbackBatches, 2);
  assert.equal(ignored.stats.bypasses, 2);
});

test('Vue parser eligibility observes live Babel files while JS and TS cache eligibility stays independent', async (t) => {
  const { directory } = await context(t);
  const batch = [{ name: join(directory, 'live.vue'), content: '<template><script>const flag=true;</script></template>', mutate: true }];
  const sut = createInstrumenter(logger, { cacheDir: join(directory, 'cache'), engine: 'auto' });
  await sut.instrument(batch, options);
  assert.equal(sut.stats.nativeBatches, 1);
  const config = join(directory, '.babelrc');
  await writeFile(config, '{}');
  assert.equal(await nativeEligibility(batch, options), false);
  assert.equal(await cacheEligibility(batch, options), false);
  await sut.instrument(batch, options);
  assert.equal(sut.stats.fallbackBatches, 1);
  await rm(config);
  await sut.instrument(batch, options);
  assert.equal(sut.stats.nativeBatches, 2);
  assert.deepEqual([sut.stats.bypasses, sut.stats.hits, sut.stats.misses, sut.stats.nativeErrors], [3, 0, 0, 0]);
  for (const extension of ['js', 'ts']) {
    const ordinary = [{ ...batch[0], name: join(directory, `ordinary.${extension}`), content: 'const flag=true;' }];
    assert.equal(await nativeEligibility(ordinary, options), true);
    assert.equal(await cacheEligibility(ordinary, options), true);
  }
  await writeFile(join(directory, 'package.json'), '{"babel":{}}');
  assert.equal(await nativeEligibility(batch, options), false);
  await writeFile(join(directory, 'package.json'), '{broken');
  await assert.rejects(nativeEligibility(batch, options), SyntaxError);
  assert.equal(await cacheEligibility(batch, options), false);
});

test('cache preserves exact files, metadata, global IDs and results on miss and hit', async (t) => {
  const { sut } = await context(t);
  const batch = [...files, { name: '/fixture/other.ts', content: 'export const flag = true;', mutate: true }];
  const expected = await new Instrumenter(logger).instrument(batch, options);
  assert.deepEqual(await sut.instrument(batch, options), expected);
  const cached = await sut.instrument(batch, options);
  assert.deepEqual(cached, expected);
  assert.equal(sut.stats.hits, 1);
  cached.mutants[0].replacement = 'mutated caller state';
  assert.deepEqual(await sut.instrument(batch, options), expected);
});

test('source, path, file order, ranges and mutator options invalidate cache', async (t) => {
  const { sut } = await context(t);
  await sut.instrument(files, options);
  const changes = [
    [[{ ...files[0], content: files[0].content.replace('+', '-') }], options],
    [[{ ...files[0], name: '/fixture/renamed.ts' }], options],
    [[{ ...files[0], mutate: false }], options],
    [files, { ...options, excludedMutations: ['ArithmeticOperator'] }],
    [[{ ...files[0], mutate: [{ start: { line: 0, column: 60 }, end: { line: 0, column: 75 } }] }], options],
  ];
  for (const [batch, config] of changes) {
    assert.deepEqual(await sut.instrument(batch, config), await new Instrumenter(logger).instrument(batch, config));
  }
  assert.equal(sut.stats.misses, changes.length + 1);
  assert.equal(sut.stats.hits, 0);
});

test('corrupted cache is regenerated, concurrent writes are atomic', async (t) => {
  const { sut, directory } = await context(t);
  const expected = await sut.instrument(files, options);
  const [entry] = (await readdir(directory)).filter((name) => name.endsWith('.bin'));
  await writeFile(join(directory, entry), '{broken');
  assert.deepEqual(await sut.instrument(files, options), expected);
  await rm(join(directory, entry));
  const results = await Promise.all(Array.from({ length: 4 }, () => sut.instrument(files, options)));
  for (const result of results) assert.deepEqual(result, expected);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  deserialize(await readFile(join(directory, entry)));
});

test('custom ignorers are invoked on every call and never cached', async (t) => {
  const { sut } = await context(t);
  let calls = 0;
  const config = { ...options, ignorers: [{ shouldIgnore() { calls++; } }] };
  await sut.instrument(files, config);
  const first = calls;
  await sut.instrument(files, config);
  assert.ok(first > 0);
  assert.equal(calls, first * 2);
  assert.equal(sut.stats.bypasses, 2);
});

test('directive inputs preserve repeated warnings without disabling native dispatch', async (t) => {
  const { directory } = await context(t);
  for (const directive of ['disable UnknownName', 'restore UnknownName', 'disable ALL', 'disable BooleanLiteral,', 'disable next-line ', 'disable BooleanLiteral']) {
    for (const engine of ['auto', 'upstream']) {
      const files = [{ name: 'directive.js', content: `// Stryker ${directive}\nconst flag = true;`, mutate: true }];
      const expectedWarnings = [], actualWarnings = [];
      const reference = new Instrumenter({ ...logger, warn: (...args) => expectedWarnings.push(args) });
      const sut = createInstrumenter({ ...logger, warn: (...args) => actualWarnings.push(args) }, { cacheDir: directory, engine });
      let previous;
      for (let invocation = 0; invocation < 2; invocation++) {
        const expected = await reference.instrument(files, options);
        const actual = await sut.instrument(files, options);
        assert.deepEqual(actual.mutants, expected.mutants, `${engine}: ${directive}`);
        assert.deepEqual(actualWarnings, expectedWarnings, `${engine}: ${directive}: invocation ${invocation}`);
        if (previous) assert.deepEqual(actual, previous);
        previous = actual;
      }
      const native = engine === 'auto' && directive === 'disable BooleanLiteral';
      assert.equal(expectedWarnings.length, directive === 'disable BooleanLiteral' ? 0 : 2);
      assert.equal(sut.stats.nativeBatches, native ? 2 : 0);
      assert.equal(sut.stats.fallbackBatches, native ? 0 : 2);
      assert.equal(sut.stats.nativeErrors, 0);
      assert.equal(sut.stats.bypasses, 2);
      assert.equal(sut.stats.hits, 0);
      assert.equal(sut.stats.misses, 0);
    }
  }
  assert.deepEqual(await readdir(directory), [], 'directive output must never enter the cache');
});

test('cache I/O errors and diagnostic callback failures do not affect execution', async (t) => {
  const { directory } = await context(t);
  const path = join(directory, 'file');
  await writeFile(path, 'not a directory');
  const reference = await new Instrumenter(logger).instrument(files, options);
  for (const engine of ['auto', 'upstream']) {
    const baseline = createInstrumenter(logger, { cache: false, engine });
    const expected = await baseline.instrument(files, options);
    const sut = createInstrumenter(logger, { engine, cacheDir: join(path, 'nested'), onEvent() { throw new Error('observer'); } });
    const actual = await sut.instrument(files, options);
    assert.deepEqual(actual, expected, `${engine}: cache and callback failures preserve the complete engine result`);
    assert.deepEqual(actual.mutants, reference.mutants, `${engine}: complete ordered upstream records`);
    assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), reference.files.map(({ content, ...rest }) => rest));
    assert.equal(sut.stats.nativeBatches, baseline.stats.nativeBatches);
    assert.equal(sut.stats.fallbackBatches, baseline.stats.fallbackBatches);
    assert.ok(sut.stats.errors > 0);
  }
});

test('Babel config bypass does not execute config twice or reuse dynamic output', async (t) => {
  const { directory } = await context(t);
  const input = join(directory, 'source.js');
  const countFile = join(directory, 'count.txt');
  await writeFile(join(directory, 'package.json'), '{"private":true}');
  await writeFile(join(directory, 'babel.config.cjs'), `const fs = require('node:fs'); module.exports = api => { api.cache(false); fs.appendFileSync(${JSON.stringify(countFile)}, 'x'); return {}; };`);
  const batch = [{ name: input, mutate: true, content: 'export const flag = true;' }];
  const sut = createInstrumenter(logger, { cacheDir: join(directory, 'cache') });
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    await sut.instrument(batch, options);
    await sut.instrument(batch, options);
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(await readFile(countFile, 'utf8'), 'xx');
  assert.equal(sut.stats.bypasses, 2);
});

test('cache keys distinguish undefined, missing values and unsafe objects', () => {
  assert.notDeepEqual(serializePlain({ a: undefined }), serializePlain({}));
  assert.notDeepEqual(serializePlain(-0), serializePlain(0));
  for (const value of [new Date(), /x/, () => {}, { get value() { throw new Error('must not execute'); } }]) {
    assert.throws(() => serializePlain(value));
  }
});

test('unsafe arrays fall back without executing toJSON or custom iterators', async (t) => {
  const { directory } = await context(t);
  const batch = [{ name: 'array.js', content: 'const x = true;', mutate: true }];
  let toJsonCalls = 0;
  const executable = [];
  executable.toJSON = () => { toJsonCalls++; return ['BooleanLiteral']; };
  const native = createInstrumenter(logger, { cache: false, engine: 'auto' });
  const config = { ...options, excludedMutations: executable };
  assert.deepEqual(await native.instrument(batch, config), await new Instrumenter(logger).instrument(batch, config));
  assert.equal(native.stats.fallbackBatches, 1);
  assert.equal(toJsonCalls, 0);
  let iteratorCalls = 0;
  const iterator = function* () { iteratorCalls++; yield 'shared'; };
  const cached = createInstrumenter(logger, { cacheDir: directory });
  for (const excludedMutations of [[], ['BooleanLiteral']]) {
    excludedMutations[Symbol.iterator] = iterator;
    const config = { ...options, excludedMutations };
    assert.throws(() => serializePlain(excludedMutations));
    assert.deepEqual(await cached.instrument(batch, config), await new Instrumenter(logger).instrument(batch, config));
  }
  assert.equal(iteratorCalls, 0);
  assert.equal(cached.stats.hits, 0);
  assert.equal(cached.stats.bypasses, 2);
});

test('descriptor and proxy validation never executes accessors or proxy traps', () => {
  let calls = 0;
  const accessor = [1];
  Object.defineProperty(accessor, '0', { get() { calls++; return 1; }, enumerable: true });
  const hidden = {};
  Object.defineProperty(hidden, 'excludedMutations', { value: ['BooleanLiteral'] });
  for (const value of [accessor, [,], Object.assign([], { custom: 1 }), hidden, new (class extends Array {})(), new Proxy([], { getOwnPropertyDescriptor() { calls++; throw new Error('trap'); } })]) {
    assert.throws(() => serializePlain(value));
  }
  assert.equal(calls, 0);
});

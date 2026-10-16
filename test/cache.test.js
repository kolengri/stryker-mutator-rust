import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { serializePlain } from '../lib/cache.js';
import { logger, options } from './helpers.js';

const files = [{ name: '/fixture/values.ts', content: 'export function add(a: number,b: number) { return a + b; }', mutate: true }];

async function context(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stryker-rust-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sut: createInstrumenter(logger, { cacheDir: directory, engine: 'upstream' }) };
}

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

test('cache I/O errors and diagnostic callback failures do not affect execution', async (t) => {
  const { directory } = await context(t);
  const path = join(directory, 'file');
  await writeFile(path, 'not a directory');
  const sut = createInstrumenter(logger, { cacheDir: join(path, 'nested'), onEvent() { throw new Error('observer'); } });
  assert.deepEqual(await sut.instrument(files, options), await new Instrumenter(logger).instrument(files, options));
  assert.ok(sut.stats.errors > 0);
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

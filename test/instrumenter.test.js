import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from './helpers.js';

const cases = [
  ['arithmetic', 'function calc(a,b) { return (a + b) * (a - b) / (a % b); }', '[calc(6, 4), calc(3, 2)]'],
  ['if', 'function calc(a,b) { if (a > b) { return a + b; } return a - b; }', '[calc(4, 2), calc(1, 3)]'],
  ['equality', 'function calc(a,b) { return a === b || a != b; }', '[calc(1, 1), calc(1, 2)]'],
  ['logical', 'function calc(a,b) { return a && b || false; }', '[calc(true, false), calc(true, true)]'],
  ['coalesce', 'function calc(a,b) { return a ?? (b && true); }', '[calc(null, 2), calc(3, 1)]'],
  ['unary', 'function calc(a) { return -a + +a; }', '[calc(2), calc(-3)]'],
  ['not', 'function calc(a) { return !a; }', '[calc(true), calc(false)]'],
  ['ternary', 'function calc(a,b) { return a ? b + 1 : b - 1; }', '[calc(true, 2), calc(false, 2)]'],
  ['arrow', 'const calc = (a,b) => a + b;', '[calc(4, 2), calc.name]'],
  ['block arrow', 'const calc = (a,b) => { return a + b; };', '[calc(4, 2), calc.name]'],
  ['static', 'const flag = true; function calc(a) { return flag && a; }', '[calc(1), calc(0)]'],
  ['else', 'function calc(a) { if (a) return true; else return false; }', '[calc(1), calc(0)]'],
  ['unicode', 'const 𐐀 = true;\r\nfunction calc(a) {\u2028return 𐐀 && a > 0;\u2029}', '[calc(1), calc(-1)]'],
  ['ASI variable', 'const x = 1\ntrue\nfunction calc() { return x }', 'calc()'],
  ['ASI return', 'function calc(a) { return a\ntrue }', 'calc(2)'],
  ['ASI empty return', 'function calc() { return\ntrue }', 'calc()'],
  ['ASI arrow', 'const calc = a => a\ntrue', '[calc(2), calc.name]'],
  ['ASI if', 'function calc(a) { if (a) true\nfalse\nreturn a }', '[calc(1), calc(0)]'],
  ['ASI else', 'function calc(a) { if (a) true\nelse false\nreturn a }', '[calc(1), calc(0)]'],
];

function execute(code, observation, activeMutant, { afterLoad = false, hitLimit } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(code).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'test-0';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, ns });
}

for (const [name, source, observation] of cases) {
  test(`native parity: records, baseline, each active ID and coverage: ${name}`, async () => {
    const files = [{ name: `/fixture/${name}.js`, content: source, mutate: true }];
    const expected = await new Instrumenter(logger).instrument(files, options);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
    const actual = await sut.instrument(files, options);
    assert.equal(sut.stats.nativeBatches, 1, 'test must execute Rust, not fallback');
    assert.deepEqual(actual.mutants, expected.mutants);
    const native = actual.files[0].content;
    const upstream = expected.files[0].content;
    // A parseable instrumented baseline alone is not sufficient evidence.
    assert.deepEqual(execute(native, observation), execute(upstream, observation));
    for (const { id } of expected.mutants) {
      for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }]) {
        assert.deepEqual(execute(native, observation, id, settings), execute(upstream, observation, id, settings), `mutant ${id}: ${JSON.stringify(settings)}`);
      }
    }
  });
}

test('native exclusions, multiple files, selected-off files and global IDs match upstream', async () => {
  const files = [
    { name: '/fixture/one.js', content: 'function add(a,b){ return a+b; }', mutate: true },
    { name: '/fixture/off.js', content: 'const off = true;', mutate: false },
    { name: '/fixture/two.js', content: 'export const flag = true;', mutate: true },
  ];
  const config = { ...options, excludedMutations: ['BlockStatement', 'BooleanLiteral'] };
  const expected = await new Instrumenter(logger).instrument(files, config);
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.deepEqual(actual.mutants, expected.mutants);
});

test('unsupported grammar takes explicit atomic fallback without losing mutations', async () => {
  const files = [{ name: '/fixture/methods.js', content: 'export const lower = value => (value?.trim()).toLowerCase();', mutate: true }];
  const expected = await new Instrumenter(logger).instrument(files, options);
  const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
  assert.deepEqual(await auto.instrument(files, options), expected);
  assert.equal(auto.stats.fallbackBatches, 1);
  assert.equal(auto.stats.nativeBatches, 0);
  const native = createInstrumenter(logger, { cache: false, engine: 'native' });
  await assert.rejects(native.instrument(files, options), /unsupported/i);
});

test('future import grammar and string namespace exports preserve upstream errors or exclusions', async () => {
  const sources = [
    'import source x from "foo"; const flag = true;',
    'import defer * as x from "foo"; const flag = true;',
    'import x from "foo" assert { type: "json" }; const flag = true;',
    'import x from "foo" with { type: "json" }; const flag = true;',
    'export * as "foo" from "bar"; const flag = true;',
  ];
  for (const content of sources) for (const excludedMutations of [[], ['StringLiteral']]) {
    const files = [{ name: 'input.js', mutate: true, content }];
    const config = { ...options, excludedMutations };
    const upstream = new Instrumenter(logger);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await upstream.instrument(files, config); } catch (error) { failure = error; }
    // Stryker embeds the underlying call stack in some placement error messages.
    // Wrapper frames differ; preserve error class, source diagnostic and cause.
    if (failure) await assert.rejects(auto.instrument(files, config), (error) =>
      error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
    else assert.deepEqual(await auto.instrument(files, config), expected);
    assert.equal(auto.stats.fallbackBatches, 1);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, config), /unsupported/i);
  }
});

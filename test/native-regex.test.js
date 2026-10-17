import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mutate } from 'weapon-regex';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'regex.js', selection = true) => ({ name, content, mutate: selection });
const raw = (files, config = options, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: { threads },
})));
const plain = value => JSON.parse(JSON.stringify(value));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const abi = raw(files, config);
  assert.equal(abi.supported, true, abi.reason);
  assert.deepEqual(abi.result.mutants, plain(expected.mutants), 'complete ordered ABI records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'complete ordered API records');
  return { actual, expected };
}

function execute(result, observation, activeMutant, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    if (settings.setup) new vm.Script(settings.setup).runInContext(context, { timeout: 1000 });
    for (const { content } of result.files) new vm.Script(content).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'regex-test';
    if (settings.afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'runtime parity requires a deterministic external loop bound');
    error = { name: caught.name, message: caught.message };
  }
  const state = settings.state === undefined ? {} : {
    state: new vm.Script(settings.state).runInContext(context, { timeout: 1000 }),
  };
  return structuredClone({ value, error, ns, ...state });
}

function runtime({ actual, expected }, observation, environment = {}) {
  const baseline = execute(actual, observation, undefined, environment);
  assert.equal(baseline.error, undefined, 'native baseline must execute');
  assert.deepEqual(baseline, execute(expected, observation, undefined, environment));
  for (const active of [undefined, ...expected.mutants.map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(actual, observation, active, { ...environment, ...settings }),
        execute(expected, observation, active, { ...environment, ...settings }),
        `mutant ${active}, ${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}

const atoms = ['a', 'Z9_', '-', ' ', String.raw`\d`, String.raw`\D`, '[+-]', '[-+]', '[aba]', '[a a]',
  String.raw`\/`, String.raw`\\`, String.raw`[\/+]`, String.raw`[\\+]`];
const patterns = new Set(['^', '$', '^$', '$$', '^^a$', '$a^', 'a^$b', 'abc', String.raw`^[+-]?\d+$`]);
for (const atom of atoms) for (const quantifier of ['', '?', '+']) {
  for (const [start, end] of [['', ''], ['^', ''], ['', '$'], ['^', '$'], ['^^', '$$']]) {
    patterns.add(`${start}${atom}${quantifier}${end}`);
  }
}
for (const left of ['a?', String.raw`\d+`, '[+-]?']) for (const right of ['b+', String.raw`\D?`, '[ab]+']) {
  patterns.add(`^${left}${right}$`);
}

test('pinned weapon-regex level-one grammar: ordered patterns and full ABI/API records', async t => {
  const require = createRequire(import.meta.url);
  assert.equal(JSON.parse(readFileSync(require.resolve('weapon-regex/package.json'))).version, '2.0.6');
  const inputs = [...patterns];
  const files = inputs.map((pattern, index) => file(`const value${index} = /${pattern}/;`, `pattern-${index}.js`));
  const { actual } = await compare(files);
  let checked = 0;
  for (const [index, pattern] of inputs.entries()) {
    const replacements = actual.mutants.filter(m => m.fileName === files[index].name).map(m => m.replacement);
    const oracle = mutate(pattern, '', { mutationLevels: [1] }).map(m => `/${m.pattern}/`);
    assert.deepEqual(replacements, oracle, pattern);
    checked += oracle.length;
  }
  assert.equal(mutate(String.raw`^[+-]?\d+$`, '', { mutationLevels: [1] }).length, 6);
  assert.equal(actual.mutants.filter(m => m.fileName === 'pattern-3.js').length, 2, 'duplicate $ removals survive');
  t.diagnostic(`${inputs.length} patterns, ${checked} ordered regex mutants`);
});

const samples = ['', '0', '1', '12', '+12', '-12', '++12', '--12', 'a12', '12a', '12\n', '\n12', ' ',
  '+', '-', 'a', 'ab', 'aba', 'a/b', 'a\\b', '😀', '٩', 'A9_',
  String.raw`a/\12`, String.raw`a/\+12`, String.raw`a/\-12`, String.raw`a/\a`, String.raw`a/\1x`];
const observe = `JSON.stringify(${JSON.stringify(samples)}.map(value => calc(value)))`;
const runtimeCases = [
  ['target member receiver under logical not', String.raw`function calc(t) { return !/^[+-]?\d+$/.test(t); }`],
  ['direct regex receiver', String.raw`function calc(t) { return /^[+-]?\d+$/.test(t); }`],
  ['module-static and per-test coverage', String.raw`const initial = /^[+-]?\d+$/.test('12'); function calc(t) { return initial && /^[+-]?\d+$/.test(t); }`],
  ['escaped pattern and cloned strings', String.raw`function calc(t) { return !/^a\/\\[+-]?\d+$/.test(t || '\x61'); }`],
  ['classes and mixed quantifiers', String.raw`function calc(t) { return /^[ab]+\D?x?$/ .test(t); }`],
  ['operator clones and duplicate anchors', String.raw`function calc(t) { return /^^a$$/.test(t) === /\d?/.test(t); }`],
  ['method clones and regex arguments', String.raw`function calc(t) { return t.trim(/^[+-]?\d+$/); }`],
  ['template clones containing regex', 'function calc(t) { return !`match:${/^[+-]?\\d+$/.test(t)}`; }'],
  ['regex value property and identifier access', String.raw`const pattern = /^[+-]?\d+$/; function calc(t) { return pattern.test(t); }`],
];
for (const [name, content] of runtimeCases) {
  test(`regex instrumentation runtime: ${name}`, async () => {
    const result = runtime(await compare([file(content)]), observe);
    assert.ok(Object.keys(result.ns.mutantCoverage.perTest).length > 0);
    if (name === 'module-static and per-test coverage') {
      assert.ok(Object.keys(result.ns.mutantCoverage.static).length > 0);
    }
  });
}

test('previous literal-only loop and parameter fixtures have full positive ABI/API records', async () => {
  const pair = await compare([
    file('while(tick(true)) /x/.test(value);', 'literal-loop.js'),
    file('function f(a=/x/){}', 'literal-default.js'),
  ]);
  assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'Regex').length, 0);
  for (const output of pair.actual.files) assert.ok(output.content.includes('/x/'));
});

// Both guards live outside instrumented source. A removed body still advances
// tick(); a condition forced true still calls .test and reaches the body budget.
// Observe real .test results without changing the unbraced source statement.
const loopEnvironment = {
  setup: `const inputs=${JSON.stringify(samples)}; let ticks=0, tests=0, value; const matches=[];
    function tick(enabled) {
      if (++ticks > inputs.length + 1) throw new RangeError('regex loop condition budget');
      value=inputs[ticks - 1];
      return enabled && ticks <= inputs.length;
    }
    const originalTest=RegExp.prototype.test;
    RegExp.prototype.test=function(input) {
      if (++tests > inputs.length) throw new RangeError('regex loop body budget');
      const matched=originalTest.call(this,input); matches.push([input,matched]); return matched;
    };`,
  state: '({ticks, tests, matches})',
};

test('unbraced while regex bodies preserve records and bounded static/per-test runtime', async () => {
  const body = String.raw`while(tick(true)) /^[+-]?\d+$/.test(value);`;
  for (const [content, observation, coverage] of [
    [body, 'ticks', 'static'],
    [`function calc(){${body}}`, 'calc()', 'perTest'],
  ]) {
    const pair = await compare([file(content)]);
    assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'Regex').length, 6);
    const baseline = runtime(pair, observation, loopEnvironment);
    assert.deepEqual(baseline.state, {
      ticks: samples.length + 1, tests: samples.length,
      matches: samples.map(input => [input, /^[+-]?\d+$/.test(input)]),
    });
    assert.ok(Object.keys(baseline.ns.mutantCoverage[coverage]).length > 0);
  }
  // Prove the external bounds themselves; VM timeouts are always test failures.
  const forcedTrue = execute({ files: [file(String.raw`while(true) /^[+-]?\d+$/.test(value);`)] },
    'ticks', undefined, loopEnvironment);
  assert.deepEqual(forcedTrue.error, { name: 'RangeError', message: 'regex loop body budget' });
  assert.equal(forcedTrue.state.matches.length, samples.length);
  const removedBody = execute({ files: [file('while(tick(true));')] }, 'ticks', undefined, loopEnvironment);
  assert.equal(removedBody.error, undefined);
  assert.deepEqual(removedBody.state, { ticks: samples.length + 1, tests: 0, matches: [] });
});

test('default regex initializers preserve full records, explicit arguments and runtime activation', async () => {
  const pair = await compare([file(String.raw`function f(a=/^[+-]?\d+$/){return a;} const initial=f();`)]);
  assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'Regex').length, 6);
  const observation = `JSON.stringify({matches:${JSON.stringify(samples)}.map(input =>
    [initial.test(input),f().test(input),f(undefined).test(input)]),
    overrides:[f(null),f(false),f(0),f('explicit')]})`;
  const baseline = runtime(pair, observation);
  assert.deepEqual(JSON.parse(baseline.value), {
    matches: samples.map(input => Array(3).fill(/^[+-]?\d+$/.test(input))),
    overrides: [null, false, 0, 'explicit'],
  });
  for (const coverage of ['static', 'perTest']) {
    assert.ok(Object.keys(baseline.ns.mutantCoverage[coverage]).length > 0);
  }
});

test('Regex exclusions and directives retain Ignored records, reasons, order and runtime', async () => {
  const files = [file(String.raw`// Stryker disable next-line Regex: preserved regex
const pattern = /^[+-]?\d+$/;
function calc(t) { return pattern.test(t) || /[ab]+/.test(t); }`)];
  for (const config of [options, { ...options, excludedMutations: ['Regex'] },
    { ...options, excludedMutations: ['Regex', 'BooleanLiteral', 'BlockStatement'] }]) {
    const pair = await compare(files, config);
    assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'Regex' && m.status === 'Ignored'));
    runtime(pair, observe);
  }
  const restored = await compare([file(String.raw`// Stryker disable Regex: initial
const first = /\d+/;
// Stryker restore Regex
const last = /[+-]?/;
function calc(t) { return first.test(t) && last.test(t); }`)]);
  assert.ok(restored.actual.mutants.some(m => m.mutatorName === 'Regex' && !m.status));
  runtime(restored, observe);
});

test('regex UTF16 ranges, global IDs, selected-off files and parallel emission agree', async () => {
  const files = [file('consume(true);', 'filtered.js'),
    file("const astral='😀';\r\nconst pattern=/^[+-]?\\d+$/;", 'ranges.js', [
      { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } },
    ]),
    file('const off=/[ab]?/;', 'off.js', false),
    file('const last=/[aba]?/;', 'last.js')];
  for (const config of [options, { ...options, noHeader: true }]) {
    const { expected } = await compare(files, config);
    const serial = raw(files, config);
    const parallel = raw(files, config, 4);
    assert.equal(parallel.supported, true, parallel.reason);
    assert.deepEqual(parallel.result, serial.result);
    assert.deepEqual(serial.result.mutants, plain(expected.mutants));
    assert.ok(Number(serial.result.mutants[0].id) > 0);
  }
});

test('unsupported regex syntax, flags and constructors reject mixed batches atomically without native errors', async () => {
  // Admitted former negatives retain full-record/runtime proof in native-regex-extensions.test.js.
  const unsupported = ['/a??/', '/a+?/',
    '/(ab)/', '/a|b/', '/(?=a)/', '/./', '/\\x61/', '/é/', '/[]/', '/\\^/',
    '/a/u', '/a/v',
    'new RegExp("^[+-]?\\\\d+$")', 'new RegExp("a", "i")'];
  for (const expression of unsupported) {
    const files = [file('const before=/^[+-]?\\d+$/;', 'before.js'),
      file(`const unsupported=${expression};`, 'unsupported.js'), file('const after=/[ab]+/;', 'after.js')];
    for (const config of [options, { ...options, excludedMutations: ['Regex'] }]) {
      for (const threads of [1, 4]) {
        const response = raw(files, config, threads);
        assert.equal(response.supported, false, expression);
        assert.equal(response.result, undefined, expression);
        assert.match(response.reason, /Regex|RegExp/);
      }
      const expected = await new Instrumenter(logger).instrument(files, config);
      const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
      assert.deepEqual(await auto.instrument(files, config), expected, expression);
      assert.equal(auto.stats.nativeBatches, 0);
      assert.equal(auto.stats.fallbackBatches, 1);
      assert.equal(auto.stats.nativeErrors, 0);
    }
  }
  const native = createInstrumenter(logger, { cache: false, engine: 'native' });
  await assert.rejects(native.instrument([file('const unsupported=/a*?/;')], options), /unsupported/i);
  assert.equal(native.stats.nativeErrors, 0);
  await compare([file('const recovered=/^[+-]?\\d+$/;')]);
});

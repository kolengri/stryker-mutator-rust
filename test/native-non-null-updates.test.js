import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';
import { nonNullUpdateOracle, pinnedNonNullSource, pinnedNonNullHash, nonNullErrorMessage, sha256, substitute, oracleGlobalState } from './non-null-update-oracle.js';

const file = (content, name = 'non-null-update.ts', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const metadata = files => files.map(({ content, ...rest }) => rest);
const proofs = [];
const raw = (files, config = options, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));
async function compare(files, config = options, modes = [1]) {
  const oracle = await nonNullUpdateOracle(files, config);
  const serial = raw(files, config);
  assert.equal(serial.supported, true, `${files.map(f => f.content).join('\n')}: ${serial.reason}`);
  assert.deepEqual(serial.result.mutants, plain(oracle.expected.mutants), 'independent full ordered mutation records');
  assert.deepEqual(metadata(serial.result.files), metadata(files), 'complete file metadata');
  for (const threads of modes) {
    const abi = raw(files, config, threads);
    assert.equal(abi.supported, true, abi.reason);
    assert.deepEqual(abi.result, serial.result, `all bytes, threads=${threads}`);
    for (const engine of ['native', 'auto']) {
      const sut = createInstrumenter(logger, { cache: false, engine,
        ...(threads === 'auto' ? {} : { instrumentationThreads: threads }) });
      assert.deepEqual(plain(await sut.instrument(files, config)), abi.result, `${engine}: complete ABI/API result`);
      assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
    }
  }
  const proof = { files, config, oracle: oracle.oracle, actual: serial.result, spans: oracle.spans, runtimeComparisons: 0 };
  proofs.push(proof);
  return { actual: serial.result, expected: oracle.expected, original: { files }, proof };
}

const completed = new Map();
const require = createRequire(import.meta.url);
const transpiler = process.versions.bun ? new Bun.Transpiler({ loader: 'ts' }) : undefined;
function executable({ content }) {
  if (!completed.has(content)) {
    // Only completed outputs are transpiled, identically for original, direct,
    // corrected upstream and native programs. Expose the fixture export to the VM.
    const code = transpiler ? transpiler.transformSync(content) : transformSync(content, {
      filename: 'input.ts', configFile: false, babelrc: false,
      presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
    }).code;
    completed.set(content, code.replace(/^export function count\(/m, 'function count('));
  }
  return completed.get(content);
}
function execute(result, setup, observation, state, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.initialTestId === undefined ? {} : { currentTestId: settings.initialTestId }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'VM timeout fails the proof');
    return { name: error.name, message: error.message };
  };
  evaluate(`const events=[];let budget=0;
    function bounded(){if(++budget>12)throw new RangeError('external iteration budget');}
    function capture(fn){try{return fn();}catch(error){return {error:{name:error.name,message:error.message}};}}
    ${setup}`);
  const loadErrors = [];
  for (let load = 0; load < (settings.loads ?? 1); load++) for (const output of result.files) {
    const script = new vm.Script(executable(output));
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'non-null-update-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = evaluate(observation); } catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, events: evaluate('events'), state: evaluate(state), ns });
}
function observable({ ns, ...value }) { return value; }
function runtime(pair, setup = '', observation = '[capture(()=>calc()),capture(()=>calc())]', state = 'null', baselineOK = true) {
  const original = observable(execute(pair.original, setup, observation, state));
  (pair.proof.baselines ??= []).push({ setup, observation, state, original });
  if (baselineOK) {
    assert.deepEqual(original.loadErrors, []);
    assert.equal(original.error, undefined);
  }
  assert.deepEqual(observable(execute(pair.actual, setup, observation, state)), original, 'inactive matches original TS');
  const settings = [{}, { afterLoad: true }, { initialTestId: 'load-test' }, { currentTestId: '' },
    { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }, { afterLoad: true, hitLimit: 2 }];
  if (pair.original.files.every(f => f.content.startsWith('function'))) settings.push({ loads: 2, afterLoad: true });
  for (const id of [undefined, ...pair.actual.mutants.map(m => m.id)]) {
    for (const setting of settings) {
      assert.deepEqual(execute(pair.actual, setup, observation, state, id, setting),
        execute(pair.expected, setup, observation, state, id, setting), `id=${id} ${JSON.stringify(setting)}`);
      pair.proof.runtimeComparisons++;
    }
  }
  for (const mutant of pair.actual.mutants.filter(m => m.status === 'Ignored')) {
    assert.deepEqual(observable(execute(pair.actual, setup, observation, state, mutant.id)), original,
      `ignored mutant ${mutant.id} stays inactive even when selected`);
    pair.proof.runtimeComparisons++;
  }
  for (const mutant of pair.actual.mutants.filter(m => m.status !== 'Ignored')) {
    const files = pair.original.files.map(f => ({ ...f, content: f.name === mutant.fileName ? substitute(f.content, mutant) : f.content }));
    assert.deepEqual(observable(execute(pair.actual, setup, observation, state, mutant.id)),
      observable(execute({ files }, setup, observation, state)), `actual original-span direct mutant ${mutant.id}`);
    pair.proof.runtimeComparisons++;
  }
  return original;
}

const targetSetup = `let a=5,index=0,stored=5;
  const obj={get x(){events.push('get');return stored;},set x(v){events.push(['set',v]);stored=v;},0:4,1:7};
  const outer={inner:obj};
  function factory(){events.push('factory');return obj;}
  function key(){events.push('key');return 'x';}`;
for (const target of ['a!', 'obj.x!', 'obj!.x!', 'factory()[key()]!', 'outer.inner.x!', 'obj[index++]!', 'obj["x"]!', '(obj.x)!']) {
  for (const expression of [`${target}++`, `${target}--`, `++${target}`, `--${target}`]) test(`non-null update reference: ${expression}`, async () => {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    runtime(pair, targetSetup, '[capture(()=>calc()),capture(()=>calc())]', '[a,index,stored,obj[0],obj[1]]');
  });
}

test('per-call original-AST oracle preserves ordinary upstream results and package globals', async () => {
  const before = oracleGlobalState();
  for (const [files, config] of [
    [[file('function calc(){return a++ + --b;}')], options],
    [[file('function calc(){return obj!.x++ + b!;}')], options],
    [[file('// Stryker disable next-line UpdateOperator: retained\na++; ++b; c--; --d;')], options],
    [[file('a++; b--;', 'ordinary.ts', [{start:{line:0,column:0},end:{line:0,column:4}}])], options],
    [[file('a++;'), file('b--;', 'second.ts', false)], { ...options, noHeader: true }],
    [[file('a++; b--;')], { ...options, excludedMutations: ['UpdateOperator'] }],
  ]) {
    const baseline = await new Instrumenter(logger).instrument(files, config);
    const oracle = await nonNullUpdateOracle(files, config);
    assert.equal(oracle.oracle.correctedConstructors, 0);
    assert.deepEqual(oracle.expected, baseline, 'complete ordinary output, ordered records and file metadata');
  }
  assert.deepEqual(oracleGlobalState(), before, 'shared mutator objects and methods are unchanged');
});

for (const [expression, mutator, replacement] of [
  ['!(a!++)', 'BooleanLiteral', 'a!++'],
  ['(a!++)+1', 'ArithmeticOperator', 'a!++ - 1'],
  ['a!--', 'UpdateOperator', 'a!++'],
  ['!(a!--)', 'BooleanLiteral', 'a! --'],
  ['(a!--)+1', 'ArithmeticOperator', 'a! -- - 1'],
]) test(`review regression: ${expression}`, async () => {
  const pair = await compare([file(`function calc(){return ${expression};}`)], options, [1, 4, 'auto']);
  assert.equal(pair.actual.mutants.find(m => m.mutatorName === mutator).replacement, replacement);
  runtime(pair, 'let a=5;', '[capture(()=>calc()),capture(()=>calc())]', 'a');
});

for (const expression of ['(a!--)||1', '(a!--)&&1', '[a!--, b!++]', 'flag ? a!-- : b!++',
  '(a!--)===1', '-(a!--)', '[(a!++), (a!--), ++b!, --b!]']) {
  test(`original non-null update AST survives clone ancestor: ${expression}`, async () => {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    runtime(pair, 'let a=5,b=3;const flag=true;', '[capture(()=>calc()),capture(()=>calc())]', '[a,b]');
  });
}

for (const expression of ["obj['\\x78']!--", 'obj[0xff]!--', 'obj[1_000-1_000]!--',
  'obj[/x/mi.test(key)]!--', "obj[pick('\\x78',0xff,/x/mi)]!--", "obj['!--']!--"]) {
  test(`postfix decrement shares raw literal printer ranges: ${expression}`, async () => {
    const pair = await compare([file(`function calc(){return (${expression})+1;}`)]);
    runtime(pair, `const key='x';const obj={x:5,255:7,0:4,true:6,false:3,'!--':2};
      function pick(s,n,re){events.push(['pick',s,n,re.flags]);return re.test(key)?s:n;}`,
      '[capture(()=>calc()),capture(()=>calc())]', '[obj.x,obj[255],obj[0],obj.true,obj.false,obj["!--"]]');
  });
}

for (const expression of ['(obj.x!-- satisfies number)+1', '(<number>(obj.x!--))+1', '(x=>obj.x!--)(1)']) {
  test(`non-null decrement shares assertion and arrow generated ranges: ${expression}`, async () => {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    runtime(pair, 'const obj={x:5};', '[capture(()=>calc()),capture(()=>calc())]', 'obj.x');
  });
}

test('mixed literal array keys retain their existing explicit printer boundary', async () => {
  const files = [file("function calc(){return obj[['\\x78',0xff,/x/mi][0]]!--;}")];
  const response = raw(files);
  assert.equal(response.supported, false);
  assert.equal(response.result, undefined);
  assert.match(response.reason, /Multiline array printing requires upstream replacement formatting/);
  await assert.rejects(new Instrumenter(logger).instrument(files, options), error => error.name === 'TypeError' && error.message === nonNullErrorMessage);
  const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
  await assert.rejects(auto.instrument(files, options), error => error.name === 'TypeError' && error.message === nonNullErrorMessage);
  assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
});

test('pinned original non-null corpus error is corrected with all four intended source mutations', async () => {
  const source = process.env.STRYKER_UPSTREAM ? readFileSync(`${process.env.STRYKER_UPSTREAM}/packages/instrumenter/testResources/instrumenter/non-null-expression.ts`, 'utf8') : pinnedNonNullSource;
  assert.equal(source, pinnedNonNullSource);
  assert.equal(sha256(source), pinnedNonNullHash);
  let upstreamError;
  try { await new Instrumenter(logger).instrument([file(source)], options); } catch (error) { upstreamError = error; }
  assert.equal(upstreamError?.name, 'TypeError');
  assert.equal(upstreamError.message, nonNullErrorMessage);
  const upstream = createInstrumenter(logger, { cache: false, engine: 'upstream' });
  await assert.rejects(upstream.instrument([file(source)], options), error => error.name === 'TypeError' && error.message === nonNullErrorMessage);
  const pair = await compare([file(source, 'non-null-expression.ts')], options, [1, 4, 'auto']);
  assert.deepEqual(pair.proof.spans.map(m => [m.id, m.mutatorName, m.original, m.replacement]), [
    ['0', 'BlockStatement', source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1), '{}'],
    ['1', 'BlockStatement', '{\n    c[letter.charCodeAt(0) - 65]!++;\n  }', '{}'],
    ['2', 'UpdateOperator', 'c[letter.charCodeAt(0) - 65]!++', 'c[letter.charCodeAt(0) - 65]! --'],
    ['3', 'ArithmeticOperator', 'letter.charCodeAt(0) - 65', 'letter.charCodeAt(0) + 65'],
  ]);
  pair.proof.upstreamError = { name: upstreamError.name, message: upstreamError.message, stack: upstreamError.stack };
  const baseline = runtime(pair, `function letters(){return {[Symbol.iterator]:function*(){for(const x of ['A','B','A','Z']){bounded();yield x;}}};}`,
    '[capture(()=>Array.from(count(letters()))),capture(()=>Array.from(count(letters())))]', 'budget');
  assert.deepEqual(baseline.value[0].filter(Boolean), [2, 1, 1]);
});

test('exact obsolete negative source bytes have positive ABI/API and runtime witnesses', async () => {
  for (const source of ['obj!.x!++;', 'c[index]!++;']) {
    const pair = await compare([file(source)], options, [1, 4, 'auto']);
    runtime(pair, 'const obj={x:5};const c=[5];const index=0;', '[obj.x,c[0]]', '[obj.x,c[0]]');
  }
});

test('receiver/key/getter/setter order, numeric conversion and errors match direct source mutations', async () => {
  const pair = await compare([file('function calc(){return factory()[key()]!++;}')]);
  for (const initial of ['"5"', '5n', 'NaN', '-0', 'Infinity', 'undefined', 'null',
    '{[Symbol.toPrimitive](hint){events.push(["primitive",hint]);return 5;}}',
    '{valueOf(){events.push("valueOf");return {};},toString(){events.push("toString");return "5";}}',
    'Symbol("bad")', '{[Symbol.toPrimitive](){events.push("throw conversion");throw new TypeError("conversion");}}']) {
    const baseline = runtime(pair, `let stored=${initial};const obj={get x(){events.push('get');return stored;},set x(v){events.push(['set',v]);stored=v;}};
      function factory(){events.push('factory');return obj;} function key(){events.push('key');return {[Symbol.toPrimitive](hint){events.push(['key primitive',hint]);return 'x';}};}`,
    '[capture(()=>calc()),capture(()=>calc())]', 'typeof stored');
    assert.deepEqual(baseline.events.slice(0, 4), ['factory', 'key', ['key primitive', 'string'], 'get']);
    if (initial === '"5"') {
      assert.deepEqual(baseline.value, [5, 6]);
    }
  }
  for (const setup of [
    'function factory(){events.push("factory");throw new Error("receiver");}function key(){events.push("key");return "x";}',
    'function factory(){events.push("factory");return null;}function key(){events.push("key");return "x";}',
    'function factory(){events.push("factory");return {};}function key(){events.push("key");throw new Error("key");}',
    'function factory(){return {get x(){events.push("get");throw new Error("getter");}};}function key(){return "x";}',
    'function factory(){return {get x(){events.push("get");return 5;},set x(v){events.push("set");throw new Error("setter");}};}function key(){return "x";}',
  ]) runtime(pair, setup);
  for (const content of ['function calc(){return missing!++;}', 'function calc(){return ++fixed!;}',
    'function calc(){return obj.x!++;}']) {
    const errors = await compare([file(content)]);
    runtime(errors, 'const fixed=5;const obj=Object.freeze({x:5});');
  }
});

test('closures, load-time updates, this receivers and contextual update roots retain state and coverage', async () => {
  for (const [source, setup, observation, state] of [
    ['let n=5;function calc(){return n!++;}', '', '[capture(()=>calc()),capture(()=>calc())]', 'n'],
    ['a!++;function calc(){return ++a!;}', 'let a=5;', '[capture(()=>calc()),capture(()=>calc())]', 'a'],
    ['function make(){let n=5;return ()=>n!++;}let calc=make();', '', '[capture(()=>calc()),capture(()=>calc())]', 'null'],
    ['function calc(){return this.x!++;}', 'const obj={x:5};', '[capture(()=>calc.call(obj)),capture(()=>calc.call(obj))]', 'obj.x'],
    ['function calc(){if(a!++)return true;return false;}', 'let a=0;', '[capture(()=>calc()),capture(()=>calc())]', 'a'],
    ['const label="😀";function calc(){return obj.x!++;}\r\n', 'const obj={x:5};', '[label,capture(()=>calc()),capture(()=>calc())]', 'capture(()=>[label,obj.x])'],
  ]) runtime(await compare([file(source)]), setup, observation, state);
});

test('selection directives excluded/all ignored noHeader no-mutants and spawned recovery retain batch contracts', async () => {
  const source = '// 😀\r\nfunction calc(){return obj!.x!++;}';
  for (const [files, config] of [
    [[file(source)], options],
    [[file(source)], { ...options, noHeader: true }],
    [[file(source, 'range.ts', [{ start: { line: 1, column: 16 }, end: { line: 1, column: 30 } }])], options],
    [[file(source, 'none.ts', false)], options],
    [[file('a!++;')], { ...options, excludedMutations: ['UpdateOperator'] }],
    [[file('// Stryker disable all: retained\na!++;')], options],
    [[file('// Stryker disable next-line UpdateOperator: retained\na!++;')], options],
    [[file('const inert=1;')], options],
  ]) {
    const pair = await compare(files, config, [1, 4, 'auto']);
    let setup = 'let a=5;const obj={x:5};';
    if (config.noHeader) {
      // A noHeader caller supplies the same published helpers. Obtain them
      // independently from upstream, including coverage and hit-limit behavior.
      const reference = await new Instrumenter(logger).instrument([file('function calc(){return a++;}')], options);
      const end = reference.files[0].content.indexOf('function calc(');
      assert.ok(end > 0);
      setup += reference.files[0].content.slice(0, end);
    }
    runtime(pair, setup, 'typeof calc==="function"?capture(()=>calc()):null', '[a,obj.x]');
  }
  const recoveryFiles = [file('function calc(){return obj.x!++;}'), file('type Hidden=typeof stryMutAct_9fa48;', 'opaque.ts'), file('const last=true;', 'last.ts')];
  const pair = await compare(recoveryFiles, options, [1, 4, 'auto']);
  const recovered = raw(recoveryFiles, options, 4);
  assert.ok(recovered.execution.spawnedThreads > 0, 'actual parallel workers attempted');
  assert.equal(recovered.execution.serialRecoveries, 1);
  assert.equal(recovered.execution.reason, 'unproven-relocation');
  pair.proof.execution = recovered.execution;
  runtime(pair, 'const obj={x:5};', '[capture(()=>calc()),capture(()=>calc()),last]', 'capture(()=>[obj.x,last])');
});

test('unsupported siblings and conservative typed/optional/private/super targets stay atomic', async () => {
  for (const source of ['a!!++;', 'obj!.x! = value;', 'for(obj!.x! of values);', '(obj.x as number)++;', '(obj.x satisfies number)++;',
    '(<number>obj.x)++;', '(obj?.x)!++;', 'class C{#x=0;f(){this.#x!++;}}',
    'class C extends B{f(){super.x!++;}}', 'factory().trim().field!++;', 'factory().trim().field++;', '[a]=values;']) {
    const files = [file('a!++;', 'supported.ts'), file(source, 'unsupported.ts')];
    const response = raw(files, options, 4);
    assert.equal(response.supported, false, source);
    assert.equal(response.result, undefined);
    await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, options), /unsupported/i);
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    if (failure) await assert.rejects(auto.instrument(files, options), error => error.name === failure.name && error.message === failure.message);
    else assert.deepEqual(await auto.instrument(files, options), expected);
    assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
  }
});


test('unsupported siblings remain atomic when excluded ignored or unselected', async () => {
  for (const [unsupported, config] of [
    [file('[a]=values;', 'unsupported.ts', false), options],
    [file('[a]=values;', 'unsupported.ts', []), options],
    [file('// Stryker disable all: retained\n[a]=values;', 'unsupported.ts'), options],
    [file('[a]=values;', 'unsupported.ts'), { ...options, excludedMutations: ['UpdateOperator', 'BlockStatement'] }],
  ]) {
    const files = [file('a!++;', 'supported.ts'), unsupported];
    for (const threads of [1, 4, 'auto']) {
      const response = raw(files, config, threads);
      assert.equal(response.supported, false);
      assert.equal(response.result, undefined);
    }
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    if (failure) await assert.rejects(auto.instrument(files, config), error => error.name === failure.name && error.message === failure.message);
    else assert.deepEqual(await auto.instrument(files, config), expected);
    assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
  }
});

test('write complete source-span and runtime evidence when explicitly requested', () => {
  if (process.env.STRYKER_NON_NULL_PROOF) writeFileSync(process.env.STRYKER_NON_NULL_PROOF,
    JSON.stringify({ engine: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, pinnedNonNullHash, proofs }, (_key, value) => {
      if (typeof value === 'bigint') return { $bigint: String(value) };
      if (value === undefined) return { $undefined: true };
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { $number: Object.is(value, -0) ? '-0' : String(value) };
      return value;
    }, 2) + '\n');
});

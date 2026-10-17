import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const file = (content, name = 'capabilities.ts', mutate = true) => ({ name, content, mutate });
const raw = (files, workers = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: workers === 'auto' ? {} : { threads: workers },
})));
const transformed = new Map();
function transpile(content) {
  if (!transformed.has(content)) transformed.set(content, transformSync(content, {
    filename: 'input.ts', configFile: false, babelrc: false,
    presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
  }).code);
  return transformed.get(content);
}
async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const abi = raw(files, 1, config);
  assert.equal(abi.supported, true, `${abi.reason}: ${files.at(-1).content}`);
  assert.deepEqual(abi.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'raw ABI ordered records');
  const native = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await native.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public native ordered records');
  assert.equal(native.stats.nativeBatches, 1);
  assert.equal(native.stats.fallbackBatches, 0);
  assert.equal(native.stats.nativeErrors, 0);
  return { actual, expected };
}
function programError(error) {
  assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeouts are failed proofs');
  return { name: error.name, message: error.message };
}
async function execute(result, setup, observation, state, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  // An external activation budget bounds exact old for(;;) fixtures even when
  // a BlockStatement mutant removes both the callback and the break statement.
  let active = ns.activeMutant, checks = 0, running = true;
  Object.defineProperty(ns, 'activeMutant', { enumerable: true, get() {
    if (running && ++checks > 1000) throw new RangeError('activation budget');
    return active;
  }, set(value) { active = value; } });
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
  const loadErrors = [];
  let module, value, error;
  for (const { content } of result.files) {
    const source = transpile(content);
    if (/^export /m.test(source)) {
      module = new vm.SourceTextModule(`${source}\nexport function __observe(){return (${observation});}
        export function __state(){return (${state});}`, { context });
      await module.link(() => assert.fail('No fixture imports'));
      try { await module.evaluate({ timeout: 1000 }); } catch (caught) { loadErrors.push(programError(caught)); }
    } else {
      const script = new vm.Script(source);
      try { script.runInContext(context, { timeout: 1000 }); } catch (caught) { loadErrors.push(programError(caught)); }
    }
  }
  ns.currentTestId = settings.currentTestId ?? 'capabilities-test';
  if (settings.afterLoad) ns.activeMutant = id;
  if (module) { context.__observe = module.namespace.__observe; context.__state = module.namespace.__state; }
  try { value = new vm.Script(module ? '__observe()' : observation).runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = programError(caught); }
  running = false;
  return structuredClone({ value, error, loadErrors,
    state: new vm.Script(module ? '__state()' : state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }), ns });
}
async function runtime(pair, setup = '', observation = 'events', state = 'null', { baselineThrows = false } = {}) {
  const baseline = await execute(pair.actual, setup, observation, state);
  if (!baselineThrows) {
    assert.deepEqual(baseline.loadErrors, [], 'baseline load executes');
    assert.equal(baseline.error, undefined, 'baseline observer executes');
  }
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(await execute(pair.actual, setup, observation, state, id, settings),
        await execute(pair.expected, setup, observation, state, id, settings),
        `mutant=${id}, settings=${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}
function moduleTest(name, action) {
  test(name, async () => {
    if (typeof vm.SourceTextModule === 'function') return action();
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', `--test-name-pattern=^${name}$`,
      fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /# pass 1|ℹ pass 1/);
  });
}

moduleTest('runtime namespaces retain source ordered exports initialization opaque types and comment ownership', async () => {
  const source = `// Stryker disable next-line BooleanLiteral: namespace entry
export namespace N {
  export interface Shape { value: number; /* Stryker disable all: opaque */ }
  // Stryker disable next-line BooleanLiteral: local flag
  export const flag=true;
  // Stryker restore all
  export const seed=mark('seed',1_000+2);
  export namespace Inner { export const value=mark('inner',seed>>>2); }
  export function calc(x=1<<2){const y=x&7;return y+Inner.value;}
}
export namespace N { export const next=mark('next',N.seed+1); }
namespace Alias { export const value=mark('alias',0xff+1); }
namespace Dotted.Child { export const value=mark('dotted',true); }
declare namespace Hidden { const value: /* Stryker disable all */ true; }
const later=true;`;
  const pair = await compare([file(source)]);
  assert.ok(pair.actual.mutants.some(m => m.statusReason === 'local flag'));
  assert.ok(pair.actual.mutants.some(m => m.replacement.includes('1_000 - 2')));
  assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'BlockStatement').length, 1,
    'only the function body has a removal mutant');
  const baseline = await runtime(pair, 'function mark(k,v){events.push([k,v]);return v;}',
    '[N.flag,N.seed,N.Inner.value,N.calc(),N.next,Alias.value,Dotted.Child.value,later]');
  assert.deepEqual(baseline.events.map(([k]) => k), ['seed', 'inner', 'next', 'alias', 'dotted']);
});

test('ordinary branch comments and opaque interface comments preserve directives without invented owners', async () => {
  const source = `interface Shape { x: number; // Stryker disable all: opaque
}
function calc(x){if(x>0) x+=1; // first branch
else if(x<0) x-=1; // second branch
else x+=2; // last branch
return x;}
// Stryker disable next-line BooleanLiteral: real owner
const flag=true;
const later=false;`;
  const pair = await compare([file(source)]);
  assert.equal(pair.actual.mutants.filter(m => m.status === 'Ignored').length, 1);
  assert.match(pair.actual.files[0].content, /first branch/);
  await runtime(pair, '', '[calc(-2),calc(0),calc(2),flag,later]');
});

test('bitwise operands traverse in source order without bitwise arithmetic or xor assignment mutants', async () => {
  for (const operator of ['<<', '>>', '>>>', '&', '|', '^']) {
    const source = `function calc(a=1<<2){let x=3;const y=(mark('a',a+1) ${operator} mark('b',2+1))+1;
x^=mark('rhs',1+1);obj[(a+1)&3]+=mark('set',2+1);return [y,x,obj[1]];}`;
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'AssignmentOperator').length, 1, '^= has no mutant');
    await runtime(pair, 'const obj={0:1,1:2,2:3,3:4};function mark(k,v){events.push([k,v]);return v;}', 'calc(4)', 'obj');
  }
  const pair = await compare([file('function calc(flag){return flag&&(mark("left",1+2)&mark("right",3+4));}')]);
  const baseline = await runtime(pair, 'function mark(k,v){events.push([k,v]);return v;}', '[calc(false),calc(true)]');
  assert.deepEqual(baseline.events.map(([k]) => k), ['left', 'right']);
});

test('raw numeric tokens survive cloned replacements mixed strings arrows defaults and lvalues', async () => {
  for (const token of ['0xffffffff', '0x10', '0Xff', '1_000', '1e2', '1E+02', '0b1010', '0o17', '.5', '1.', '0.00', '1_2.3_4e+1']) {
    const source = `function calc(a=${token}+2){let x=${token};x+=${token};return flag??(a+${token});}`;
    const pair = await compare([file(source)]);
    assert.ok(pair.actual.mutants.some(m => m.replacement.includes(token)), token);
    await runtime(pair, 'const flag=null;', 'calc()');
  }
  const pair = await compare([file(`function calc(){return values.map(value=>0x10).filter(Boolean);}`)]);
  await runtime(pair, 'const values=[0,1];', 'calc()');
  for (const expression of ['(1_000).toString()', '(0x10).toString()', '(1e2).toString()', '(1).toString()', '(1_000)?.toString()']) {
    await runtime(await compare([file(`function calc(){return (0xff+1)+(${expression});}`)]), '', 'calc()');
  }
  const mixed = await compare([file(`function calc(){return values.map(x=>{const n=1_000+0xff;record('raw',n);return x+n;}).some(x=>x>0);}`)]);
  await runtime(mixed, 'const values=[1,2];function record(k,v){events.push([k,v]);}', 'calc()');
});

test('zero argument construction in logical clones is conditional and preserves thrown constructors', async () => {
  const source = 'function calc(config){return config.logger ?? new NullLogger();}';
  const pair = await compare([file(source)]);
  assert.ok(pair.actual.mutants.some(m => m.replacement === 'config.logger && new NullLogger()'));
  const setup = 'let count=0;function NullLogger(){events.push(["construct",++count]);this.kind="null";}';
  const baseline = await runtime(pair, setup, '[calc({logger:null}).kind,calc({logger:0}),calc({logger:{kind:"real"}}).kind]', 'count');
  assert.equal(baseline.state, 1);
  const throwing = await runtime(pair, 'let count=0;function NullLogger(){events.push(++count);throw new RangeError("constructor");}',
    'calc({logger:null})', 'count', { baselineThrows: true });
  assert.deepEqual(throwing.error, { name: 'RangeError', message: 'constructor' });
  assert.equal(throwing.state, 1);
  await runtime(pair, 'let count=0;function NullLogger(){events.push(++count);throw new RangeError("constructor");}',
    'calc({logger:7})', 'count');
  const atLoad = await compare([file('const value=config.logger ?? new NullLogger();')]);
  await runtime(atLoad, 'let count=0,reads=0;const config={get logger(){reads++;return null;}};function NullLogger(){events.push(++count);this.kind="null";}',
    'value.kind', '[count,reads]');
});

test('mapped sort block callback clones have exact formatting and observable callback evaluation', async () => {
  const source = `function calc(){const decorated=values.slice();decorated.sort((x,y)=>{const c=cmp(x,y);return c!==0?c:x-y;});return decorated;}`;
  const pair = await compare([file(source)]);
  const sort = pair.actual.mutants.find(m => m.mutatorName === 'MethodExpression' && m.replacement === 'decorated');
  assert.ok(sort);
  const setup = 'const values=[3,1,2];let calls=0;function cmp(x,y){if(++calls>30)throw new RangeError("comparator budget");events.push([x,y]);return x-y;}';
  await runtime(pair, setup, 'calc()', 'calls');
  const clone = await compare([file('function calc(){return values.sort((x,y)=>{const c=cmp(x,y);return c!==0?c:x-y;}).filter(Boolean);}')] );
  assert.ok(clone.actual.mutants.some(m => m.replacement === 'values.sort((x, y) => {\n  const c = cmp(x, y);\n  return c !== 0 ? c : x - y;\n})'));
  await runtime(clone, setup, 'calc()', 'calls');
});

// Exact former negative fixtures are now positive ABI, public API and runtime
// proofs. Their negative counterparts change only the still-unproven boundary.
const previousBoundaries = [
  ['function f(a=1<<2){}', 'f()'],
  ['function f(a=1_000+2){}', 'f()'],
  ['class C{constructor(public x:number=1<<2){record(x);}}', 'new C().x'],
  ['class C { constructor(public x:number=1<<2){} }', 'new C().x'],
  ['class C{constructor(public x:number=1<<2){}}', 'new C().x'],
  ['namespace N {export const x=true;}', 'N.x'],
  ['a+(b=>{return b;})', 'events'],
  ['a+0x10', 'events'], ['a+1_000', 'events'], ['a+1e2', 'events'],
  ['const x = a + 0x10;', 'x'], ['const x = a + 1_000;', 'x'], ['const x = a + 1e2;', 'x'],
  ['const x = a + (b => { return b; });', 'typeof x'],
  ['function f(a,b,c) { return a+(b=>{return b;}); }', 'typeof f(1,2,3)'],
  ['function f(a,b,c) { return a+0x10; }', 'f(1,2,3)'],
  ['function f(a,b,c) { return a+1_000; }', 'f(1,2,3)'],
  ['function f(a,b,c) { return a+1e2; }', 'f(1,2,3)'],
  ['values.map(value=>{return value;}).filter(Boolean);', 'events'],
  ['values.map(value=>0x10).filter(Boolean);', 'events'],
  ["obj.trim('x',()=>{return 1;});", 'events'],
  ["obj.trim('x',0x10);", 'events'],
  ['for(;;){note(0x10);break;}', 'events'],
  ['for(;;){note(()=>{return 1;});break;}', 'events'],
  ['const value=(new C())+1;', 'typeof value'],
  ['factory().trim().field = x => { return x; };', 'typeof obj.field'],
  ['f(x => { return x; })', 'events'],
  ['obj.x += ()=>{return 1;};', '[typeof obj.x,Number.isNaN(obj.x)]'],
  ['factory().trim().field = x=>{return x;};', 'typeof obj.field'],
  ['obj.x += 0x10;', 'obj.x'],
  ['const x=obj.trim(() => { return 1; });', 'x===obj'],
  ['const a = value + (() => { return "x"; });', 'typeof a'],
  ['obj?.trim(()=>{return 1;});', 'events'],
];
test('all broadened former negative fixtures retain their exact source as positive proofs', async () => {
  const setup = `const a=2;const values=[0,2];const obj={x:1,trim(...args){events.push(args.map(x=>typeof x));return obj;}};
let notes=0;function factory(){return obj;}function f(x){events.push(x(2));}function record(x){events.push(x);}function note(x){if(++notes>3)throw new RangeError("note budget");events.push(typeof x==='function'?x():x);}function C(){events.push('new');}`;
  for (const [source, observation] of previousBoundaries) {
    let fixtureSetup = setup;
    if (source.startsWith('function f')) fixtureSetup = fixtureSetup.replace('function f(x){events.push(x(2));}', '');
    if (source.startsWith('const a =')) fixtureSetup = fixtureSetup.replace('const a=2;', 'const value=2;');
    if (source.includes('class C')) fixtureSetup = fixtureSetup.replace("function C(){events.push('new');}", '');
    try { await runtime(await compare([file(source)]), fixtureSetup, observation); }
    catch (error) { error.message += `\nExact former fixture: ${source}`; throw error; }
  }
});

test('unproven adjacent grammar still rejects mixed batches even when mutations are pruned or excluded', async () => {
  const unsupported = [
    // Exact old namespace is qualified in native-ts-assertion-wrappers.test.js.
    'namespace N {export const x=true satisfies true;}', 'module Alias {export const x=true;}',
    'namespace N {"directive";export const x=true;}',
    'function f(a=1**2){}', 'class C{constructor(public x:number=1**2){}}',
    'function calc(){return flag??new C(1);}', 'function calc(){return flag??new C<T>();}',
    'function calc(){return flag??new ns.C();}',
    'values.map(value=>{if(value)return value;}).filter(Boolean);',
    'values.map((value=1)=>{return value;}).filter(Boolean);',
    'function calc(x){if(x)x++; /* Stryker disable all */ else x--;return true;}',
    'const x=a+0x10n;',
  ];
  for (const source of unsupported) for (const mutate of [true, false, []]) {
    const files = [file('const first=true;', 'first.js'), file(source, 'unsupported.ts', mutate)];
    for (const config of [options, { ...options, excludedMutations: ['MethodExpression', 'ArithmeticOperator', 'LogicalOperator'] }]) {
      const serial = raw(files, 1, config);
      assert.equal(serial.supported, false, source);
      assert.equal(serial.result, undefined);
      assert.deepEqual(raw(files, 4, config), serial);
      const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
      await assert.rejects(strict.instrument(files, config), /unsupported/i);
      const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
      let expected, failure;
      try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
      if (failure) await assert.rejects(automatic.instrument(files, config), error => error.name === failure.name
        && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
      else assert.deepEqual(await automatic.instrument(files, config), expected);
      assert.equal(automatic.stats.fallbackBatches, 1);
      assert.equal(automatic.stats.nativeErrors, 0);
    }
  }
});

test('new capabilities preserve exclusions ignored reasons UTF16 ranges and empty selections', async () => {
  const source = `const emoji="😀";
namespace N {
// Stryker disable next-line ArithmeticOperator: namespace clone
export function calc(a=1_000+2){return config.logger??new NullLogger();}
export const flag=true;
}`;
  for (const mutate of [true, false, [], [{ start: { line: 3, column: 0 }, end: { line: 3, column: 90 } }]]) {
    for (const excludedMutations of [[], ['BlockStatement', 'ArithmeticOperator', 'LogicalOperator']]) {
      const pair = await compare([file(source, 'ranges.ts', mutate)], { ...options, excludedMutations });
      await runtime(pair, 'const config={logger:null};function NullLogger(){events.push("new");}', '[emoji,N.calc(),N.flag]');
    }
  }
  const noHeader = await compare([file('namespace N{export const value=1_000+2;}', 'noheader.ts')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
});

const benchmarkPath = new URL('../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/perf/benchmark-big.ts', import.meta.url);
test('unchanged pinned large benchmark has 948 exact ordered native records with serial parallel auto and recovery parity',
  { skip: !existsSync(benchmarkPath) }, async () => {
    const content = await readFile(benchmarkPath, 'utf8');
    const files = [file(content, fileURLToPath(benchmarkPath))];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants.length, 948);
    const large = raw(files);
    for (const workers of [4, 'auto']) assert.deepEqual(raw(files, workers).result, large.result);
    const small = [file('function calc(){return flag??new NullLogger();}', 'small.ts')];
    const clean = raw(small);
    const bad = [file('const first=true;', 'first.ts'), file('const x=a+0x10n;', 'bad.ts')];
    const rejected = raw(bad);
    for (const workers of [1, 4, 'auto']) {
      assert.deepEqual(raw(bad, workers), rejected);
      assert.deepEqual(raw(small, workers).result, clean.result);
      const mixed = [files[0], ...small];
      assert.deepEqual(raw(mixed, workers).result, raw(mixed).result);
    }
    const recovery = [...files, file('type T=typeof stryMutAct_9fa48;const live=true;', 'opaque.ts'), ...small];
    const recovered = raw(recovery, 4);
    assert.deepEqual(recovered.result, raw(recovery).result);
    if (recovered.execution.spawnedThreads) {
      assert.equal(recovered.execution.serialRecoveries, 1);
      assert.equal(recovered.execution.reason, 'unproven-relocation');
    }
    for (const instrumentationThreads of [1, 4, undefined]) {
      const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads });
      for (const batch of [files, small, recovery, small]) {
        const actual = await sut.instrument(batch, options);
        assert.deepEqual(JSON.parse(JSON.stringify(actual)), raw(batch).result);
      }
      await assert.rejects(sut.instrument(bad, options), /unsupported/i);
      assert.deepEqual(JSON.parse(JSON.stringify(await sut.instrument(small, options))), clean.result);
      assert.equal(sut.stats.fallbackBatches, 0);
      assert.equal(sut.stats.nativeErrors, 0);
    }
    const output = new URL('../artifacts/native-benchmark-capabilities/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('benchmark-receipt.json', output), JSON.stringify({
      source: fileURLToPath(benchmarkPath), sha256: createHash('sha256').update(content).digest('hex'),
      upstream: '10.0.0', supported: true, orderedMutants: pair.actual.mutants.length,
      nativeErrors: 0, fallbackBatches: 0, executionModes: [1, 4, 'auto'], speedMeasurement: false,
    }, null, 2));
  });

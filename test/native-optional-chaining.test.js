import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'chains.js', mutate = true) => ({ name, content, mutate });
async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  return { actual, expected };
}

function execute(code, setup, observation, activeMutant, { afterLoad = false, hitLimit } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(`const events = [];
      function capture(fn) {
        try { const value = fn(); return { value: value !== null && (typeof value === 'object' || typeof value === 'function') ? typeof value : value }; }
        catch (error) { return { error: { name: error.name, message: error.message } }; }
      }
      ${setup}`).runInContext(context, { timeout: 1000 });
    new vm.Script(code).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'chains-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  // Observers return data only; cloning must never obscure a function/proxy result.
  return structuredClone({ value, error, ns, events: new vm.Script('events').runInContext(context) });
}

function runtime({ actual, expected }, setup, observation = 'events') {
  const native = actual.files.map(f => f.content).join('\n');
  const upstream = expected.files.map(f => f.content).join('\n');
  const baseline = execute(native, setup, observation);
  assert.equal(baseline.error, undefined, 'baseline setup and observer must execute');
  assert.deepEqual(baseline, execute(upstream, setup, observation), 'baseline');
  for (const { id, status } of expected.mutants) {
    if (status === 'Ignored') continue;
    for (const afterLoad of [false, true]) for (const hitLimit of [undefined, 0, 1]) {
      const settings = { afterLoad, hitLimit };
      assert.deepEqual(execute(native, setup, observation, id, settings), execute(upstream, setup, observation, id, settings), `mutant ${id}: ${JSON.stringify(settings)}`);
    }
  }
}

const objectSetup = `
  const obj = new Proxy({}, { get(target, key) {
    events.push('get:' + key);
    if (key === 'length') return 7;
    return function (...args) { events.push(['call', key, this === obj, args]); return 'result'; };
  }});
  function arg() { events.push('arg'); return 2; }
  function factory() { events.push('factory'); return obj; }
`;
const twice = '[capture(() => calc()), capture(() => calc())]';

// Apache-2.0 StrykerJS resource, copyright Stryker Mutator contributors; see NOTICE.
// Exact bytes from c931a93237816901f1e9f48da411170beeb3dfca, instrumenter 10.0.0.
const functionalChains = 'foo?.bar?.trim?.();\n\nbaz?.trim();\n\nqux.trim().substring(3);\n\nquux.trim?.().substring(3);\n';
test('pinned functional-chains resource: full ordered records, removed ID 6 and runtime for every ID', async () => {
  if (process.env.STRYKER_UPSTREAM) assert.equal(await readFile(`${process.env.STRYKER_UPSTREAM}/packages/instrumenter/testResources/instrumenter/functional-chains.js`, 'utf8'), functionalChains);
  const pair = await compare([file(functionalChains, 'functional-chains.js')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id, m.mutatorName, m.replacement]), [
    ['0','MethodExpression','foo?.bar'], ['1','OptionalChaining','foo?.bar?.trim()'],
    ['2','OptionalChaining','foo?.bar.trim'], ['3','OptionalChaining','foo.bar'],
    ['4','MethodExpression','baz'], ['5','OptionalChaining','baz.trim'],
    ['7','MethodExpression','qux.trim()'], ['8','MethodExpression','qux'],
    ['9','MethodExpression','quux.trim?.()'], ['10','MethodExpression','quux'], ['11','OptionalChaining','quux.trim()'],
  ]);
  assert.doesNotMatch(pair.actual.files[0].content, /stry(?:MutAct|Cov)_9fa48\("6"/);
  const setup = `const holder = { trim() { events.push(this === holder); return ' string '; } };`;
  for (const declaration of [
    'const foo={bar:holder}, baz=holder, qux=holder, quux=holder;',
    'const foo=null, baz=holder, qux=holder, quux=holder;',
    'const foo=undefined, baz=holder, qux=holder, quux=holder;',
    'const foo={bar:null}, baz=holder, qux=holder, quux=holder;',
    'const foo={bar:undefined}, baz=holder, qux=holder, quux=holder;',
    'const foo={bar:{trim:null}}, baz=null, qux=holder, quux=holder;',
    'const foo={bar:{}}, baz=undefined, qux=holder, quux=holder;',
    'const foo={bar:holder}, baz=holder, qux=holder, quux={trim:null};',
    'const foo={bar:holder}, baz=holder, qux=holder, quux={};',
  ]) runtime(pair, setup + declaration);
});

const kindCases = [
  ['foo?.bar.baz();', [['0','OptionalChaining','foo.bar']]],
  ['Array?.();', [['0','OptionalChaining','Array()']]],
  ['Array()?.x;', [['0','OptionalChaining','Array().x'], ['1','ArrayDeclaration','Array([])']]],
  ['require?.("x");', [['0','OptionalChaining','require("x")'], ['1','StringLiteral','""']]],
  ['require("x")?.x;', [['0','OptionalChaining','require("x").x']]],
  ['Symbol?.("x");', [['0','OptionalChaining','Symbol("x")'], ['1','StringLiteral','""']]],
  ['Symbol("x")?.x;', [['0','OptionalChaining','Symbol("x").x']]],
  ['if(foo?.bar);', [['0','ConditionalExpression','true'], ['1','ConditionalExpression','false'], ['2','OptionalChaining','foo.bar']]],
  ['obj[key?.x]();', [['1','OptionalChaining','key.x']]],
];
test('Babel optional kinds, ordinary prefixes and independent keys retain exact candidate filters', async () => {
  for (const [content, records] of kindCases) {
    const pair = await compare([file(content)]);
    assert.deepEqual(pair.actual.mutants.map(m => [m.id,m.mutatorName,m.replacement]), records, content);
    runtime(pair, `const foo={bar:{baz(){events.push('baz');}}}, key={x:'run'};
      const obj={run(){events.push(this===obj);}};
      function Array(...args){events.push(args);return {x:3};}
      function require(x){events.push(x);return {x:4};}
      function Symbol(x){events.push(x);return {x:5};}`);
  }
});

for (const expression of [
  'obj?.trim()', 'obj.trim?.()', '(obj?.trim?.())', 'factory()?.trim(arg()).length',
  'obj?.endsWith(arg()).length', 'obj.endsWith?.(arg()).length', 'obj?.endsWith?.(arg()).length',
  'obj?.trim(arg()).toLowerCase().length', 'obj.trim?.(arg()).substring(1).length',
  'factory()?.[endsWith]?.(arg()).length', 'factory()?.[trim]?.(arg()).length',
]) test(`continuous spine replacements and this-sensitive receiver: ${expression}`, async () => {
  const pair = await compare([file(`function calc(){return ${expression};}`)]);
  runtime(pair, objectSetup + 'const endsWith="actual", trim="actual";', twice);
});

test('null and undefined at every nullable public member/call segment, missing and noncallable methods', async () => {
  const sources = [
    'function calc(){return root?.child?.trim?.(arg()).length;}',
    'function calc(){return root?.child?.endsWith?.(arg()).length;}',
    'function calc(){return root?.child?.trim(arg()).length;}',
    'function calc(){return root?.[key()]?.[method]?.(arg()).length;}',
  ];
  for (const source of sources) {
    const pair = await compare([file(source)]);
    for (const root of ['null','undefined','{child:null}','{child:undefined}','{child:{}}','{child:{trim:null,endsWith:null}}','{child:{trim:undefined,endsWith:undefined}}','{child:{trim:3,endsWith:3}}','{child:obj}']) {
      runtime(pair, objectSetup + `const root=${root}, method="trim"; function key(){events.push('key');return 'child';}`, twice);
    }
  }
});

test('optional functions and factory return values preserve call/argument evaluation and throws', async () => {
  for (const expression of ['fn?.(arg())?.trim?.().length', 'fn?.(arg()).trim().length']) {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    for (const fn of ['null','undefined','3','function(x){events.push(["fn",x]);return null;}','function(x){events.push(["fn",x]);return undefined;}','function(x){events.push(["fn",x]);return obj;}']) {
      runtime(pair, objectSetup + `const fn=${fn};`, twice);
    }
  }
});

test('getters, computed identifiers and argument/key chains have independent short-circuit placement', async () => {
  const cases = [
    ['obj?.[key.trim()]', 'const key=" x "; const obj={x:"result"," x ":"original"};'],
    ['obj?.[key?.trim()]?.length', 'const key=" x "; const obj={x:"result"," x ":"original"};'],
    ['obj?.[key.trim()]', 'const key=null, obj=null;'],
    ['obj?.[key.trim()]', 'const key=undefined, obj=undefined;'],
    ['obj?.[key?.trim()]', 'const key=null, obj={undefined:4};'],
    ['fn?.(obj?.trim())', objectSetup + 'function fn(x){events.push(["fn",typeof x]);return x;}'],
    ['fn?.(obj?.trim())', 'const fn=null, obj=null;'],
    ['obj[key?.x]()', 'const key={x:"run"}; const obj={run(){events.push(this===obj);return "result";}};'],
    ['obj[key?.x]()', 'const key=null; const obj={undefined(){events.push(this===obj);return "result";}};'],
    ['obj?.[endsWith]?.(arg())', objectSetup + 'Object.defineProperty(globalThis,"endsWith",{get(){events.push("key");return "actual";}});'],
    ['obj?.["trim"]?.(arg())', objectSetup],
    ['obj?.trim(arg()).length', 'const obj={get trim(){events.push("get:trim");throw new Error("getter failed");}};function arg(){events.push("arg");return 2;}'],
    ['obj?.trim?.(arg()).length', objectSetup.replace("events.push('arg'); return 2;", "events.push('arg'); throw new Error('argument failed');")],
    ['obj?.child?.trim?.(arg())', 'const child={get trim(){events.push("get:trim");return function(x){events.push(["trim",this===child,x]);return "result";}}}; const obj={get child(){events.push("get:child");return child;}};function arg(){events.push("arg");return 2;}'],
  ];
  for (const [expression, setup] of cases) runtime(await compare([file(`function calc(){return ${expression};}`)]), setup, twice);
});

test('static and per-test coverage retain shared spine hits when the original chain short-circuits', async () => {
  const pair = await compare([file('const initial=obj?.trim?.(arg()); function calc(){return obj?.[key.trim()]?.endsWith?.(arg());}')]);
  for (const obj of ['null','undefined','receiver']) {
    const setup = `const receiver={trim(){events.push('trim');return 'result';},x:'result',' x ':'result'}, obj=${obj}, key=' x ';function arg(){events.push('arg');return 2;}`;
    runtime(pair, setup, twice);
    if (obj !== 'receiver') {
      const result = execute(pair.actual.files[0].content, setup, twice);
      assert.equal(result.ns.mutantCoverage.static['0'], 1);
      assert.ok(Object.keys(result.ns.mutantCoverage.perTest['chains-test']).length > 0);
    }
  }
});

test('if-test context applies once and all existing applicable mutators coexist with chains', async () => {
  const sources = [
    'function calc(){if(obj?.trim()) return true; else return false;}',
    'const calc=x=>obj?.trim(x+1)?.[flag ? "x" : "y"];',
    'function calc(){return obj?.run([true],flag&&other,1<2,!flag,-value,~value,`x${1+2}`);}',
    'const holder={key:obj?.trim()}; function calc(){return holder.key;}',
    'function calc(){return obj?.[Array()]?.trim();}',
    'function calc(){return [1]?.length;}',
    'function calc(){return "x"?.length;}',
    'function calc(){return (flag?left:right)?.trim();}',
  ];
  const setup = objectSetup + 'const flag=true,other=false,value=3,left=obj,right=null;';
  for (const source of sources) runtime(await compare([file(source)]), setup, '[capture(()=>calc(2)),capture(()=>calc(3))]');
});

test('exclusions, empty/ignored directive reasons, ranges and cross-file gaps preserve full records', async () => {
  const sources = [
    'obj?.trim?.();', 'foo(obj?.trim());',
    '// Stryker disable next-line OptionalChaining: reason\nobj?.trim?.();',
    '// Stryker disable next-line OptionalChaining:   \nobj?.trim?.();',
    '// Stryker disable next-line MethodExpression: reason\nobj?.trim?.();',
    '// Stryker disable next-line all: reason\nobj?.trim?.();',
    '// Stryker disable next-line all:   \nobj?.trim?.();',
    'if(obj?.trim()) foo();',
  ];
  for (const source of sources) for (const excludedMutations of [[], ['OptionalChaining'], ['MethodExpression'], ['CallExpression'], ['OptionalChaining','MethodExpression','ConditionalExpression']]) {
    const pair = await compare([file(source)], {...options, excludedMutations});
    runtime(pair, objectSetup + 'function foo(x){events.push(typeof x);}');
    if (pair.actual.mutants.every(m => m.status === 'Ignored')) assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_/);
  }
  const content = 'obj?.trim?.().length;';
  for (const start of [0,1]) for (let end=0;end<=content.length;end++) {
    const selection=[{start:{line:0,column:start},end:{line:0,column:end}}];
    runtime(await compare([file(content,'ranges.js',selection)]), objectSetup);
  }
  const pair = await compare([file('foo(1+2);','first.js'),file('obj?.trim?.();','off.js',false),file('obj?.trim?.();','second.js'),file('obj[key?.x]();','third.js'),file('bar();','last.js')]);
  assert.deepEqual(pair.actual.mutants.map(m=>m.id), ['1','2','3','4','6','7']);
  runtime(pair, objectSetup + 'const key={x:"run"};function foo(x){events.push(x);}function bar(){events.push("bar");}');
});

test('unproven parenthesized spines and prior unsupported grammar reject batches atomically', async () => {
  for (const content of [
    '(obj?.trim)?.();', '(obj?.trim)();', '(obj?.trim()).length;', '(obj?.x)?.trim();',
    'obj?.trim(...args);', 'obj?.x++;', '[obj.x]=items;', 'delete obj?.x();',
    'new obj?.x();', 'obj?.x`tag`;', 'class C{#x;f(){return this?.#x;}}',
    'class C extends B{f(){return super.x?.();}}', 'const x: number=(obj?.x)!;',
    'obj?.trim(/* comment */ arg());', 'obj?.trim(()=>{return 1;});', 'obj?.run({key:1});',
  ]) {
    const files=[file('const first=true;','first.js'),file(content,content.includes(': number')?'unsupported.ts':'unsupported.js')];
    const raw=JSON.parse(loadNative().instrumentBatch(JSON.stringify({files,options})));
    assert.equal(raw.supported,false,content);
    assert.equal(raw.result,undefined,content);
    await assert.rejects(createInstrumenter(logger,{cache:false,engine:'native'}).instrument(files,options),/unsupported/i,content);
    const auto=createInstrumenter(logger,{cache:false,engine:'auto'});
    const oracle=new Instrumenter(logger);
    let expected, failure;
    try {expected=await oracle.instrument(files,options);} catch(error){failure=error;}
    if(failure) await assert.rejects(auto.instrument(files,options),error=>error.name===failure.name&&error.message.split(/\n\s+at /)[0]===failure.message.split(/\n\s+at /)[0]);
    else assert.deepEqual(await auto.instrument(files,options),expected,content);
    assert.equal(auto.stats.nativeBatches,0);
    assert.equal(auto.stats.fallbackBatches,1);
  }
});

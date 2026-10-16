import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { availableParallelism } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'bindings.js', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === undefined ? {} : { execution: { threads } }),
})));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'direct complete ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'public complete ordered records');
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

const stripped = new Map();
function executable(output) {
  if (!/\.[cm]?ts$/.test(output.name)) return output.content;
  if (!stripped.has(output.content)) stripped.set(output.content, stripTypeScriptTypes(output.content));
  return stripped.get(output.content);
}

function execute(result, setup, observation, id, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = source => new vm.Script(source).runInContext(context, { timeout: 1000 });
  const describe = error => {
    assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return error && typeof error === 'object' ? { name: error.name, message: error.message } : { primitive: error };
  };
  evaluate(`const events=[]; ${setup}`);
  const loadErrors = [];
  for (const output of result.files) {
    // Compilation errors are test failures, including for active mutants.
    const script = new vm.Script(`${settings.strict ? '"use strict";\n' : ''}${executable(output)}`);
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'inert-bindings';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = evaluate(observation); }
  catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, events: evaluate('events'), ns });
}

function runtime(pair, setup = '', observation = 'calc()') {
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const strict of [false, true]) for (const settings of [
      {}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 },
    ]) {
      assert.deepEqual(execute(pair.actual, setup, observation, id, { strict, ...settings }),
        execute(pair.expected, setup, observation, id, { strict, ...settings }),
        `id=${id}, strict=${strict}, settings=${JSON.stringify(settings)}`);
    }
  }
}

test('const let and var preserve aliases shorthand quoted numeric keys and original pattern bytes', async () => {
  for (const kind of ['const', 'let', 'var']) {
    const pattern = `{renamed: alias, other, 'quoted\\x20key': text, 0x01: numeric}`;
    const source = `function calc(){${kind} ${pattern}=makeSource(true,"value",1+2);return [alias,other,text,numeric];}`;
    const pair = await compare([file(source)]);
    assert.ok(pair.actual.files[0].content.includes(`${kind} ${pattern}=`));
    assert.deepEqual(pair.actual.mutants.filter(m => m.mutatorName === 'StringLiteral').map(m => m.replacement), ['""']);
    runtime(pair, `function makeSource(flag,text,n){events.push([flag,text,n]);return {renamed:n,other:flag,'quoted key':text,1:n};}`);
  }
});

test('recursive object and array patterns holes and identifier rest have no pattern mutants', async () => {
  const patterns = [
    ['{nested:{renamed:alias},list:[first,,{deep},...tail],...rest}', '[alias,first,deep,tail,rest]'],
    ['[{nested:[first,,...tail]},,last,...rest]', '[first,tail,last,rest]'],
    ['{empty:{},list:[],...rest}', 'rest'],
    ['[,,...rest]', 'rest'],
    ['{}', 'null'], ['[]', 'null'],
  ];
  const setup = `const object={nested:{renamed:3},list:[1,2,{deep:4},5,6],empty:{},other:true};
    const array=[{nested:[1,2,3,4]},2,5,6,7];`;
  for (const [pattern, observation] of patterns) {
    const initializer = pattern.startsWith('{') ? 'object' : 'array';
    const pair = await compare([file(`function calc(){const ${pattern}=${initializer};return ${observation};}`)]);
    assert.equal(pair.actual.mutants.some(m => ['ObjectLiteral', 'ArrayDeclaration'].includes(m.mutatorName)
      && m.location.start.column < 30 + pattern.length), false, 'patterns are not expression literals');
    runtime(pair, setup);
  }
});

test('literal initializers retain expression mutants while binding keys and brackets stay inert', async () => {
  for (const [source, expectedNames, observation] of [
    ['const [a] = ["x"];', ['ArrayDeclaration', 'StringLiteral'], 'a'],
    ['const {"x":a}={"x":true};', ['ObjectLiteral', 'BooleanLiteral'], 'a'],
    ['const { a } = { a: "x" };', ['ObjectLiteral', 'StringLiteral'], 'a'],
  ]) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants.map(m => m.mutatorName), expectedNames);
    runtime(pair, '', observation);
  }
});

test('getter initializer and rest property effects preserve order symbols and thrown values', async () => {
  const pair = await compare([file('function calc(){const {renamed:alias,other,...rest}=makeSource(true);return [alias,other,rest.extra,rest[symbol]];}')]);
  const common = `const symbol=Symbol('rest'); function makeSource(flag){events.push(['init',flag]);return {
    get renamed(){events.push('renamed');return 3;},get other(){events.push('other');return 4;},
    get extra(){events.push('extra');return 5;},get [symbol](){events.push('symbol');return 6;}};}`;
  runtime(pair, common);
  assert.deepEqual(execute(pair.actual, common, 'calc()').events,
    [['init', true], 'renamed', 'other', 'extra', 'symbol']);
  for (const thrown of ['new TypeError("getter failed")', '17', 'null', 'undefined']) {
    runtime(pair, `const symbol=Symbol();function makeSource(flag){events.push(['init',flag]);return {
      get renamed(){events.push('renamed');throw ${thrown};},get other(){events.push('unreached');return 4;}};}`);
  }
});

test('array binding iterator holes rest and abrupt nested binding close preserve runtime', async () => {
  const setup = `function iterable(value,throwNext=false,throwClose=false){return {[Symbol.iterator](){events.push('iterator');let n=0;
    return {next(){events.push(['next',n]);if(throwNext&&n===1)throw new RangeError('next failed');
      return n<4?{value:n++===0?value:n,done:false}:{done:true};},
      return(){events.push('close');if(throwClose)throw new SyntaxError('close failed');return {done:true};}};}};}`;
  for (const [pattern, observation] of [['[first]', 'first'], ['[,second]', 'second'], ['[first,,...tail]', '[first,tail]'], ['[{x}]', 'x'], ['[]', 'null']]) {
    const pair = await compare([file(`function calc(){const ${pattern}=source;return ${observation};}`)]);
    for (const value of ['{x:3}', 'null', 'undefined']) for (const flags of ['', ',true', ',false,true']) {
      runtime(pair, `${setup} const source=iterable(${value}${flags});`);
    }
  }
});

test('null undefined and primitive sources preserve exact upstream errors including mutated initializers', async () => {
  for (const initializer of ['null', 'undefined', 'true', '3', '"abc"', '[]', '{}']) {
    for (const [pattern, observation] of [['{renamed:alias}', 'alias'], ['[first]', 'first'], ['{}', 'null'], ['[]', 'null']]) {
      runtime(await compare([file(`function calc(){const ${pattern}=${initializer};return ${observation};}`)]));
    }
  }
});

test('top-level binding failures keep load errors partial effects and static coverage', async () => {
  for (const pattern of ['{x:alias}', '[alias]', '{nested:[alias]}']) {
    const pair = await compare([file(`const ${pattern}=makeSource(true);events.push("after");`)]);
    for (const value of ['null', 'undefined', 'true', '{x:3,nested:[4]}']) {
      runtime(pair, `function makeSource(flag){events.push(['init',flag]);return ${value};}`, 'events');
    }
  }
});

test('lexical TDZ shadowing var hoisting and multiple declarators retain binding environments', async () => {
  for (const kind of ['const', 'let', 'var']) {
    const source = `function calc(){${kind} {x:alias,y}=makeSource(()=>alias), {x:second}=other;{const {x:alias}=other;events.push(alias);}return [alias,y,second];}`;
    const pair = await compare([file(source)]);
    runtime(pair, `const other={x:8}; function makeSource(read){events.push('init');return {
      get x(){events.push('x');return read();},get y(){events.push('y');return 4;}};}`);
    runtime(pair, 'const other={x:8}; function makeSource(){events.push("init");return {x:3,y:4};}');
  }
  runtime(await compare([file('function calc(){events.push(typeof alias);var {x:alias}=source;return alias;}')]), 'const source={x:3};');
  runtime(await compare([file('function calc(){const {x:alias}=source,{x:second}=alias;return second;}')]), 'const source={x:{x:4}};');
});

test('anonymous pattern initializers receive no invented binding name while identifiers keep inference', async () => {
  const source = 'function calc(){const {name:arrow}=()=>true,{name:fn}=function(){return true;},named=()=>true;return [arrow,fn,named.name,named()];}';
  const pair = await compare([file(source)]);
  runtime(pair);
  assert.deepEqual(execute(pair.actual, '', 'calc()').value, ['', '', 'named', true]);
});

test('typed pattern annotations stay opaque and retain actual skip and statement-filter ID gaps', async () => {
  const source = `consume(function(){const {renamed:alias,other}:{renamed:"type";other:true}=source;});
function calc(){const [first,,...tail]:[number,number,...number[]]=values;return [first,tail];}
consume(true);`;
  const pair = await compare([file(source, 'bindings.ts')]);
  assert.match(pair.actual.files[0].content, /\{renamed:alias,other\}:\{renamed:"type";other:true\}=/);
  assert.equal(pair.actual.mutants[0].id, '0', 'annotation skip retains the enclosing statement candidate');
  assert.ok(pair.actual.mutants.some((m, i, list) => i && Number(m.id) > Number(list[i - 1].id) + 1));
  assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'StringLiteral'), false);
  runtime(pair, 'const source={renamed:"value",other:true},values=[1,2,3,4];function consume(value){events.push(typeof value);if(typeof value==="function")value();}');
});

test('selection directives exclusions UTF16 positions and inert pattern ranges preserve ordered records', async () => {
  const source = `const emoji="😀";\r\n// Stryker disable BooleanLiteral: keep reason
const {'quoted':alias,other}=makeSource(true,1+2);
// Stryker restore BooleanLiteral
consume(function(){const {x}:T=source;});
const [first,,...rest]=[true,"text",1+2];`;
  for (const mutate of [true, false, [],
    [{ start: { line: 2, column: 0 }, end: { line: 2, column: 50 } }],
    [{ start: { line: 2, column: 7 }, end: { line: 2, column: 30 } }],
    [{ start: { line: 5, column: 0 }, end: { line: 5, column: 200 } }]]) {
    for (const excludedMutations of [[], ['BooleanLiteral'], ['StringLiteral', 'CallExpression'], ['ArithmeticOperator']]) {
      const pair = await compare([file(source, 'selected.ts', mutate)], { ...options, excludedMutations });
      runtime(pair, `const source={x:3};function makeSource(a,b){events.push([a,b]);return {quoted:b,other:a};}
        function consume(value){events.push(typeof value);if(typeof value==='function')value();}`, '[alias,other,first,rest]');
    }
  }
});

test('ordinary loop declarations and nested statement scopes use inert variable patterns', async () => {
  for (const source of [
    'function calc(){let sum=0;for(let {x:i}=source;i<2;i++){const [x]=values;sum+=x;break;}return sum;}',
    'function calc(){let sum=0;for(const {x} of sources){sum+=x;}return sum;}',
    'function calc(){let sum=0;for(const [x] of lists){sum+=x;}return sum;}',
    'function calc(){let sum=0;try{const {x}=source;sum=x;}finally{const [y]=values;sum+=y;}return sum;}',
  ]) runtime(await compare([file(source)]), 'const source={x:0},values=[3],sources=[{x:2},{x:3}],lists=[[2],[3]];');
});

test('mutable initializer roots retain exact error text without changing pattern source', async () => {
  for (const initializer of ['flag&&source', 'source||other', 'source??other',
    'flag&&(source||other)',
    'object.value=source', 'object.value+=source', 'source?.value', 'factory()?.value',
    'object.trim()', 'factory(true)', '1+2', '!flag', '()=>true', 'function(){return true;}']) {
    for (const pattern of ['{x:alias}', '[alias]']) {
      const pair = await compare([file(`function calc(){const ${pattern}=${initializer};return alias;}`)]);
      for (const value of ['null', 'undefined', 'true', '{x:3}']) {
        runtime(pair, `const flag=true,source=${value},other=null;
          const object={trim(){events.push('trim');return source;}};function factory(flag){events.push(['factory',flag]);return source;}`);
      }
    }
  }
});

async function fallback(source, name = 'unsupported.js', mutate = true) {
  const files = [file('const before=true;', 'before.js'), file(source, name, mutate), file('const after=false;', 'after.js')];
  for (const threads of [1, 4, undefined]) {
    const response = raw(files, threads);
    assert.equal(response.supported, false, source);
    assert.equal(response.result, undefined, 'unsupported batches expose no partial records or files');
    assert.equal(response.execution, undefined);
  }
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, options), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
  const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
  if (failure) await assert.rejects(auto.instrument(files, options), error => error.name === failure.name
    && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await auto.instrument(files, options), expected);
  assert.equal(auto.stats.nativeBatches, 0);
  assert.equal(auto.stats.fallbackBatches, 1);
  assert.equal(auto.stats.nativeErrors, 0);
}

test('computed keys defaults parameters catch assignments and whole-for clones remain atomic fallback', async () => {
  for (const source of [
    'const {[key()]:alias}=source;', 'const {["static"]:alias}=source;',
    'const {x=1}=source;', 'const {x:alias=true}=source;', 'const [{x=1}]=source;',
    'const {x:[first=1]}=source;', 'const [...[first]]=source;',
    'const [x]=(source);', 'const {x}= /* boundary */ source;',
    'const {x}=flag?source:other;', 'const [x]=flag?source:(flag?other:source);',
    'const {x}=flag?(source&&other):other;',
    'function calc({x}){return x;}', 'const calc=([x])=>x;', 'try{}catch({x}){}',
    'let x;({x}=source);', 'let x;[x]=source;',
    'for(const {x}=source;;)break;', 'for(;;){const {x}=source;break;}',
    'for(;;){for(const [x] of values)break;break;}',
  ]) for (const mutate of [true, false, []]) await fallback(source, 'unsupported.js', mutate);
  for (const name of ['Math', 'globalThis', 'Function', 'Error', 'undefined', 'stryMutAct_9fa48']) {
    await fallback(`const {x:${name}}=source;`);
    await fallback(`const [{x:${name}}]=source;`);
  }
});

test('one four auto and serial recovery retain complete result JSON bytes across repeated calls', async () => {
  const sources = [
    'const {renamed:alias,other}=makeSource(true,"value",1+2);',
    'const {nested:[first,,...tail],...rest}=source;',
    'consume(function(){const {x}:T=source;});const [first]=[true];',
    'const {name:arrow}=()=>true;',
  ];
  for (const recovery of [false, true]) {
    const files = sources.map((source, i) => file(`${recovery && i === 1 ? 'type T=typeof stryCov_9fa48;\n' : ''}${source}`, `file-${i}.ts`));
    const expected = await new Instrumenter(logger).instrument(files, options);
    const serial = raw(files, 1);
    assert.equal(serial.supported, true, serial.reason);
    assert.deepEqual(serial.result.mutants, plain(expected.mutants));
    const bytes = JSON.stringify(serial.result);
    for (let repeat = 0; repeat < 3; repeat++) {
      const parallel = raw(files, 4);
      const automatic = raw(files, undefined);
      assert.equal(JSON.stringify(parallel.result), bytes, 'all instrumented source and record bytes');
      assert.equal(JSON.stringify(automatic.result), bytes);
      if (availableParallelism() > 1) {
        if (recovery) {
          assert.equal(parallel.execution.serialRecoveries, 1);
          assert.equal(parallel.execution.reason, 'unproven-relocation');
        } else {
          assert.ok(parallel.execution.threadsUsed > 1);
          assert.equal(parallel.execution.parallelFiles, files.length);
        }
      }
      assert.equal(automatic.execution.spawnedThreads, 0);
      assert.equal(automatic.execution.reason, 'auto-serial-unproven-speedup');
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { availableParallelism } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'async.js', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'direct ABI complete ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'public complete ordered records');
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

const executable = new Map();
function code({ name, content }) {
  if (!/\.[cm]?ts$/.test(name)) return content;
  if (!executable.has(content)) executable.set(content, stripTypeScriptTypes(content));
  return executable.get(content);
}

// No wall-clock settling or abandoned rejection races. Scenarios release every
// deferred gate explicitly, and this finite microtask budget detects lost work.
async function settle(promise) {
  let done = false, value, error, rejected = false;
  Promise.resolve(promise).then(result => { value = result; done = true; }, reason => {
    error = reason; rejected = true; done = true;
  });
  for (let turn = 0; turn < 128 && !done; turn++) await Promise.resolve();
  assert.equal(done, true, 'intended async work must settle within the microtask budget');
  if (rejected) throw error;
  return value;
}

async function execute(result, setup, observation, state, activeMutant, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, structuredClone });
  const evaluate = source => new vm.Script(source).runInContext(context, { timeout: 1000 });
  evaluate(`const events=[], pending=[];
    const thrown={tag:'thrown'}, thrownSymbol=Symbol('thrown');
    function valueOf(value){
      if(value===thrown)return {identity:'thrown',value};
      if(value===thrownSymbol)return {identity:'symbol',description:value.description};
      if(value instanceof Error)return {name:value.name,message:value.message,code:value.code};
      if(typeof describeValue==='function')return describeValue(value);
      return value;
    }
    function capture(fn){
      let value;
      try{value=fn();}catch(error){return {kind:'sync',status:'rejected',value:valueOf(error)};}
      if(!(value instanceof Promise))return {kind:'sync',status:'fulfilled',value:valueOf(value)};
      const observed=value.then(value=>({kind:'promise',status:'fulfilled',value:valueOf(value)}),
        error=>({kind:'promise',status:'rejected',value:valueOf(error)}));
      pending.push(observed);
      return observed;
    }
    function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
      promise.catch(()=>{});
      return {promise,resolve,reject};}
    ${setup}`);
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const output of result.files) {
    const script = new vm.Script(`${settings.strict ? '"use strict";\n' : ''}${code(output)}`);
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'async-test';
  if (settings.afterLoad) ns.activeMutant = activeMutant;
  let value, error;
  try { value = await settle(evaluate(observation)); }
  catch (caught) { error = describe(caught); }
  // Flush every captured call as well as the observer itself. Promise objects
  // never reach structuredClone/JSON as stand-ins for unobserved outcomes.
  const calls = [];
  for (const promise of evaluate('pending')) calls.push(await settle(promise));
  return structuredClone({ value, error, loadErrors, calls, ns, events: evaluate('events'), state: evaluate(state) });
}

async function runtime(pair, setup = '', observation = '(async()=>[await capture(()=>calc()),await capture(()=>calc())])()', state = 'null') {
  const baseline = await execute(pair.actual, setup, observation, state);
  assert.deepEqual(baseline.loadErrors, []);
  assert.equal(baseline.error, undefined, 'baseline observer must complete');
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const strict of [false, true]) for (const settings of [
      {}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 },
    ]) {
      assert.deepEqual(await execute(pair.actual, setup, observation, state, id, { strict, ...settings }),
        await execute(pair.expected, setup, observation, state, id, { strict, ...settings }),
        `mutant=${id}, strict=${strict}, settings=${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}

const fulfilled = value => ({ kind: 'promise', status: 'fulfilled', value });

test('async declarations expressions methods and arrows retain exact records and source syntax', async () => {
  for (const source of [
    'async function calc(input=true){return await choose(input);}',
    'const calc=async function(input=true){return await choose(input);};',
    'const calc=async function named(input=true){return await choose(input);};',
    'const calc=async(input=true)=>{return await choose(input);};',
    'const calc=async(input=true)=>await choose(input);',
    'class C{async method(input=true){return await choose(input);}}const calc=async()=>new C().method();',
    'function calc(){async function inner(input=true){return await choose(input);}return inner();}',
    'async function calc(input=true){async function inner(){return input;}return await inner();}',
    'async function calc(input=true){const sync=()=>input;return await sync();}',
  ]) {
    const pair = await compare([file(source)]);
    const baseline = await runtime(pair, 'function choose(value){events.push(value);return value;}');
    assert.deepEqual(baseline.value, [fulfilled(true), fulfilled(true)]);
    assert.match(pair.actual.files[0].content, /async/);
  }
});

test('ArrowFunction intentionally changes an async concise arrow into a synchronous undefined return', async () => {
  const pair = await compare([file('const calc=async value=>await choose(value);')]);
  const arrow = pair.actual.mutants.find(m => m.mutatorName === 'ArrowFunction');
  assert.equal(arrow.replacement, '() => undefined');
  const setup = 'function choose(value){events.push(value);return value;}';
  const observer = '(async()=>[await capture(()=>calc(3)),[calc.name,calc.length,calc.constructor.name]])()';
  const baseline = await runtime(pair, setup, observer);
  assert.deepEqual(baseline.value, [fulfilled(3), ['calc', 1, 'AsyncFunction']]);
  const active = await execute(pair.actual, setup, observer, 'null', arrow.id);
  assert.deepEqual(active.value, [{ kind: 'sync', status: 'fulfilled', value: undefined }, ['', 0, 'Function']]);
  assert.deepEqual(active.events, []);
  const block = await compare([file('const calc=async()=>{return true;};')]);
  assert.equal(block.actual.mutants.some(m => m.mutatorName === 'ArrowFunction'), false);
  const deleted = await execute(block.actual, '', 'capture(()=>calc())', 'null', block.actual.mutants[0].id);
  assert.deepEqual(deleted.value, fulfilled(undefined), 'an empty async block still returns a Promise');
});

test('empty async bodies and undefined concise bodies retain original bytes with no invented mutants', async () => {
  for (const source of ['async function calc(){}', 'const calc=async()=>{};', 'const calc=async()=>undefined;']) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants, []);
    assert.equal(pair.actual.files[0].content, source);
    assert.deepEqual((await runtime(pair)).value, [fulfilled(undefined), fulfilled(undefined)]);
  }
});

test('async returns and await assimilate thenables once and preserve fulfillment rejection and thrown identities', async () => {
  const setup = `function make(mode){events.push(['make',mode]);
    return {get then(){events.push('get-then');if(mode==='getter')throw thrownSymbol;return function(resolve,reject){events.push(['then',this!==undefined]);
      if(mode==='resolve'){resolve(thrown);resolve(9);reject(thrownSymbol);}
      else if(mode==='reject'){reject(thrownSymbol);resolve(9);}
      else throw thrown;
    };}};}`;
  for (const expression of ['make(mode)', 'await make(mode)', 'await await make(mode)']) {
    const pair = await compare([file(`async function calc(mode){events.push('start');return ${expression};}`)]);
    const baseline = await runtime(pair, setup,
      '(async()=>[await capture(()=>calc("resolve")),await capture(()=>calc("reject")),await capture(()=>calc("throw")),await capture(()=>calc("getter"))])()');
    assert.deepEqual(baseline.value.map(({ kind, status }) => [kind, status]),
      [['promise', 'fulfilled'], ['promise', 'rejected'], ['promise', 'rejected'], ['promise', 'rejected']]);
    assert.deepEqual(baseline.value[0].value, { identity: 'thrown', value: { tag: 'thrown' } });
    assert.deepEqual(baseline.value[1].value, { identity: 'symbol', description: 'thrown' });
    assert.deepEqual(baseline.value[2].value, { identity: 'thrown', value: { tag: 'thrown' } });
    assert.deepEqual(baseline.value[3].value, { identity: 'symbol', description: 'thrown' });
    assert.equal(baseline.events.filter(event => event === 'get-then').length, 4);
  }
});

test('async throws and rejected awaits preserve primitive undefined object and symbol reasons', async () => {
  for (const body of ['throw reason;', 'return await reject(reason);', 'await pause();throw reason;']) {
    const pair = await compare([file(`async function calc(reason){${body}}`)]);
    const baseline = await runtime(pair,
      'function reject(reason){return Promise.reject(reason);}function pause(){events.push("pause");return 1;}',
      '(async()=>[await capture(()=>calc(undefined)),await capture(()=>calc(7)),await capture(()=>calc(thrown)),await capture(()=>calc(thrownSymbol))])()');
    assert.deepEqual(baseline.value.map(item => item.status), Array(4).fill('rejected'));
    assert.equal(baseline.value[0].value, undefined);
    assert.equal(baseline.value[1].value, 7);
    assert.equal(baseline.value[2].value.identity, 'thrown');
    assert.equal(baseline.value[3].value.identity, 'symbol');
  }
});

test('awaited try catch finally preserve and override completions across suspension', async () => {
  for (const [body, status, value] of [
    ['try{return await yes(2);}finally{await note(3);}', 'fulfilled', 2],
    ['try{return await yes(2);}finally{await note(3);return 4;}', 'fulfilled', 4],
    ['try{throw thrown;}finally{await note(3);}', 'rejected', { identity: 'thrown', value: { tag: 'thrown' } }],
    ['try{return await yes(2);}finally{await note(3);throw thrown;}', 'rejected', { identity: 'thrown', value: { tag: 'thrown' } }],
    ['try{return await no(thrown);}catch(e){await note(e===thrown);return e===thrown;}finally{await note(3);}', 'fulfilled', true],
    ['try{try{return await no(7);}finally{await note(3);}}catch(e){await note(e);throw e;}', 'rejected', 7],
  ]) {
    const baseline = await runtime(await compare([file(`async function calc(){${body}}`)]),
      'function yes(value){events.push(["yes",value]);return value;}function no(value){return Promise.reject(value);}function note(value){events.push(value);return value;}');
    assert.deepEqual(baseline.value, Array.from({ length: 2 }, () => ({ kind: 'promise', status, value })));
  }
});

test('hit limits after an await reject or enter user catch and awaited finally with exact counts', async () => {
  for (const [body, caught] of [
    ['await pause();return 1+2;', false],
    ['try{await pause();return 1+2;}catch(e){events.push(e.message);return e.message;}finally{await pause();}', true],
    ['try{await pause();return 1;}finally{await pause();return 1+2;}', false],
  ]) {
    const pair = await compare([file(`async function calc(){${body}}`)]);
    const id = pair.actual.mutants.find(m => m.mutatorName === 'ArithmeticOperator').id;
    const setup = 'function pause(){events.push("pause");return 0;}';
    await runtime(pair, setup);
    const result = await execute(pair.actual, setup, 'capture(()=>calc())', 'null', id, { afterLoad: true, hitLimit: 0 });
    assert.equal(result.ns.hitCount, 1);
    assert.equal(result.value.kind, 'promise');
    assert.equal(result.value.status, caught ? 'fulfilled' : 'rejected');
    assert.match(caught ? result.value.value : result.value.value.message, /Hit count limit reached \(1\)/);
    assert.equal(result.events[0], 'pause', 'the selected helper is checked after resumption');
  }
});

test('await operands retain exact Babel grouping in operator logical conditional and method replacements', async () => {
  for (const body of [
    'return await take(2)+await take(3);',
    'return (await take(2))*3;',
    'return await take(2)>await take(1);',
    'return !(await take(false));',
    'return -(await take(2));',
    'return ~(await take(2));',
    'return (await take(true))&&await take(3);',
    'return (await take(null))??await take(3);',
    'return (await take(true))?await take(2):await take(3);',
    'return pick((await take(true))?await take(2):await take(3)).filter(Boolean);',
    'return (await take(" A ")).trim().toLowerCase();',
  ]) await runtime(await compare([file(`async function calc(){${body}}`)]),
    'function take(value){events.push(value);return value;}function pick(value){events.push("pick");return [value,0];}');
});

test('optional calls and logical operands preserve short circuiting and receivers around awaits', async () => {
  const setup = `const target={value:3,method(value){events.push(['receiver',this===target,value]);return this.value+value;}};
    function take(value){events.push(['take',value===target?'target':value]);return value;}
    function describeValue(value){return value===target?{identity:'target',value:value.value,methodName:value.method.name}:value;}`;
  for (const expression of [
    'await receiver?.method(await take(2))',
    'await receiver?.method?.(await take(2))',
    '(await take(receiver))?.method(await take(2))',
    '(await take(receiver))?.method?.(await take(2))',
    '(await take(receiver))&&(await take(receiver.method(await take(2))))',
  ]) for (const receiver of ['target', 'null']) {
    await runtime(await compare([file(`async function calc(){return ${expression};}`)]), `${setup}const receiver=${receiver};`);
  }
});

test('awaited lvalue objects keys RHS and updates preserve reference order and accessor receivers', async () => {
  const setup = `let stored=4;const target={get value(){events.push(['get',this===target]);return stored;},
      set value(value){events.push(['set',this===target,value]);stored=value;}};
    function object(){events.push('object');return target;}function key(){events.push('key');return 'value';}
    function rhs(){events.push('rhs');return 2;}`;
  for (const expression of [
    '(await object())[await key()]+=await rhs()',
    '(await object())[await key()]++',
    '++(await object()).value',
    'delete (await object())[await key()]',
  ]) await runtime(await compare([file(`async function calc(){return ${expression};}`)]), setup,
    '(async()=>[await capture(()=>calc()),await capture(()=>calc())])()', 'stored');
});

test('async arrows retain lexical this arguments and eligible async methods retain super and private fields', async () => {
  const pair = await compare([file('class C extends Base{#value=3;async method(input){const arrow=async x=>await super.read(x)+this.#value+arguments[0];return await arrow(input);}}')]);
  const baseline = await runtime(pair,
    'class Base{read(value){events.push(["base",this instanceof C,value]);return value;}}const calc=()=>new C().method(2);');
  assert.deepEqual(baseline.value, [fulfilled(7), fulfilled(7)]);
  const lexical = await compare([file('function make(input){return async x=>{await pause();return this.factor*x+arguments[0];};}')]);
  const observed = await runtime(lexical, 'const receiver={factor:3};function pause(){events.push("pause");}',
    '(async()=>{const f=make.call(receiver,4);return [f.name,f.length,await capture(()=>f(2)),await capture(()=>f(3))];})()');
  assert.deepEqual(observed.value, ['', 1, fulfilled(10), fulfilled(13)]);
  const methods = await compare([file('class C{static async method(x=true){return await take(x);}async method(x=true){return await take(x);}}')]);
  await runtime(methods, 'function take(value){events.push(value);return value;}',
    '(async()=>[C.method.name,C.method.length,await capture(()=>C.method()),await capture(()=>new C().method(false))])()');
});

test('async defaults and rest preserve errors before suspension unmapped arguments and inferred names', async () => {
  for (const source of [
    'async function calc(first=mark(true),...rest){await pause();return [first,arguments[0],rest.length];}',
    'const calc=async function(first=mark(true),...rest){await pause();return [first,arguments[0],rest.length];};',
    'const calc=async(first=mark(true),...rest)=>{await pause();return [first,rest.length];};',
    'async function calc(first=fail()){return await first;}',
  ]) await runtime(await compare([file(source)]),
    'function mark(value){events.push(value);return value;}function pause(){}function fail(){throw thrown;}',
    '(async()=>[calc.name,calc.length,await capture(()=>calc()),await capture(()=>calc(false,2,3))])()');
});

test('printed async concise identifier arrows share ordered range and raw string proofs', async () => {
  for (const [params, body] of [
    ['()', 'await take(true)'], ['value', 'await take(value)'], ['(value)', 'await take(value)'],
    ['(value,index,)', 'await take(value)+index'], ['(é)', 'await take(é)'],
    ['(\\u0076alue)', 'await take(\\u0076alue)'],
    ['value', 'await take(value?left():right())'],
    ['value', "await take(receive('é',\"\\x61\",value))"],
    ['value', 'await invoke(async other=>await take(value)+other)'],
  ]) {
    const pair = await compare([file(`function callbacks(){return values.map(async ${params}=>${body}).filter(Boolean);}`)]);
    await runtime(pair,
      `const values=[0,2];function take(value){events.push(['take',value]);return value;}
      function left(){events.push('left');return 1;}function right(){events.push('right');return 3;}
      function receive(...args){events.push(args);return args[2];}function invoke(fn){return fn(3);}`,
      '(async()=>{const batch=callbacks();if(batch===undefined)return batch;return await Promise.all(batch.map(value=>capture(()=>value)));})()');
  }
});

test('static work and dynamic activeMutant and currentTestId changes cross controlled awaits', async () => {
  const source = 'async function calc(){events.push("start");const first=await gates[0].promise;events.push("middle");const value=first+1;await gates[1].promise;events.push("end");return value+2;}const loaded=capture(()=>calc());';
  const pair = await compare([file(source)]);
  const arithmetic = pair.actual.mutants.filter(m => m.mutatorName === 'ArithmeticOperator');
  assert.equal(arithmetic.length, 2);
  const setup = 'const gates=[deferred(),deferred()];';
  const observer = `(async()=>{
    const snapshot=()=>structuredClone(__stryker__);
    const before=snapshot();
    __stryker__.activeMutant=${JSON.stringify(arithmetic[0].id)};
    __stryker__.currentTestId='first-resumption';gates[0].resolve(3);
    await Promise.resolve();
    const middle=snapshot();
    __stryker__.activeMutant=${JSON.stringify(arithmetic[1].id)};
    __stryker__.currentTestId='second-resumption';gates[1].resolve();
    const first=await loaded;
    __stryker__.activeMutant=undefined;__stryker__.currentTestId='repeat';
    const repeat=await capture(()=>calc());
    return {before,middle,first,repeat};
  })()`;
  const baseline = await runtime(pair, setup, observer);
  assert.deepEqual(baseline.value.first, fulfilled(0));
  assert.deepEqual(baseline.value.repeat, fulfilled(6));
  assert.ok(Object.keys(baseline.value.before.mutantCoverage.static).length > 0);
  for (const mutant of arithmetic) assert.equal(baseline.ns.mutantCoverage.perTest.repeat[mutant.id], 1);
  assert.ok(Object.keys(baseline.ns.mutantCoverage.perTest['first-resumption']).length > 0);
  assert.ok(Object.keys(baseline.ns.mutantCoverage.perTest['second-resumption']).length > 0);
});

test('controlled resolve and reject gates preserve microtask order with concurrent repeated calls', async () => {
  const pair = await compare([file('async function calc(gate){events.push("start");try{const value=await gate.promise;events.push("resume");return value+1;}catch(e){events.push("catch");throw e;}finally{await note();events.push("finally");}}')]);
  const baseline = await runtime(pair,
    'const first=deferred(),second=deferred();function note(){events.push("note");return 0;}',
    '(async()=>{const a=capture(()=>calc(first)),b=capture(()=>calc(second));events.push("launched");Promise.resolve().then(()=>events.push("queued"));second.reject(thrown);first.resolve(2);events.push("released");return [await a,await b];})()');
  assert.deepEqual(baseline.value, [fulfilled(3), { kind: 'promise', status: 'rejected', value: { identity: 'thrown', value: { tag: 'thrown' } } }]);
  assert.deepEqual(baseline.events, ['start', 'start', 'launched', 'released', 'queued', 'catch', 'note', 'resume', 'note', 'finally', 'finally']);
});

test('TS annotations non-null wrappers skipped nodes and statement-filter ID gaps retain parity', async () => {
  for (const source of [
    'async function calc<T extends true>(input?:number):Promise<number>{return (await take(input))!+1;}',
    'const calc=async(input:number=2,...rest:number[]):Promise<number>=>{return (await take(input))!+rest.length;};',
    'class C<T>{async method<U>(input?:number):Promise<number>{return await take(input!);}}const calc=async()=>new C().method(2);',
    'async function calc(){return await take(2 as number);}',
    'async function calc(){const {x:alias}:{x:number}=await take(source);return alias;}',
    'consume(async function(input:"inert"=true){return await take(input);});async function calc(){return await take(true);}',
  ]) {
    const pair = await compare([file(source, 'async.ts')]);
    await runtime(pair, 'const source={x:2};function take(value){events.push(value);return value;}function consume(fn){capture(()=>fn());}',
      '(async()=>[await capture(()=>calc()),await capture(()=>calc(3))])()');
    if (source.includes('Promise<number>')) assert.ok(pair.actual.files[0].content.includes('Promise<number>'));
    if (source.includes('as number')) assert.ok(pair.actual.files[0].content.includes('as number'));
  }
});

test('async directives exclusions UTF16 CRLF selections noHeader and unchanged files preserve metadata', async () => {
  const source = '// Stryker disable next-line ArrowFunction: preserve async callback\r\nconst astral="😀";const calc=async (é=true)=>await take(é);\r\nconst tail=false;';
  const files = [file('take(true);', 'filtered.js'), file(source, 'selected.js', [{
    start: { line: 1, column: 0 }, end: { line: 1, column: source.split('\r\n')[1].length },
  }]), file('const inert=async()=>await take(true);', 'off.js', false)];
  for (const config of [options, { ...options, excludedMutations: ['ArrowFunction', 'BooleanLiteral'] }, { ...options, noHeader: true }]) {
    const pair = await compare(files, config);
    if (!config.excludedMutations.length) assert.equal(pair.actual.mutants[0].id, '1', 'filtered statement consumes ID zero');
    assert.ok(pair.actual.mutants.some(m => m.status === 'Ignored'));
    assert.equal(pair.actual.files[2].content, files[2].content);
    if (!config.noHeader) await runtime(pair, 'function take(value){events.push(value);return value;}',
      '(async()=>[astral,tail,await capture(()=>calc()),await capture(()=>inert())])()');
  }
});

test('await operands in whole-for replacements retain ordered formatting and runtime', async () => {
  const pair = await compare([file('async function calc(){for(;;tick()){await take(true);break;}return await take(2)+1;}')]);
  await runtime(pair, 'let ticks=0;function tick(){if(++ticks>3)throw new RangeError("budget");}function take(value){events.push(value);return value;}');
});

async function fallback(content, name = 'unsupported.js', mutate = true) {
  const files = [file('const first=true;', 'first.js'), file(content, name, mutate), file('const last=false;', 'last.js')];
  for (const threads of [1, 4, 'auto']) {
    const response = raw(files, threads);
    assert.equal(response.supported, false, content);
    assert.equal(response.result, undefined, 'no partially collected records escape');
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
  assert.equal(raw([file('async function fresh(){return await take(true);}')], 4).supported, true);
}

test('generators module await async iteration and unproven printed async forms keep atomic fallback', async () => {
  for (const [source, name = 'unsupported.js'] of [
    ['async function* calc(){yield await take(true);}'],
    ['function* calc(){yield true;}'],
    ['async function calc(this:C){return await take(true);}', 'unsupported.ts'],
    ['async function calc(){for await(const value of list)take(value);}'],
    ['await take(true);', 'module.mjs'],
    ['const result=(await take(true)) as unknown;', 'module.ts'],
    ['const result=await take(true);async function local(){return await take(false);}', 'module.mjs'],
    ['class C extends (await base()){}', 'module.mjs'],
    ['values.map(async value=>{return await take(value);}).filter(Boolean);'],
    ['values.map(async(value=true)=>await take(value)).filter(Boolean);'],
    ['values.map(async(...values)=>await take(values)).filter(Boolean);'],
    ['values.map(async(value:number)=>await take(value)).filter(Boolean);', 'unsupported.ts'],
    ['values.map(async value=>new C(value)).filter(Boolean);'],
    ['values.map(async value=>function(){return value;}).filter(Boolean);'],
    ['async function calc(){return await import("module");}'],
  ]) for (const mutate of [true, false, []]) await fallback(source, name, mutate);
});

test('serial four-thread auto and recovered async batches have identical complete native JSON result bytes', async t => {
  const files = [
    file('async function one(x){return await take(x)+1;}', 'one.js'),
    file('const two=async x=>await take(x);', 'two.js'),
    file('class Three{async method(){return await take(true);}}', 'three.js'),
    file('function four(){return values.map(async x=>await take(x)).filter(Boolean);}', 'four.js'),
  ];
  const pair = await compare(files);
  const serial = raw(files);
  for (const threads of [4, 'auto', 4, 1]) {
    const response = raw(files, threads);
    assert.equal(response.supported, true, response.reason);
    assert.equal(JSON.stringify(response.result), JSON.stringify(serial.result));
    const stats = response.execution;
    assert.ok(stats);
    if (threads === 4 && availableParallelism() > 1) {
      assert.equal(stats.threadsUsed, Math.min(4, availableParallelism()));
      assert.equal(stats.spawnedThreads, stats.threadsUsed - 1);
      assert.equal(stats.parallelFiles, files.length);
      assert.equal(stats.serialRecoveries, 0);
    } else {
      assert.equal(stats.threadsUsed, 1);
      assert.equal(stats.spawnedThreads, 0);
      assert.equal(stats.parallelFiles, 0);
    }
  }
  const recoveredFiles = [...files, file('const hidden=stryMutAct_9fa48("0") as unknown;', 'opaque.ts')];
  const recovered = raw(recoveredFiles, 4);
  assert.equal(recovered.supported, true, recovered.reason);
  assert.equal(JSON.stringify(recovered.result), JSON.stringify(raw(recoveredFiles).result));
  assert.deepEqual(recovered.result.mutants, plain((await new Instrumenter(logger).instrument(recoveredFiles, options)).mutants));
  assert.equal(recovered.execution.threadsUsed, 1);
  assert.equal(recovered.execution.serialRecoveries, availableParallelism() > 1 ? 1 : 0);
  await fallback('async function* unsupported(){yield true;}');
  assert.equal(JSON.stringify(raw(files, 4).result), JSON.stringify(serial.result));
  await runtime(pair, 'const values=[1,2];function take(value){events.push(value);return value;}',
    '(async()=>[await capture(()=>one(2)),await capture(()=>two(3)),await capture(()=>new Three().method()),await Promise.all(four().map(value=>capture(()=>value)))])()');
  t.diagnostic(JSON.stringify({ serial: serial.execution, parallel: raw(files, 4).execution, auto: raw(files, 'auto').execution, recovery: recovered.execution }));
});

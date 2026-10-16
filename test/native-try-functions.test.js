import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'try-functions.js', mutate = true) => ({ name, content, mutate });

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, true, raw.reason);
  assert.deepEqual(raw.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'direct ABI full ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'public full ordered records');
  for (const mutant of actual.mutants) {
    assert.equal(Object.hasOwn(mutant, 'status'), true);
    assert.equal(Object.hasOwn(mutant, 'statusReason'), true);
  }
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

const completedOutputs = new Map();
function executable({ content, name }) {
  if (!/\.[cm]?ts$/.test(name)) return content;
  if (!completedOutputs.has(content)) {
    // Preserve production input. Strip types only from completed outputs,
    // identically for the native implementation and pinned upstream oracle.
    completedOutputs.set(content, stripTypeScriptTypes(content, { mode: 'strip' }));
  }
  return completedOutputs.get(content);
}

function execute(result, setup, observation, state, id, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = source => new vm.Script(source).runInContext(context, { timeout: 1000 });
  evaluate(`const events=[],thrownObject={token:1};let ticks=0;
    function guard(){if(++ticks>12)throw new RangeError('budget');}
    function bounded(value){guard();return value;}
    function capture(fn){try{return fn();}catch(e){return describe(e);}}
    function describe(e){return e===thrownObject?{sameObject:true}:
      e!==null&&typeof e==='object'?{name:e.name,message:e.message}:e;}
    ${setup}`);
  const caughtError = caught => {
    assert.notEqual(caught?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'mutants must use the deterministic external budget');
    if (caught === evaluate('thrownObject')) return { sameObject: true };
    if (caught !== null && typeof caught === 'object') return { name: caught.name, message: caught.message };
    return { primitive: caught };
  };
  const compileErrors = [], loadErrors = [];
  for (const output of result.files) {
    let script;
    try { script = new vm.Script(`${settings.strict ? '"use strict";\n' : ''}${executable(output)}`); }
    catch (caught) { compileErrors.push(caughtError(caught)); continue; }
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (caught) { loadErrors.push(caughtError(caught)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'try-functions-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  if (!compileErrors.length) {
    try { value = evaluate(observation); }
    catch (caught) { error = caughtError(caught); }
  }
  return structuredClone({ value, error, compileErrors, loadErrors, ns,
    state: evaluate(state), events: evaluate('events') });
}

function runtime(pair, setup = '', observation = 'calc()', { state = 'null', modes = [false, true], compileError = false } = {}) {
  const ids = [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)];
  for (const strict of modes) for (const id of ids) for (const settings of [
    {}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 },
  ]) {
    const actual = execute(pair.actual, setup, observation, state, id, { ...settings, strict });
    const expected = execute(pair.expected, setup, observation, state, id, { ...settings, strict });
    assert.deepEqual(actual, expected, `strict=${strict}, mutant=${id}, settings=${JSON.stringify(settings)}, source=${pair.actual.files[0].content}`);
  }
  const baseline = execute(pair.actual, setup, observation, state, undefined, { strict: modes[0] });
  assert.equal(Boolean(baseline.compileErrors.length), compileError, 'baseline compilation outcome');
  return baseline;
}

const pos = (source, offset) => {
  const lines = source.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/u);
  return { line: lines.length - 1, column: lines.at(-1).length };
};
function range(source, text) {
  const start = source.indexOf(text);
  assert.notEqual(start, -1, text);
  return { start: pos(source, start), end: pos(source, start + text.length) };
}

async function fallback(source, name = 'unsupported.js', mutate = true, config = options) {
  const files = [file('const first=true;', 'first.js'), file(source, name, mutate)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, false, source);
  assert.equal(raw.result, undefined);
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, config), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
  const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
  if (failure) await assert.rejects(auto.instrument(files, config), error =>
    error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await auto.instrument(files, config), expected);
  assert.equal(auto.stats.nativeBatches, 0);
  assert.equal(auto.stats.fallbackBatches, 1);
  assert.equal(auto.stats.nativeErrors, 0);
  return failure;
}

test('try catch finally have six exact ordered records and independent block placement', async () => {
  const source = 'try { a = 1+2; } catch (e) { a = true; } finally { a = false; }';
  const pair = await compare([file(source)]);
  assert.deepEqual(pair.actual.mutants.map(({ id, mutatorName, location, replacement }) =>
    [id, mutatorName, location.start.column, location.end.column, replacement]), [
    ['0', 'BlockStatement', 4, 16, '{}'],
    ['1', 'ArithmeticOperator', 10, 13, '1 - 2'],
    ['2', 'BlockStatement', 27, 40, '{}'],
    ['3', 'BooleanLiteral', 33, 37, 'false'],
    ['4', 'BlockStatement', 49, 63, '{}'],
    ['5', 'BooleanLiteral', 55, 60, 'true'],
  ]);
  runtime(pair, 'let a;', 'a', { state: 'a' });
  assert.match(pair.actual.files[0].content, /try \{.*\} catch \(e\) \{.*\} finally \{/);
  for (const source of ['try{}catch{}', 'try{}catch(e){}finally{}', 'try{}finally{}']) {
    const empty = await compare([file(source)]);
    assert.deepEqual(empty.actual.mutants, []);
    runtime(empty, '', 'null');
  }
  const semicolons = await compare([file('try{;}catch(e){;}finally{;}')]);
  assert.deepEqual(semicolons.actual.mutants.map(m => m.mutatorName), Array(3).fill('BlockStatement'));
  runtime(semicolons, '', 'null');
});

test('absent typed and inert literal catch bindings preserve source and TS filter bookkeeping', async () => {
  for (const [binding, ids] of [['e', ['1']], ['e:any', ['0', '1']], ['e:"inert"', ['0', '1']]]) {
    const source = `consume(function(){try{}catch(${binding}){}});`;
    const pair = await compare([file(source, 'catch-filter.ts')]);
    assert.deepEqual(pair.actual.mutants.map(m => m.id), ids);
    assert.match(pair.actual.files[0].content, new RegExp(`catch\\(${binding}\\)`));
    runtime(pair, 'function consume(fn){fn();}', 'null');
  }
  for (const binding of ['', '(e)', '(e:unknown)', '(e:"inert")']) {
    const pair = await compare([file(`function calc(){try{throw 2;}catch${binding}{events.push(1);return 1+2;}}`, 'typed.ts')]);
    assert.equal(runtime(pair).value, 3);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'StringLiteral'), false);
  }
});

test('catch bindings remain lexical under shadowing reassignment closures and rethrow', async () => {
  for (const [body, observation, value] of [
    ['try{throw thrownObject;}catch(e){events.push(e===thrownObject);e=replacement;escaped=()=>e;}return e;', '[calc()===outer,escaped()===replacement,e===outer]', [true, true, true]],
    ['try{throw thrownObject;}catch(e){return inner();function inner(){return e===thrownObject;}}', 'calc()', true],
    ['try{throw thrownObject;}catch(e){throw e;}', 'capture(calc)', { sameObject: true }],
    ['try{throw 2;}catch(e){throw e;}', 'capture(calc)', 2],
    ['try{throw thrownObject;}catch(e){saved=e;throw e;}', 'capture(calc)', { sameObject: true }],
  ]) {
    const pair = await compare([file(`function calc(){${body}}`)]);
    const baseline = runtime(pair, 'const outer={outer:1},replacement={other:1};let e=outer,escaped,saved;', observation,
      { state: '[e===outer,saved===thrownObject,typeof escaped]' });
    assert.deepEqual(baseline.value, value);
  }
});

test('finally preserves and overrides returns throws break and continue', async () => {
  for (const [body, observation, value] of [
    ['try{events.push(1);return 2;}finally{events.push(3);return 4;}', 'calc()', 4],
    ['try{throw 2;}finally{throw 3;}', 'capture(calc)', 3],
    ['try{throw thrownObject;}finally{events.push(1);}', 'capture(calc)', { sameObject: true }],
    ['try{return thrownObject;}finally{events.push(1);}', 'calc()===thrownObject', true],
    ['let i=0;while(bounded(i<3)){i++;try{if(i===1)continue;if(i===2)break;events.push(i);}finally{events.push(i);}}return i;', 'calc()', 2],
    ['let i=0;outer:while(bounded(i<3)){i++;try{continue outer;}finally{if(i===2)break outer;events.push(i);}}return i;', 'calc()', 2],
    ['let i=0;while(bounded(i<3)){i++;try{break;}finally{continue;}}return i;', 'calc()', 3],
  ]) {
    const baseline = runtime(await compare([file(`function calc(){${body}}`)]), '', observation, { state: 'ticks' });
    assert.deepEqual(baseline.value, value);
  }
});

test('user handlers catch hit-limit errors from try while handler and finally errors propagate', async () => {
  for (const body of [
    'try{return 1+2;}catch(e){events.push(e.message);return e.message;}',
    'try{throw 2;}catch(e){events.push(e);return 1+2;}',
    'try{return 1+2;}finally{events.push(1);}',
    'try{try{return 1+2;}finally{events.push(1);}}catch(e){return e.message;}',
  ]) runtime(await compare([file(`function calc(){${body}}`)]));
  const pair = await compare([file('function calc(){try{return 1+2;}catch(e){events.push(e.message);return e.message;}}')]);
  const arithmetic = pair.actual.mutants.find(m => m.mutatorName === 'ArithmeticOperator').id;
  const caught = execute(pair.actual, '', 'calc()', 'null', arithmetic, { hitLimit: 0 });
  assert.equal(caught.error, undefined);
  assert.match(caught.value, /Hit count limit reached \(1\)/);
  assert.deepEqual(caught.events, [caught.value]);
  for (const body of ['try{throw 2;}catch(e){return 1+2;}', 'try{return 1;}finally{return 1+2;}']) {
    const pair = await compare([file(`function calc(){${body}}`)]);
    const id = pair.actual.mutants.find(m => m.mutatorName === 'ArithmeticOperator').id;
    const thrown = execute(pair.actual, '', 'calc()', 'null', id, { hitLimit: 0 });
    assert.equal(thrown.error.name, 'Error');
    assert.match(thrown.error.message, /Hit count limit reached \(1\)/);
    assert.deepEqual(thrown, execute(pair.expected, '', 'calc()', 'null', id, { hitLimit: 0 }));
  }
});

test('try handler and finalizer preserve assignment references receivers and evaluation order', async () => {
  const setup = `let stored=4;const target={get value(){events.push(this===target);return stored;},
    set value(v){events.push(this===target);stored=v;}};
    function key(){events.push('key');return 'value';}function rhs(){events.push('rhs');return 2;}`;
  for (const body of [
    'try{return target[key()]+=rhs();}finally{events.push(stored);}',
    'try{throw thrownObject;}catch(e){events.push(e===thrownObject);return target[key()]+=rhs();}',
    'try{return target.value;}finally{target[key()]+=rhs();}',
    'try{target[key()]+=rhs();throw thrownObject;}catch(e){return e===thrownObject;}finally{events.push(stored);}',
  ]) runtime(await compare([file(`function calc(){${body}}`)]), setup, 'calc()', { state: 'stored' });
});

test('constructor suppression stops at the immediate body even when a nested try contains super', async () => {
  const source = 'class C extends B{value=0;constructor(){try{super();this.value=1+2;}catch(e){throw e;}finally{events.push(1);}}}';
  const pair = await compare([file(source)]);
  assert.deepEqual(pair.actual.mutants[0].location, range(source, '{super();this.value=1+2;}'));
  assert.equal(runtime(pair, 'class B{}', 'new C().value').value, 3);
  assert.equal(execute(pair.actual, 'class B{}', 'new C().value', 'null', '0').error.name, 'ReferenceError');
});

test('nested declarations preserve call-before-declaration recursion names lengths and identity', async () => {
  for (const [body, setup, observation, value] of [
    ['return inner();function inner(){return 1+2;}', '', 'calc()', 3],
    ['function recur(n){guard();return n>0?n*recur(n-1):1;}return [recur.name,recur.length,recur===recur,recur(3)];', '', 'calc()', ['recur', 1, true, 6]],
    ['function even(n){guard();return n===0?true:odd(n-1);}function odd(n){guard();return n===0?false:even(n-1);}return [even(4),odd(3)];', '', 'calc()', [true, true]],
    ['function inner(x=1+2,...rest){return [x,rest.length];}return [inner.name,inner.length,inner===inner,inner()];', '', 'calc()', ['inner', 0, true, [3, 0]]],
  ]) assert.deepEqual(runtime(await compare([file(`function calc(){${body}}`)]), setup, observation, { state: 'ticks' }).value, value);
  const oracle = await compare([file('function outer(){return inner();function inner(){return 1+2;}}')]);
  assert.deepEqual(oracle.actual.mutants.map(({ id, mutatorName }) => [id, mutatorName]),
    [['0', 'BlockStatement'], ['1', 'BlockStatement'], ['2', 'ArithmeticOperator']]);
  for (const [id, value] of [[undefined, 3], ['0', undefined], ['1', undefined], ['2', -1]]) {
    assert.equal(execute(oracle.actual, '', 'outer()', 'null', id).value, value);
  }
  assert.match(oracle.actual.files[0].content, /return inner\(\);function inner\(\)/);
  const overlap = await compare([file('function calc(inner){function inner(x){return x+1;}return [inner.name,inner.length,inner(2)];}')]);
  assert.deepEqual(runtime(overlap, '', 'calc(9)').value, ['inner', 1, 3]);
});

test('nested typed declarations reuse parameter defaults return annotations and lexical environments', async () => {
  const source = 'function calc<T>(a:T=seed){function inner<U>(x:U=a):U{try{return x;}catch(e:unknown){throw e;}finally{events.push(true);}}return [inner.name,inner.length,inner()===seed];}';
  const pair = await compare([file(source, 'nested-typed.ts')]);
  assert.match(pair.actual.files[0].content, /function inner<U>\(x:U=a\):U/);
  assert.match(pair.actual.files[0].content, /catch\(e:unknown\)/);
  assert.deepEqual(runtime(pair, 'const seed={};').value, ['inner', 0, true]);
  const defaultScope = await compare([file('function calc(a=outer){function outer(){return true;}return [a===seed,outer.name];}')]);
  assert.deepEqual(runtime(defaultScope, 'const seed={};const outer=seed;').value, [true, 'outer']);
});

test('declarations in blocks switch methods static try catch and finally retain their scopes', async () => {
  for (const [source, observation] of [
    ['function calc(){{function inner(){return true;}events.push(inner());}return typeof inner;}', 'calc()'],
    ['function calc(){switch(choice){case 1:function inner(){return 1+2;}return inner();default:return false;}}', 'calc()'],
    ['class C{method(){function inner(){return this;}return [inner.name,inner.length,inner()===void 0];}}', 'new C().method()'],
    ['class C{static{function inner(){return 1+2;}this.value=inner();this.nameOf=inner.name;}}', '[C.value,C.nameOf]'],
    ['function calc(){try{function inner(){return 1+2;}return inner();}finally{function end(){events.push(1);}end();}}', 'calc()'],
    ['function calc(){try{throw 2;}catch(e){return inner();function inner(){return e+1;}}}', 'calc()'],
    ['function calc(){try{return 2;}finally{return inner();function inner(){return 1+2;}}}', 'calc()'],
  ]) runtime(await compare([file(source)]), 'const choice=1;', observation);
  const block = await compare([file('function calc(){{function inner(){return true;}}return typeof inner;}')]);
  assert.equal(execute(block.actual, '', 'calc()', 'null', undefined).value, 'function');
  assert.equal(execute(block.actual, '', 'calc()', 'null', undefined, { strict: true }).value, 'undefined');
});

test('upstream duplicate declaration compilation remains observable through options directives and ranges', async () => {
  for (const body of ['function inner(){return 1;}function inner(){return 2;}return inner();',
    'var inner;function inner(){return 2;}return inner();']) {
    const source = `function calc(){${body}}`;
    for (const [input, config, compileError] of [
      [file(source), options, true],
      [file(source), { ...options, excludedMutations: ['BlockStatement'] }, false],
      [file(`// Stryker disable BlockStatement: keep declarations\n${source}`), options, false],
      [file(source, 'selected.js', [range(source, 'return 2;')]), options, false],
      [file(source, 'unselected.js', false), options, false],
    ]) runtime(await compare([input], config), '', 'calc()', { modes: [true], compileError });
  }
});

test('catch and nested declaration ranges preserve parent child and touching boundary traversal', async () => {
  for (const source of [
    'const emoji="😀";\r\nfunction calc(){try{throw 2;}catch(e:any){function inner(x=1+2){return e+x;}return inner();}finally{events.push(true);}}',
    'consume(function(){try{}catch(e:any){}});',
  ]) {
    const texts = source.startsWith('const') ? ['try{throw 2;}catch(e:any){function inner(x=1+2){return e+x;}return inner();}finally{events.push(true);}',
      '{throw 2;}', 'catch(e:any){function inner(x=1+2){return e+x;}return inner();}', 'e:any', ':any', 'any',
      'function inner(x=1+2){return e+x;}', 'x=1+2', 'return e+x;', '{events.push(true);}', 'true'] : ['e:any', ':any', 'try{}', 'catch(e:any){}'];
    const selections = [false, [], ...texts.map(text => [range(source, text)])];
    for (const text of texts) {
      const selected = range(source, text);
      selections.push([{ start: selected.start, end: selected.start }], [{ start: selected.end, end: selected.end }]);
    }
    for (const mutate of selections) runtime(await compare([file(source, 'ranges.ts', mutate)]),
      'function consume(fn){fn();}', source.startsWith('const') ? '[emoji,calc()]' : 'null');
  }
});

test('directives traverse unreachable handlers and pruned subtrees do not change later rules', async () => {
  const source = `function calc(){try{return 1+2;}catch(e){
// Stryker disable BooleanLiteral: unreachable handler rule
events.push(true);
}finally{events.push(false);}}`;
  for (const mutate of [true, [range(source, '{events.push(false);}')], [range(source, 'events.push(false);')]]) {
    const pair = await compare([file(source, 'directives.js', mutate)]);
    const final = pair.actual.mutants.find(m => m.replacement === 'true');
    assert.equal(final?.status, mutate === true ? 'Ignored' : undefined);
    runtime(pair);
  }
  for (const excludedMutations of [[], ['BlockStatement'], ['CallExpression'], ['ArithmeticOperator'], ['BlockStatement', 'BooleanLiteral']]) {
    runtime(await compare([file(source)], { ...options, excludedMutations }));
    runtime(await compare([file('// Stryker disable next-line all: keep scopes\nfunction calc(){function inner(x=1+2){try{return x;}catch(e){return true;}finally{events.push(false);}}return inner();}')],
      { ...options, excludedMutations }));
  }
});

test('coverage stays at actual try catch finally and nested function execution sites', async () => {
  const source = 'function calc(){function inner(){try{return 1+2;}catch(e){return true;}finally{events.push(false);}}return inner();}';
  const pair = await compare([file(source)]);
  const before = execute(pair.actual, '', 'null', 'null', undefined);
  assert.equal(before.ns.mutantCoverage, undefined);
  const baseline = runtime(pair);
  const handler = pair.actual.mutants.find(m => m.mutatorName === 'BooleanLiteral' && m.replacement === 'false');
  const finallyBoolean = pair.actual.mutants.find(m => m.mutatorName === 'BooleanLiteral' && m.replacement === 'true');
  assert.equal(baseline.ns.mutantCoverage.perTest['try-functions-test'][handler.id], undefined);
  assert.equal(baseline.ns.mutantCoverage.perTest['try-functions-test'][finallyBoolean.id], 1);
  const staticPair = await compare([file('class C{static{try{function inner(){return 1+2;}this.value=inner();}catch(e){this.value=true;}finally{this.done=false;}}}')]);
  const loaded = runtime(staticPair, '', '[C.value,C.done]');
  assert.ok(Object.keys(loaded.ns.mutantCoverage.static).length > 0);
  const noHeader = await compare([file(source)], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
  const header = await compare([file('const seed=true;', 'header.js')]);
  runtime({ actual: { files: [...header.actual.files, ...noHeader.actual.files] },
    expected: { files: [...header.expected.files, ...noHeader.expected.files], mutants: noHeader.expected.mutants } });
});

test('unproven catches declarations comments and whole-for clones reject atomically', async () => {
  for (const source of [
    'try{}catch({message}){consume(message);}', 'try{}catch([e]){consume(e);}',
    'function calc(){async function inner(){return true;}return inner();}',
    'function calc(){function* inner(){return true;}return inner();}',
    'function calc(){function inner(){"use strict";return true;}return inner();}',
    'export default function calc(){function inner(){return true;}return inner();}',
    'if(true) function inner(){return true;}', 'label:function inner(){return true;}',
    'try /* ambiguous */ {}catch(e){}', 'try{} /* ambiguous */ catch(e){}',
    'try{}catch(e /* ambiguous */){}', 'try{}finally /* ambiguous */ {}',
    'for(;;){try{}catch(e){}break;}', 'for(;;){function inner(){return true;}break;}',
  ]) await fallback(source);
  for (const name of ['stryNS_9fa48', 'stryCov_9fa48', 'stryMutAct_9fa48', 'globalThis', 'Math', 'Function', 'Error', 'undefined']) {
    for (const mutate of [true, false, []]) await fallback(`try{}catch(${name}){}`, 'reserved.js', mutate);
  }
  for (const source of ['if(true) function inner(){return true;}', 'label:function inner(){return true;}']) {
    assert.ok(await fallback(source, 'annex-b.ts'), 'pinned module parser rejects Annex B declarations');
  }
  for (const source of ['for(;;){try{}catch(e){}break;}', 'for(;;){function inner(){return true;}break;}']) {
    await fallback(source, 'clone.js', false, { ...options, excludedMutations: ['ConditionalExpression'] });
  }
});

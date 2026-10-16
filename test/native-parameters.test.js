import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const file = (content, name = 'parameters.js', mutate = true) => ({ name, content, mutate });

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
function executable({ content, name }, parameterProperties) {
  if (!/\.[cm]?ts$/.test(name)) return content;
  if (!completedOutputs.has(content)) {
    // Transform only completed instrumentation, identically for both engines.
    completedOutputs.set(content, parameterProperties ? transformSync(content, {
      filename: name, configFile: false, babelrc: false,
      presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
    }).code : stripTypeScriptTypes(content, { mode: 'strip' }));
  }
  return completedOutputs.get(content);
}

function execute(result, setup, observation, state, id, settings, parameterProperties) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  new vm.Script(`const events=[];
    function capture(fn){try{return fn();}catch(e){return {name:e.name,message:e.message};}}
    ${setup}`).runInContext(context, { timeout: 1000 });
  const caughtError = caught => {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: caught.name, message: caught.message };
  };
  const loadErrors = [];
  for (const output of result.files) {
    // Compilation/transformation failures are test failures, not runtime parity.
    const script = new vm.Script(executable(output, parameterProperties));
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (caught) { loadErrors.push(caughtError(caught)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'parameters-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  const observer = new vm.Script(observation);
  try { value = observer.runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = caughtError(caught); }
  return structuredClone({ value, error, loadErrors, ns,
    state: new vm.Script(state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }) });
}

function runtime(pair, setup, observation, { state = 'null', parameterProperties = false } = {}) {
  const run = (result, id, settings) => execute(result, setup, observation, state, id, settings, parameterProperties);
  const baseline = run(pair.actual, undefined, {});
  assert.deepEqual(baseline.loadErrors, [], 'baseline must load');
  assert.equal(baseline.error, undefined, 'baseline must reach its observer');
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(run(pair.actual, id, settings), run(pair.expected, id, settings),
        `mutant=${id}, settings=${JSON.stringify(settings)}, source=${pair.actual.files[0].name}`);
    }
  }
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

test('default and rest parameters have pinned exact records and executable signature switches', async () => {
  const source = 'function f(a = 1+2, b = true, ...rest) { return a+rest.length; }';
  const pair = await compare([file(source, 'exact.js')]);
  assert.deepEqual(pair.actual.mutants.map(({ id, mutatorName, replacement, location, fileName }) =>
    ({ id, mutatorName, replacement, location, fileName })), [
    ['0', 'ArithmeticOperator', '1 - 2', 15, 18],
    ['1', 'BooleanLiteral', 'false', 24, 28],
    ['2', 'BlockStatement', '{}', 39, 64],
    ['3', 'ArithmeticOperator', 'a - rest.length', 48, 61],
  ].map(([id, mutatorName, replacement, start, end]) => ({ id, mutatorName, replacement,
    location: { start: { line: 0, column: start }, end: { line: 0, column: end } }, fileName: 'exact.js' })));
  const output = pair.actual.files[0].content;
  const signature = output.slice(output.indexOf('function f('), output.indexOf('...rest)') + '...rest)'.length);
  assert.match(signature, /a = .*stryMutAct_9fa48\("0"\)/);
  assert.match(signature, /b = .*stryMutAct_9fa48\("1"\)/);
  assert.match(signature, /\.\.\.rest/);
  runtime(pair, '', '[f.length,f(),f(undefined),f(null),f(0),f(7,false,8,9)]');
  for (const [content, names] of [
    ['const f=(a="x",...rest)=>a+rest.length;', ['ArrowFunction', 'StringLiteral', 'ArithmeticOperator']],
    ['function f(cb = () => 1+2) { return cb; }', ['ArrowFunction', 'ArithmeticOperator', 'BlockStatement']],
    ['function f<T>(a: true = false, b = foo.trim()) { return a; }', ['BooleanLiteral', 'MethodExpression', 'BlockStatement']],
    ['class C { constructor(public value:number = 1+2) { this.value += 1; } }', ['ArithmeticOperator', 'BlockStatement', 'AssignmentOperator']],
  ]) {
    const oracle = await compare([file(content, 'oracle.ts')]);
    assert.deepEqual(oracle.actual.mutants.map(m => m.mutatorName), names);
  }
});

test('every synchronous owner preserves defaults, rest, length and original arrow replacement', async () => {
  for (const [source, observation] of [
    ['function f(a,b=1+2,...rest){return [a,b,rest];}', '[f.length,f(),f(undefined),f(null,0),f(1,2,3,4)]'],
    ['const f=function(a,b=true,...rest){return [this.value,a,b,rest,arguments.length];};',
      '[f.length,f.call({value:7}),f.call({value:8},null,0,3,4)]'],
    ['const f=(a="x",...rest)=>a+rest.length;', '[f.name,f.length,f(),f(undefined),f(null),f(0),f(2,3,4)]'],
    ['const f=(a=true,...rest)=>{return [a,rest];};', '[f.length,f(),f(0,1,2)]'],
    ['class C{constructor(a=1+2,...rest){this.values=[a,rest];}m(a=true,...rest){return [this.values,a,rest];}static m(a="x",...rest){return [this.name,a,rest];}}',
      '[C.length,C.prototype.m.length,C.m.length,new C().m(),new C(0,1,2).m(null,3),C.m(undefined,1,2)]'],
  ]) runtime(await compare([file(source)]), '', observation);
  const pair = await compare([file('const f=(a=mark(true),...rest)=>a+rest.length;')]);
  const outer = pair.actual.mutants.find(m => m.mutatorName === 'ArrowFunction');
  assert.equal(outer.replacement, '() => undefined');
  const active = execute(pair.actual, 'function mark(v){events.push(v);return v;}', '[f.length,f()]', 'null', outer.id, {}, false);
  assert.deepEqual(active.events, [], 'outer ArrowFunction mutant removes original defaults');
  runtime(pair, 'function mark(v){events.push(v);return v;}', '[f.length,f(),f(undefined),f(0)]');
});

test('defaults execute left to right only for omitted or undefined values, including deleted bodies', async () => {
  const source = 'function f(a=mark("a",1+2),b=mark("b",a+1),...rest){mark("body",b);return [a,b,rest,arguments.length,arguments[0]];}';
  const pair = await compare([file(source)]);
  const setup = 'function mark(label,value){events.push([label,value]);return value;}';
  runtime(pair, setup, '[f(),f(undefined,undefined,8),f(null),f(0,0,9),f(7,8)]');
  const block = pair.actual.mutants.find(m => m.mutatorName === 'BlockStatement');
  const active = execute(pair.actual, setup, 'f()', 'null', block.id, {}, false);
  assert.deepEqual(active.events, [['a',3],['b',4]], 'body deletion still executes defaults');
  assert.equal(active.value, undefined);
});

test('parameter TDZ and separate body var environments survive instrumentation', async () => {
  for (const [source, setup, observation] of [
    ['function f(a=1+2,b=a+1){return [a,b];}', '', '[f(),f(8),f(8,9)]'],
    ['function f(a=b,b=1+2){return [a,b];}', '', '[capture(()=>f()),f(8),f(8,9)]'],
    ['function f(a=a+1){return a;}', 'const a=9;', '[capture(()=>f()),f(0)]'],
    ['function f(a=outside,b=a+1){var outside=20;return [a,b,outside];}', 'const outside=7;', '[f(),f(8)]'],
    ['function f(a=onlyInBody){var onlyInBody=1+2;return a;}', '', '[capture(()=>f()),f(0)]'],
    ['function f(a=()=>local){var local=1+2;return a();}', 'const local=7;', '[f(),f(()=>9)]'],
  ]) runtime(await compare([file(source)]), setup, observation);
});

test('rest arrays are fresh and non-simple parameters retain unmapped arguments', async () => {
  for (const [source, observation] of [
    ['function f(a=1+2,...rest){a=8;rest[0]=9;return [a,arguments[0],rest,arguments[1],arguments.length];}',
      '[f(),f(0,1,2),f(undefined,3),f(null,4)]'],
    ['function f(a,...rest){a=8;return [a,arguments[0],rest,arguments.length];}', '[f(0,1,2),f()]'],
    ['function f(...rest){return rest;}', '(()=>{const a=f(1,2),b=f(1,2);a.push(3);return [f.length,a,b,a===b];})()'],
  ]) runtime(await compare([file(source)]), '', observation);
});

test('method and constructor defaults preserve this and lexical arrow captures', async () => {
  for (const [source, setup, observation] of [
    ['class C{constructor(a=mark(this)){this.values=[a===this];}m(a=this.values,b=()=>this){return [a,b()===this];}}',
      'function mark(value){events.push("this");return value;}', '[new C().m(),new C(0).m(0,()=>null)]'],
    ['function f(value){const g=(a=this.offset+1,b=arguments[0],...rest)=>[a,b,rest];return g;}', '',
      '(()=>{const g=f.call({offset:7},9);return [g(),g(0,null,3),g.length];})()'],
    ['class C extends B{constructor(a=1+2,...rest){super(a);this.rest=rest;}m(a=super.value(),b=this.base){return [a,b];}}',
      'class B{constructor(v){this.base=v;}value(){return this.base;}}', '[new C().m(),new C(0,8).m(),new C().rest]'],
  ]) runtime(await compare([file(source)]), setup, observation);
});

test('direct eval defaults and anonymous initializer names match pinned upstream', async () => {
  for (const [source, observation] of [
    ['function f(a=1+2,b=eval("a")){var a=9;return [a,b];}', '[f(),f(8),f(null),f(0)]'],
    ['function f(a=eval("var local=7"),b=()=>local){return [local,b()];}', '[f(),f(undefined,()=>8)]'],
    ['function f(cb=()=>1+2){return [cb.name,cb()];}', '[f(),f(()=>7)]'],
    ['function f(cb=function(){return 1+2;}){return [cb.name,cb()];}', '[f(),f(function supplied(){return 7;})]'],
    ['function f(cb=function named(){return true;}){return [cb.name,cb()];}', '[f(),f(()=>7)]'],
  ]) runtime(await compare([file(source)]), '', observation);
  const arrow = await compare([file('function f(cb=()=>1+2){return cb.name;}')]);
  assert.equal(execute(arrow.actual, '', 'f()', 'null', undefined, {}, false).value, '',
    'the conditional wrapper loses default arrow name inference just as upstream does');
});

test('default coverage runs before bodies and supports delayed activation, limits and throws', async () => {
  const pair = await compare([file('function f(a=mark(true),b=fail(1+2)){return a;}f(0,0);')]);
  const setup = 'function mark(v){events.push(["default",v]);return v;}function fail(v){events.push(["throw",v]);throw new RangeError("default failed");}';
  const baseline = runtime(pair, setup, '[capture(()=>f()),capture(()=>f(0)),f(0,0)]');
  assert.equal(baseline.ns.mutantCoverage.static['2'], 1, 'load-time call covers the body only');
  assert.ok(baseline.ns.mutantCoverage.perTest['parameters-test']['0']);
  assert.deepEqual(baseline.events, [['default',true],['throw',3],['throw',3]]);
});

test('typed defaults and rest preserve type bytes and traverse annotations in Babel order', async () => {
  for (const source of [
    'function f<T extends true>(a: true = false,b?:number,...rest: true[]): true{return a;}',
    'const f=<T extends true>(a: true = false,...rest: number[]): true=>a;',
    'class C{m<T extends true>(a: true=false,...rest:number[]):true{return a;}}',
  ]) {
    const pair = await compare([file(source, 'typed.ts')]);
    assert.match(pair.actual.files[0].content, /<T extends true>/);
    assert.match(pair.actual.files[0].content, /a: true\s*=/);
    assert.match(pair.actual.files[0].content, /\.\.\.rest:\s*(true\[\]|number\[\])/);
    runtime(pair, '', source.startsWith('class') ? '[new C().m(),new C().m(0,1)]' : '[f.length,f(),f(undefined),f(0)]');
  }
});

test('parameter property defaults preserve derived super suppression and complete metadata', async () => {
  for (const modifier of ['public', 'protected', 'private', 'readonly', 'public readonly', 'public override', 'override readonly']) {
    const source = `class C extends B{constructor(${modifier} value:number=1+2,...rest:number[]){super(value);this.rest=rest;}m(){return this.value;}}`;
    const pair = await compare([file(source, 'properties.ts')]);
    assert.match(pair.actual.files[0].content, new RegExp(`${modifier} value:number=`));
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement' && m.location.start.column === source.indexOf('{super')), false);
    runtime(pair, 'class B{constructor(value){this.base=value;}}', '[new C().m(),new C(0,8).rest,new C(null).base]', { parameterProperties: true });
  }
  const source = 'class C extends B{constructor(public value:number=1+2){super(value);}x=1;}';
  for (const text of ['1+2', '{super(value);}', 'super(value)']) {
    const pair = await compare([file(source, 'ranges.ts', [range(source, text)])]);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement'), false);
    runtime(pair, 'class B{constructor(value){this.base=value;}}', '[new C().value,new C(0).base]', { parameterProperties: true });
  }
  runtime(await compare([file('class C extends B{constructor(public value=this.base){super();}}', 'before-super.ts')]),
    'class B{constructor(){this.base=7;}}', '[capture(()=>new C()),new C(0).value]', { parameterProperties: true });
});

test('default expressions retain established non-null, delete and opaque as placement', async () => {
  for (const [source, observation] of [
    ['function f(a=obj!.trim(),b=delete target!.value){return [a,b,target.value];}', '[f(),f(0,0)]'],
    ['function f(a=make(1+2) as any){return a;}', '[f(),f(0)]'],
    ['function f(a=1+2){(target as any)=a;return a;}', '[f(),f(0)]'],
    ['function f(a=()=>{(target as any)=1+2;return target;}){return a();}', '[f(),f(()=>7)]'],
  ]) runtime(await compare([file(source, 'expressions.ts')]),
    'const obj=" x ";let target={value:true};function make(v){events.push(v);return v;}', observation);
});

test('parameter and body ranges match actual wrappers, typed bindings and skipped-type filter events', async () => {
  for (const source of [
    'consume(function f<T>(a: true = false,b=true,...rest: number[]):true{return true;});',
    'consume((a: true = false,b=true,...rest:number[]):true=>true);',
    'class C{constructor(public value:true=false,readonly other=true){this.value=true;}}',
  ]) {
    for (const text of ['true', 'false', source.includes('b=true') ? 'b=true' : 'other=true', source.includes('return') ? 'return true;' : source.includes('=>') ? '=>true' : 'this.value=true;', source.includes('...') ? '...rest' : 'public', source.includes('...') ? 'number[]' : 'value:true']) {
      const pair = await compare([file(source, 'selection.ts', [range(source, text)])]);
      runtime(pair, 'let captured;function consume(fn){captured=fn;}', source.startsWith('class') ? 'new C().value' : '[captured(),captured(0)]', { parameterProperties: source.startsWith('class') });
    }
  }
});

test('enclosing statement-call filters retain removed ID gaps and ignore inactive defaults', async () => {
  for (const [source, ids] of [
    ['consume(function f(a=true){});', ['1']],
    ['consume(function f(...rest){});', ['0']],
    ['consume(function f(a:true=true){});', ['0','1']],
    ['consume((a=true):true=>a);', ['0','1','2']],
  ]) {
    const pair = await compare([file(source, 'filter.ts')]);
    assert.deepEqual(pair.actual.mutants.map(m => m.id), ids);
    runtime(pair, 'let captured;function consume(fn){events.push("consume");captured=fn;}', 'typeof captured==="function"?captured():null');
  }
  for (const excludedMutations of [['BooleanLiteral'], ['ArrowFunction'], ['BlockStatement'], ['BooleanLiteral','BlockStatement']]) {
    runtime(await compare([file('consume(function f(a=true){return false;});')], { ...options, excludedMutations }),
      'let captured;function consume(fn){captured=fn;}', 'typeof captured==="function"?captured():null');
  }
});

test('directives, ignored defaults, multi-file IDs and UTF16 CRLF selections retain parity', async () => {
  const source = '// Stryker disable next-line BooleanLiteral: parameter\r\nfunction f(a=true,b="😀",...rest){return [a,b,rest];}\r\n// Stryker restore BooleanLiteral\r\nconst g=(a=false)=>a;';
  const pair = await compare([file(source)]);
  assert.equal(pair.actual.mutants.find(m => m.mutatorName === 'BooleanLiteral').status, 'Ignored');
  runtime(pair, '', '[f(),f(0),g(),g(null)]');
  const utf16 = 'const emoji="😀";\r\nfunction f(a="😀",b=true,...rest){return a+rest.length;}';
  for (const mutate of [true, false, [], [range(utf16, 'b=true')], [range(utf16, 'a+rest.length')]]) {
    runtime(await compare([file(utf16, 'unicode.js', mutate)]), '', '[f(),f(undefined,0,1),f(null)]');
  }
  const multi = await compare([file('function f(a=true){return a;}', 'first.js'), file('const g=(a="x",...rest)=>a+rest.length;', 'second.js')]);
  runtime(multi, '', '[f(),g(),g(0,1)]');
});

async function fallback(source, name = 'unsupported.ts', mutate = true) {
  const files = [file('const accepted=true;', 'accepted.js'), file(source, name, mutate)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
  assert.equal(raw.supported, false, source);
  assert.equal(raw.result, undefined, source);
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, options), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
  const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
  let automaticFailure;
  if (failure) await assert.rejects(automatic.instrument(files, options), error => {
    automaticFailure = error;
    return error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0];
  });
  else assert.deepEqual(await automatic.instrument(files, options), expected);
  assert.equal(automatic.stats.nativeBatches, 0);
  assert.equal(automatic.stats.fallbackBatches, 1);
  assert.equal(automatic.stats.nativeErrors, 0);
  return { raw, failure, automaticFailure };
}

test('parameter parser preflight rejects inherited class scopes and nested opaque defaults atomically', async () => {
  const sources = target => [
    `function f(a=class extends factory(${target}=B){}){return a;}`,
    `function f(a=class{static{${target}=1;}}){return a;}`,
    `function f(a=(function inner(b=${target}=1){}) as any){return a;}`,
    `function f(a=((b=${target}=1)=>b) as any){return a;}`,
    `function f(a=(class{m(b=${target}=1){}}) as any){return a;}`,
    `const hidden=(function inner(b=${target}=1){}) as any;`,
    `const hidden=((b=${target}=1)=>b) as any;`,
    `const hidden=(class{constructor(b=${target}=1){}}) as any;`,
    `function f(a=class{value=(function inner(b=${target}=1){}) as any;}){return a;}`,
    `function f(a=class{value=((b=${target}=1)=>b) as any;}){return a;}`,
    `function f(a=function(){return (function inner(b=${target}=1){}) as any;}){return a;}`,
    `function f(a=()=>((b=${target}=1)=>b) as any){return a;}`,
    `function f(a=class{value=0;static{${target}=1;}}){return a;}`,
    `function f(a=class{m(){${target}=1;}static{${target}=2;}}){return a;}`,
    `function f(a=function inner(){${target}=1;},b=${target}=2){return a;}`,
  ];
  for (const [target, reason] of [['(target as any)', 'UnexpectedTypeCastInParameter'], ['(target)', 'InvalidParenthesizedAssignment']]) {
    for (const source of sources(target)) {
      for (const mutate of [true, false, []]) {
        const { raw, failure, automaticFailure } = await fallback(source, 'parser-scope.ts', mutate);
        assert.match(raw.reason, /Typed or parenthesized identifier assignment targets in defaults/);
        assert.equal(failure?.code, 'BABEL_PARSE_ERROR', source);
        assert.equal(failure.reasonCode, reason, source);
        assert.equal(automaticFailure.code, failure.code);
        assert.equal(automaticFailure.reasonCode, failure.reasonCode);
        assert.equal(automaticFailure.message, failure.message, 'auto must preserve the exact upstream parser error');
        assert.deepEqual(automaticFailure.loc, failure.loc);
      }
    }
  }
});

test('grouped inherited class assignments retain conservative fallback and exact upstream behavior', async () => {
  for (const target of ['(target as any)', '(target)']) {
    for (const source of [
      `function f(a=(class extends factory(${target}=B){}) as any){return a;}`,
      `function f(a=(class{static{${target}=1;}}) as any){return a;}`,
    ]) {
      for (const mutate of [true, false, []]) await fallback(source, 'grouped-class.ts', mutate);
    }
  }
});

test('field initializers and function bodies reset parser scope while nested valid defaults retain records and runtime', async () => {
  for (const target of ['(target as any)', '(target)']) {
    const fixtures = [
      [`function f(a=1+2){${target}=a;return a;}`, '[f(),f(0),target]'],
      [`function f(a=function inner(b=true){${target}=b;return b;}){return a;}`,
        '[capture(()=>f()()),capture(()=>f()(0)),target]'],
      [`function f(a=(b=true)=>(${target}=b)){return a;}`,
        '[capture(()=>f()()),capture(()=>f()(0)),target]'],
      [`function f(a=class{value=${target}=1;static value=${target}=2;m(b=true){${target}=b;return b;}}){return a;}`,
        'capture(()=>{const C=f();const c=new C();return [C.value,c.value,c.m(),target];})'],
      [`function f(a=class{value=class extends factory(${target}=B){static{${target}=3;}};}){return a;}`,
        'capture(()=>{const Outer=f();const c=new Outer();return [typeof c.value,target];})'],
      [`function f(a=class{value=(function inner(b=true){${target}=b;return b;}) as any;}){return a;}`,
        'capture(()=>{const C=f();return [new C().value(),target];})'],
    ];
    for (const [source, observation] of fixtures) {
      runtime(await compare([file(source, 'scope-resets.ts')]),
        'let target=0;class B{};function factory(value){return value;}', observation, { state: 'target' });
    }
  }
});

test('syntactic inspection of opaque defaults adds no mutation records or ID gaps', async () => {
  const source = 'function f(a=(function inner(b=1+2){(target as any)=b;return b;}) as any){return a;}';
  const pair = await compare([file(source, 'opaque-default.ts')]);
  assert.deepEqual(pair.actual.mutants.map(({ id, mutatorName }) => [id, mutatorName]), [['0', 'BlockStatement']]);
  runtime(pair, 'let target=0;', '[capture(()=>f()()),capture(()=>f()(7)),target]', { state: 'target' });
  const hidden = 'const hidden=(class{value=(target as any)=1;m(b=1+2){(target as any)=b;return b;}}) as any;function f(a=true){return a;}';
  const hiddenPair = await compare([file(hidden, 'opaque-class.ts')]);
  assert.deepEqual(hiddenPair.actual.mutants.map(({ id, mutatorName }) => [id, mutatorName]), [['0', 'BooleanLiteral'], ['1', 'BlockStatement']]);
  runtime(hiddenPair, 'let target=0;', 'capture(()=>{const c=new hidden();return [c.value,c.m(),f(),target];})', { state: 'target' });
});

test('unproven parameter patterns and existing grammar and printer boundaries reject atomically', async () => {
  for (const source of [
    'function f({a}=obj){return a;}', 'function f(...[a]){return a;}', 'const f=([a]=list)=>a;',
    'class C{m(...{length}){return length;}}', 'function f(this:C,a=true){return a;}',
    'function* f(a=true){}',
    'class C{*m(a=true){}}',
    'class C{constructor(@dec public a=true){}}', 'class C{constructor(override a=true){}}',
    'class C{m(public a=true){}}', 'function f(a /* comment */=true){}',
    'function f(a=true){"use strict";}', 'function f(a=true){"directive";return a;}',
    'function f(a=/[a-z]/){}',
    'function f(a=1**2){}', 'function f(a=[...items]){}', 'function f(...rest){return obj.g(...rest);}',
    'const f=((a=true)=>a)+1;', 'for(;;){const f=(a=true)=>a;break;}',
    'function f(a=1_000+2n){}', 'function f(a=true){try{return a;}catch({message}){}}', 'function f(a=new.target){}',
    'function f(a=(target as any)=1){}', 'function f(a=foo((target as any)=1)){}',
    'function f(a=((target as any)=1)){}', 'function f(a=(target)=1){}', 'function f(a=((target)=1)){}',
  ]) await fallback(source);
  for (const name of ['stryNS_9fa48','stryCov_9fa48','stryMutAct_9fa48','globalThis','Math','Function','Error','undefined']) {
    for (const mutate of [true, false, []]) await fallback(`function f(...${name}){}`, 'reserved.js', mutate);
  }
  for (const source of ['function f(a=()=>{const Math=1;return true;}){}',
    'function f(a=stryCov_9fa48()){}', 'function f(a=function(Error){return true;}){}']) await fallback(source);
});

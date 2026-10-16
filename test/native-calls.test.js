import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const upstreamRoot = process.env.STRYKER_UPSTREAM;
const file = (content, name = 'calls.js', mutate = true) => ({ name, content, mutate });

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
    new vm.Script(`const events = []; ${setup}`).runInContext(context, { timeout: 1000 });
    new vm.Script(code).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'calls-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    value = undefined;
    error = { name: caught.name, message: caught.message };
  }
  const events = new vm.Script('events').runInContext(context);
  return structuredClone({ value, error, ns, events });
}

function runtime({ actual, expected }, setup, observation, { baselineThrows = false } = {}) {
  const native = actual.files[0].content;
  const upstream = expected.files[0].content;
  const baseline = execute(native, setup, observation);
  assert.equal(Boolean(baseline.error), baselineThrows, 'baseline observer must run as intended');
  assert.deepEqual(baseline, execute(upstream, setup, observation), 'baseline');
  for (const { id, status } of expected.mutants) {
    if (status === 'Ignored') continue;
    for (const afterLoad of [false, true]) {
      for (const hitLimit of [undefined, 0, 1]) {
        const settings = { afterLoad, hitLimit };
        assert.deepEqual(execute(native, setup, observation, id, settings), execute(upstream, setup, observation, id, settings), `mutant ${id}: ${JSON.stringify(settings)}`);
      }
    }
  }
}

const mapping = [
  ['charAt', null], ['endsWith', 'startsWith'], ['every', 'some'], ['filter', null],
  ['reverse', null], ['slice', null], ['sort', null], ['substr', null], ['substring', null],
  ['toLocaleLowerCase', 'toLocaleUpperCase'], ['toLowerCase', 'toUpperCase'], ['trim', null],
  ['trimEnd', 'trimStart'], ['min', 'max'], ['setDate', 'setTime'], ['setFullYear', 'setMonth'],
  ['setHours', 'setMinutes'], ['setSeconds', 'setMilliseconds'], ['setUTCDate', 'setTime'],
  ['setUTCFullYear', 'setUTCMonth'], ['setUTCHours', 'setUTCMinutes'], ['setUTCSeconds', 'setUTCMilliseconds'],
];
for (const [from, to] of [...mapping]) if (to && from !== 'setUTCDate') mapping.push([to, from]);

const receiverSetup = `
  const obj = new Proxy({}, { get(target, key) {
    events.push('get:' + key);
    return function (...args) { events.push(['call', key, this === obj, args]); return String(key); };
  }});
  function arg() { events.push('arg'); return 3; }
`;

for (const [name, replacement] of mapping) {
  test(`native method mapping and runtime: ${name}`, async () => {
    const pair = await compare([file(`function calc(o) { return o.${name}(arg()); }`)]);
    assert.equal(pair.actual.mutants.find(m => m.mutatorName === 'MethodExpression').replacement, replacement ? `o.${replacement}(arg())` : 'o');
    runtime(pair, receiverSetup, 'Array.from({length:2}, () => { const result = calc(obj); return result === obj ? "receiver" : result; })');
  });
}

const cases = [
  ['ordinary calls and this', 'const fn = x => x + 1; function calc(o) { return o.call(fn, 2) + fn(3); }', 'const holder = {call(f,x){events.push(this===holder);return f(x);}};', '[calc(holder),calc(holder)]'],
  ['this receiver', 'function calc() { return this.value + this.run(1); }', 'const obj = {value: 4, run(x) { events.push(this === obj); return x; }};', '[calc.call(obj), calc.call(obj)]'],
  ['chain placement', 'function calc(a, b) { return obj.trim(a + b).length; }', 'const obj = {length: 7, trim(x) { events.push([this === obj, x]); return "  x  "; }};', '[calc(4, 2), calc(1, 1)]'],
  ['nested chain', 'function calc() { return getObject().trim(arg()).toLowerCase().length; }', 'const obj = {length: 11, trim(x) { events.push(["trim", this === obj, x]); return " A "; }, toLowerCase() { events.push("lower"); return "a"; }, toUpperCase() { events.push("upper"); return "A"; }}; function getObject() {events.push("object"); return obj;} function arg() {events.push("arg");return 2;}', '[calc(), calc()]'],
  ['rename evaluation order', 'function calc() { return getObject().startsWith(arg()); }', 'function getObject(){events.push("object");return obj;} ' + receiverSetup, '[calc(), calc()]'],
  ['computed key call', 'function calc() { return obj[key.trim()].slice(arg()).length; }', 'const key = " a "; const obj = {a: "abc", " a ": "def", "": "ghi"}; function arg(){events.push("arg");return 1;}', '[calc(),calc()]'],
  ['computed identifier', 'function calc() { return obj[trim](arg()); }', 'Object.defineProperty(globalThis,"trim",{get(){events.push("key");return "actual";}});' + receiverSetup, 'Array.from({length:2},()=>{const result=calc();return result===obj?"receiver":result;})'],
  ['computed identifier rename', 'function calc() { return obj[endsWith](arg()); }', 'Object.defineProperty(globalThis,"endsWith",{get(){events.push("key");return "actual";}});' + receiverSetup, '[calc(),calc()]'],
  ['computed string', 'function calc() { return obj["trim"](arg()); }', receiverSetup, '[calc(),calc()]'],
  ['computed key evaluation', 'function calc() { return getObject()[getKey()](arg()); }', 'function getObject(){events.push("object");return obj;} function getKey(){events.push("key");return "trim";}' + receiverSetup, '[calc(),calc()]'],
  ['call callee chain', 'function calc() { return factory().trim(arg())(); }', 'function factory(){events.push("factory"); const o={trim(x){events.push(["trim",this===o,x]);return ()=>"result";}}; return o;} function arg(){events.push("arg");return 2;}', '[calc(),calc()]'],
  ['parenthesized receivers', 'function calc(a, b) { return (a + b).toLowerCase(); }', '', '[calc("A", "B"),calc("C","D")]'],
  ['conditional receivers', 'function calc(flag) { return (flag ? left : right).trim(arg()).length; }', 'const left=" x ", right=" y "; function arg(){events.push("arg");return 1;}', '[calc(true),calc(false)]'],
  ['mapped numeric receiver precedence', 'function calc(x) { return (-x).min(arg()) + (2).min(arg()); }', 'Number.prototype.min=function(x){events.push(["min",Number(this),x]);return Number(this)+x;}; Number.prototype.max=function(x){events.push(["max",Number(this),x]);return Number(this)-x;}; function arg(){events.push("arg");return 3;}', '[calc(4),calc(2)]'],
  ['numeric and unary receivers', 'function calc(x) { return (-x).toString() + (2).toString() + (x + 1).toString(); }', '', '[calc(3),calc(2)]'],
  ['method in condition', 'function calc(){if(obj.trim()) foo(); else bar();}', receiverSetup + 'function foo(){events.push("foo");}function bar(){events.push("bar");}', '[calc(),calc()]'],
  ['method statement removal', 'obj.trim(arg());', receiverSetup, 'events'],
  ['standalone statement calls', 'foo(); foo(bar());', 'function foo(x){events.push(["foo",x]);} function bar(){events.push("bar");return 1;}', 'events'],
  ['dangling else', 'function calc(flag, other) { if (flag) if (other) foo(); else bar(); else baz(); }', 'function foo(){events.push("foo");}function bar(){events.push("bar");}function baz(){events.push("baz");}', '[calc(true,true),calc(true,false),calc(false,false)]'],
  ['require and Symbol direct versus nested', 'function calc() { return [require("x"), require(["nested"]), Symbol("x").description, Symbol(["nested"]).description, Symbol(`template`).description, obj.require("x"), obj.Symbol("x")]; }', 'function require(x){events.push(["require",x]);return x;}const obj={require(x){events.push(["method",this===obj,x]);return x;},Symbol(x){return x;}};', '[calc(),calc()]'],
  ['direct argument string exclusions', 'require("x"); Symbol("x"); require(["nested"]); obj.require("x");', 'function require(x){events.push(x);} const obj={require(x){events.push(x);}};', 'events'],
  ['direct eval lexical initializer', 'const lexical=40; const result=eval("lexical + 2");', '', 'result'],
  ['direct eval', 'function calc(x) { return eval("x + 1"); }', '', '[calc(4),calc(2)]'],
  ['parenthesized direct eval', 'function calc(x) { return (eval)("x + 1"); }', '', '[calc(4),calc(2)]'],
  ['Array arguments', 'function calc(x) { return [Array(), Array(x + 1), Array(arg(), arg())]; }', 'function arg(){events.push("arg");return 2;}', '[calc(2),calc(1)]'],
  ['shadowed Array', 'function Array(x) { return x; } function calc() { return Array(arg()); }', 'function arg(){events.push("arg");return 2;}', '[calc(),calc()]'],
  ['Array chain', 'function calc() { return Array(2).slice(arg()).length; }', 'function arg(){events.push("arg");return 1;}', '[calc(),calc()]'],
  ['public Array properties', 'function calc() { return [obj.Array(1), obj["Array"](2)]; }', 'const obj={Array(x){events.push(this===obj);return x;}};', '[calc(),calc()]'],
  ['argument throws', 'function calc() { return obj.trim(boom()); }', 'const obj={trim(){events.push("trim");return 1;}};function boom(){events.push("boom");throw new RangeError("argument");}', '(() => {const result=calc();return result===obj?"receiver":result;})()', true],
  ['getter throws', 'function calc() { return obj.trim(arg()); }', 'const obj={get trim(){events.push("getter");throw new RangeError("getter");}};function arg(){events.push("arg");return 1;}', '(() => {const result=calc();return result===obj?"receiver":result;})()', true],
  ['names in argument and property', 'const named = value => value; function calc() { return take(named, { fn: x => x + 1 }); }', 'function take(f,o){return [f.name,o.fn.name,o.fn(1)];}', '[calc(),named.name]'],
];
for (const [name, content, setup, observation, baselineThrows = false] of cases) {
  test(`native calls complete records, coverage and effects: ${name}`, async () => {
    runtime(await compare([file(content)]), setup, observation, { baselineThrows });
  });
}

const filterExamples = [
  ['foo();', [['0', 'CallExpression', ';']]],
  ['foo(a+b);', [['1', 'ArithmeticOperator', 'a - b']]],
  ['foo(bar());', [['0', 'CallExpression', ';']]],
  ['obj.trim();', [['1', 'MethodExpression', 'obj']]],
  ['foo(obj.trim());', [['1', 'MethodExpression', 'obj']]],
  ['Array();', [['1', 'ArrayDeclaration', 'Array([])']]],
  ['Array(1+2);', [['1', 'ArrayDeclaration', 'Array()'], ['2', 'ArithmeticOperator', '1 - 2']]],
  ['const x=Array();', [['0', 'ArrayDeclaration', 'Array([])']]],
  ['foo(); bar(a+b); baz();', [['0', 'CallExpression', ';'], ['2', 'ArithmeticOperator', 'a - b'], ['3', 'CallExpression', ';']]],
];

test('statement filter preserves exact public mutators and monotonic ID gaps', async () => {
  for (const [content, records] of filterExamples) {
    const { actual } = await compare([file(content)]);
    assert.deepEqual(actual.mutants.map(({id,mutatorName,replacement}) => [id,mutatorName,replacement]), records);
    const removed = content === 'foo(a+b);' ? '0' : undefined;
    if (removed) assert.doesNotMatch(actual.files[0].content, /stry(?:MutAct|Cov)_9fa48\("0"/);
  }
  const { actual } = await compare([file('foo(a+b);'), file('foo();', 'second.js'), file('Array(1+2);', 'third.js'), file('baz();', 'fourth.js')]);
  assert.deepEqual(actual.mutants.map(m => m.id), ['1','2','4','5','6']);
});

test('cross-file ID gaps execute with static and per-test coverage', async () => {
  for (const files of [
    [file('foo(a+b);'), file('foo();', 'second.js'), file('Array(1+2);', 'third.js'), file('baz();', 'fourth.js')],
    [file('function first(){foo(a+b);}'), file('function second(){foo(); Array(1+2);}', 'second.js')],
  ]) {
    const pair = await compare(files);
    const combine = result => ({ ...result, files: [{ content: result.files.map(f => f.content).join('\n') }] });
    runtime({ actual: combine(pair.actual), expected: combine(pair.expected) }, 'const a=4,b=2;function foo(x){events.push(["foo",x]);}function baz(){events.push("baz");}', files.length === 4 ? 'events' : '[first(),second(),first(),second()]');
  }
});

test('exclusions, directives, explicit empty reasons and filtered descendants preserve records and placement', async () => {
  const setup = receiverSetup + 'function foo(x){events.push(["foo",x===obj?"receiver":typeof x==="function"?"function":x]); if(typeof x==="function") return x();} function bar(x){events.push(["bar",x]);}';
  const sources = [
    'obj.trim();', 'foo(1+2);', 'foo(obj.trim());', 'foo(() => { bar(); });', 'foo(() => { bar(1+2); });',
    '// Stryker disable next-line CallExpression:   \nfoo(1+2);',
    '// Stryker disable next-line CallExpression: reason\nfoo(obj.trim());',
    '// Stryker disable next-line MethodExpression: reason\nobj.trim();',
    '// Stryker disable next-line MethodExpression:   \nobj.trim();',
    '// Stryker disable next-line all: reason\nobj.trim();',
  ];
  for (const content of sources) for (const excludedMutations of [[], ['MethodExpression'], ['CallExpression'], ['ArithmeticOperator'], ['CallExpression','MethodExpression']]) {
    const pair = await compare([file(content)], { ...options, excludedMutations });
    runtime(pair, setup, 'events');
    if (pair.actual.mutants.every(m => m.status === 'Ignored')) assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_/);
  }
});

test('statement ranges include semicolons independently of call spans', async () => {
  for (const content of ['obj.trim();', 'Array();', 'foo();', 'foo(1+2);', 'foo();\nobj.trim();', '(foo());', '(obj.trim());', 'foo()']) {
    for (let end = 0; end <= content.length; end++) {
      const mutate = [{ start: {line:0,column:0}, end: {line:0,column:end} }];
      const pair = await compare([file(content, 'ranges.js', mutate)]);
      runtime(pair, receiverSetup + 'function foo(x){events.push(x);}', 'events');
    }
  }
  await compare([file('foo(a+b);'),file('obj.trim();','off.js',false),file('foo();','last.js')]);
});

test('conservative call boundaries reject the whole batch and auto returns the complete upstream result', async () => {
  const sources = [
    ['const x=(obj?.trim)?.();','js'], ['const x=(obj.trim?.()).length;','js'], ['const x=(foo?.())();','js'],
    ['const x=(obj?.trim)();','js'], ['const x=(obj?.["key"]).length;','js'], ['const x=new Array(2);','js'],
    ['const x=import("x");','js'], ['foo(...args);','js'], ['[obj.key]=items;','js'], ['([obj.key]=items,other++);','js'],
    ['delete obj.key;','js'], ['const x=tag`x`;','js'], ['class C extends B { foo() { super.foo(); } }','js'],
    ['class C { #x=1; foo() { return this.#x; } }','js'], ['const x: number=foo();','ts'],
    ['<div>{{ foo() }}</div>','html'], ['const x=obj.trim("single quoted");'.replace('"single quoted"',"'single quoted'"),'js'],
    ['const x=obj.trim(/* comment */ arg());','js'], ['const x=obj.trim(() => 1);','js'],
  ];
  for (const [content, extension] of sources) {
    const files = [file('const first=true;', 'first.js'), file(content, `unsupported.${extension}`)];
    const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
    assert.equal(raw.supported, false, content);
    assert.equal(raw.result, undefined, content);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i, content);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    assert.deepEqual(await auto.instrument(files, options), await new Instrumenter(logger).instrument(files, options), content);
    assert.equal(auto.stats.nativeBatches, 0, content);
    assert.equal(auto.stats.fallbackBatches, 1, content);
  }
});

// Exact pinned resource bytes; STRYKER_UPSTREAM additionally verifies these
// fixtures against the real checkout without making the suite path-dependent.
const corpusFixtures = {
  'console-sample.js': 'console.log(a + b);\n\n// Typo on purpose\nconsolee.log(a + b);\n',
  'js-sample.js': 'function add(a, b) {\n  return a + b;\n}\n\nadd(40, 2);\n',
};
for (const [name, content] of Object.entries(corpusFixtures)) {
  test(`real upstream corpus fixture forced native: ${name}`, async () => {
    if (upstreamRoot) assert.equal(await readFile(`${upstreamRoot}/packages/instrumenter/testResources/instrumenter/${name}`, 'utf8'), content);
    const pair = await compare([file(content, name)]);
    const setup = name === 'console-sample.js'
      ? 'const a=4,b=2; const console={log(x){events.push(["console",x]);}}, consolee={log(x){events.push(["consolee",x]);}};'
      : '';
    runtime(pair, setup, name === 'console-sample.js' ? 'events' : '[add(4,2),add(1,3)]');
  });
}

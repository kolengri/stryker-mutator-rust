import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'classes.js', mutate = true) => ({ name, content, mutate });

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, true, raw.reason);
  assert.deepEqual(raw.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'direct ABI ordered full records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

async function execute(result, setup, observation, state, id, settings) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
  let value, loadError, error;
  const caughtError = caught => {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: caught.name, message: caught.message };
  };
  for (const { content, name } of result.files) {
    try {
      // Use the established Node strip helper on completed instrumentation only.
      const source = /\.(?:[cm]?ts)$/.test(name) ? stripTypeScriptTypes(content, { mode: 'strip' }) : content;
      if (/^import /m.test(source)) {
        const module = new vm.SourceTextModule(`${source}\nglobalThis.__observedValue=(${observation});`, { context });
        await module.link(() => new vm.SyntheticModule([], () => {}, { context }));
        await module.evaluate({ timeout: 1000 });
        value = context.__observedValue;
      } else {
        new vm.Script(source).runInContext(context, { timeout: 1000 });
      }
    } catch (caught) {
      loadError = [...(loadError ?? []), caughtError(caught)];
    }
  }
  ns.currentTestId = settings.currentTestId ?? 'classes-test';
  if (settings.afterLoad) ns.activeMutant = id;
  // Still exercise the real Person class when its corpus script ends in throw.
  if (!result.files.some(({ content }) => /^import /m.test(content))) {
    try {
      value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
    } catch (caught) {
      error = caughtError(caught);
    }
  }
  return structuredClone({ value, loadError, error,
    state: new vm.Script(state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }), ns });
}

async function runtime(pair, setup = '', observation = 'calc()', state = 'null', { baselineLoadThrows = false, baselineThrows = false } = {}) {
  const baseline = await execute(pair.actual, setup, observation, state, undefined, {});
  assert.equal(Boolean(baseline.loadError), baselineLoadThrows, 'baseline load must exercise the intended behavior');
  assert.equal(Boolean(baseline.error), baselineThrows, 'baseline observer must exercise the intended behavior');
  assert.deepEqual(baseline, await execute(pair.expected, setup, observation, state, undefined, {}));
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(await execute(pair.actual, setup, observation, state, id, settings),
        await execute(pair.expected, setup, observation, state, id, settings),
        `mutant=${id}, settings=${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}

async function fallback(source, config = options, name = 'unsupported.js') {
  const files = [file('const first=true;', 'first.js'), file(source, name)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, false, source);
  assert.equal(raw.result, undefined, source);
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

test('function expressions preserve names, recursion, dynamic this, arguments and construction', async () => {
  for (const [source, observation] of [
    ['const calc=function(x){return this.offset+arguments[0];};', '[calc.name,calc.call({offset:4},2),calc.call({offset:1},3)]'],
    ['const calc=function recur(n){guard();return n>0?n*recur(n-1):1;};', '[calc.name,calc(3),typeof recur]'],
    ['const Calc=function(x){this.value=x+1;};', '[Calc.name,new Calc(2).value,new Calc(3) instanceof Calc]'],
    ['const holder={calc:function(x){return this.offset+arguments[0];},offset:4};', '[holder.calc.name,holder.calc(2)]'],
    ['const holder={"calc":function(x){return x+1;}};', '[holder.calc.name,holder.calc(2)]'],
    ['const calc=(function named(x){return x+1;});', '[calc.name,calc(2)]'],
    ['const calc=function(x){return x+1;};', '[calc.name,calc(2)]'],
  ]) {
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'ArrowFunction'), false);
    await runtime(pair, 'let depth=0;function guard(){if(++depth>10)throw new RangeError("recursion limit");}', observation);
  }
});

test('class expressions preserve inferred and explicit names and class-local bindings', async () => {
  for (const [source, observation] of [
    ['const C=class{value=1+2;method(){return this.value;}};', '[C.name,new C().method()]'],
    ['const holder={C:class{value=true;}};', '[holder.C.name,new holder.C().value]'],
    ['const holder={"C":class{value=true;}};', '[holder.C.name,new holder.C().value]'],
    ['const C=class Local{method(){return Local;}};', '[C.name,new C().method()===C,typeof Local]'],
  ]) await runtime(await compare([file(source)]), '', observation);
  // A method's Oxc Function is not a synthetic Babel FunctionExpression.
  const pair = await compare([file('class C{m(){return true;}}')]);
  assert.deepEqual(pair.actual.mutants.map(m => m.mutatorName), ['BlockStatement', 'BooleanLiteral']);
});

test('public fields, static blocks, accessors and methods retain evaluation order and receivers', async () => {
  const source = `class C {
    static first=mark("static:first");
    value=mark("instance:first");
    static { mark("static:block"); { mark("nested:block"); } }
    static last=mark("static:last");
    other=mark("instance:last");
    constructor(x){mark("constructor");this.stored=x;}
    get amount(){mark("get");return this.stored;}
    set amount(v){mark("set");this.stored=v+1;}
    method(x){mark("method");return this.amount+x;}
    static method(x){mark("static:method");return this.first+x;}
  }`;
  const setup = 'function mark(x){events.push(x);return events.length;}';
  await runtime(await compare([file(source)]), setup,
    '(() => {const c=new C(3);c.amount=4;return [c.value,c.other,c.amount,c.method(2),C.method(1)];})()');
  const pair = await compare([file('class C{static{foo();}}')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id,m.mutatorName]), [['0','CallExpression']]);
  await runtime(pair, 'function foo(){events.push("foo");}', 'events');
});

test('private fields preserve brands, assignment references, updates and static ownership', async () => {
  const source = `class C {
    #x=2;static #total=1;
    get value(){return this.#x;}
    set value(v){this.#x=v;}
    add(v){return this.#x+=v;}
    update(){return [this.#x++,++this.#x,this.#x--,--this.#x];}
    read(o){return o.#x;}
    write(o,v){return o.#x=v;}
    static add(v){return this.#total+=v;}
    static read(o){return o.#total;}
  }`;
  const observation = `(() => {const c=new C();const values=[c.value,c.add(3),c.update(),c.value];c.value=7;values.push(c.value,c.read(c),c.write(c,4),c.value,C.add(2));
    for(const action of [()=>c.read({}),()=>c.write({},1),()=>C.read({}),()=>C.add.call({},1)]) {
      try {values.push(action());} catch(error) {values.push([error.name,error.message]);}
    }return values;})()`;
  const baseline = await runtime(await compare([file(source)]), '', observation);
  assert.equal(baseline.value.filter(value => Array.isArray(value) && value[0] === 'TypeError').length, 4);
});

test('private object spines use assignment lifting and reject conditional update references', async () => {
  for (const source of [
    'class C{#x=2;assign(o){return o.trim().#x+=3;}read(){return this.#x;}}',
    'class C{#x=2;assign(o){return o.trim().#x=3;}read(){return this.#x;}}',
    'class C{#x=2;assign(o){return o.trim().#x;}read(){return this.#x;}}',
  ]) await runtime(await compare([file(source)]), '', '(() => {const c=new C();const o={trim(){events.push("trim");return c;}};try{return [c.assign(o),c.read()];}catch(e){return [e.name,e.message,c.read()];}})()');
  assert.ok(await fallback('class C{#x=1;f(o){return o.trim().#x++;}}'));
  await compare([file('class C{#x=1;f(o){return o.trim().#x++;}}')], { ...options, excludedMutations: ['MethodExpression'] });
});

test('constructor block suppression follows the whole-class public-field and direct-super predicate', async () => {
  for (const [field, blockExpected] of [['x=1;',false],['static x=1;',false],['#x=1;',true],['',true],['x;',true]]) {
    // Put the field after the constructor to prove whole-class detection.
    const source = `class C extends B{constructor(x){super(x+1);mark("body");}${field}}`;
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement'), blockExpected);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'CallExpression' && m.location.start.column === source.indexOf('super')), false);
    await runtime(pair, 'class B{constructor(x){events.push(["base",x]);this.base=x;}}function mark(x){events.push(x);}',
      '(() => {const c=new C(2);return [c.base,c.x,C.x,c instanceof C];})()');
  }
  // No direct super means the constructor keeps its ordinary block mutation.
  const pair = await compare([file('class C{x=1;constructor(){this.y=2+3;}}')]);
  assert.equal(pair.actual.mutants[0].mutatorName, 'BlockStatement');
  await runtime(pair, '', 'new C()');
  await compare([file('class C extends B{constructor(){const f=()=>super();f();}static x=1;}')]);
});

test('unmapped super calls preserve receiver, accessors and argument effects', async () => {
  const source = 'class C extends B{constructor(v){super(v+1);}method(x){return super.method(arg(x+1));}get amount(){return super.amount;}}';
  const setup = `class B{constructor(v){this.value=v;}method(x){events.push(["base",this.value,x]);return this.value+x;}get amount(){events.push(["getter",this.value]);return this.value;}}
    function arg(x){events.push(["arg",x]);return x;}`;
  await runtime(await compare([file(source)]), setup, '(() => {const c=new C(2);return [c.method(3),c.amount];})()');
  const failure = await fallback('class C extends B{method(){return super.trim();}}');
  assert.ok(failure, 'pinned bare-Super conditional placement throws');
});

test('new has its own Array mutation and independent callee placement', async () => {
  for (const [source, setup, observation] of [
    ['const value=new C(1+2);', 'function C(x){events.push(["new",new.target===C,x]);this.x=x;}', '[value.x,value instanceof C]'],
    ['new C();', 'function C(){events.push("construct");}', 'events'],
    ['const value=new obj.trim();', 'const obj={trim:function(){events.push("new:trim");this.x=3;}};', '[value.x,value instanceof obj.trim]'],
    ['const value=new (factory().trim())(1+2);', 'function C(x){events.push(["C",x]);this.x=x;}function factory(){events.push("factory");return {trim(){events.push("trim");return C;}};}', 'value.x'],
    ['const value=new Array();', '', '[value.length,value[0]]'],
    ['const value=new Array(1,2);', '', '[value.length,value[0],value[1]]'],
    ['const Array=function(x){this.x=x;};const value=new Array(1);', '', 'value.x'],
  ]) await runtime(await compare([file(source)]), setup, observation);
  for (const [source,replacement] of [['new Array();','new Array([])'],['new Array(2);','new Array()']]) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants.map(m => [m.mutatorName,m.replacement]), [['ArrayDeclaration',replacement]]);
  }
  const pair = await compare([file('const value=new obj.trim();')]);
  assert.deepEqual(pair.actual.mutants, []);
});

test('throw-new filtering preserves ID gaps, ignored candidates and TS skip behavior', async () => {
  for (const source of ['throw new C();','throw new Error("x");','throw new C(1+2);','throw new C<T>(1+2);',
    'throw new C((1+2) as number);','throw new RegExp(value);','throw "text";']) {
    for (const excludedMutations of [[],['CallExpression'],['StringLiteral'],['ArithmeticOperator']]) {
      const pair = await compare([file(source, 'throw.ts')], { ...options, excludedMutations });
      await runtime(pair, 'const value="x";function C(x){this.message=x;this.name="C";}', 'events', 'null', { baselineLoadThrows: true });
    }
  }
  const pair = await compare([file('throw new Error("x");')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id,m.mutatorName]), [['1','StringLiteral']]);
  const empty = await compare([file('throw new C();')]);
  assert.deepEqual(empty.actual.mutants.map(m => [m.id,m.mutatorName]), [['0','CallExpression']]);
});

test('only literal first arguments to new RegExp require Regex fallback', async () => {
  for (const source of ['new RegExp("ab");','new RegExp("ab","i");','const value=new RegExp("x");']) await fallback(source);
  for (const source of ['const value=RegExp("ab");','const value=new RegExp(pattern);','const value=new RegExp();']) {
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'Regex'), false);
    await runtime(pair, 'const pattern="ab";', 'String(value)');
  }
});

test('field keys exclude quoted strings while unproven method keys and modifiers fallback atomically', async () => {
  const pair = await compare([file('class C{"key"="value";12=true;static "other"="text";}')]);
  assert.equal(pair.actual.mutants.filter(m => m.mutatorName === 'StringLiteral').length, 2);
  await runtime(pair, '', '(() => {const c=new C();return [c.key,c[12],C.other];})()');
  assert.ok(await fallback('class C{"method"(){return true;}}'), 'quoted method retains upstream placement error');
  for (const source of [
    'class C{["method"](){return true;}}','class C{[key]=true;}',
    'class C{#method(){return true;}}','class C{get #value(){return true;}}',
    'class C{set #value(v){foo(v);}}','class C{accessor x=true;}',
    '@dec class C{x=true;}','class C{@dec x=true;}','class C{@dec method(){return true;}}',
    'class C{async method(){return true;}}','class C{*method(){return true;}}',
    'class C{method({x}=obj){return true;}}','class C{method(...[args]){return true;}}',
    'class C{method({x}){return true;}}','class C{#x=1;f(o){return o?.#x;}}','class C{#fn;f(){return this.#fn?.();}}',
    'const f=async function(){return true;};','const f=function*(){return true;};',
    'const f=function({x}=obj){return true;};','const f=function(...[args]){return true;};',
    'const f=function({x}){return true;};','const x=new C(...args);',
  ]) await fallback(source);
  for (const source of ['abstract class C{x=true;}','declare class C{x:true;}','class C{constructor(public x:number=1<<2){}}',
    'class C{declare x:true;}','class C{abstract x:true;}','class C{method():true;}']) await fallback(source, options, 'unsupported.ts');
});

test('erasable class and function metadata retains runtime syntax and TS skip generations', async () => {
  for (const source of [
    'class C<T extends true> extends B<T> implements I<T>{public readonly x?:number=1+2;protected other!:number;private flag:boolean=true;public method<U>(v?:number):number{return this.x+v;}}',
    'const C=class<T>{#x:number=1+2;get value():number{return this.#x;}set value(v:number){this.#x=v;}};',
    'const calc=function<T>(x?:number):number{return x+1;};',
    'foo(class<T>{x:number=1+2;method(x:number):number{return x+1;}});',
    'throw new C<T>(1+2);',
  ]) {
    const pair = await compare([file(source, 'metadata.ts')]);
    await runtime(pair, 'class B{}function foo(x){events.push([x.name,new x().x]);}',
      source.includes('const calc') ? '[calc.name,calc(2)]' : source.startsWith('throw') ? 'events' : source.startsWith('foo') ? 'events' : '(() => {const c=new C();return [C.name,c.x,c.value];})()',
      'null', { baselineLoadThrows: source.startsWith('throw') });
  }
});

test('class directives, empty reasons, ranges, UTF16, CRLF and cross-file IDs match fully', async () => {
  const sources = [
    'class C{\n// Stryker disable next-line all: reason\nx="x";\nmethod(){return true;}\n}',
    '// Stryker disable all:   \nclass C{x="😀";method(){return true;}}',
    'class C{static{\n// Stryker disable next-line CallExpression: reason\nfoo();\nfoo();\n}}',
    'class C{\r\nvalue="😀";\r\nmethod(){return 1+2;}\r\n}',
  ];
  for (const source of sources) for (const excludedMutations of [[],['BlockStatement'],['StringLiteral'],['CallExpression']]) {
    await runtime(await compare([file(source)], { ...options, excludedMutations }), 'function foo(){events.push("foo");}', 'new C()');
  }
  const source = 'class C{x="x";method(){return this.x;}}';
  for (let end = 0; end <= source.length; end++) {
    await runtime(await compare([file(source, 'ranges.js', [{ start: { line: 0, column: 0 }, end: { line: 0, column: end } }])]), '', 'new C().method()');
  }
  const pair = await compare([file('throw new Error("x");', 'first.js'), file('class Off{x=true;}', 'off.js', false),
    file('class C{x=true;method(){return 1+2;}}', 'last.js')]);
  assert.deepEqual(pair.actual.mutants.map(m => m.id), ['1','2','3','4']);
  await runtime(pair, '', 'new C().method()', 'null', { baselineLoadThrows: true });
  const noHeader = await compare([file('class C{x=true;}')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
});

test('implements clauses skip only actual type argument subtrees', async () => {
  for (const [clause, ids] of [['I', ['1']], ['I<T>', ['0', '1']], ['I, J', ['1']], ['I, J<T>', ['0', '1']]]) {
    const pair = await compare([file(`foo(class C implements ${clause} { x=1+2; });`, 'implements.ts')]);
    assert.deepEqual(pair.actual.mutants.map(m => m.id), ids);
    await runtime(pair, 'function foo(C){events.push(new C().x);}', 'events');
  }
});

test('pruned class bodies do not apply directives to later selected statements', async () => {
  for (const source of [
    'class C{\n// Stryker disable all: hidden\nx=true;\n}\nconst flag=true;',
    'const C=class{\n// Stryker disable all: hidden\nstatic{ const hidden=true; }\n};\nconst flag=true;',
  ]) {
    const ranges = [
      { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
      { start: { line: 4, column: 0 }, end: { line: 4, column: 16 } },
    ];
    const pair = await compare([file(source, 'pruned.js', ranges)]);
    assert.equal(pair.actual.mutants.length, 1);
    assert.equal(pair.actual.mutants[0].status, undefined);
    await runtime(pair, '', 'flag');
  }
});

test('unproven new nodes in cloned replacements reject whole batches', async () => {
  for (const source of [
    'const value=(new C())+1;','const value=(function(){return 1;})+1;',
    'const value=(class{x=true;})+1;','for(;;){const C=class{x=true;};break;}',
    'for(;;){class C{x=true;}break;}','for(;;){const f=function(){return true;};break;}',
    'for(;;){new C();break;}','for(;;){throw new C();}',
  ]) await fallback(source);
});

// Exact original class resources. These remain useful without a pinned clone;
// when available, the original bytes are asserted before differential execution.
const corpus = {
  'string-mutations.ts': "require('foo');\nimport 'foo'; // no mutation\n\nclass Foo {\n  public 'bar-baz': string; // no mutation\n}\n",
  'ts-sample.ts': "const bar: number = 40 + 2;\n\nclass Person {\n  #name = 'unknown';\n\n  get name(): string {\n    return this.#name;\n  }\n  set name(value: string) {\n    if (value.length < 2) {\n      throw new Error('Name should be at least 2 characters long');\n    }\n    this.#name = value;\n  }\n}\n\nconst foo = (string?: string) => {\n  return false;\n};\n\nfoo();\nfoo('test');\nconsole.log();\nthrow new Error();\n\nconst add = (a: number, b: number) => {\n  return a + b;\n};\n\nconst a = 1;\nconst b = 2;\nadd(a, b);\n",
  'perf/ts-sample.ts': "const bar: number = 40 + 2;\n\nclass Person {\n  #name = 'unknown';\n\n  get name(): string {\n    return this.#name;\n  }\n  set name(value: string) {\n    if (value.length < 2) {\n      throw new Error('Name should be at least 2 characters long');\n    }\n    this.#name = value;\n  }\n}\n",
};

test('real pinned corpus classes run baseline and every active mutant forced native', async () => {
  if (typeof vm.SourceTextModule !== 'function') {
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', '--test-name-pattern=real pinned corpus classes', fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /# pass 1|ℹ pass 1/, 'child must actually run the corpus test');
    return;
  }
  const root = process.env.STRYKER_UPSTREAM ?? resolve('artifacts/upstream/stryker-js');
  const observation = `(() => {const p=new Person();const values=[p.name];
    for(const value of ["a","Alice","Bob"]){try{p.name=value;values.push(p.name);}catch(e){values.push([e.name,e.message]);}}
    const descriptor=Object.getOwnPropertyDescriptor(Person.prototype,"name");
    for(const action of [()=>descriptor.get.call({}),()=>descriptor.set.call({},"Alice")]){try{values.push(action());}catch(e){values.push([e.name,e.message]);}}
    return values;})()`;
  for (const [name, content] of Object.entries(corpus)) {
    const path = join(root, 'packages/instrumenter/testResources/instrumenter', name);
    if (existsSync(path)) assert.equal(await readFile(path, 'utf8'), content, `original ${name} bytes`);
    await runtime(await compare([file(content, name)]),
      'function require(x){events.push(["require",x]);}const console={log(){events.push("log");}};',
      name === 'string-mutations.ts' ? '[new Foo()["bar-baz"],Foo.name,events]' : observation,
      'null', { baselineLoadThrows: name === 'ts-sample.ts' });
  }
});

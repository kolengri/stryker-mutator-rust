import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const file = (content, name = 'extensions.ts', mutate = true) => ({ name, content, mutate });
const completedOutputs = new Map();

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
  assert.deepEqual(actual.mutants, expected.mutants);
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

function transpile(content) {
  if (!completedOutputs.has(content)) {
    // Instrument the original TS first. Node strip mode cannot execute parameter
    // properties or enums; the installed Babel preset transforms outputs only.
    completedOutputs.set(content, transformSync(content, {
      filename: 'input.ts', configFile: false, babelrc: false,
      presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
    }).code);
  }
  return completedOutputs.get(content);
}

async function execute(result, setup, observation, state, id, settings) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
  let value, error;
  const loadErrors = [];
  const modules = [];
  const caughtError = caught => {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: caught.name, message: caught.message };
  };
  for (const { content } of result.files) {
    // Transformation and compilation failures fail the test, rather than
    // masquerading as a matching program exception.
    const source = transpile(content);
    if (/^export /m.test(source)) {
      const module = new vm.SourceTextModule(`${source}\nexport function __observe(){return (${observation});}
        export function __state(){return (${state});}`, { context });
      await module.link(() => assert.fail('These runtime fixtures have no imports'));
      modules.push(module);
      try { await module.evaluate({ timeout: 1000 }); } catch (caught) { loadErrors.push(caughtError(caught)); }
    } else {
      const script = new vm.Script(source);
      try { script.runInContext(context, { timeout: 1000 }); } catch (caught) { loadErrors.push(caughtError(caught)); }
    }
  }
  ns.currentTestId = settings.currentTestId ?? 'extensions-test';
  if (settings.afterLoad) ns.activeMutant = id;
  context.__observe = modules.length ? modules.at(-1).namespace.__observe : undefined;
  context.__state = modules.length ? modules.at(-1).namespace.__state : undefined;
  try {
    value = new vm.Script(modules.length ? '__observe()' : observation).runInContext(context, { timeout: 1000 });
  } catch (caught) { error = caughtError(caught); }
  return structuredClone({ value, error, loadErrors,
    state: new vm.Script(modules.length ? '__state()' : state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }), ns });
}

async function runtime(pair, setup = '', observation = 'events', state = 'null') {
  const baseline = await execute(pair.actual, setup, observation, state, undefined, {});
  assert.deepEqual(baseline.loadErrors, [], 'baseline must reach the runtime observer');
  assert.equal(baseline.error, undefined, 'baseline observer must execute successfully');
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

function moduleTest(name, action) {
  test(name, async () => {
    if (typeof vm.SourceTextModule === 'function') return action();
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', `--test-name-pattern=^${name}$`,
      fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /# pass 1|ℹ pass 1/, 'child must run the named runtime test');
  });
}

async function fallback(source, config = options, name = 'unsupported.ts') {
  const files = [file('const first=true;', 'first.js'), file(source, name)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, false, source);
  assert.equal(raw.result, undefined, 'no partial result from a rejected batch');
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

const constructorSetup = `class B { x=100; constructor(){events.push(["super",this.x]);} }
  function mark(label,value){events.push([label,value]);return value;}
  function record(value){events.push(["body",value]);}
  const replacement={replaced:true};`;

test('simple parameter property modifiers preserve bindings and derived initialization', async () => {
  for (const modifiers of ['public', 'private', 'protected', 'readonly', 'public readonly', 'private readonly',
    'protected readonly', 'override readonly', 'public override', 'protected override', 'private override',
    'public override readonly', 'protected override readonly', 'private override readonly']) {
    const signature = `constructor(${modifiers} x:number)`;
    const source = `class C extends B{${signature}{super();record(this.x);this.x+=2;}read(){return this.x;}}`;
    const pair = await compare([file(source)]);
    assert.ok(pair.actual.files[0].content.includes(signature), 'preserve original modifiers and annotation');
    assert.ok(!pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement' && m.location.start.column === source.indexOf('{super')));
    const baseline = await runtime(pair, constructorSetup, '[new C(3).read(),new C(7).read()]');
    const values = [3, 7];
    assert.deepEqual(baseline.value, values.map(value => value + 2));
    assert.deepEqual(baseline.events, [['super', 100], ['body', values[0]], ['super', 100], ['body', values[1]]]);
  }
  for (const signature of ['constructor(public x)', 'constructor(public x?:number)', 'constructor(public readonly x:number,y:number)']) {
    const pair = await compare([file(`class C{${signature}{record(this.x);}}`)]);
    assert.equal(pair.actual.mutants[0].mutatorName, 'BlockStatement', 'base constructor keeps deletion');
    const baseline = await runtime(pair, constructorSetup, '[new C(3,4).x,new C(7,8).x]');
    assert.deepEqual(baseline.value, [3, 7]);
  }
});

test('constructor suppression uses complete property and direct super metadata', async () => {
  for (const property of ['', 'x=mark("public",100);', '#hidden=mark("private",100);', 'static x=mark("static",100);']) {
    for (const parameter of ['x:number', 'public x:number']) {
      const source = `class C extends B{${property}constructor(${parameter}){super();record(this.x);}}`;
      const pair = await compare([file(source)]);
      const suppressed = parameter.startsWith('public') || (property && !property.startsWith('#'));
      assert.equal(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement'), !suppressed, source);
      const baseline = await runtime(pair, constructorSetup, 'new C(3).x');
      assert.equal(baseline.value, parameter.startsWith('public') ? 3 : 100);
      assert.deepEqual(baseline.events.filter(event => event[0] === 'body'), [['body', baseline.value]]);
      if (property.startsWith('x=')) assert.deepEqual(baseline.events.slice(0, 2), [['super', 100], ['public', 100]]);
    }
  }
  const base = await runtime(await compare([file('class C{x=mark("field",100);constructor(public x:number){record(this.x);}}')]),
    constructorSetup, 'new C(3).x');
  assert.deepEqual(base.events, [['field', 100], ['body', 3]], 'fields run before the parameter property assignment');
  for (const source of [
    'class C extends B{constructor(public x:number){return replacement;}}',
    'class C{constructor(public x:number){record(x);}}',
  ]) {
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants[0].mutatorName, 'BlockStatement', 'no direct super retains body deletion');
    await runtime(pair, constructorSetup, 'new C(3)');
  }
  const nested = await compare([file('class C extends B{constructor(public x:number){const run=()=>super();run();record(this.x);}}')]);
  assert.ok(!nested.actual.mutants.some(m => m.mutatorName === 'BlockStatement'));
  await runtime(nested, constructorSetup, 'new C(3).x');
});

test('parameter property annotations alone produce TS skip filter events', async () => {
  for (const [parameter, ids] of [['public x', ['1', '2']], ['public x:number', ['0', '1', '2']],
    ['readonly x', ['1', '2']], ['public override x', ['1', '2']], ['override readonly x', ['1', '2']]]) {
    const pair = await compare([file(`consume(class C{constructor(${parameter}){record(x);}});`)]);
    assert.deepEqual(pair.actual.mutants.map(m => m.id), ids);
    await runtime(pair, `${constructorSetup} function consume(C){events.push(new C(3).x);}`);
  }
  const source = 'class C extends B{constructor(public x:number){super();record(x+2);}}';
  const bodyStart = source.indexOf('{super');
  const ranges = [{ start: { line: 0, column: bodyStart }, end: { line: 0, column: source.length - 1 } }];
  const pair = await compare([file(source, 'selected-body.ts', ranges)]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id, m.mutatorName]), [['1', 'ArithmeticOperator']]);
  await runtime(pair, constructorSetup, 'new C(3).x');
});

test('opaque enums retain initializer side effects without mutants IDs or headers', async () => {
  for (const source of ['enum E{A=mark("first",1+2),B="text",C=mark("second",5)}',
    'const enum E{A=mark("first",1+2),B="text",C=mark("second",5)}']) {
    for (const mutate of [true, false, [], [{ start: { line: 0, column: 15 }, end: { line: 0, column: 38 } }]]) {
      const pair = await compare([file(source, 'enum.ts', mutate)]);
      assert.deepEqual(pair.actual.mutants, []);
      assert.equal(pair.actual.files[0].content, source);
      const baseline = await runtime(pair, constructorSetup, '[E.A,E.B,E.C,E[3],E[5]]');
      assert.deepEqual(baseline.value, [3, 'text', 5, 'A', 'C']);
      assert.deepEqual(baseline.events, [['first', 3], ['second', 5]]);
      assert.equal(baseline.ns.mutantCoverage, undefined);
    }
  }
  const pair = await compare([file('enum E{A=mark("enum",1+2)}\nconst flag=true;')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id, m.mutatorName]), [['0', 'BooleanLiteral']]);
  await runtime(pair, constructorSetup, '[E.A,flag]');
  const nested = await compare([file('consume(()=>{enum E{A=mark("enum",1+2)};return E.A+2;});')]);
  assert.deepEqual(nested.actual.mutants.map(m => [m.id, m.mutatorName]),
    [['0', 'CallExpression'], ['1', 'BlockStatement'], ['2', 'ArithmeticOperator']]);
  await runtime(nested, `${constructorSetup} function consume(fn){events.push(fn());}`);
});

moduleTest('exported enums keep opaque initializers and global IDs', async () => {
  const source = 'export enum E{A=mark("first",1+2),B="text",C=mark("second",5)}';
  const pair = await compare([file(source)]);
  assert.deepEqual(pair.actual.mutants, []);
  assert.equal(pair.actual.files[0].content, source);
  const baseline = await runtime(pair, constructorSetup, '[E.A,E.B,E.C]');
  assert.deepEqual(baseline.value, [3, 'text', 5]);
  assert.deepEqual(baseline.events, [['first', 3], ['second', 5]]);
  const mixed = await compare([file('const first=true;', 'first.ts'), file(source, 'enum.ts'),
    file('const off=true;', 'off.ts', false), file('export const last=true;', 'last.ts')]);
  assert.deepEqual(mixed.actual.mutants.map(m => m.id), ['0', '1']);
  await runtime(mixed, constructorSetup, 'last');
});

const targetSetup = `let a=0; const b=7; const store={slot:0};
  const obj={trim(){events.push("trim");return store;}};
  function key(value){events.push(["key",value]);return "slot";}
  function value(input){events.push(["value",input]);return input;}
  function consume(input){events.push(["consume",input]);return input;}`;

test('plain as targets are opaque while RHS mutations and evaluation order remain live', async () => {
  for (const source of ['(a as any)=b as any;', '(obj.trim()[key(1+2)] as any)=value(3+4);',
    'consume((obj.trim()[key(1+2)] as any)=value(3+4));']) {
    const pair = await compare([file(source)]);
    assert.ok(!pair.actual.mutants.some(m => m.mutatorName === 'MethodExpression'));
    const rhs = source.indexOf('3+4');
    assert.deepEqual(pair.actual.mutants.filter(m => m.mutatorName === 'ArithmeticOperator')
      .map(m => m.location.start.column), rhs === -1 ? [] : [rhs]);
    assert.ok(pair.actual.files[0].content.includes(source.includes('obj.trim') ? 'obj.trim()[key(1+2)] as any' : 'a as any'));
    const baseline = await runtime(pair, targetSetup, '[a,store.slot]');
    assert.deepEqual(baseline.value, source.startsWith('(a') ? [7, 0] : [0, 7]);
    if (rhs !== -1) assert.deepEqual(baseline.events.slice(0, 3), ['trim', ['key', 3], ['value', 7]]);
  }
  const noMutants = await compare([file('(obj.trim()[key(1+2)] as any)=b as any;')]);
  assert.deepEqual(noMutants.actual.mutants, []);
  assert.doesNotMatch(noMutants.actual.files[0].content, /function stryNS_/);
  await runtime(noMutants, targetSetup, 'store.slot');
});

test('opaque TS skips preserve directive reasons exclusions ranges and UTF16 records', async () => {
  const sources = [
    'consume((obj.trim()[key(1+2)] as any)=value(3+4));',
    'consume(()=>{enum E{A=value(1+2)};return 3+4;});',
    'consume(class C{constructor(public x:number){value(1+2);}});',
  ];
  const setup = `${targetSetup.replace('function consume(input){events.push(["consume",input]);return input;}', '')}
    function consume(input){if(typeof input!=="function")return input;
      if(input.toString().startsWith("class"))return new input(3);return input();}`;
  for (const source of sources) {
    for (const directive of ['', '// Stryker disable next-line all: reason\n',
      '// Stryker disable next-line all:   \n', '// Stryker disable next-line CallExpression:   \n']) {
      for (const excludedMutations of [[], ['CallExpression'], ['BlockStatement'], ['ArithmeticOperator']]) {
        await runtime(await compare([file(directive + source)], { ...options, excludedMutations }), setup);
      }
    }
  }
  for (const source of [
    '// Stryker disable all: enum reason\nenum E{A=value(1+2)}\nconst flag=true;',
    '// Stryker disable all: target reason\n(a as any)=b as any;\nconst flag=true;',
  ]) {
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants[0].status, 'Ignored');
    assert.match(pair.actual.mutants[0].statusReason, /reason/);
    await runtime(pair, targetSetup, 'flag');
  }
  const source = 'const emoji="😀";\r\nconsume((obj.trim()[key(1+2)] as any)=value(3+4));';
  for (let end = 0; end <= source.split('\r\n')[1].length; end++) {
    const pair = await compare([file(source, 'ranges.ts', [{ start: { line: 1, column: 0 }, end: { line: 1, column: end } }])]);
    await runtime(pair, targetSetup, '[emoji,store.slot]');
  }
  const noHeader = await compare([file('(a as any)=value(3+4);')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
  const header = await compare([file('const seed=true;', 'header.ts')]);
  await runtime({ actual: { files: [...header.actual.files, ...noHeader.actual.files] },
    expected: { files: [...header.expected.files, ...noHeader.expected.files], mutants: noHeader.expected.mutants } }, targetSetup, 'a');
});

test('standalone override falls back because pinned printing removes its runtime assignment', async () => {
  for (const parameter of ['override x', 'override x:number']) {
    const source = `class C extends B{constructor(${parameter}){super();record(x);}}`;
    await fallback(source);
    const files = [file(source)];
    const upstream = await new Instrumenter(logger).instrument(files, options);
    assert.doesNotMatch(upstream.files[0].content, /constructor\(override /);
    assert.match(upstream.files[0].content, /constructor\(x(?:: number)?\)/);
    // Reparse both completed sources with the same installed Babel transform.
    // The source-preserving candidate would disagree even without mutations.
    const preserved = await execute({ files }, constructorSetup, 'new C(3).x', 'null', undefined, {});
    const expected = await execute(upstream, constructorSetup, 'new C(3).x', 'null', undefined, {});
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    const actual = await auto.instrument(files, options);
    assert.deepEqual(actual, upstream);
    assert.deepEqual(await execute(actual, constructorSetup, 'new C(3).x', 'null', undefined, {}), expected);
    assert.deepEqual(preserved.loadErrors, []);
    assert.equal(preserved.error, undefined);
    assert.equal(expected.error, undefined);
    assert.equal(preserved.value, 3);
    assert.equal(expected.value, 100);
    assert.match(transpile(source), /this\.x = x;/);
    assert.doesNotMatch(transpile(upstream.files[0].content), /this\.x = x;/);
  }
});

test('runtime enum and parameter property bindings retain reserved name validation', async () => {
  for (const name of ['stryNS_9fa48', 'stryCov_9fa48', 'stryMutAct_9fa48', 'globalThis', 'Math', 'Function', 'Error', 'undefined']) {
    await fallback(`enum ${name}{A=1}\nconst flag=true;`);
    await fallback(`class C{constructor(public ${name}:number){record(${name});}}`);
  }
  for (const source of ['type Error={x:true};enum E{A=1}',
    'interface Math{x:true}class C{constructor(public x:Math){}}']) await compare([file(source)]);
});

test('unsupported parameter properties typed targets and serialized ancestors reject atomically', async () => {
  for (const source of [
    'class C{constructor(public x:number=1**2){record(x);}}',
    'class C{constructor(public ...x:number[]){}}', 'class C{constructor(public {x}:T){}}',
    'class C{constructor(@dec public x:number){}}', 'function f(public x:number){return x;}',
    'class C{method(public x:number){return x;}}', 'const f=(public x:number)=>x;',
    '(a as any)+=1;', '(a as any)+="text";', '(a as any)&&=b;',
    '(a as any)++;', '++(a as any);', 'for((a as any) of values){}', 'for((a as any) in values){}',
    'a! = b;', '(a satisfies number)=b;', '(<number>a)=b;',
    '((a as any)=1)+2;', 'obj.startsWith((a as any)=1);', '((a as any)=1)&&b;',
    'for(;;){(a as any)=1;break;}', 'for(;;){enum E{A=1}break;}',
    'const c=(class C{constructor(public x:number){}})+1;',
  ]) await fallback(source);
  for (const mutate of [true, false, []]) for (const content of ['enum E{A=}', 'class C{constructor(public x:){}}', '(a as)=b;']) {
    const files = [file(content, 'invalid.ts', mutate)];
    const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
    assert.equal(raw.supported, false);
    assert.equal(raw.result, undefined);
    await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'auto' }).instrument(files, options));
  }
});

const corpus = {
  'super-call.ts': 'export class InjectionError extends TypedInjectError {\n  constructor(\n    public readonly path: InjectionTarget[],\n    public readonly cause: Error,\n  ) {\n    super(\n      `Could not ${describeInjectAction(path[0])} ${path.map(name).join(\' -> \')}. Cause: ${cause.message}`,\n    );\n  }\n}\n\n// See https://github.com/stryker-mutator/stryker-js/issues/4744\nexport class UniqueKeyFailedError<T> extends UnprocessableEntityException {\n  constructor(public readonly fields: ReadonlyArray<keyof T & string>) {\n    const errorBody: UnprocessableEntityBody<T> = {\n      status: \'uniqueness_failed\',\n      fields,\n    };\n    super(errorBody);\n    console.log(`${this.message} created`);\n  }\n}\n',
  'type-definitions.ts': '/**\n * @see https://github.com/stryker-mutator/stryker-js/issues/2465\n */\nconst flatten = require(\'lodash/flatten\') as typeof import(\'lodash/flatten\');\n\n/**\n * @see https://github.com/babel/babel/issues/16676\n */\n(a as any) = b as any;\n',
};

moduleTest('original pinned TS extension corpus executes every active mutant forced native', async () => {
  const root = process.env.STRYKER_UPSTREAM ?? resolve('artifacts/upstream/stryker-js');
  for (const [name, content] of Object.entries(corpus)) {
    const path = join(root, 'packages/instrumenter/testResources/instrumenter', name);
    if (existsSync(path)) assert.equal(await readFile(path, 'utf8'), content, `original ${name} bytes`);
    const pair = await compare([file(content, name)]);
    if (name === 'super-call.ts') {
      assert.deepEqual(pair.actual.mutants.map(m => [m.id, m.mutatorName, m.replacement]),
        [['0', 'StringLiteral', '``'], ['1', 'StringLiteral', '""'], ['2', 'ObjectLiteral', '{}'],
          ['3', 'StringLiteral', '""'], ['5', 'StringLiteral', '``']]);
      const baseline = await runtime(pair, `class TypedInjectError extends Error{constructor(message){super(message);events.push(["inject",message]);}}
        class UnprocessableEntityException{constructor(body){this.body=body;this.message=JSON.stringify(body);events.push(["body",body]);}}
        function describeInjectAction(value){events.push(["describe",value]);return "resolve";}
        function name(value){events.push(["name",value]);return value.toUpperCase();}
        const console={log(value){events.push(["log",value]);}};`,
      `(() => {const injection=new InjectionError(["a","b"],new Error("cause"));const unique=new UniqueKeyFailedError(["key"]);
        return [injection.path,injection.cause.message,injection.message,unique.fields,unique.body];})()`);
      assert.deepEqual(baseline.value, [['a', 'b'], 'cause', 'Could not resolve A -> B. Cause: cause', ['key'],
        { status: 'uniqueness_failed', fields: ['key'] }]);
      assert.deepEqual(baseline.events.map(event => event[0]), ['describe', 'name', 'name', 'inject', 'body', 'log']);
    } else {
      assert.deepEqual(pair.actual.mutants, []);
      assert.equal(pair.actual.files[0].content, content);
      const baseline = await runtime(pair, 'let a=0;const b=7;function require(value){events.push(["require",value]);return "flatten";}', '[a,flatten]');
      assert.deepEqual(baseline.value, [7, 'flatten']);
      assert.deepEqual(baseline.events, [['require', 'lodash/flatten']]);
    }
  }
});

test('unproven optional chain shapes remain fallback', async () => {
  for (const source of ['(input?.id)!.toString();', 'delete obj?.method();']) await fallback(source);
});

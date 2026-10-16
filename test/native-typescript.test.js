import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as nodeModule from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { analyze, loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'typed.ts', mutate = true) => ({ name, content, mutate });

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

function execute(result, setup, observation, state, id, settings) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
    for (const { content } of result.files) {
      // Strip completed instrumentation only. Mutation traversal sees original TS.
      const source = nodeModule.stripTypeScriptTypes(content, { mode: 'strip' });
      new vm.Script(source).runInContext(context, { timeout: 1000 });
    }
    ns.currentTestId = settings.currentTestId ?? 'typed-test';
    if (settings.afterLoad) ns.activeMutant = id;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error,
    state: new vm.Script(state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }), ns });
}

function runtime(t, pair, setup = '', observation = 'calc()', state = 'null') {
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
    t.diagnostic('Runtime TS proof unavailable: node:module.stripTypeScriptTypes is absent');
    return;
  }
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(pair.actual, setup, observation, state, id, settings),
        execute(pair.expected, setup, observation, state, id, settings),
        `id=${id}, settings=${JSON.stringify(settings)}`);
    }
  }
}

const setup = `const a=4,b=2,x=5,y=3; let stored=0;
  function foo(...args){events.push(args.map(v=>typeof v==='function'?'callback':v));return typeof args[0]==='function'?args[0](2):args[0];}
  const obj={startsWith(v){events.push(['startsWith',v]);return true;},endsWith(v){events.push(['endsWith',v]);return false;},trim(){events.push('trim');return 'x';}};
  function fn(){events.push('fn');return obj;} function bar(v){events.push(['bar',v]);return v;}`;

test('typed simple bindings preserve annotations and never mutate literal types', async t => {
  const source = 'const text: "literal"="value"; const flag: true=false; let n:number=1+2; function calc():number{return flag?n:0;}';
  const pair = await compare([file(source)]);
  assert.match(pair.actual.files[0].content, /text: "literal"=/);
  assert.match(pair.actual.files[0].content, /flag: true=/);
  assert.deepEqual(pair.actual.mutants.filter(m=>m.mutatorName==='StringLiteral').map(m=>m.location.start.column), [22]);
  runtime(t, pair);
});

test('generic functions, optional identifier parameters and return types retain the original body span', async t => {
  for (const source of [
    'function calc<T extends "x" | true>(value?:number):number {let n:number=2;return value+n;}',
    'const calc=<T extends true>(value?:number):number=>value+2;',
    'const calc=(value?:number):number=>{const text:"x"="ok";return value+text.length;};',
    'function calc(value?:number):value is number {return value>0;}',
  ]) {
    const pair = await compare([file(source)]);
    assert.match(pair.actual.files[0].content, /value\?:number/);
    runtime(t, pair, '', '[calc(3),calc()]');
  }
});

test('complex types and ambient declarations are inert and preserve bytes', async () => {
  const source = `type Error<T extends true = false> = { readonly [K in keyof T]?: T[K] extends "x" ? true : false };
interface Function<T> { property: "text"; method(value: true): false; }
declare const Math: "x", globalThis: true;
declare function undefined<T extends true>(value?:"x"):false;
declare module "express" { export class C { method(): true; } }
declare namespace Ambient { const x: "x"; }
function overloaded(x:number):number;
`;
  const pair = await compare([file(source)]);
  assert.deepEqual(pair.actual.mutants, []);
  assert.equal(pair.actual.files[0].content, source);
});

test('exported declarations remain inert while exported runtime functions mutate', async () => {
  await compare([file('export type Alias=true; export interface Shape {x:"x";} export declare const value="x"; export declare function f():true; export function calc<T>(x:number):number{return x+1;}')]);
});

test('as and as const skip their entire subtree before own or descendant mutations', async t => {
  for (const source of [
    'const x=(a+b) as number;',
    'const x=[true,"text",a+b] as const;',
    'const x=((a+b) as number) as unknown;',
    'const hidden=(class {method(){return true;}}) as unknown;',
    'const hidden=(new Map([["x",true]])) as unknown;',
  ]) {
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.length, 0);
    assert.equal(pair.actual.files[0].content, source);
  }
  const pair = await compare([file('function calc():number{if((a>b) as boolean)return (a+b) as number;return b+1;}')]);
  runtime(t, pair, setup);
});

test('known TS subtree-filter leak keeps statement calls with mutations before or after skips', async t => {
  for (const [source, records] of [
    ['foo((a+b) as number);', [['CallExpression',';']]],
    ['foo((a+b) as number,x+y);', [['CallExpression',';'],['ArithmeticOperator','x - y']]],
    ['foo(a+b,(x+y) as number);', [['CallExpression',';'],['ArithmeticOperator','a - b']]],
    ['obj.startsWith<T>("x");', [['CallExpression',';'],['MethodExpression','obj.endsWith("x")'],['StringLiteral','""']]],
    ['Array<T>();', [['CallExpression',';'],['ArrayDeclaration','Array([])']]],
  ]) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants.map(m=>[m.mutatorName,m.replacement]),records);
    assert.deepEqual(pair.actual.mutants.map(m=>m.id),records.map((_,i)=>String(i)));
    runtime(t, pair, setup, 'events');
  }
  runtime(t, await compare([file('foo<true | "type", {x:"literal"}>((a+b) as number,x+y);')]), setup, 'events');
  runtime(t, await compare([file('foo<T>(a+b);')]), setup, 'events');
  const ordinary = await compare([file('foo(a+b,x+y);')]);
  assert.deepEqual(ordinary.actual.mutants.map(m=>m.id),['1','2']);
});

test('nested typed callbacks propagate the bounded filter leak through enclosing calls', async t => {
  for (const source of [
    'foo((v:number):number=>v+1);',
    'foo(<T>(v:T):number=>{bar(a+b);return x+y;});',
    'foo((v:number)=>{bar((a+b) as number,x+y);return v+1;});',
    'foo(()=>{const n:number=a+b;bar(x+y);return n;});',
    'foo(()=>{type T=true;bar(a+b);return x+y;});',
    'foo(()=>{bar(a+b,(x+y) as number);bar(a+b);return x+y;});',
  ]) runtime(t, await compare([file(source)]), setup, 'events');
});

test('reconstructed generic methods, Array and optional calls drop only reconstructed type arguments', async t => {
  for (const source of [
    'function calc(){return obj.startsWith<T>("x");}',
    'function calc(){return obj[startsWith]<T>("x");}',
    'function calc(){return Array<T>();}',
    'function calc(){return Array<T>(1,2);}',
    'function calc(){return fn?.<T>();}',
    'function calc(){return fn?.<T>().startsWith<U>("x");}',
    'function calc(){return fn<T>()?.startsWith<U>("x");}',
    'function calc(){return obj?.startsWith?.<T>("x");}',
    'function calc(){return fn<T>().trim<U>();}',
    'function calc(){return fn<T>().startsWith<U>("x")===true;}',
    'function calc(){return Array<T>(obj.startsWith<U>("x"));}',
    'function calc(){return fn<number,string,boolean,any,unknown,never,void,null,undefined,object,bigint,symbol,T,U>()?.trim();}',
  ]) {
    const pair = await compare([file(source)]);
    assert.match(pair.actual.files[0].content, /<[\w,]+>/);
    runtime(t, pair, setup+'const startsWith="startsWith";', 'typeof calc()');
  }
});

test('all mapped generic methods retain complete ordered replacement records', async () => {
  for (const name of ['charAt','filter','reverse','slice','sort','substr','substring','trim',
    'endsWith','startsWith','every','some','toLocaleLowerCase','toLocaleUpperCase','toLowerCase','toUpperCase','trimEnd','trimStart',
    'min','max','setDate','setTime','setFullYear','setMonth','setHours','setMinutes','setSeconds','setMilliseconds','setUTCDate',
    'setUTCFullYear','setUTCMonth','setUTCHours','setUTCMinutes','setUTCSeconds','setUTCMilliseconds']) {
    await compare([file(`const result=obj.${name}<T>("x");`)]);
  }
});

test('exclusions and explicit empty directive reasons preserve TS filter records', async t => {
  for (const directive of ['', '// Stryker disable next-line all: reason\n', '// Stryker disable next-line all:   \n', '// Stryker disable next-line CallExpression:   \n']) {
    for (const excludedMutations of [[], ['CallExpression'], ['MethodExpression'], ['ArithmeticOperator'], ['StringLiteral','CallExpression']]) {
      for (const source of ['foo(a+b,(x+y) as number);','obj.startsWith<T>("x");','foo((v:number)=>{bar(a+b);return x+y;});']) {
        runtime(t, await compare([file(directive+source)],{...options,excludedMutations}), setup, 'events');
      }
    }
  }
});

test('directives entering inert declarations retain scope for following runtime statements', async t => {
  for (const source of [
    '// Stryker disable all: reason\ntype T=true;\nconst flag:boolean=true;',
    '// Stryker disable next-line all: reason\ntype T=true;\nconst flag:boolean=true;',
    '// Stryker disable all: reason\ninterface I {x:"x";}\n// Stryker restore all\nfoo<T>(a+b);',
    '// Stryker disable all:   \ndeclare function f():true;\nfoo((a+b) as number,x+y);',
  ]) runtime(t, await compare([file(source)]), setup, 'events');
});

test('ranges around TS skips retain full locations, IDs and native runtime', async t => {
  for (const source of ['foo(a+b,(x+y) as number);','obj.startsWith<T>("x");','foo((v:number)=>v+1);']) {
    for (let end=0;end<=source.length;end++) {
      const ranges=[{start:{line:0,column:0},end:{line:0,column:end}}];
      const pair=await compare([file(source,'range.ts',ranges)]);
      runtime(t,pair,setup,'events');
    }
  }
});

test('TS extensions including d.ts accept runtime declarations without definition-mode restrictions', async t => {
  for (const extension of ['ts','mts','cts','d.ts','d.mts','d.cts']) {
    const pair = await compare([file('const x:number=1+2;',`input.${extension}`)]);
    assert.equal(pair.actual.mutants[0].replacement,'1 - 2');
    runtime(t,pair,'','x');
  }
  await compare([file('const x=1+2;','plain.d.ts')]);
  const pair=await compare([file('foo<T>();','generic.ts',false),file('const x:number=1+2;','ranges.ts',[])]);
  assert.deepEqual(pair.actual.mutants,[]);
});

test('UTF16 CRLF positions, global IDs and noHeader preserve typed source', async t => {
  const files=[file('const emoji:"😀"="😀";\r\nfoo((a+b) as number,x+y);','first.ts'),
    file('const off:boolean=true;','off.cts',false),file('foo(a+b);','gap.mts'),file('Array<T>();','last.d.ts')];
  const pair=await compare(files);
  assert.deepEqual(pair.actual.mutants.map(m=>m.id),['0','1','2','4','5','6']);
  runtime(t,pair,setup,'events');
  const noHeader=await compare([file('const x:number=1+2;')],{...options,noHeader:true});
  assert.doesNotMatch(noHeader.actual.files[0].content,/function stryNS_/);
  const header=await compare([file('const seed:boolean=true;','header.ts')]);
  runtime(t, {
    actual:{files:[...header.actual.files,...noHeader.actual.files]},
    expected:{files:[...header.expected.files,...noHeader.expected.files],mutants:noHeader.expected.mutants},
  }, '', 'x');
});

test('whole-for replacements reject typed declarations in headers and nested bodies atomically', async () => {
  for (const source of ['for(let i:number=0;;i++)break;', 'for(;;){let n:number=1+2;break;}',
    'for(;;){for(let i:number=0;i<1;i++)break;break;}', 'for(;;){const f=(x:number)=>x+1;break;}',
    'for(;;){const n=(a+b) as number;break;}']) await fallback(source);
  await compare([file('for(let i:number=0;i<2;i++) {const n:number=1+2;foo(n);}')]);
});

async function fallback(source, config=options, name='unsupported.ts') {
  const files=[file('const first=true;','first.js'),file(source,name)];
  const raw=JSON.parse(loadNative().instrumentBatch(JSON.stringify({files,options:config})));
  assert.equal(raw.supported,false,source);
  assert.equal(raw.result,undefined,source);
  await assert.rejects(createInstrumenter(logger,{cache:false,engine:'native'}).instrument(files,config),/unsupported/i);
  let expected, failure;
  try {expected=await new Instrumenter(logger).instrument(files,config);} catch(error) {failure=error;}
  const auto=createInstrumenter(logger,{cache:false,engine:'auto'});
  if (failure) await assert.rejects(auto.instrument(files,config),error=>error.name===failure.name && error.message.split(/\n\s+at /)[0]===failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await auto.instrument(files,config),expected);
  assert.equal(auto.stats.nativeBatches,0);
  assert.equal(auto.stats.fallbackBatches,1);
  return failure;
}

test('deferred TS wrappers, targets and unproven printing preserve fallback and upstream errors', async () => {
  for (const source of ['const x=(a+b) satisfies number;', 'const x=<number>(a+b);', 'const x=(a+b)! satisfies number;',
    '(foo?.trim())!;', 'obj.x! += 1;', 'const x=((a+b) as number)+1;', 'obj.startsWith<T>((a+b) as number);',
    'fn<{x:true}>()?.trim();', 'const x=fn<{x:true}>()+1;', 'const x=fn(()=>true) as unknown; class C {accessor x=1;}',
    'for(;;){enum E {A=1}break;}', 'namespace N {export const x=true satisfies boolean;}', 'class C { constructor(public x:number=1**2){} }',
    'function calc(...[args]:number[]){return true;}', 'function calc({x}:T=obj){return true;}',
    'const {x=1}:T=obj;', 'const x=new Array<T>(...items);']) await fallback(source);
  for (const source of ['const x=foo satisfies true;', 'const x=<true>foo;']) {
    const failure=await fallback(source);
    assert.ok(failure,'pinned upstream type-literal placement must throw');
  }
  await fallback('const x=<div/>;',options,'unsupported.tsx');
});

test('invalid TS is parsed even for mutate:false and empty ranges', async () => {
  for (const mutate of [true,false,[]]) for (const source of ['const x: = 1;', 'function f(x?:){}', 'type X = ;']) {
    const files=[file(source,'invalid.ts',mutate)];
    const raw=JSON.parse(loadNative().instrumentBatch(JSON.stringify({files,options})));
    assert.equal(raw.supported,false);
    assert.equal(raw.result,undefined);
    await assert.rejects(createInstrumenter(logger,{cache:false,engine:'auto'}).instrument(files,options));
  }
});

test('pinned TS corpus resources run forced native with complete records', {skip:!process.env.STRYKER_UPSTREAM}, async () => {
  for (const name of ['specific-no-mutants.ts','specific-mutants.ts','ts-declarations.ts']) {
    const path=join(process.env.STRYKER_UPSTREAM,'packages/instrumenter/testResources/instrumenter',name);
    await compare([file(await readFile(path,'utf8'),path)]);
  }
});

test('analyze retains the preview supported:false contract for TS', () => {
  assert.equal(analyze('const x:number=1+2;','preview.ts').supported,false);
});

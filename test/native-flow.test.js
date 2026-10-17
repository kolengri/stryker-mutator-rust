import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger } from './helpers.js';
import { compare, file, runtime, proofs, raw, flowOptions } from './flow-runtime-helpers.js';

// Apache-2.0 StrykerJS c931a932 resource; copyright Stryker Mutator contributors.
// Keep the exact bytes portable without requiring a local upstream checkout. See NOTICE.
const pinnedFlowDeclarations = `declare module 'react-test-renderer' {
  // eslint-disable-next-line no-inner-declarations
}
declare type ReactTestRenderer = {
  toJSON(): null | ReactTestRendererJSON,
  toTree(): null | ReactTestRendererTree,
  unmount(nextElement?: React$Element<any>): void,
  update(nextElement: React$Element<any>): void,
  getInstance(): ?ReactComponentInstance,
  root: ReactTestInstance,
};

declare type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): mixed,
};

declare function create(
  nextElement: React$Element<any>,
  options?: TestRendererOptions
): ReactTestRenderer;

declare function act(callback: () => ?Thenable): Thenable;

`;
assert.equal(createHash('sha256').update(pinnedFlowDeclarations).digest('hex'), '8670a0727e94cd798a2a2d6c4311be175b54b0c187c1811fe49958005ec914da');

test('Flow runtime witness: typed initializer retains its original arithmetic mutant', async () => {
  const pair = await compare([file('const n: number = 1 + 2;')]);
  assert.equal(pair.actual.mutants.length, 1);
  assert.equal(pair.actual.mutants[0].mutatorName, 'ArithmeticOperator');
  assert.match(pair.actual.files[0].content, /n: number/);
  runtime(pair, '', 'n');
});
test('Flow runtime witness: named function defaults and body retain all three mutants', async () => {
  const pair = await compare([file('function bump(x: number = 1 + 2): number { return x + 1; }')]);
  assert.equal(pair.actual.mutants.length, 3);
  assert.deepEqual(pair.actual.mutants.map(m => m.mutatorName), ['ArithmeticOperator', 'BlockStatement', 'ArithmeticOperator']);
  runtime(pair, '', '[bump(),bump(4)]');
});
after(() => {
  if (process.env.STRYKER_FLOW_PROOF) writeFileSync(process.env.STRYKER_FLOW_PROOF, JSON.stringify({
    engine: process.versions.bun ? 'Bun' : 'Node', compiler: '@babel/plugin-transform-flow-strip-types@8.0.1', proofs,
  }, null, 2));
});

test('Flow primitive bindings, assignments, defaults and return bodies preserve runtime effects and conversions', async () => {
  for (const source of [
    `const text: string = 'raw\\x21'; const n: number = 0x10 + 2; const yes: boolean = true;
function calc(x: number = mark('default', n)): string { return text + mark('arg', x); }`,
    `let n: number = 3; function calc(x: number = 1): number { n += x; return n++; }`,
    `const flag: boolean = true; const choose = flag || (()=>1+2); const n: number = 4;
function calc(): number { return choose ? n : 0; }`,
    `const text: string = 'ab'; const n: number = 0x10 + 2;
function calc(): boolean { return /a[bc]/mi.test(text) && n > 1; }`,
    `function calc(x: number = touch()): number { function inner(y: number): number { return y + 1; } return inner(x); }`,
  ]) {
    const pair = await compare([file(source)]);
    runtime(pair, `function mark(name,value){events.push([name,value]);return value;}
function touch(){events.push('touch');return {valueOf(){events.push('number');return 3;}};}`, '[calc(),calc()]');
  }
});

test('Flow original UTF16 locations survive astral CRLF and multibyte whitespace masking', async () => {
  const source = '// 😀 leading\r\nconst emoji: string = "😀";\r\nconst n:\u2003number = 0x10 + 2;\r\nfunction calc(x:\u00a0number = 1 + 2):\u2028number { return x + n; }';
  const pair = await compare([file(source)], undefined, [1, 4, 'auto']);
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'ArithmeticOperator' && m.location.start.line === 2));
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement' && m.location.start.line === 4));
  assert.ok(pair.actual.files[0].content.includes(':\u2003number'));
  assert.ok(pair.actual.files[0].content.includes(':\u2028number'));
  runtime(pair, '', '[emoji,calc()]');
});

test('Flow comment ownership, ignored reasons and skipped annotation selections match upstream', async () => {
  const source = `// Stryker disable ArithmeticOperator: held
const n: number = 1 + 2;
// Stryker restore ArithmeticOperator
function calc(x: number = 3 + 4): number { return x + n; }`;
  for (const excludedMutations of [[], ['ArithmeticOperator'], ['BlockStatement']]) {
    const pair = await compare([file(source)], { ...flowOptions, excludedMutations });
    runtime(pair, '', 'calc()');
  }
  const ignored = await compare([file(source)]);
  assert.equal(ignored.actual.mutants[0].status, 'Ignored');
  assert.equal(ignored.actual.mutants[0].statusReason, 'held');
  for (const mutate of [false, [], [{start:{line:1,column:7},end:{line:1,column:15}}],
    [{start:{line:3,column:26},end:{line:3,column:31}}]]) {
    const pair = await compare([file(source, 'selected.js', mutate)]);
    runtime(pair, '', 'calc()');
  }
});

test('Flow leading pragmas and exact all tuples preserve ordinary JavaScript call filtering', async () => {
  for (const prefix of ['', '// @flow\n', '/* @flow strict */\n', '// @noflow\n']) {
    for (const plugins of [['flow'], [['flow', {}]], [['flow', { all: false }]], [['flow', { all: true }]]]) {
      const pair = await compare([file(`${prefix}const n: number = 1 + 2; function calc(): number { ping(); return n; }`)], { ...flowOptions, plugins });
      runtime(pair, `function ping(){events.push('ping');}`, 'calc()');
    }
  }
});

test('Flow constant empty-block mutation intentionally removes a typed nested declaration', async () => {
  const pair = await compare([file('function calc(): number { function inner(x: number): number { return x + 1; } return inner(2); }')]);
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'BlockStatement' && m.replacement === '{}'));
  runtime(pair, '', 'calc()');
});

test('Flow ABI modes preserve mixed JS/Flow bytes and IDs with actual spawned serial recovery', async () => {
  const files = [file('const first: number = 1 + 2;', 'first.js'), file('const middle = true;', 'middle.js'),
    file('function calc(x: number = 3 + 4): number { return x + first; }', 'last.js')];
  const pair = await compare(files, flowOptions, [1, 4, 'auto']);
  const parallel = raw(files, flowOptions, 4);
  if (availableParallelism() > 1) {
    assert.ok(parallel.execution.spawnedThreads > 0, 'actual worker threads spawned');
    assert.equal(parallel.execution.serialRecoveries, 1);
    assert.equal(parallel.execution.reason, 'unproven-relocation');
  }
  runtime(pair, '', '[calc(),middle]');
  assert.equal(raw(files, flowOptions, 'auto').execution.spawnedThreads, 0);
  const clean = [file('const a=true;', 'a.js'), file('const b=false;', 'b.js')];
  assert.deepEqual(raw(clean, flowOptions, 4).result, raw(clean).result);
  for (const files of [[], [file('const n: number = 1 + 2;', 'off.js', false)]]) await compare(files, flowOptions, [1,4,'auto']);
});

async function fallback(files, config = flowOptions) {
  for (const mode of [1,4,'auto']) {
    const rejected = raw(files, config, mode);
    assert.equal(rejected.supported, false, files.map(f => f.content).join('\n'));
    assert.equal(rejected.result, undefined, 'whole batch is rejected');
  }
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
  const sut = createInstrumenter(logger, { cache: false, engine: 'auto' });
  let actual;
  if (failure) await assert.rejects(sut.instrument(files, config), error => error.name === failure.name && error.message === failure.message);
  else { actual = await sut.instrument(files, config); assert.deepEqual(actual, expected); }
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [0,1,0]);
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, config), /unsupported/i);
  if (!failure) return { actual, expected, original: { files }, proof: { runtimeComparisons: 0 } };
}

test('Flow ASI declarations fall back before a trailing annotation escapes reconstruction', async () => {
  for (const [source, observation] of [
    ['let n: number', 'n'],
    ['let n: number\nn=1;', 'n'],
    ['var n: number', 'n'],
    ['function calc(){ let n: number\nreturn n; }', 'calc()'],
    ['function calc(){ let n: number }', 'calc()'],
    ['let first: number, last: number\nlast=1+2;', '[first,last]'],
    ['let first: number, last: number // keep\nlast=1+2;', '[first,last]'],
  ]) {
    const pair = await fallback([file(source)]);
    runtime(pair, '', observation);
  }
});

test('Flow declaration endpoint guard retains safe semicolons, initializers and for-in', async () => {
  for (const [source, observation] of [
    ['let n: number;', 'n'],
    ['let n: number = 1+2', 'n'],
    ['let first: number, last = 1+2', '[first,last]'],
    ['let first, last: number;', '[first,last]'],
    ['function calc(){ let n: number; return n; }', 'calc()'],
    ['for(let n: number in obj){use(n);}', 'events'],
  ]) {
    const pair = await compare([file(source)], flowOptions, [1,4,'auto']);
    runtime(pair, 'const obj={a:1,b:2}; function use(n){events.push(n);}', observation);
  }
});

test('Flow exported ASI declarations retain exact upstream fallback', async () => {
  for (const source of ['export let n: number', 'export var n: number\nn=1;']) {
    await fallback([file(source)]);
  }
});

test('Flow conditioned typed loop preserves all records and every runtime mutant', async () => {
  const pair = await compare([file('const first: number = 1 + 2;', 'first.js'),
    file('for(let n: number = 0; n < 1; n++){ use(n); }', 'unsupported.js')], flowOptions, [1,4,'auto']);
  runtime(pair, `function use(value){events.push(value);if(events.length>8)throw new RangeError('external iteration budget');}`, 'events');
});

test('Flow casts and every unsupported grammar witness fall back atomically', async () => {
  const sources = [
    '(foo(): T);', 'const n = ("x": string) + value;', 'consume((1 + 2: number));',
    'const n: ?number = 1;', 'const n: mixed = 1;', 'const n: "x" = "x";',
    'const n = choose<T>(x);', 'function calc<T>(x: number): number { return x + 1; }',
    'function calc(x?: number): number { return 1; }', 'const {x}: T = value;',
    'const calc = (x: number): number => x + 1;', 'const calc = function(x: number): number { return x + 1; };',
    'class C { x: number = 1; }', 'declare function calc(x: number): number;', 'type T = number;',
    'enum Mode { A, B }', 'component Widget() {return null;}', 'hook useFlag(): boolean {return true;}',
    'record Point {x: number}', 'const n = match (x) {0 => 1, _ => 2};', 'const view = <div/>;',
    'function calc(x: mixed): boolean %checks { return !!x; }',
    'const n: /* hidden */ number = 1 + 2;', 'const n: // hidden\nnumber = 1 + 2;',
    'const n: = 1;', 'const n: number = ;',
    'consume(function(){ function calc(x: number): number {return x+1;} return calc(1); });',
    'throw new Error((function(){ function f(x: number): number {return x+1;} return f(1); })());',
    'for(let n: number = 0;;n++){ use(n); }',
    'const calc = flag || function(){ const n: number = 1 + 2; return n; };',
    '"use strict";\n// @flow\nconst n: number = 1 + 2;',
    'const n: number = 1 + 2;\n// @flow\nconst m: number = 3 + 4;',
  ];
  for (const source of sources) await fallback([file('const first: number = 1 + 2;', 'first.js'), file(source, 'unsupported.js')]);
  await fallback([file(pinnedFlowDeclarations)]);
});

test('Flow unsupported policies and non-JS filenames retain exact upstream error/result fallback', async () => {
  for (const plugins of [['flow','jsx'], ['flow','typescript'], [['flow',{all:'yes'}]], [['flow',{enums:true}]],
    [['flow',{all:true,other:false}]], [['flow',{all:true},'extra']], ['jsx']]) {
    await fallback([file('const n: number = 1 + 2;')], { ...flowOptions, plugins });
  }
  for (const name of ['input.ts','input.tsx','input.jsx','input.html','input.vue','input.svelte']) await fallback([file('const n: number = 1 + 2;',name)]);
});

test('Flow ambient Babel configuration bypasses native eligibility without executing a second parser', async () => {
  await mkdir(new URL('../artifacts/native-flow-annotations/', import.meta.url), { recursive: true });
  const directory = await mkdtemp(new URL('../artifacts/native-flow-annotations/babel-', import.meta.url));
  try {
    await writeFile(join(directory,'.babelrc.json'),JSON.stringify({parserOpts:{plugins:['flow']}}));
    const files = [file('const n: number = 1 + 2;', join(directory,'configured.js'))];
    const expected = await new Instrumenter(logger).instrument(files, flowOptions);
    const sut = createInstrumenter(logger,{cache:false,engine:'auto'});
    assert.deepEqual(await sut.instrument(files,flowOptions),expected);
    assert.deepEqual([sut.stats.nativeBatches,sut.stats.fallbackBatches,sut.stats.nativeErrors],[0,1,0]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

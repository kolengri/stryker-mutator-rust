import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { transformSync } from '@babel/core';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'assertions.ts', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const metadata = files => files.map(({ content, ...rest }) => rest);
const correctionProof = [];
const raw = (files, config = options, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));

async function compare(files, config = options, modes = [1]) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const serial = raw(files, config);
  assert.equal(serial.supported, true, `${files.map(f => f.content).join('\n')}: ${serial.reason}`);
  assert.deepEqual(serial.result.mutants, plain(expected.mutants), 'complete ordered ABI records');
  assert.deepEqual(metadata(serial.result.files), metadata(plain(expected.files)), 'ABI file metadata');
  let actual;
  for (const threads of modes) {
    const abi = raw(files, config, threads);
    assert.equal(abi.supported, true, abi.reason);
    assert.deepEqual(abi.result, serial.result, `complete native bytes, threads=${threads}`);
    for (const engine of ['native', 'auto']) {
      const sut = createInstrumenter(logger, { cache: false, engine,
        ...(threads === 'auto' ? {} : { instrumentationThreads: threads }) });
      actual = await sut.instrument(files, config);
      assert.deepEqual(actual.mutants, expected.mutants, `${engine} complete public records`);
      assert.deepEqual(metadata(actual.files), metadata(expected.files), `${engine} file metadata`);
      assert.deepEqual(plain(actual), abi.result, 'complete raw/public result');
      assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
    }
  }
  return { actual, expected, original: { files } };
}

const completed = new Map();
const require = createRequire(import.meta.url);
const bunTranspiler = process.versions.bun ? new Bun.Transpiler({ loader: 'ts' }) : undefined;
function executable({ name, content }) {
  if (!/\.[cm]?ts$/.test(name)) return content;
  const key = `${name}\0${content}`;
  if (!completed.has(key)) {
    // Both instrumenters receive original TS. Transform the completed outputs
    // identically within this engine. Node's strip-only API rejects angle
    // assertions and namespaces; reuse the installed Babel TS output transform.
    completed.set(key, bunTranspiler ? bunTranspiler.transformSync(content)
      : transformSync(content, {
        filename: 'input.ts', configFile: false, babelrc: false,
        presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
      }).code);
  }
  return completed.get(key);
}

async function settle(value) {
  let done = false, result, failure, rejected = false;
  Promise.resolve(value).then(v => { result = v; done = true; }, e => { failure = e; rejected = true; done = true; });
  for (let turn = 0; turn < 128 && !done; turn++) await Promise.resolve();
  assert.equal(done, true, 'async proof must settle within its deterministic microtask budget');
  if (rejected) throw failure;
  return result;
}

async function execute(result, setup, observation, state, activeMutant, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.initialTestId === undefined ? {} : { currentTestId: settings.initialTestId }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = source => new vm.Script(source).runInContext(context, { timeout: 1000 });
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'VM timeout is a proof failure');
    return { name: error.name, message: error.message };
  };
  evaluate(`const events=[];let budget=0;
    function capture(fn){try{return fn();}catch(error){return {error:{name:error.name,message:error.message}};}}
    function bounded(){if(++budget>12)throw new RangeError('external iteration budget');}
    ${setup}`);
  const loadErrors = [];
  for (const output of result.files) {
    // Transformation and compilation failures fail the proof, not a comparison
    // of two matching errors. Natural runtime errors are observed separately.
    const script = new vm.Script(executable(output));
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'assertion-wrapper-test';
  if (settings.afterLoad) ns.activeMutant = activeMutant;
  let value, error;
  try { value = await settle(evaluate(observation)); } catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, events: evaluate('events'), state: evaluate(state), ns });
}

function substitute(source, mutant) {
  // Public locations are zero-based UTF-16 positions. Slice preserves literal
  // replacement bytes, including $$ and $&, without replacement-string rules.
  const starts = [0];
  const endings = /\r\n|[\r\n\u2028\u2029]/g;
  for (const match of source.matchAll(endings)) starts.push(match.index + match[0].length);
  const offset = ({ line, column }) => starts[line] + column;
  return source.slice(0, offset(mutant.location.start)) + mutant.replacement + source.slice(offset(mutant.location.end));
}

async function runtime(pair, setup = '', observation = '[calc(),calc()]', state = 'null', direct = true) {
  const { ns: _originalNs, ...original } = await execute(pair.original, setup, observation, state);
  assert.deepEqual(original.loadErrors, [], 'original baseline must load');
  assert.equal(original.error, undefined, 'original baseline must reach the observer');
  for (const program of [pair.actual, pair.expected]) {
    const { ns: _ns, ...baseline } = await execute(program, setup, observation, state);
    assert.deepEqual(baseline, original, 'inactive output matches the original');
  }
  const settings = [{}, { afterLoad: true }, { initialTestId: 'load-test' }, { currentTestId: '' },
    { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }];
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const setting of settings) {
      assert.deepEqual(await execute(pair.actual, setup, observation, state, id, setting),
        await execute(pair.expected, setup, observation, state, id, setting), `id=${id}, settings=${JSON.stringify(setting)}`);
    }
  }
  if (direct) for (const mutant of pair.expected.mutants.filter(m => m.status !== 'Ignored')) {
    const files = pair.original.files.map(f => ({ ...f, content: f.name === mutant.fileName ? substitute(f.content, mutant) : f.content }));
    const { ns: _ns, ...actual } = await execute(pair.actual, setup, observation, state, mutant.id);
    const { ns: _directNs, ...expected } = await execute({ files }, setup, observation, state);
    assert.deepEqual(actual, expected, `exact original replacement ${mutant.id}: ${mutant.replacement}`);
  }
}

const formerSources = [
  ['const x=(a+b) satisfies number;', 'x'],
  ['const x=<number>(a+b);', 'x'],
  ['const x=(a+b)! satisfies number;', 'x'],
  ['namespace N {export const x=true satisfies boolean;}', 'N.x'],
  ['for(let i:number=0;i<2;i++)foo(i satisfies number);', 'events'],
];
const formerSetup = 'const a=4,b=2;function foo(value){bounded();events.push(value);return value;}';

test('exact former negative fixtures have complete native ABI/public and original/upstream runtime proof', async () => {
  for (const [source, observation] of formerSources) {
    const pair = await compare([file('const first=true;', 'first.js'), file(source, 'unsupported.ts')], options, [1, 4, 'auto']);
    await runtime(pair, formerSetup, observation, 'budget');
  }
});

test('exact former namespace rejection also qualifies pruned and excluded sibling batches', async () => {
  const source = formerSources[3][0];
  for (const mutate of [true, false, []]) for (const config of [options,
    { ...options, excludedMutations: ['MethodExpression', 'ArithmeticOperator', 'LogicalOperator'] }]) {
    const pair = await compare([file('const first=true;', 'first.js'), file(source, 'unsupported.ts', mutate)], config);
    await runtime(pair, '', 'N.x');
  }
});

test('cache fixture original bytes gain native traversal without changing cache contracts', async () => {
  const pair = await compare([file('export function add(a: number,b: number) { return (a + b)! satisfies number; }', '/fixture/values.ts')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id, m.mutatorName, m.replacement]), [
    ['0', 'BlockStatement', '{}'], ['1', 'ArithmeticOperator', 'a - b'],
  ]);
  // Runtime companion retains the exact function body without module export.
  await runtime(await compare([file('function add(a: number,b: number) { return (a + b)! satisfies number; }')]), '', '[add(4,2),add(-1,3)]');
});

test('wrappers traverse ordinary inner expressions across TS and declaration file parsing modes', async () => {
  const expressions = ['a+b', 'take(a+b)', 'a>b?take(a):take(b)', '[true,a+b]', '{x:true,y:a+b}',
    'obj.value', 'obj[key+1]', 'obj?.value', 'obj?.take?.(a+b)', '(a+b)!', '((a+b) as number)'];
  const setup = 'const a=4,b=2,key=0,obj={value:3,take(v){events.push([this===obj,v]);return v;}};function take(v){events.push(v);return v;}';
  for (const expression of expressions) for (const wrap of [value => `(${value}) satisfies unknown`, value => `<unknown>(${value})`]) {
    const source = `function calc(){return ${wrap(expression)};}`;
    const pair = await compare([file(source)]);
    await runtime(pair, setup);
  }
  for (const extension of ['ts', 'mts', 'cts', 'd.ts', 'd.mts', 'd.cts']) {
    const pair = await compare([file('function calc(){return <number>(a+b) satisfies number;}', `mode.${extension}`)]);
    await runtime(pair, 'const a=4,b=2;');
  }
});

test('wrapper boundaries preserve filter ID gaps and differ from opaque as and non-null spines', async () => {
  const sources = ['foo(a+b satisfies number);', 'foo(<number>(a+b));', 'foo((a+b) as number);',
    'foo((a+b)!);', 'foo((a+b) satisfies {value:true});', 'foo(<{value:true}>(a+b));',
    'foo((a+b) satisfies Box<true>);', 'foo(<Box<true>>(a+b));'];
  for (const source of sources) {
    const pair = await compare([file(source), file('const tail=true;', 'tail.ts')]);
    if (source === sources[0] || source === sources[1]) assert.deepEqual(pair.actual.mutants.map(m => m.id), ['1', '2']);
    await runtime(pair, formerSetup, 'events');
  }
  for (const source of ['const x=foo satisfies "x";', 'const x=<"x">foo;', 'const x=foo satisfies 1;',
    'const x=<1>foo;', 'const x=foo satisfies {value:true;label:"x"};', 'const x=<Box<true>>foo;']) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants, []);
    assert.equal(pair.actual.files[0].content, source, 'inert assertion retains all original bytes and no header');
    await runtime(pair, 'const foo={value:true};', 'x===foo');
  }
});

test('predicate and logical parents stop at the wrapper and literal type annotations stay inert', async () => {
  for (const condition of ['(a>b) satisfies boolean', '<boolean>(a>b)', '(a&&b) satisfies boolean', '<boolean>(a&&b)']) {
    const pair = await compare([file(`function calc(){if(${condition})return true;return false;}`)]);
    await runtime(pair, 'const a=4,b=2;');
  }
  for (const type of ['{value:true;label:"x"}', 'Box<true>', '(x:true)=>false', '{method<T extends true>(x:"x"):false}']) {
    for (const expression of [`(a+b) satisfies ${type}`, `<${type}>(a+b)`]) {
      const pair = await compare([file(`foo(${expression});`)]);
      assert.ok(pair.actual.mutants.every(m => m.mutatorName !== 'BooleanLiteral' && m.mutatorName !== 'StringLiteral'));
      await runtime(pair, formerSetup, 'events');
    }
  }
});

test('default async class and namespace contexts preserve effects identity and errors for every mutant', async () => {
  const sources = [
    'function calc(x=(take(a+b) satisfies number)){return x;}',
    'function calc(x=<number>take(a+b)){return x;}',
    'const calc=(x=(a+b) satisfies number)=>take(x);',
    'class C{value=take(a+b) satisfies number;method(){return <number>take(this.value);}}function calc(){return new C().method();}',
    'namespace N{export const value=take(a+b) satisfies number;export function calc(){return <number>take(value);}}function calc(){return N.calc();}',
    'async function calc(){return (await take(a+b)) satisfies number;}',
    'async function calc(){return <number>(await take(a+b));}',
    'function calc(){return take(obj) satisfies unknown;}',
  ];
  const setup = 'const a=4,b=2,obj={value:9};let count=0;function take(v){events.push([++count,v===obj?"identity":v]);if(count===3)throw new RangeError("third call");return v;}';
  for (const source of sources) {
    const pair = await compare([file(source)]);
    await runtime(pair, setup, '(async()=>{const rows=[];for(let i=0;i<2;i++){try{rows.push(await calc());}catch(error){rows.push({error:{name:error.name,message:error.message}});}}return rows;})()', 'count');
  }
  const pair = await compare([file('function calc(){return (factory().method() satisfies unknown);}')]);
  await runtime(pair, 'let calls=0;const object={method(){events.push(this===object);return object;}};function factory(){calls++;return object;}',
    '[calc()===object,calc()===object]', 'calls');
});

test('combined assertion and named-reference regex clones preserve complete records and runtime', async () => {
  const expressions = [
    String.raw`((/(?<capture>a)\k<capture>/dimu) satisfies RegExp).test("aa")||false`,
    String.raw`(<RegExp>/(?<capture>a)\k<capture>/umid).test("aa")||false`,
    String.raw`((/\1(a)/umig) satisfies RegExp).test("a")||false`,
    String.raw`(<RegExp>/(?<\u0061>a)\k<a>/ugmi).test("aa")||false`,
  ];
  for (const expression of expressions) {
    const pair = await compare([file(`function calc(){return ${expression};}`)], options, [1, 4, 'auto']);
    await runtime(pair);
  }
});

test('cloned wrappers preserve pinned spacing grouping and raw literal occurrence metadata', async () => {
  const cases = [
    ['(<number>a)+b', '<number> a - b'],
    ['((a+b) satisfies number)+1', '(a + b satisfies number) - 1'],
    ['((a>b) satisfies boolean)&&true', 'a > b satisfies boolean || true'],
    ['(a satisfies number)+b', '(a satisfies number) - b'],
    ['(<string>text).trim()', '<string> text'],
    ['(text satisfies string).trim()', 'text satisfies string'],
    ['(<unknown>obj)?.value', '(<unknown> obj).value'],
    ['((/(?=a).+?/mi) satisfies RegExp).test("a")||false'],
    ['(<RegExp>/(?=a).+?/mi).test("a")||false'],
    ['(<number>(0xff+1_000))+0x10'],
    [String.raw`(("\x61" satisfies string)+"$&$$")||"x"`],
    ['((<number><number>a)+b)||false'],
    ['((a===b) satisfies boolean)||false'],
    ['((a&b) satisfies number)+1'],
    ['((a<<b) satisfies number)+1'],
  ];
  const setup = 'const a=4,b=2,text=" a ",obj={value:3};';
  for (const [expression, replacement] of cases) {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    if (replacement) assert.ok(pair.actual.mutants.some(m => m.replacement === replacement), replacement);
    await runtime(pair, setup);
  }
  for (const expression of ['((await take()) satisfies number)+1', '(<number>(await take()))+1']) {
    const pair = await compare([file(`async function calc(){return ${expression};}`)]);
    await runtime(pair, 'let count=0;async function take(){events.push(++count);return 3;}',
      '(async()=>[await calc(),await calc()])()', 'count');
  }
});

test('deterministic generated wrapper combinations preserve all records and each executable mutant', async () => {
  const values = ['a+b', 'a*b', 'a>b', 'a===b', 'a&b', 'a<<b', 'take(a+b)', 'flag?a:b'];
  for (const value of values) for (const wrap of [v => `(${v}) satisfies number`, v => `<number>(${v})`]) {
    for (const outer of [v => `(${v})+1`, v => `(${v})||false`]) {
      const source = `function calc(){return ${outer(wrap(value))};}`;
      if (wrap(value).startsWith('<') && outer('x') === '(x)+1' && ['a>b', 'a===b', 'a&b', 'a<<b'].includes(value)) {
        const printed = { 'a>b': 'a > b', 'a===b': 'a === b', 'a&b': 'a & b', 'a<<b': 'a << b' }[value];
        const pair = await compareCorrected([file(source)], [
          ['1', `<number> ${printed} - 1`, `<number> (${printed}) - 1`],
        ]);
        await correctedRuntime(pair, { [`(<number>(${value}))+1`]: `(<number>(${value}))-1` },
          'const a=4,b=2,flag=true;function take(v){events.push(v);return v;}');
        continue;
      }
      const pair = await compare([file(source)]);
      try { await runtime(pair, 'const a=4,b=2,flag=true;function take(v){events.push(v);return v;}'); }
      catch (error) { error.message += `\nGenerated source: ${pair.original.files[0].content}`; throw error; }
    }
  }
});

test('selection UTF16 CRLF directives namespaces exclusions and noHeader retain exact records', async () => {
  const source = 'const astral="😀";\r\nconst selected=(1+2) satisfies number;\r\nconst outside=<boolean>true;';
  const files = [file('foo(true);', 'before.js'), file(source, 'selected.mts', [
    { start: { line: 1, column: 0 }, end: { line: 1, column: 80 } },
  ]), file('const pruned=<number>(1+2);', 'off.cts', false),
  file('// Stryker disable next-line ArithmeticOperator: retain arithmetic\nconst x=(1+2) satisfies number;\n// Stryker disable BooleanLiteral: retained flag\nnamespace N{export const value=<boolean>true;}\n// Stryker restore BooleanLiteral\nconst later=<boolean>false;', 'directives.ts')];
  for (const config of [options, { ...options, noHeader: true }, { ...options, excludedMutations: ['ArithmeticOperator', 'BooleanLiteral'] }]) {
    await compare(files, config, [1, 4, 'auto']);
  }
  for (const content of ['const x=(1+2) satisfies number;', 'const x=<number>(1+2);',
    '// Stryker disable all: intentionally inert\nconst x=(1+2) satisfies number;']) {
    const pair = await compare([file(content)], { ...options, excludedMutations: ['ArithmeticOperator'] });
    assert.ok(pair.actual.mutants.length > 0 && pair.actual.mutants.every(m => m.status === 'Ignored'));
    assert.equal(pair.actual.files[0].content, content);
    await runtime(pair, '', 'x');
  }
  const header = (await new Instrumenter(logger).instrument([file('true;', 'header.js')], options)).files[0].content;
  const pair = await compare([file('function calc(){return <number>(1+2) satisfies number;}')], { ...options, noHeader: true });
  await runtime(pair, header.slice(0, header.lastIndexOf('\n')));
});

test('mixed batches actually spawn and recover parallel relocation before a small next batch', async t => {
  const source = Array.from({ length: 64 }, (_, index) => `function f${index}(a,b){return (a+b) satisfies number;}`).join('\n');
  const files = [file(source, 'large.ts'), file(source, 'large.mts'),
    file('type Hidden=typeof stryMutAct_9fa48;const tail=<boolean>true;', 'hidden.cts')];
  await compare(files, options, [1, 4, 'auto']);
  const recovered = raw(files, options, 4);
  assert.ok(recovered.execution.spawnedThreads > 0, 'actual spawned parallel work');
  assert.equal(recovered.execution.serialRecoveries, 1);
  assert.equal(recovered.execution.reason, 'unproven-relocation');
  assert.deepEqual(recovered.result, raw(files).result);
  await compare([file('const next=<number>(1+2);')], options, [1, 4, 'auto']);
  t.diagnostic(JSON.stringify(recovered.execution));
});

async function fallback(source, config = options, mutate = true, name = 'unsupported.ts') {
  const files = [file('const first=true;', 'first.js'), file(source, name, mutate)];
  const serial = raw(files, config);
  assert.equal(serial.supported, false, source);
  assert.equal(serial.result, undefined, 'no partial records or output');
  assert.deepEqual(raw(files, config, 4), serial, 'atomic parallel fallback');
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, config), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
  const sut = createInstrumenter(logger, { cache: false, engine: 'auto' });
  if (failure) await assert.rejects(sut.instrument(files, config), error => error.name === failure.name
    && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await sut.instrument(files, config), expected);
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [0, 1, 0]);
  return { failure, reason: serial.reason };
}

test('reachable literal types and wrapped assignment update iteration targets preserve upstream errors', async () => {
  for (const source of ['const x=foo satisfies true;', 'const x=<true>foo;', 'const x=foo satisfies true|false;',
    'const x=foo satisfies -1;', 'const x=foo satisfies `x`;', 'const x=foo satisfies [true];',
    '(a satisfies number)=b;', '(<number>a)=b;', '(a satisfies number)+=1;', '(<number>a)++;',
    'for((a satisfies number) of values){}', 'for((<number>a) in values){}']) {
    const { failure } = await fallback(source);
    if (/const x=foo satisfies (?:true|-1|`x`|\[true\])|const x=<true>/.test(source)) assert.ok(failure, source);
  }
});

// Explicit correctness exception accepted by the parent: only listed replacement
// strings differ. The ordinary complete upstream comparison above stays intact.
async function compareCorrected(files, differences, config = options) {
  const upstream = await new Instrumenter(logger).instrument(files, config);
  const expected = upstream.mutants.map(mutant => {
    const correction = differences.find(([id]) => mutant.id === id);
    if (!correction) return mutant;
    assert.equal(mutant.replacement, correction[1], 'exact pinned defective replacement');
    return { ...mutant, replacement: correction[2] };
  });
  assert.equal(differences.length, expected.filter((m, i) => m.replacement !== upstream.mutants[i].replacement).length);
  const serial = raw(files, config);
  assert.equal(serial.supported, true, serial.reason);
  assert.deepEqual(serial.result.mutants, plain(expected), 'every field, with only the exact declared correction');
  assert.deepEqual(metadata(serial.result.files), metadata(plain(upstream.files)));
  let actual;
  for (const threads of [1, 4, 'auto']) {
    const abi = raw(files, config, threads);
    assert.deepEqual(abi.result, serial.result, 'corrected complete bytes across execution modes');
    for (const engine of ['native', 'auto']) {
      const sut = createInstrumenter(logger, { cache: false, engine,
        ...(threads === 'auto' ? {} : { instrumentationThreads: threads }) });
      actual = await sut.instrument(files, config);
      assert.deepEqual(actual.mutants, expected);
      assert.deepEqual(metadata(actual.files), metadata(upstream.files));
      assert.deepEqual(plain(actual), serial.result);
      assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
    }
  }
  const pair = { actual, expected: upstream, original: { files } };
  correctionProof.push({ files, options: config, differences, upstream, native: serial });
  return pair;
}

function originalSpan(source, mutant) {
  // Use the same tested UTF-16 span substitution, with an empty replacement,
  // to locate a single-line fixture's original bytes independently of printing.
  assert.equal(mutant.location.start.line, 0);
  assert.equal(mutant.location.end.line, 0);
  return source.slice(mutant.location.start.column, mutant.location.end.column);
}

async function correctedRuntime(pair, oracle, setup, state = 'null', observation = '[capture(()=>calc()),capture(()=>calc())]') {
  const { ns: _originalNs, ...original } = await execute(pair.original, setup, observation, state);
  const { ns: _nativeNs, ...inactive } = await execute(pair.actual, setup, observation, state);
  assert.deepEqual(inactive, original, 'corrected inactive output preserves original semantics');
  const source = pair.original.files[0].content;
  const runtimeProof = [];
  for (const mutant of [undefined, ...pair.actual.mutants.filter(m => m.status !== 'Ignored')]) {
    let directSource = source;
    if (mutant) {
      const span = originalSpan(source, mutant);
      let replacement = oracle[span];
      if (replacement === undefined && mutant.mutatorName === 'BlockStatement') replacement = '{}';
      if (replacement === undefined) {
        const independent = {
          'ConditionalExpression:true': 'true', 'ConditionalExpression:false': 'false',
          'LogicalOperator:a || b': 'a||b', 'ArithmeticOperator:a - b': 'a-b',
          'ArithmeticOperator:b - c': 'b-c',
          'EqualityOperator:a >= b': 'a>=b', 'EqualityOperator:a <= b': 'a<=b',
          'EqualityOperator:a !== b': 'a!==b',
        };
        replacement = independent[`${mutant.mutatorName}:${mutant.replacement}`];
      }
      assert.notEqual(replacement, undefined, `independent original-source oracle missing for ${mutant.mutatorName} at ${span}`);
      directSource = substitute(source, { ...mutant, replacement });
    }
    for (const settings of [{}, { afterLoad: true }, { initialTestId: 'load-test' }, { currentTestId: '' },
      { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = await execute(pair.actual, setup, observation, state, mutant?.id, settings);
      // These fixtures have one activation of each selected mutant per calc
      // call. An independent observer enforces the explicit hit-limit contract,
      // outside the original-source mutation and its side effects.
      const limited = mutant && settings.hitLimit !== undefined;
      const oracleSetup = `${setup}\nfunction oracleInvoke(fn){const ns=__stryker__;if(++ns.hitCount>ns.hitLimit)throw new Error('Stryker: Hit count limit reached ('+ns.hitCount+')');return fn();}`;
      const oracleObservation = limited ? observation.replaceAll('calc()', 'oracleInvoke(()=>calc())') : observation;
      const direct = await execute({ files: [file(directSource)] }, oracleSetup, oracleObservation, state, mutant?.id, settings);
      const { ns: actualNs, ...actualProgram } = actual;
      const { ns: directNs, ...directProgram } = direct;
      assert.deepEqual(actualProgram, directProgram, `intended source mutant=${mutant?.id}, ${JSON.stringify(settings)}`);
      if (limited) assert.equal(actualNs.hitCount, directNs.hitCount);
      // Grouping changes program results, not these helper activation sites.
      // Preserve complete coverage/test-ID/hit-limit state against the pinned
      // protocol, while program effects use the independent original oracle.
      const reference = await execute(pair.expected, setup, observation, state, mutant?.id, settings);
      assert.deepEqual(actualNs, reference.ns, 'complete namespace and coverage protocol');
      runtimeProof.push({ id: mutant?.id, settings, directSource, actual, direct, upstream: reference });
    }
  }
  correctionProof.at(-1).runtime = [...(correctionProof.at(-1).runtime ?? []), { setup, observation, state, original, runtimeProof }];
  return original;
}

test('bounded angle grouping correction preserves original behavior and honest intended-mutant metadata', async () => {
  const scenarios = [
    ['(<number>(a&b))+1', '<number> a & b - 1', '<number> (a & b) - 1', '(<number>(a&b))-1', 'const a=4,b=2;'],
    ['(<number>(a+b))*2', '<number> a + b / 2', '<number> (a + b) / 2', '(<number>(a+b))/2', 'const a=4,b=2;'],
    ['(<number>(a&&b))+1', '<number> a && b - 1', '<number> (a && b) - 1', '(<number>(a&&b))-1', 'const a=0,b=2;'],
    ['a-(<number>(b+c))', 'a + <number> b + c', 'a + <number> (b + c)', 'a+(<number>(b+c))', 'const a="x",b=2,c=3;'],
    ['(<number>(left()&right()))+tail()', '<number> left() & right() - tail()', '<number> (left() & right()) - tail()', '(<number>(left()&right()))-tail()',
      `let calls=0,conversions=0;const shared={valueOf(){events.push('a-value');if(++conversions===2)throw new RangeError('second conversion');return 4;}};
       const left=(()=>{let captured=0;return()=>{calls++;events.push(['left',++captured,shared===shared]);return shared;};})();
       function right(){calls++;events.push('right');return {valueOf(){events.push('b-value');return 2;}};}
       function tail(){calls++;events.push('tail');return 1;}`],
  ];
  for (const [expression, bad, corrected, mutation, setup] of scenarios) {
    const pair = await compareCorrected([file(`function calc(){return ${expression};}`)], [['1', bad, corrected]]);
    const baseline = await correctedRuntime(pair, { [expression]: mutation }, setup, expression.includes('left()') ? '[calls,conversions]' : 'null');
    if (expression === '(<number>(a&b))+1') {
      assert.deepEqual(baseline.value, [1, 1]);
      assert.deepEqual((await execute(pair.expected, setup, '[calc(),calc()]', 'null')).value, [0, 0], 'pinned defect remains visible');
    }
  }
  const source = 'function calc(){return (<number>(a&b))+1;}';
  for (const config of [options, { ...options, excludedMutations: ['ArithmeticOperator'] },
    { ...options, excludedMutations: ['BlockStatement', 'ArithmeticOperator'] }, { ...options, noHeader: true }]) {
    for (const mutate of [true, false, []]) {
      const pair = await compareCorrected([file(source, 'assertions.ts', mutate)],
        mutate === true ? [['1', '<number> a & b - 1', '<number> (a & b) - 1']] : [], config);
      if (mutate !== true || config.excludedMutations.length === 2) assert.equal(pair.actual.files[0].content, source);
    }
  }
  if (process.env.STRYKER_WRAPPER_CORRECTION_PROOF) writeFileSync(process.env.STRYKER_WRAPPER_CORRECTION_PROOF,
    JSON.stringify({ engine: process.versions.bun ? 'Bun' : 'Node', contract: 'explicit parent-approved bounded correctness exception', cases: correctionProof }, null, 2) + '\n');
});

test('awaited angle operands preserve intended Boolean mutant grouping and asynchronous coverage', async () => {
  const expression = '!(await (<number>(a&b)))';
  const pair = await compareCorrected([file(`async function calc(){return ${expression};}`)],
    [['1', 'await <number> a & b', 'await <number> (a & b)']]);
  const setup = 'const a=Promise.resolve(6),b=2;';
  const observation = 'Promise.all([Promise.resolve().then(()=>calc()),Promise.resolve().then(()=>calc())])';
  const original = await correctedRuntime(pair, { [expression]: 'await (<number>(a&b))' }, setup, 'null', observation);
  assert.deepEqual(original.value, [true, true]);
  assert.deepEqual((await execute(pair.actual, setup, observation, 'null', '1')).value, [0, 0]);
  assert.deepEqual((await execute(pair.expected, setup, observation, 'null', '1')).value, [2, 2], 'pinned await grouping defect remains visible');
});

test('unsupported siblings stay atomic when ignored excluded or unselected and TSX stays ambiguous', async () => {
  for (const source of [
    'const x=foo satisfies true;', 'const x=<true>foo;', 'const x=foo satisfies import("module");',
    'const x=foo satisfies {"key":number};', 'const x=(<number>a)**2;',
    'const x=((a satisfies number) satisfies number)+1;', 'const x=(<Box<number>>a)+1;',
    'const x=(<number><number>(a&b))+1;', 'const x=((<number>(a&&b))??c)+1;',
    '// Stryker disable all: unsupported boundary\nconst x=foo satisfies true;',
    'const x=({value:true} satisfies unknown)+1;',
  ]) for (const mutate of [true, false, []]) for (const config of [options,
    { ...options, excludedMutations: ['BooleanLiteral', 'ArithmeticOperator', 'UnaryOperator'] }]) await fallback(source, config, mutate);
  for (const mutate of [true, false, []]) {
    const { failure } = await fallback('const x=<number>(a+b);', options, mutate, 'ambiguous.tsx');
    assert.ok(failure, 'TSX angle brackets must retain the original parser policy');
  }
});

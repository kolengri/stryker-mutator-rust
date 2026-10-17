import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutate } from 'weapon-regex';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'regex-extensions.js', selection = true) => ({ name, content, mutate: selection });
const plain = value => JSON.parse(JSON.stringify(value));
const metadata = files => files.map(({ content, ...rest }) => rest);
const raw = (files, config = options, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const abi = raw(files, config);
  assert.equal(abi.supported, true, abi.reason);
  assert.deepEqual(abi.result.mutants, plain(expected.mutants), 'complete ordered ABI records');
  assert.deepEqual(metadata(abi.result.files), metadata(plain(expected.files)), 'ABI file metadata');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'complete ordered public records');
  assert.deepEqual(metadata(actual.files), metadata(expected.files), 'public file metadata');
  assert.deepEqual(plain(actual), abi.result, 'public and ABI complete result');
  return { actual, expected, original: { files } };
}

function execute(result, observation, activeMutant, { afterLoad = false, hitLimit, setup = '' } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const logs = [];
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, console: {
    log: (...args) => logs.push(['log', ...args]), error: (...args) => logs.push(['error', ...args]),
  } });
  let value, error;
  try {
    new vm.Script(setup).runInContext(context, { timeout: 1000 });
    for (const { content } of result.files) new vm.Script(content).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'regex-extension-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, logs, ns });
}

function runtime(pair, observation, environment = {}) {
  const { ns: _originalNs, ...original } = execute(pair.original, observation, undefined, environment);
  for (const program of [pair.actual, pair.expected]) {
    const { ns: _ns, ...baseline } = execute(program, observation, undefined, environment);
    assert.deepEqual(baseline, original, 'inactive instrumentation matches original program');
  }
  for (const active of [undefined, ...pair.expected.mutants.map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(pair.actual, observation, active, { ...environment, ...settings }),
        execute(pair.expected, observation, active, { ...environment, ...settings }),
        `mutant ${active}, ${JSON.stringify(settings)}`);
    }
  }
}

const samples = ['', 'a', 'A', 'ab', 'aA', 'aaa', 'b', 'Z09_', '12', '  ', '\t', '\n', 'a\nb', '\na\n',
  '+12', '-12', '12\n', 'é', 'É', 'ſ', 'K', '٩', '😀', 'a/b', 'a\\b'];
const observe = `JSON.stringify(${JSON.stringify(samples)}.map(t => calc(t)))`;

// Every old negative admitted by this extension retains complete ABI/API and
// every-mutant runtime proof before its old rejection assertion is removed.
const formerUnsupportedLiterals = [
  '/[a-z]/', '/[^ab]/', String.raw`/[\d]/`, '/a*/', '/a{2}/', String.raw`/\w/`,
  String.raw`/^[+-]?\d+$/g`, String.raw`/^[+-]?\d+$/i`, '/a/ig', '/a/mi', '/a/d', '/a/m', '/a/s', '/a/y',
];

test('every newly admitted old negative preserves full records, metadata and runtime', async () => {
  for (const literal of formerUnsupportedLiterals) {
    const pair = await compare([file(`function calc(t) { return ${literal}.test(t); }`)]);
    runtime(pair, observe);
    const only = await compare([file(`const pattern=${literal};`)]);
    assert.deepEqual(only.actual.mutants.map(m => m.replacement),
      mutate(literal.slice(1, literal.lastIndexOf('/')), literal.slice(literal.lastIndexOf('/') + 1),
        { mutationLevels: [1] }).map(m => `/${m.pattern}/${literal.slice(literal.lastIndexOf('/') + 1)}`));
  }
  const pair = await compare([file('a = /[a-z]/;')]);
  runtime(pair, 'JSON.stringify([a.test("abc"),a.test("ABC"),a.source,a.flags])', { setup: 'let a;' });
});

test('exact former loop and default-parameter negatives retain complete native and runtime proofs', async () => {
  const loop = await compare([file('while(tick(true)) /[a-z]/.test(value);')]);
  runtime(loop, 'JSON.stringify({ ticks, observations })', { setup: `
    let ticks=0;
    const value='abc', observations=[];
    function tick(enabled){return ++ticks<=4 && enabled;}
    const test=RegExp.prototype.test;
    RegExp.prototype.test=function(value){
      const result=test.call(this,value);
      observations.push([this.source,this.flags,result,this.lastIndex]);
      return result;
    };
  ` });
  const parameter = await compare([file('function f(a=/[a-z]/){}')]);
  runtime(parameter, 'JSON.stringify([f(),f(undefined),f(/q/),f.length])');
  const observable = await compare([file('function calc(a=/[a-z]/){return a;}')]);
  runtime(observable, 'JSON.stringify([calc().test("abc"),calc().test("ABC"),calc(undefined).source,calc(/q/).source])');
});

const flagOrders = [''];
function flagPermutations(prefix, rest) {
  for (const flag of rest) {
    const next = prefix + flag;
    flagOrders.push(next);
    flagPermutations(next, rest.replace(flag, ''));
  }
}
flagPermutations('', 'gimsdy');
const atoms = ['[a-z]', '[^ab]', '[a-zA-Z0-9_]', String.raw`[\d\D\w\W\s\S]`,
  String.raw`[^a-z\d\W]`, String.raw`[\d\d]`, '[ -~]', '[/+]', '[[]', String.raw`[\/\\+]`,
  String.raw`[a-z\D-\W]`, String.raw`\w`, String.raw`\W`, String.raw`\s`, String.raw`\S`, 'a'];
const patternSet = new Set(['^', '$', '$$', '^^a$$', 'abc', String.raw`^[+-]?\d+$`]);
for (const atom of atoms) for (const quantifier of ['', '?', '+', '*', '{0}', '{2}', '{2,}', '{0,0}', '{1,3}']) {
  for (const [start, end] of [['', ''], ['^', '$']]) patternSet.add(`${start}${atom}${quantifier}${end}`);
}
const patternInputs = [...patternSet];

test('pinned level-one oracle agrees for extended AST forms and all 1957 non-Unicode flag orders', async t => {
  const cases = [
    ...patternInputs.map((pattern, i) => ({ pattern, flags: flagOrders[i % flagOrders.length] })),
    ...flagOrders.map(flags => ({ pattern: String.raw`^[^a-z\d\W]{1,3}\s*$`, flags })),
    ...flagOrders.map(flags => ({ pattern: 'abc', flags })),
    { pattern: 'a{2147483647}', flags: 'mi' },
  ];
  const files = cases.map(({ pattern, flags }, i) => file(`const pattern=/${pattern}/${flags};`, `regex-${i}.js`));
  const diagnostics = [], saved = console.error;
  let pair;
  try {
    console.error = (...args) => diagnostics.push(args.map(String));
    pair = await compare(files);
    const byFile = Map.groupBy(pair.actual.mutants, m => m.fileName);
    for (const [i, { pattern, flags }] of cases.entries()) {
      assert.deepEqual((byFile.get(files[i].name) ?? []).map(m => m.replacement),
        mutate(pattern, flags, { mutationLevels: [1] }).map(m => `/${m.pattern}/${flags}`), `${pattern}/${flags}`);
    }
  } finally { console.error = saved; }
  assert.deepEqual(diagnostics, [], 'qualified patterns and flags cause no diagnostic side effects');
  assert.equal(flagOrders.length, 1957);
  assert.deepEqual(pair.actual.mutants.map(m => m.id), pair.actual.mutants.map((_, i) => String(i)));
  t.diagnostic(`${patternInputs.length} AST patterns, ${flagOrders.length} flag orders, ${cases.length} full-record files, ${pair.actual.mutants.length} ordered mutants`);
});

const runtimeCases = [
  ['predefined classes and negated ranges', String.raw`function calc(t) { return /^[^a-z\d\W]{1,3}\s*$/mi.test(t); }`],
  ['greedy star and counted forms', String.raw`function calc(t) { return /^\w*\S{2}\s{0,}\D{1,3}$/is.test(t); }`],
  ['duplicate class children and anchors', String.raw`function calc(t) { return /^^[\d\d]{0,0}$$/m.test(t); }`],
  ['escaped slashes and backslashes', String.raw`function calc(t) { return /^a\/\\[^a-z\s]*$/ig.test(t); }`],
  ['logical and method replacement clones', String.raw`function calc(t) { return !/[^a-z\w]{1,2}/mi.test(t.trim()); }`],
  ['template and call replacement clones', 'function calc(t) { return !`value:${/[^a-z\\w]*/ig.test(t)}`; }'],
  ['parameter initialization', String.raw`function calc(t, pattern=/[^a-z\w]{1,3}/yd) { return pattern.exec(t); }`],
  ['computed key placement', String.raw`const obj={true:1,false:2}; function calc(t) { return obj[/[^a-z\w]*/mi.test(t)]; }`],
  ['class field placement', String.raw`class C { pattern=/[^a-z\w]{1,3}/g; test(t){return this.pattern.test(t);} } function calc(t){return new C().test(t);}`],
];
for (const [name, content] of runtimeCases) test(`extended regex runtime: ${name}`, async () => {
  runtime(await compare([file(content)]), observe);
});

const stateObservation = `JSON.stringify((() => {
  const records=[];
  const inputs=${JSON.stringify(samples)};
  for (const input of inputs) {
    for (const operation of ['test','exec','match','search','replace']) {
      pattern.lastIndex=1;
      const before=pattern.lastIndex;
      let value;
      if(operation==='test') value=pattern.test(input);
      if(operation==='exec') { const m=pattern.exec(input); value=m && {items:[...m],index:m.index,input:m.input,groups:m.groups,indices:m.indices}; }
      if(operation==='match') value=input.match(pattern);
      if(operation==='search') value=input.search(pattern);
      if(operation==='replace') value=input.replace(pattern,'#');
      records.push([operation,input,before,pattern.lastIndex,value,pattern===saved]);
    }
  }
  console.log('state',pattern.lastIndex,pattern.flags);
  return [records,pattern.source,pattern.flags,pattern.hasIndices,pattern.global,pattern.sticky,pattern.ignoreCase,pattern.multiline,pattern.dotAll];
})())`;
for (const flags of ['g', 'y', 'd', 'dg', 'dy', 'ygd', 'ig', 'mi', 'sim', 'ygsdmi']) {
  test(`stateful identity, lastIndex, indices and string operations: ${flags}`, async () => {
    const pair = await compare([file(`const pattern=/[a-z\\s]{1,3}/${flags}; const saved=pattern;`)]);
    runtime(pair, stateObservation);
  });
}

test('activation after initialization keeps stored identity and repeated literals initialize independently', async () => {
  const pair = await compare([file(String.raw`let previous; const pattern=/\w*/g; const saved=pattern;
function calc(t) { const fresh=/[^a-z\d]{1,3}/yd; const same=previous===fresh; previous=fresh; const before=pattern.lastIndex; const hit=pattern.exec(t); return [same,before,pattern.lastIndex,hit,fresh.exec(t),fresh.lastIndex,pattern===saved]; }`)]);
  runtime(pair, observe);
});

test('excluded, disabled, restored and all-ignored regex retain IDs and runtime placement', async () => {
  const files = [file(String.raw`// Stryker disable next-line Regex: class boundary
const initial=/[^a-z\w]{1,3}/mi;
function calc(t) { return initial.test(t) && /\s*/g.test(t); }`)];
  for (const config of [options, { ...options, excludedMutations: ['Regex'] },
    { ...options, excludedMutations: ['Regex','BlockStatement','LogicalOperator','ConditionalExpression'] }]) {
    const pair = await compare(files, config);
    assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'Regex' && m.status === 'Ignored'));
    runtime(pair, observe);
    if (config.excludedMutations.length === 4) assert.equal(pair.actual.files[0].content, files[0].content);
  }
  const restored = await compare([file(String.raw`// Stryker disable Regex: initial
const first=/[a-z\s]*/g;
// Stryker restore Regex
const last=/\W{1,3}/y;
function calc(t) { return first.test(t) && last.test(t); }`)]);
  assert.ok(restored.actual.mutants.some(m => m.mutatorName === 'Regex' && !m.status));
  runtime(restored, observe);
});

test('UTF16/CRLF ranges, TS/JS global IDs, noHeader, zero mutants and parallel modes remain exact', async () => {
  const files = [file('consume(true);', 'filtered.js'),
    file("const astral='😀';\r\nconst pattern=/^[^a-z\\w]{2,3}$/mi;", 'ranges.ts', [
      { start: { line: 1, column: 0 }, end: { line: 1, column: 46 } },
    ]), file('const off=/[a-z\\s]*/g;', 'off.js', false),
    file('const last=/[\\d\\d]{1,3}/yd;', 'last.ts')];
  for (const config of [options, { ...options, noHeader: true }, { ...options, excludedMutations: ['Regex'] }]) {
    const { expected } = await compare(files, config);
    const serial = raw(files, config);
    for (const threads of [4, 'auto']) assert.deepEqual(raw(files, config, threads).result, serial.result);
    assert.deepEqual(serial.result.mutants, plain(expected.mutants));
    assert.ok(Number(serial.result.mutants[0].id) > 0, 'filtered candidates consume IDs');
    assert.equal(serial.result.files[2].content, files[2].content);
  }
  for (const source of ['const a=/abc/mi;', 'const a=/^/g;', '', 'const a=/abc/yd;']) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants, []);
    assert.equal(pair.actual.files[0].content, source);
  }
  const headerResult = await new Instrumenter(logger).instrument([file('true;')], options);
  const printed = headerResult.files[0].content;
  const setup = printed.slice(0, printed.lastIndexOf('\n'));
  const pair = await compare([file(String.raw`function calc(t){return /^[^a-z\w]{1,3}$/mi.test(t);}`)], { ...options, noHeader: true });
  assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_/);
  runtime(pair, observe, { setup });
});

test('large mixed files retain serial/four/auto IDs and complete records without changing ordinary mutators', async () => {
  const files = [file('consume(true);', 'before.js'),
    file(Array.from({ length: 80 }, (_, i) => `const value${i}=/[^a-z\\w]{1,3}/mi.test('A') && (1+2 > 0);`).join('\n'), 'large.ts'),
    file('const last=/[\\s\\S]{0,}/ygd;', 'last.js')];
  const { actual } = await compare(files);
  const serial = raw(files);
  for (const threads of [4, 'auto']) assert.deepEqual(raw(files, options, threads).result, serial.result);
  assert.equal(new Set(actual.mutants.map(m => m.id)).size, actual.mutants.length);
  assert.ok(actual.mutants.some(m => m.mutatorName === 'ArithmeticOperator'));
  assert.ok(actual.mutants.some(m => m.mutatorName === 'Regex'));
});

test('extended regex files retain exact results after parallel relocation recovery', async () => {
  const files=[file('const before=/[^a-z\\w]{1,3}/mi;', 'before.ts'),
    file('type T=typeof stryMutAct_9fa48; const live=true;', 'opaque.ts'),
    file('const after=/[\\s\\S]{0,}/ygd;', 'after.ts')];
  await compare(files);
  const serial=raw(files), recovered=raw(files,options,4);
  assert.deepEqual(recovered.result,serial.result);
  if (recovered.execution.spawnedThreads) {
    assert.equal(recovered.execution.serialRecoveries,1);
    assert.equal(recovered.execution.reason,'unproven-relocation');
  }
  const next=[file('const next=/[^a-z\\w]{2,}/ig;')];
  for(const threads of [1,4,'auto']) assert.deepEqual(raw(next,options,threads).result,raw(next).result);
});

test('unproved forms still fall back atomically when ignored, with post-failure native recovery', async () => {
  const unsupported = ['/a/u','/a/v','/a*?/g','/a{2}?/i','/(a)/g','/a|b/m','/(?=a)/s',
    String.raw`/\1/`, String.raw`/\p{L}/u`, '/é/i', '/[]/g', '/[^]/y', String.raw`/[a\-z]/`,
    String.raw`/[\/-0]/`, '/a{02}/', '/a{2,03}/', '/a{2147483648}/', 'new RegExp("a", "i")'];
  for (const expression of unsupported) {
    const files = [file('const before=/[a-z]*/mi;', 'before.js'), file(`const bad=${expression};`, 'unsupported.js'),
      file('const after=/\\s{2,}/g;', 'after.js')];
    for (const config of [options, { ...options, excludedMutations: ['Regex'] }]) {
      for (const threads of [1,4,'auto']) {
        const response = raw(files, config, threads);
        assert.equal(response.supported, false, expression);
        assert.equal(response.result, undefined);
      }
      const diagnostics=[], saved=console.error;
      try {
        console.error=(...args)=>diagnostics.push(args.map(String));
        const expected = await new Instrumenter(logger).instrument(files, config);
        const expectedDiagnostics=diagnostics.splice(0);
        const auto=createInstrumenter(logger,{ cache:false,engine:'auto' });
        assert.deepEqual(await auto.instrument(files,config),expected,expression);
        assert.deepEqual(diagnostics,expectedDiagnostics,'fallback preserves upstream diagnostics');
        assert.equal(auto.stats.nativeBatches,0);assert.equal(auto.stats.fallbackBatches,1);assert.equal(auto.stats.nativeErrors,0);
      } finally {console.error=saved;}
    }
  }
  for (const expression of ['/a/u', '/a*?/g', '/(a)/g', '/a{02}/']) {
    const files=[file(`// Stryker disable all: grammar still requires proof
const ignored=${expression};`)];
    for (const threads of [1,4,'auto']) assert.equal(raw(files,options,threads).supported,false);
    const expected=await new Instrumenter(logger).instrument(files,options);
    const auto=createInstrumenter(logger,{cache:false,engine:'auto'});
    assert.deepEqual(await auto.instrument(files,options),expected);
    assert.equal(auto.stats.fallbackBatches,1);assert.equal(auto.stats.nativeErrors,0);
  }
  const sut=createInstrumenter(logger,{cache:false,engine:'native'});
  await assert.rejects(sut.instrument([file('const bad=/a/u;')],options), /unsupported/i);
  assert.equal(sut.stats.nativeErrors,0);
  const recovered=[file('const recovered=/[^a-z\\w]{1,3}/mi;')];
  assert.deepEqual((await sut.instrument(recovered,options)).mutants,(await new Instrumenter(logger).instrument(recovered,options)).mutants);
  assert.equal(sut.stats.nativeBatches,1);assert.equal(sut.stats.nativeErrors,0);
  // Babel rejects duplicate/unknown flags, but delegates some malformed
  // patterns to weapon. Preserve each actual success/error/diagnostic outcome.
  for (const expression of ['/a/gg','/a/z','/[z-a]/','/a{3,2}/']) {
    const files=[file(`const bad=${expression};`)];
    assert.equal(raw(files).supported,false);
    const auto=createInstrumenter(logger,{cache:false,engine:'auto'});
    const diagnostics=[], saved=console.error;
    try {
      console.error=(...args)=>diagnostics.push(args.map(String));
      let expected, failure;
      try { expected=await new Instrumenter(logger).instrument(files,options); }
      catch(error) { failure=error; }
      const expectedDiagnostics=diagnostics.splice(0);
      if (failure) await assert.rejects(auto.instrument(files,options), error => error.name===failure.name && error.message===failure.message);
      else assert.deepEqual(await auto.instrument(files,options),expected);
      assert.deepEqual(diagnostics,expectedDiagnostics);
      assert.equal(auto.stats.fallbackBatches,1);assert.equal(auto.stats.nativeErrors,0);
    } finally { console.error=saved; }
  }
});

test('cache and engine settings preserve newly qualified complete results', async () => {
  const cacheDir=await mkdtemp(join(tmpdir(),'native-regex-extensions-'));
  const files=[file('const pattern=/[^a-z\\w]{1,3}/mi;')];
  try {
    const expected=await new Instrumenter(logger).instrument(files,options);
    const sut=createInstrumenter(logger,{cacheDir,engine:'native',instrumentationThreads:4});
    const first=await sut.instrument(files,options);
    assert.deepEqual(first.mutants,expected.mutants);
    assert.deepEqual(await sut.instrument(files,options),first);
    assert.equal(sut.stats.nativeBatches,1);assert.equal(sut.stats.fallbackBatches,0);assert.equal(sut.stats.nativeErrors,0);
    assert.equal(sut.stats.hits,1);
  } finally {await rm(cacheDir,{recursive:true,force:true});}
});

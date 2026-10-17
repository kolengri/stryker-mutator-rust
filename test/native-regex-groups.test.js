import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mutate } from 'weapon-regex';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'regex-groups.js', selection = true) => ({ name, content, mutate: selection });
const plain = value => JSON.parse(JSON.stringify(value));
const metadata = files => files.map(({ content, ...rest }) => rest);
const raw = (files, config = options, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));
const oracle = (pattern, flags = '') => mutate(pattern, flags, { mutationLevels: [1] }).map(m => `/${m.pattern}/${flags}`);

async function compare(files, config = options, modes = [1]) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  let actual;
  const serial = raw(files, config);
  assert.equal(serial.supported, true, serial.reason);
  assert.deepEqual(serial.result.mutants, plain(expected.mutants), 'complete ordered ABI records');
  assert.deepEqual(metadata(serial.result.files), metadata(plain(expected.files)), 'ABI file metadata');
  for (const threads of modes) {
    const abi = raw(files, config, threads);
    assert.equal(abi.supported, true, abi.reason);
    assert.deepEqual(abi.result, serial.result, `complete ABI result, threads=${threads}`);
    for (const engine of ['native', 'auto']) {
      const sut = createInstrumenter(logger, { cache: false, engine,
        ...(threads === 'auto' ? {} : { instrumentationThreads: threads }) });
      actual = await sut.instrument(files, config);
      assert.deepEqual(actual.mutants, expected.mutants, `${engine} complete ordered public records`);
      assert.deepEqual(metadata(actual.files), metadata(expected.files), `${engine} file metadata`);
      assert.deepEqual(plain(actual), abi.result, 'public and raw ABI complete result');
      assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
    }
  }
  return { actual, expected, original: { files } };
}

function execute(result, observation, activeMutant, { afterLoad = false, hitLimit, setup = '', state = 'undefined' } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const logs = [];
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, console: {
    log: (...args) => logs.push(['log', ...args]), error: (...args) => logs.push(['error', ...args]),
  } });
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  let value, error;
  try {
    evaluate(setup);
    for (const { content } of result.files) evaluate(content);
    ns.currentTestId = 'regex-group-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = evaluate(observation);
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'loop mutants require external deterministic bounds');
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, logs, ns, state: evaluate(state) });
}

function runtime(pair, observation, environment = {}) {
  const { ns: _originalNs, ...original } = execute(pair.original, observation, undefined, environment);
  assert.equal(original.error, undefined, 'original program must execute');
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
  return execute(pair.actual, observation, undefined, environment);
}

const samples = ['', 'a', 'A', 'ab', 'aba', 'aa', 'b', 'bc', '123', 'a12', '  ', '\t', '\n', '\r\n',
  '\u2028', '\u2029', 'a\nb', '\na\n', 'é', 'É', 'ſ', 'K', '٩', '😀', 'a/b', 'a\\b', 'Z09_'];
const inspectSetup = `
  const inputs=${JSON.stringify(samples)};
  function inspect(pattern) {
    const records=[];
    for (const input of inputs) {
      for (const operation of ['test','exec','match','search','replace','replace-callback']) {
        pattern.lastIndex=1;
        let result;
        if(operation==='test') result=pattern.test(input);
        if(operation==='exec') { const m=pattern.exec(input); result=m && {
          captures:[...m],index:m.index,input:m.input,groups:m.groups,indices:m.indices }; }
        if(operation==='match') { const m=input.match(pattern); result=m && {
          captures:[...m],index:m.index,input:m.input,groups:m.groups,indices:m.indices }; }
        if(operation==='search') result=input.search(pattern);
        if(operation==='replace') result=input.replace(pattern,"[$&][$1][$2][$3][$\x60][$\x27]");
        if(operation==='replace-callback') {
          const calls=[];
          const text=input.replace(pattern,(...args)=>{calls.push(args);return '#';});
          result={text,calls};
        }
        records.push([input,operation,result,pattern.lastIndex]);
      }
    }
    return [records,pattern.source,pattern.flags,pattern.hasIndices,pattern.global,pattern.sticky,
      pattern.ignoreCase,pattern.multiline,pattern.dotAll];
  }
`;

// Preserve every admitted old negative's exact source, including the empty
// function body. The companion below makes otherwise unobservable captures visible.
test('exact old group negatives retain full ABI/public records and runtime before rejection repair', async () => {
  for (const literal of ['/(ab)/', '/a|b/', '/(a)/g', '/a|b/m']) {
    const declaration = literal === '/(ab)/' || literal === '/a|b/' ? 'unsupported' : 'bad';
    const exact = file(`const ${declaration}=${literal};`, 'unsupported.js');
    const siblings = declaration === 'unsupported'
      ? [file('const before=/^[+-]?\\d+$/;', 'before.js'), exact, file('const after=/[ab]+/;', 'after.js')]
      : [file('const before=/[a-z]*/mi;', 'before.js'), exact, file('const after=/\\s{2,}/g;', 'after.js')];
    const pair = await compare(siblings);
    runtime(pair, `JSON.stringify(inspect(${declaration}))`, { setup: inspectSetup });
    const literalOnly = await compare([file(`const pattern=${literal};`)]);
    assert.deepEqual(literalOnly.actual.mutants.map(m => m.replacement),
      oracle(literal.slice(1, literal.lastIndexOf('/')), literal.slice(literal.lastIndexOf('/') + 1)));
  }
  const ignored = await compare([file('// Stryker disable all: grammar still requires proof\nconst ignored=/(a)/g;')]);
  runtime(ignored, 'JSON.stringify(inspect(ignored))', { setup: inspectSetup });
  const assigned = await compare([file('a = /(a)/;')]);
  runtime(assigned, 'JSON.stringify(inspect(a))', { setup: `${inspectSetup}\nlet a;` });
  const parameter = await compare([file('function f(a=/(a)/){}')]);
  runtime(parameter, 'JSON.stringify([f(),f(undefined),f(/q/),f(null),f.length])');
  const companion = await compare([file('function f(a=/(a)/){return a;} const initial=f();')]);
  const baseline = runtime(companion, `JSON.stringify([inspect(initial),inspect(f()),inspect(f(undefined)),
    f(initial)===initial,f()===f(),f(null),f(false),f(0),f('explicit')])`, { setup: inspectSetup });
  assert.deepEqual(JSON.parse(baseline.value).slice(3), [true, false, null, false, 0, 'explicit']);
  for (const pattern of ['(a)', 'a|b']) {
    const pair = await compare([file(`const value=/${pattern}/;`)]);
    runtime(pair, 'JSON.stringify(inspect(value))', { setup: inspectSetup });
  }
});

const loopSetup = `
  const inputs=${JSON.stringify(samples)};let ticks=0,tests=0,value;const observations=[];
  function tick(enabled) {
    if(++ticks>inputs.length+1) throw new RangeError('group loop condition budget');
    value=inputs[ticks-1];return enabled && ticks<=inputs.length;
  }
  const originalTest=RegExp.prototype.test;
  RegExp.prototype.test=function(input) {
    if(++tests>inputs.length) throw new RangeError('group loop body budget');
    const result=originalTest.call(this,input);
    observations.push([input,this.source,this.flags,result,this.lastIndex]);return result;
  };
`;
test('exact old unbraced loop and quantified group companion preserve bounded every-mutant runtime', async () => {
  for (const content of ['while(tick(true)) /(a)/.test(value);',
    'while(tick(true)) /^(a|(?:b[ab]+)){1,2}$/mi.test(value);',
    'function calc(){while(tick(true)) /^(a|(?:b[ab]+)){1,2}$/mi.test(value);}']) {
    const pair = await compare([file(content)]);
    const baseline = runtime(pair, content.startsWith('function') ? 'calc()' : 'ticks',
      { setup: loopSetup, state: '({ticks,tests,observations})' });
    assert.equal(baseline.state.ticks, samples.length + 1);
    assert.equal(baseline.state.tests, samples.length);
    assert.ok(Object.keys(baseline.ns.mutantCoverage[content.startsWith('function') ? 'perTest' : 'static']).length);
  }
  const forcedTrue = execute({ files: [file('while(true) /(a)/.test(value);')] }, 'ticks', undefined,
    { setup: loopSetup, state: '({ticks,tests,observations})' });
  assert.deepEqual(forcedTrue.error, { name: 'RangeError', message: 'group loop body budget' });
  assert.equal(forcedTrue.state.observations.length, samples.length);
  const removed = execute({ files: [file('while(tick(true));')] }, 'ticks', undefined,
    { setup: loopSetup, state: '({ticks,tests,observations})' });
  assert.equal(removed.error, undefined);
  assert.deepEqual(removed.state, { ticks: samples.length + 1, tests: 0, observations: [] });
});

// A fixed, bounded generator varies collapsed singleton/concat nodes, Or nodes,
// both group kinds, nesting and quantifiers. No random or unbounded fuzzing.
const seeds = ['a', '^', '$', '[ab]+', String.raw`\d{1,2}`, String.raw`a?\w`, '^a$', 'a|b', '|a', 'a|', '|', 'a||b'];
const generated = new Set(['(a)', '(?:a)', 'a|b', '(^)', '(?:$)', '(^$)', '^|$', '(^)|^a$|$',
  '^|^|$', '(^^a$$|(?:[ab]+|\\d{1,2}))', '(|)', '(?:|)', 'a|', '|a', 'a||b',
  '(a|)', '(|a)', '(^|)', '(|^)', '(?:|$)', '((|a)|(?:b|))', '(^|$)+\\d{0}', '(a|a){0,0}',
  '((a))', '(?:(?:a))', '(a(b|c)){2,4}', '^(a|(?:b[ab]+)){1,2}$', String.raw`(a\/|b\\)+`]);
for (const group of ['(a|[ab])', String.raw`(?:^a$|\d)`]) {
  for (const suffix of ['?', '+', '*', '{0}', '{2}', '{0,}', '{2,}', '{0,0}', '{2,4}', '{2147483647}']) {
    generated.add(`${group}${suffix}`);
  }
}
let level = seeds;
for (let depth = 0; depth < 3; depth++) {
  const next = [];
  for (let i = 0; i < 24; i++) {
    const left = level[i % level.length], right = level[(i * 5 + 3) % level.length];
    const pattern = i % 3 === 0 ? `(${left}|(?:${right})){1,2}`
      : i % 3 === 1 ? `(?:${left})(${right})?` : `(${left})|(?:${right})+`;
    generated.add(pattern);next.push(pattern);
  }
  level = next;
}

test('bounded nested grammar matches pinned weapon order, duplicate and zero-mutant records in serial/four/auto', async t => {
  const require = createRequire(import.meta.url);
  assert.equal(JSON.parse(readFileSync(require.resolve('weapon-regex/package.json'))).version, '2.0.6');
  assert.equal(JSON.parse(readFileSync(require.resolve('@stryker-mutator/instrumenter/package.json'))).version, '10.0.0');
  const flags = ['', 'g', 'mi', 'ymigsd'];
  const cases = [...generated].map((pattern, i) => ({ pattern, flags: flags[i % flags.length] }));
  const files = cases.map(({ pattern, flags }, i) => file(`const pattern=/${pattern}/${flags};`, `generated-${i}.js`));
  const diagnostics = [], saved = console.error;
  let pair;
  try {
    console.error = (...args) => diagnostics.push(args.map(String));
    pair = await compare(files, options, [1, 4, 'auto']);
    const byFile = Map.groupBy(pair.actual.mutants, m => m.fileName);
    for (const [i, { pattern, flags }] of cases.entries()) {
      assert.deepEqual((byFile.get(files[i].name) ?? []).map(m => m.replacement), oracle(pattern, flags), pattern);
      // Isolate each program's lexical binding while retaining the batch's real
      // global IDs. Exercise every generated mutant, not just its replacement text.
      const isolated = Object.fromEntries(['actual', 'expected', 'original'].map(key => [key, {
        files: [pair[key].files[i]],
        mutants: pair[key].mutants?.filter(m => m.fileName === files[i].name),
      }]));
      runtime(isolated, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
    }
  } finally { console.error = saved; }
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(oracle('(^)|^a$|$'), ['/(^)|^a$/', '/()|^a$|$/', '/(^)|a$|$/', '/(^)|^a|$/']);
  assert.deepEqual(oracle('^|^|$'), ['/^|$/', '/^|$/', '/^|^/']);
  for (const pattern of ['(a)', '(?:a)', 'a|b', '|', '(?:|)', '(a|a)']) assert.deepEqual(oracle(pattern), []);
  assert.deepEqual(pair.actual.mutants.map(m => m.id), pair.actual.mutants.map((_, i) => String(i)));
  t.diagnostic(`${cases.length} deterministic nested patterns, ${pair.actual.mutants.length} complete ordered mutants`);
});

const statefulPatterns = ['^(a|(?:b[ab]+)){1,2}$', '((a)|(b)){0,2}', '(a|(b))', '(^)|$|a',
  '((|a)|(?:b|))', '(?:^|)', '(a|a){0,0}', String.raw`(a\/|b\\)+`, String.raw`(^[\d\d]$|(?:\w\s?))`,
  '(a|[ab])*', '(?:a|b){0}', '(a|b){2,}', '(?:a|b){0,}'];
for (const [index, pattern] of statefulPatterns.entries()) {
  test(`captures, indices, replacement captures and original/stored identity: ${pattern}`, async () => {
    const flags = ['g', 'y', 'd', 'dg', 'dy', 'ygd', 'mi', 'sim', 'ygsdmi'][index % 9];
    const pair = await compare([file(`const pattern=/${pattern}/${flags}; const saved=pattern;`)]);
    const baseline = runtime(pair, 'JSON.stringify([inspect(pattern),pattern===saved])', { setup: inspectSetup });
    assert.equal(JSON.parse(baseline.value)[1], true);
  });
}

test('post-load activation and fresh repeated group literals preserve identity and lastIndex', async () => {
  const pair = await compare([file(`let previous; const pattern=/(a|b)+/g; const saved=pattern;
function calc(t) { const fresh=/((a)|(?:b[ab]+)){1,2}/yd; const same=previous===fresh;
previous=fresh; const before=pattern.lastIndex; const hit=pattern.exec(t);
return [same,before,pattern.lastIndex,hit,fresh.exec(t),fresh.lastIndex,pattern===saved]; }`)]);
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`);
});

const clonedLiteral = String.raw`/(a|(?:b[\d\w]{1,2}))+/ymigsd`;
const cloneContexts = [
  ['logical/method receiver', `function calc(t){return !${clonedLiteral}.test(t.trim());}`],
  ['template', 'function calc(t){return !`match:${' + clonedLiteral + '.test(t)}`;}'],
  ['call argument', `function calc(t){return t.trim(${clonedLiteral});}`],
  ['assignment', `let pattern;function calc(t){pattern=${clonedLiteral};return pattern.exec(t);}`],
  ['computed property', `const obj={true:1,false:2};function calc(t){return obj[${clonedLiteral}.test(t)];}`],
  ['class field', `class C{pattern=${clonedLiteral};test(t){return this.pattern.exec(t);}}function calc(t){return new C().test(t);}`],
  ['conditional and optional call', `function calc(t){return t?.trim(${clonedLiteral})?${clonedLiteral}.exec(t):null;}`],
  ['arrow/raw strings', `function calc(t){return t.trim((x)=>'\\x61',${clonedLiteral});}`],
];
for (const [name, content] of cloneContexts) test(`group literals reuse the shared raw spelling printer through ${name}`, async () => {
  runtime(await compare([file(content)]), `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`);
});

test('group call effects, errors and coverage/hit limits preserve order within each engine', async () => {
  const pair = await compare([file(`function calc(value){console.log('input',value);
return receive(value,/((a)|(?:b[ab]+)){1,2}/mi).exec(next(value));}`)]);
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>{
try{return calc(input);}catch(error){return [error.name,error.message];}}))`, {
    setup: `function receive(value,pattern){console.log('receive',value,pattern.source);
if(value==='b')throw new TypeError('receiver failure');return pattern;}
function next(value){console.log('next',value);if(value==='a')throw new RangeError('argument failure');return value;}`,
  });
});

test('selection, comments, exclusions, ignore/restore, no-mutant headers and namespaces preserve full records', async () => {
  const files = [file('consume(true);', 'before.js'),
    file("const astral='😀';\r\nconst pattern=/^((a)|(?:b[ab]+)){1,2}$/mi;", 'selected.js', [
      { start: { line: 1, column: 0 }, end: { line: 1, column: 80 } },
    ]), file('const off=/(a|b)+/;', 'off.js', false),
    file(`// Stryker disable next-line Regex: retained group
const pattern=/^((a)|(?:b[ab]+)){1,2}$/mi;
// Stryker disable Regex: first
const disabled=/(a|b)+/;
// Stryker restore Regex
function calc(t){return pattern.test(t)||disabled.test(t)||/(b|[ab])+/.test(t);}`, 'directives.js')];
  files.push(file('namespace Groups{export const pattern=/(a|b)+/mi;}', 'namespace.ts'));
  for (const config of [options, { ...options, excludedMutations: ['Regex'] },
    { ...options, noHeader: true }]) {
    await compare(files, config, [1, 4, 'auto']);
  }
  const excluded = await compare([file('const pattern=/^((a)|(?:b[ab]+)){1,2}$/mi;')],
    { ...options, excludedMutations: ['Regex'] });
  assert.ok(excluded.actual.mutants.every(m => m.status === 'Ignored'));
  runtime(excluded, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
  for (const content of ['const pattern=/(a|b)/;', 'const pattern=/(?:|)/;',
    '// Stryker disable all: intentional\nconst pattern=/^((a)|(?:b[ab]+)){1,2}$/mi;']) {
    const pair = await compare([file(content)]);
    assert.ok(pair.actual.mutants.every(m => m.status === 'Ignored'));
    assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_/);
    assert.equal(pair.actual.files[0].content, content);
    runtime(pair, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
  }
  const header = (await new Instrumenter(logger).instrument([file('true;')], options)).files[0].content;
  const pair = await compare([file('function calc(t){return /^(a|[ab]+){1,2}$/mi.test(t);}')], { ...options, noHeader: true });
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`, { setup: header.slice(0, header.lastIndexOf('\n')) });
});

test('mixed JS/TS parallel emission and actual relocation recovery retain ordered group records', async t => {
  const groups = Array.from({ length: 48 }, (_, i) => `const value${i}=/(a|(?:b[\\d\\w]{1,2}))+/mi.test('A') && (1+2>0);`).join('\n');
  const files = [file(groups, 'large.js'), file(groups, 'large.ts'),
    file('type T=typeof stryMutAct_9fa48; const last=/((a)|b){1,3}/ygd;', 'opaque.ts')];
  await compare(files, options, [1, 4, 'auto']);
  const recovered = raw(files, options, 4);
  assert.ok(recovered.execution.spawnedThreads > 0, 'exercise actual parallel work, not a serial-shaped request');
  assert.equal(recovered.execution.serialRecoveries, 1);
  assert.equal(recovered.execution.reason, 'unproven-relocation');
  assert.deepEqual(recovered.result, raw(files).result);
  const next = [file('const next=/(a|[ab]+){1,3}/mi;')];
  await compare(next, options, [1, 4, 'auto']);
  t.diagnostic(JSON.stringify(recovered.execution));
});

test('empty groups, root-empty mutations and unsupported siblings preserve atomic fallback and exact diagnostics', async () => {
  const unsupported = ['()', '(?:)', '(())', '(?:())', '()|a', 'a|(?:)', '()?',
    '^|', '|^', '$|', '|$', '(?<capture>a)', '(?=a)', '(?!a)', '(?<=a)', '(?<!a)',
    String.raw`(a)\1`, String.raw`(a|\x61)`, '(a|.)', '(a)+?', '(?:a){2}?'];
  for (const pattern of ['()', '(?:)', '(())', '(?:())', '()|a', 'a|(?:)', '()?']) {
    assert.throws(() => oracle(pattern), 'weapon rejects a sole empty RE inside a group');
  }
  for (const pattern of ['^|', '|^', '$|', '|$']) assert.deepEqual(oracle(pattern), ['//']);
  for (const expression of [...unsupported.map(p => `/${p}/`), '/(a|b)/u', '/(a|b)/v',
    '/(?i:a)/', 'new RegExp("(a|b)")']) {
    const files = [file('const before=/(a|[ab]+){1,3}/mi;', 'before.js'),
      file(`const bad=${expression};`, 'unsupported.js'), file('const after=/((a)|b)+/ygd;', 'after.ts')];
    for (const config of [options, { ...options, excludedMutations: ['Regex'] }]) {
      for (const threads of [1, 4, 'auto']) {
        const response = raw(files, config, threads);
        assert.equal(response.supported, false, expression);
        assert.equal(response.result, undefined, expression);
      }
      const diagnostics = [], saved = console.error;
      try {
        console.error = (...args) => diagnostics.push(args.map(String));
        let expected, failure;
        try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
        const expectedDiagnostics = diagnostics.splice(0);
        const sut = createInstrumenter(logger, { cache: false, engine: 'auto' });
        if (failure) await assert.rejects(sut.instrument(files, config), error => error.name === failure.name && error.message === failure.message);
        else assert.deepEqual(await sut.instrument(files, config), expected, expression);
        assert.deepEqual(diagnostics, expectedDiagnostics, 'fallback keeps weapon diagnostics');
        assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [0, 1, 0]);
      } finally { console.error = saved; }
    }
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i);
    assert.equal(strict.stats.nativeErrors, 0);
    const next = [file('const recovered=/((a)|[ab]+){1,3}/mi;')];
    assert.deepEqual((await strict.instrument(next, options)).mutants, (await new Instrumenter(logger).instrument(next, options)).mutants);
    assert.deepEqual([strict.stats.nativeBatches, strict.stats.fallbackBatches, strict.stats.nativeErrors], [1, 0, 0]);
  }
  // Ignoring a Regex mutation must not suppress weapon's parser diagnostic.
  const ignored = [file('// Stryker disable all: still unproved\nconst bad=/()/;')];
  for (const threads of [1, 4, 'auto']) assert.equal(raw(ignored, options, threads).supported, false);
  const diagnostics = [], saved = console.error;
  try {
    console.error = (...args) => diagnostics.push(args.map(String));
    const expected = await new Instrumenter(logger).instrument(ignored, options);
    const originalDiagnostics = diagnostics.splice(0);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    assert.deepEqual(await auto.instrument(ignored, options), expected);
    assert.deepEqual(diagnostics, originalDiagnostics);
    assert.ok(originalDiagnostics.length > 0);
    assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
  } finally { console.error = saved; }
});

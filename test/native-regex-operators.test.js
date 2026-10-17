import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mutate } from 'weapon-regex';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'regex-operators.js', selection = true) => ({ name, content, mutate: selection });
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
    ns.currentTestId = 'regex-operator-test';
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

// Exact declarations and sibling batches from the pre-edit negative inventory.
// Keep these witnesses when replacing their obsolete rejection entries.
const oldNegatives = [
  ...['/a??/', '/a+?/', '/a|(?=b)/', '/(?=a)/', '/./'].map(literal => ({
    literal, content: `const unsupported=${literal};`, name: 'unsupported.js', siblings: 'initial',
  })),
  { literal: '/a*?/', content: 'const unsupported=/a*?/;', name: 'regex.js' },
  ...['/a*?/g', '/a{2}?/i', '/a|(?=b)/m', '/(?=a)/s'].map(literal => ({
    literal, content: `const bad=${literal};`, name: 'unsupported.js', siblings: 'extensions',
  })),
  { literal: '/a*?/g', content: '// Stryker disable all: grammar still requires proof\nconst ignored=/a*?/g;', name: 'regex-extensions.js' },
  ...['(?=a)', '(?!a)', '(?<=a)', '(?<!a)', '(a|.)', '(a)+?', '(?:a){2}?'].map(pattern => ({
    literal: `/${pattern}/`, content: `const bad=/${pattern}/;`, name: 'unsupported.js', siblings: 'groups',
  })),
  ...['a??', 'a+?', 'a*?', 'a{2}?', 'a|(?=b)', '(?=a)', '.', String.raw`a.[+-]?\d+`].map(pattern => ({
    literal: `/${pattern}/`, content: `const pattern=/${pattern}/;`, name: 'rust-boundary.js',
  })),
];

function literalRuntime(pair, literal, observation, environment = {}) {
  runtime(pair, observation, environment);
  // An uninstrumented program with the exact reference replacement is a third
  // execution witness, independent of both instrumentation implementations.
  const name = pair.original.files.find(f => f.content.includes(literal)).name;
  for (const mutant of pair.expected.mutants.filter(m => m.fileName === name && m.mutatorName === 'Regex' && !m.status)) {
    const direct = { files: pair.original.files.map(f => ({ ...f, content: f.content.replace(literal, () => mutant.replacement) })) };
    const { ns: _ns, ...actual } = execute(pair.actual, observation, mutant.id, environment);
    const { ns: _directNs, ...reference } = execute(direct, observation, undefined, environment);
    assert.deepEqual(actual, reference, `direct original replacement ${mutant.replacement}`);
  }
}

test('every exact newly admitted old negative has strict ABI/public and observable runtime proof', async () => {
  for (const old of oldNegatives) {
    const exact = file(old.content, old.name);
    const files = old.siblings === 'initial'
      ? [file('const before=/^[+-]?\\d+$/;', 'before.js'), exact, file('const after=/[ab]+/;', 'after.js')]
      : old.siblings === 'extensions'
        ? [file('const before=/[a-z]*/mi;', 'before.js'), exact, file('const after=/\\s{2,}/g;', 'after.js')]
        : old.siblings === 'groups'
          ? [file('const before=/(a|[ab]+){1,3}/mi;', 'before.js'), exact, file('const after=/((a)|b)+/ygd;', 'after.ts')]
          : [exact];
    const pair = await compare(files);
    const binding = old.content.includes('const ignored=') ? 'ignored'
      : old.content.includes('const unsupported=') ? 'unsupported'
        : old.content.includes('const bad=') ? 'bad' : 'pattern';
    literalRuntime(pair, old.literal, `JSON.stringify(inspect(${binding}))`, { setup: inspectSetup });
    const single = await compare([file(old.content)]);
    assert.deepEqual(single.actual.mutants.map(m => m.replacement),
      oracle(old.literal.slice(1, old.literal.lastIndexOf('/')), old.literal.slice(old.literal.lastIndexOf('/') + 1)));
  }
});

const seeds = [
  '(?=a)', '(?!a)', '(?<=a)', '(?<!a)', '(?=^)', '(?!$)', '(?<=^)', '(?<!$)',
  '(?=^$)', '(?!^|$)', '(?<=|^)', '(?<!$|)', '(?=(?=^))', '(?<!(?<=($)))',
  '(?=^)|$|^', '(?=^)|(?=^)', '(?=(^))', '(?<=((a)|(b)))',
  String.raw`\b`, String.raw`\B`, '.', String.raw`^\b.\B$`,
  String.raw`(?=\b[\d\w])(?:a|.)+?`, String.raw`(?<!\B)[^a-z]{0,2}?`,
  '(?=a)+?', '(?!b){0,2}?', '(a|.)+?', '(?:a){2}?', '(?=|)', '(?<!|)',
  '(?=^^)', '(?<=a$$)', String.raw`\b|^|\B`,
];
const generated = new Set(seeds);
for (const [i, suffix] of ['??', '+?', '*?', '{0}?', '{2}?', '{0,}?', '{2,}?', '{0,0}?', '{1,3}?',
  '{2147483647}?', '{0,2147483647}?'].entries()) {
  generated.add(`${['a', '.', '(a|b)', String.raw`[\d\w]`][i % 4]}${suffix}`);
}
let level = seeds;
for (let depth = 0; depth < 2; depth++) {
  const next = [];
  for (let i = 0; i < 16; i++) {
    const left = level[i % level.length], right = seeds[(i * 7 + depth) % seeds.length];
    const pattern = i % 4 === 0 ? `(?=${left})|(?:${right})`
      : i % 4 === 1 ? `(?<!${left})(?:${right}){0,2}?`
        : i % 4 === 2 ? `(?<=${left}|${right})[ab]+?` : `(?:${left})(?!${right})`;
    generated.add(pattern);next.push(pattern);
  }
  level = next;
}

test('bounded nested operators match direct weapon and all ordered records with every mutant runtime-qualified', async t => {
  const require = createRequire(import.meta.url);
  assert.equal(JSON.parse(readFileSync(require.resolve('weapon-regex/package.json'))).version, '2.0.6');
  assert.equal(JSON.parse(readFileSync(require.resolve('@stryker-mutator/instrumenter/package.json'))).version, '10.0.0');
  const flags = ['', 'g', 'mi', 'y', 'dy', 'ymigsd'];
  const cases = [...generated].map((pattern, i) => ({ pattern, flags: flags[i % flags.length] }));
  const files = cases.map(({ pattern, flags }, i) => file(`const pattern=/${pattern}/${flags};`, `operator-${i}.js`));
  const pair = await compare(files, options, [1, 4, 'auto']);
  const byFile = Map.groupBy(pair.actual.mutants, m => m.fileName);
  for (const [i, { pattern, flags }] of cases.entries()) {
    const replacements = oracle(pattern, flags);
    assert.deepEqual((byFile.get(files[i].name) ?? []).map(m => m.replacement), replacements, pattern);
    const isolated = Object.fromEntries(['actual', 'expected', 'original'].map(key => [key, {
      files: [pair[key].files[i]], mutants: pair[key].mutants?.filter(m => m.fileName === files[i].name),
    }]));
    literalRuntime(isolated, `/${pattern}/${flags}`, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
  }
  assert.deepEqual(pair.actual.mutants.map(m => m.id), pair.actual.mutants.map((_, i) => String(i)));
  for (const pattern of [String.raw`\b`, String.raw`\B`, '.', String.raw`\b.\B`, '(?:.|a)']) assert.deepEqual(oracle(pattern), []);
  assert.deepEqual(oracle('(?=^)'), ['/(?=)/', '/(?!^)/']);
  assert.deepEqual(oracle('(?=^$)'), ['/(?!^$)/', '/(?=$)/', '/(?=^)/']);
  assert.deepEqual(oracle('(?=^^)'), ['/(?!^^)/', '/(?=^)/', '/(?=^)/']);
  assert.deepEqual(oracle('(?=(?=^))'), ['/(?!(?=^))/', '/(?=(?=))/', '/(?=(?!^))/']);
  assert.deepEqual(oracle('(?=^)|(?=^)'), ['/(?=)|(?=^)/', '/(?!^)|(?=^)/', '/(?=^)|(?=)/', '/(?=^)|(?!^)/']);
  if (process.env.REGEX_OPERATOR_EVIDENCE) {
    writeFileSync(join(process.env.REGEX_OPERATOR_EVIDENCE, `oracle-${process.versions.bun ? 'bun' : 'node'}.json`),
      JSON.stringify({ cases: cases.map(c => ({ ...c, replacements: oracle(c.pattern, c.flags) })),
        mutants: pair.actual.mutants, files: metadata(pair.actual.files), modes: [1, 4, 'auto'],
        runtime: 'every generated mutant; original, exact replacement, upstream and native within this engine',
        versions: process.versions }, null, 2) + '\n');
  }
  t.diagnostic(`${cases.length} deterministic nested/operator patterns, ${pair.actual.mutants.length} complete ordered mutants`);
});

const clonedLiteral = String.raw`/(?<=a)(?!(b))\b(?:.|[\d\w])+?/ymigsd`;
const cloneContexts = [
  ['logical receiver', `function calc(t){return !${clonedLiteral}.test(t.trim());}`],
  ['template', 'function calc(t){return !`match:${' + clonedLiteral + '.test(t)}`;}'],
  ['call argument', `function calc(t){return t.trim(${clonedLiteral});}`],
  ['assignment', `let pattern;function calc(t){pattern=${clonedLiteral};return pattern.exec(t);}`],
  ['computed property', `const obj={true:1,false:2};function calc(t){return obj[${clonedLiteral}.test(t)];}`],
  ['class field', `class C{pattern=${clonedLiteral};test(t){return this.pattern.exec(t);}}function calc(t){return new C().test(t);}`],
  ['conditional optional call', `function calc(t){return t?.trim(${clonedLiteral})?${clonedLiteral}.exec(t):null;}`],
  ['arrow/raw strings', `function calc(t){return t.trim((x)=>'\\x61',${clonedLiteral});}`],
];
for (const [name, content] of cloneContexts) test(`operators retain raw flags in cloned ancestors: ${name}`, async () => {
  runtime(await compare([file(content)]), `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`);
});

test('stored and repeated fresh literals preserve captures, indices, g/y lastIndex and post-load activation', async () => {
  const pair = await compare([file(String.raw`let previous;const pattern=/(?=(a+?))a/ygd;const saved=pattern;
function calc(t){const fresh=/(?<=([ab]))(?!b).+?/dy;const same=previous===fresh;
previous=fresh;const before=pattern.lastIndex;const hit=pattern.exec(t);
return [same,before,pattern.lastIndex,hit,fresh.exec(t),fresh.lastIndex,pattern===saved];}`)]);
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`);
});

test('operator receivers and arguments retain side-effect order and natural errors', async () => {
  const pair = await compare([file(`function calc(t){return receive(t,${clonedLiteral}).test(next(t));}`)]);
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>{
try{return calc(input);}catch(error){return [error.name,error.message];}}))`, {
    setup: `function receive(value,pattern){console.log('receive',value,pattern.source);
if(value==='b')throw new TypeError('receiver failure');return pattern;}
function next(value){console.log('next',value);if(value==='a')throw new RangeError('argument failure');return value;}`,
  });
});

test('zero-width lookaround loop mutants terminate under external deterministic budgets', async () => {
  const pair = await compare([file('let count=0;while(/(?=a)/g.test(next()))count++;')]);
  runtime(pair, 'JSON.stringify(count)', {
    setup: `let budget=0;function next(){if(++budget>8)throw new RangeError('external loop budget');return 'a';}`,
    state: 'budget',
  });
  const repeated = await compare([file('const pattern=/(?=a)/g;')]);
  runtime(repeated, `JSON.stringify((()=>{const rows=[];for(let i=0;i<8;i++){
const match=pattern.exec('a');rows.push([match,pattern.lastIndex]);if(!match)break;}return rows;})())`);
});

test('selection, directives, exclusion, no-header, all-ignored, zero-mutant and namespace records agree', async () => {
  const literal = String.raw`/^\b(?=(a))(?<!b).{1,2}?$/mi`;
  const files = [file('consume(true);', 'before.js'),
    file(`const astral='😀';\r\nconst pattern=${literal};`, 'selected.js', [
      { start: { line: 1, column: 0 }, end: { line: 1, column: 80 } },
    ]), file(`const off=${literal};`, 'off.js', false),
    file(`// Stryker disable next-line Regex: retained operator\nconst pattern=${literal};
// Stryker disable Regex: first
const disabled=/(?!b).+?/;
// Stryker restore Regex
function calc(t){return pattern.test(t)||disabled.test(t)||/(?<=a)./.test(t);}`, 'directives.js'),
    file(`namespace Operators{export const pattern=${literal};}`, 'namespace.ts')];
  for (const config of [options, { ...options, excludedMutations: ['Regex'] }, { ...options, noHeader: true }]) {
    await compare(files, config, [1, 4, 'auto']);
  }
  const excluded = await compare([file(`const pattern=${literal};`)], { ...options, excludedMutations: ['Regex'] });
  assert.ok(excluded.actual.mutants.length > 0 && excluded.actual.mutants.every(m => m.status === 'Ignored'));
  runtime(excluded, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
  for (const content of [String.raw`const pattern=/\b.\B/;`,
    `// Stryker disable all: intentional\nconst pattern=${literal};`]) {
    const pair = await compare([file(content)]);
    assert.ok(pair.actual.mutants.every(m => m.status === 'Ignored'));
    assert.equal(pair.actual.files[0].content, content);
    runtime(pair, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup });
  }
  const header = (await new Instrumenter(logger).instrument([file('true;')], options)).files[0].content;
  const noHeader = await compare([file(`function calc(t){return ${literal}.exec(t);}`)], { ...options, noHeader: true });
  runtime(noHeader, `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`, { setup: header.slice(0, header.lastIndexOf('\n')) });
});

test('mixed JS/TS large-first/small-next batches actually spawn and recover relocation to serial', async t => {
  const content = Array.from({ length: 48 }, (_, i) => `const value${i}=${clonedLiteral}.test('a')&&(1+2>0);`).join('\n');
  const files = [file(content, 'large.js'), file(content, 'large.ts'),
    file(String.raw`type T=typeof stryMutAct_9fa48;const last=/(?<!b)\B.+?/yd;`, 'opaque.ts')];
  await compare(files, options, [1, 4, 'auto']);
  const recovered = raw(files, options, 4);
  assert.ok(recovered.execution.spawnedThreads > 0, 'actual parallel work');
  assert.equal(recovered.execution.serialRecoveries, 1);
  assert.equal(recovered.execution.reason, 'unproven-relocation');
  assert.deepEqual(recovered.result, raw(files).result);
  await compare([file(String.raw`const next=/\b(?=a).+?/mi;`)], options, [1, 4, 'auto']);
  t.diagnostic(JSON.stringify(recovered.execution));
});

test('unproven operands remain atomic even ignored or excluded and retain exact upstream diagnostics', async () => {
  const unsupported = ['(?=)', '(?!)', '(?<=)', '(?<!)', '(?=())', '(?![])', '(?<=é)',
    String.raw`(?=\x61)`, String.raw`(?=(a)\1)`, '(?<capture>a)', '(?i:a)',
    'a{02}?', 'a{2,03}?', 'a{2147483648}?', 'a{0,2147483648}?', '^|', '|$'];
  for (const expression of [...unsupported.map(p => `/${p}/`), '/(?=a)/u', '/(?=a)/v', 'new RegExp("(?=a)")']) {
    const files = [file(`const before=${clonedLiteral};`, 'before.js'), file(`const bad=${expression};`, 'bad.js'),
      file('const after=/(?<=a).+?/yd;', 'after.ts')];
    const ignored = [file(`// Stryker disable all: operands still require proof\nconst bad=${expression};`)];
    for (const batch of [files, ignored]) for (const config of [options, { ...options, excludedMutations: ['Regex'] }]) {
      for (const threads of [1, 4, 'auto']) {
        const response = raw(batch, config, threads);
        assert.equal(response.supported, false, expression);assert.equal(response.result, undefined);
      }
      const diagnostics = [], saved = console.error;
      try {
        console.error = (...args) => diagnostics.push(args.map(String));
        let expected, failure;
        try { expected = await new Instrumenter(logger).instrument(batch, config); } catch (error) { failure = error; }
        const expectedDiagnostics = diagnostics.splice(0);
        const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
        if (failure) await assert.rejects(auto.instrument(batch, config), e => e.name === failure.name && e.message === failure.message);
        else assert.deepEqual(await auto.instrument(batch, config), expected);
        assert.deepEqual(diagnostics, expectedDiagnostics);
        assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
      } finally { console.error = saved; }
    }
    const native = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(native.instrument(files, options), /unsupported/i);
    assert.equal(native.stats.nativeErrors, 0);
    await native.instrument([file('const next=/(?=^).+?/;')], options);
    assert.deepEqual([native.stats.nativeBatches, native.stats.fallbackBatches, native.stats.nativeErrors], [1, 0, 0]);
  }
  // Compare the natural original/reference compile outcome inside this engine.
  // Babel can retain malformed patterns; no rewriting makes them executable.
  for (const expression of ['/(?<=a)+?/', '/a++/', '/a{3,2}?/', '/(?=a)/gg']) {
    const files = [file(`const bad=${expression};`)];
    assert.equal(raw(files).supported, false);
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    if (failure) await assert.rejects(auto.instrument(files, options), e => e.name === failure.name && e.message === failure.message);
    else {
      const actual = await auto.instrument(files, options);assert.deepEqual(actual, expected);
      assert.equal(execute({ files }, 'typeof bad').error.name, 'SyntaxError', 'preserve the original compile failure');
      for (const active of [undefined, ...expected.mutants.map(m => m.id)]) {
        assert.deepEqual(execute(actual, 'typeof bad', active), execute(expected, 'typeof bad', active));
        assert.equal(execute(expected, 'typeof bad', active).error.name, 'SyntaxError');
      }
    }
  }
});

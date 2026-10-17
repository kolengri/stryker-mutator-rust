import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import { createRequire } from 'node:module';
import { mutate } from 'weapon-regex';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const completed = content => transformSync(content, { filename: 'fixture.ts', configFile: false, babelrc: false,
  presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
}).code;
const file = (content, name = 'regex-named-references.js', selection = true) => ({ name, content, mutate: selection });
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

function execute(result, observation, activeMutant, { afterLoad = false, hitLimit, setup = '', state = 'undefined', activationBudget } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  let active = ns.activeMutant, checks = 0, running = true;
  if (activationBudget) Object.defineProperty(ns, 'activeMutant', { enumerable: true,
    get() { if (running && ++checks > activationBudget) throw new RangeError('external activation budget'); return active; },
    set(value) { active = value; } });
  const logs = [];
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, console: {
    log: (...args) => logs.push(['log', ...args]), error: (...args) => logs.push(['error', ...args]),
  } });
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  let value, error;
  try {
    evaluate(setup);
    for (const { content, name } of result.files) evaluate(name.endsWith('.ts') ? completed(content) : content);
    ns.currentTestId = 'regex-named-reference-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = evaluate(observation);
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'loop mutants require external deterministic bounds');
    error = { name: caught.name, message: caught.message };
  }
  running = false;
  return structuredClone({ value, error, logs, ns, state: evaluate(state) });
}

function runtime(pair, observation, environment = {}) {
  const { ns: _originalNs, ...original } = execute(pair.original, observation, undefined, environment);
  if (!environment.allowFailure) assert.equal(original.error, undefined, 'the original runtime witness must execute');
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
  '\u2028', '\u2029', 'a\nb', '\na\n', 'é', 'É', 'ſ', 'K', '٩', '😀', 'a/b', 'a\\b', 'Z09_', 'aaaa', 'abab', 'abb', 'aaaabbbb', '\ud800', '\udc00', '😀😀'];
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
          captures:[...m],index:m.index,input:m.input,groups:m.groups,
          indices:m.indices&&{captures:[...m.indices],groups:m.indices.groups} }; }
        if(operation==='match') { const m=input.match(pattern); result=m && {
          captures:[...m],index:m.index,input:m.input,groups:m.groups,
          indices:m.indices&&{captures:[...m.indices],groups:m.indices.groups} }; }
        if(operation==='search') result=input.search(pattern);
        if(operation==='replace') result=input.replace(pattern,"[$&][$1][$2][$3][$<word>][$<capture>][$<a>][$\x60][$\x27]");
        if(operation==='replace-callback') {
          const calls=[];
          const text=input.replace(pattern,(...args)=>{calls.push(args);return '#';});
          result={text,calls};
        }
        records.push([input,operation,result,pattern.lastIndex]);
      }
    }
    return [records,pattern.source,pattern.flags,pattern.hasIndices,pattern.global,pattern.sticky,
      pattern.ignoreCase,pattern.multiline,pattern.dotAll,pattern.unicode];
  }
`;

function literalRuntime(pair, literal, observation = 'JSON.stringify(inspect(pattern))', environment = { setup: inspectSetup }) {
  runtime(pair, observation, environment);
  const name = pair.original.files.find(f => f.content.includes(literal)).name;
  for (const mutant of pair.expected.mutants.filter(m => m.fileName === name && m.mutatorName === 'Regex' && !m.status)) {
    const direct = { files: pair.original.files.map(f => ({ ...f,
      content: f.content.includes(literal) ? f.content.replace(literal, () => mutant.replacement) : f.content })) };
    const { ns: _actualNs, ...actual } = execute(pair.actual, observation, mutant.id, environment);
    const { ns: _directNs, ...reference } = execute(direct, observation, undefined, environment);
    assert.deepEqual(actual, reference, `exact original substitution ${mutant.replacement}`);
  }
}

// Exact source strings from every newly admitted pre-edit negative. Keep empty
// bodies verbatim; the observable companion below exercises the same default.
const oldNegatives = [
  ...['/(?<capture>ab)/', '/(?<capture>.)/', '/a/u'].map(literal => ({
    literal, content: `const unsupported=${literal};`, name: 'unsupported.js', siblings: 'initial' })),
  ...['/a/u', '/(?<capture>a)/g'].map(literal => ({
    literal, content: `const bad=${literal};`, name: 'unsupported.js', siblings: 'extensions' })),
  ...['/a/u', '/(?<capture>a)/g'].map(literal => ({ literal,
    content: `// Stryker disable all: grammar still requires proof\nconst ignored=${literal};` })),
  { literal: '/a/u', content: 'const bad=/a/u;' },
  ...['/(?<capture>a)/', String.raw`/(a)\1/`, '/(a|b)/u'].map(literal => ({ literal,
    content: `const bad=${literal};`, name: 'unsupported.js', siblings: 'groups' })),
  ...[String.raw`/(?=(a)\1)/`, '/(?<capture>a)/', '/(?=a)/u'].map(literal => ({ literal,
    content: `const bad=${literal};`, name: 'bad.js', siblings: 'operators' })),
  ...[String.raw`/(?=(a)\1)/`, '/(?<capture>a)/', '/(?=a)/u'].map(literal => ({ literal,
    content: `// Stryker disable all: operands still require proof\nconst bad=${literal};` })),
  { literal: '/(?<capture>a)/', content: 'a = /(?<capture>a)/;', name: 'unsupported.js', siblings: 'assignment', setup: 'let a;', observe: 'a' },
  { literal: '/(?<capture>a)/', content: 'function f(a=/(?<capture>a)/){}', name: 'unsupported.ts', siblings: 'parameters',
    expression: 'JSON.stringify([f(),f(undefined),f(/b/u),f.length])' },
  { literal: '/(?<capture>a)/', content: 'while(tick(true)) /(?<capture>a)/.test(value);', name: 'unsupported.js', siblings: 'assignment',
    setup: `let steps=0;const value="a";function tick(value){if(++steps>3)throw new RangeError("external tick budget");return value;}
const originalTest=RegExp.prototype.test;RegExp.prototype.test=function(value){const result=originalTest.call(this,value);
console.log(this.source,this.flags,value,result);return result;};`,
    observe: 'undefined', activationBudget: 80, allowFailure: true },
  { literal: '/(?<capture>a)/', content: 'const pattern=/(?<capture>a)/;', name: 'rust-boundary.js' },
];

test('every exact old negative is admitted with complete ABI/public and original/upstream/native runtime witnesses', async () => {
  for (const old of oldNegatives) {
    const exact = file(old.content, old.name);
    const files = old.siblings === 'initial'
      ? [file('const before=/^[+-]?\\d+$/;', 'before.js'), exact, file('const after=/[ab]+/;', 'after.js')]
      : old.siblings === 'extensions'
        ? [file('const before=/[a-z]*/mi;', 'before.js'), exact, file('const after=/\\s{2,}/g;', 'after.js')]
        : old.siblings === 'groups'
          ? [file('const before=/(a|[ab]+){1,3}/mi;', 'before.js'), exact, file('const after=/((a)|b)+/ygd;', 'after.ts')]
          : old.siblings === 'operators'
            ? [file(String.raw`const before=/(?<=a)(?!(b))\b(?:.|[\d\w])+?/ymigsd;`, 'before.js'), exact,
              file('const after=/(?<=a).+?/yd;', 'after.ts')]
            : old.siblings === 'assignment' ? [file('const first=true;', 'first.js'), exact]
              : old.siblings === 'parameters' ? [file('const accepted=true;', 'accepted.js'), exact]
                : [exact];
    const pair = await compare(files, options, [1, 4, 'auto']);
    const binding = /const (\w+)=/.exec(old.content)?.[1];
    const observation = old.expression ?? (old.observe === 'undefined' ? 'undefined'
      : `JSON.stringify(inspect(${old.observe ?? binding}))`);
    literalRuntime(pair, old.literal, observation, { setup: `${inspectSetup}\n${old.setup ?? ''}`,
      activationBudget: old.activationBudget, allowFailure: old.allowFailure });
  }
  const companion = await compare([file('function calc(a=/(?<capture>a)/){return inspect(a);}')]);
  literalRuntime(companion, '/(?<capture>a)/', 'JSON.stringify(calc())', { setup: inspectSetup });
});

const cases = [
  [String.raw`^(?<word>[ab]+)\k<word>$`, 'dgy'],
  [String.raw`(?<word>a*)\k<word>`, 'u'],
  [String.raw`(?<word>a)?b\k<word>`, 'du'],
  [String.raw`\k<word>(?<word>a+)`, 'uy'],
  [String.raw`(?<word>a\k<word>)+`, ''],
  [String.raw`^(?<$_9>a|b)\k<$_9>+$`, 'ug'],
  [String.raw`(?<\u0061>a+)\k<a>`, 'u'],
  [String.raw`(?<a>a+)\k<\u{000061}>`, ''],
  [String.raw`(?<\u{61}>[ab]+)\k<\u0061>`, 'du'],
  [String.raw`(?<\u005f\u0024\u0039>a+)\k<_$9>`, ''],
  [String.raw`(?<word>a+)|(?<word>b+)`, 'u'],
  [String.raw`(?:(?<word>a+)|(?<word>b+))\k<word>`, 'd'],
  [String.raw`(?<outer>(?<inner>a+))\2\k<outer>\1`, 'u'],
  [String.raw`(?<=(a+))(?<word>b)\2\1\k<word>`, 'd'],
  [String.raw`(?<!((a)+))\2\1`, 'u'],
  [String.raw`(a|(b))\2\1+`, ''],
  [String.raw`\2(a)(b+)`, 'u'],
  [String.raw`(\1a)+`, ''],
  ['(?<word>^)', 'u'], ['(?<word>^|$)', ''], ['(?<word>|a)+?', 'u'],
  [String.raw`\b.\B`, 'u'], ['[A-Z]+', 'iu'], ['[a-z]+', 'ui'],
  [String.raw`[^a-z\d\W]{1,3}?`, 'usy'], [String.raw`^\/\\[+-]? $`, 'u'],
];
for (const count of [9, 10, 12, 99, 100, 1000]) cases.push([
  '(a)'.repeat(count) + `\\${count}+`, count % 2 ? '' : 'u',
  ['a'.repeat(count + 1), 'a'.repeat(count + 2), 'a'.repeat(count) + 'b'],
]);
for (const [index, atom] of [String.raw`(?<word>a+)\k<word>`, String.raw`(a+)\1`,
  String.raw`(?<\u0061>[ab]?)\k<a>`, String.raw`\1(a|b)`, String.raw`(?<=((a)+))\2`].entries()) {
  for (const [j, wrapper] of [x => `^${x}$`, x => `(?:${x}){1,2}?`, x => `(?=${x})|$`, x => `(?<!${x})`].entries()) {
    cases.push([wrapper(atom), ['', 'u', 'uydg', 'digu', 'msuy'][(index + j) % 5]]);
  }
}

test('bounded named/reference/Unicode corpus preserves exact weapon level-one order, duplicates and every runtime mutant', async t => {
  const records = [];
  let duplicateCases = 0;
  for (const [pattern, flags, extraInputs = []] of cases) {
    const literal = `/${pattern}/${flags}`;
    const pair = await compare([file(`const pattern=${literal};`)], options, [1, 4, 'auto']);
    const replacements = pair.actual.mutants.filter(m => m.mutatorName === 'Regex').map(m => m.replacement);
    assert.deepEqual(replacements, oracle(pattern, flags), literal);
    if (new Set(replacements).size < replacements.length) duplicateCases++;
    const environment = { setup: inspectSetup.replace(`const inputs=${JSON.stringify(samples)}`,
      () => `const inputs=${JSON.stringify([...samples, ...extraInputs])}`) };
    if (extraInputs.length) {
      const result = execute(pair.original, `const match=pattern.exec(${JSON.stringify(extraInputs[0])});
JSON.stringify([match!==null,match&&match.length,match&&match[match.length-1]])`);
      const captures = extraInputs[0].length - 1;
      assert.equal(result.error, undefined);
      assert.deepEqual(JSON.parse(result.value), [true, captures + 1, 'a'], 'multi-digit reference must match and capture');
    }
    // Node 22 rejects disjoint duplicate names accepted by newer engines.
    // Keep complete instrumentation parity and explicitly prove that engine's
    // compile failures instead of silently skipping these corpus entries.
    const duplicateNames = pattern === String.raw`(?<word>a+)|(?<word>b+)`
      || pattern === String.raw`(?:(?<word>a+)|(?<word>b+))\k<word>`;
    const original = duplicateNames ? execute(pair.original, 'undefined', undefined, environment) : undefined;
    if (original?.error) {
      assert.equal(original.error.name, 'SyntaxError');
      assert.match(original.error.message, /duplicate.*name/i);
      for (const active of [undefined, ...pair.actual.mutants.map(m => m.id)]) {
        for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
          const actual = execute(pair.actual, 'undefined', active, { ...environment, ...settings });
          assert.equal(actual.error?.name, 'SyntaxError');
          assert.deepEqual(actual, execute(pair.expected, 'undefined', active, { ...environment, ...settings }),
            'complete native/upstream compile failure and helper state');
        }
      }
      for (const mutant of pair.actual.mutants) {
        const direct = { files: [file(`const pattern=${mutant.replacement};`)] };
        assert.equal(execute(direct, 'undefined').error?.name, 'SyntaxError', 'every direct duplicate-name mutant remains rejected');
      }
    } else {
      literalRuntime(pair, literal, undefined, environment);
    }
    records.push({ pattern, flags, mutants: pair.actual.mutants, originalCompileError: original?.error });
  }
  // Duplicate boundary removals must remain distinct ordered mutants.
  const duplicate = await compare([file(String.raw`const pattern=/^^(?<word>a+)\k<word>$$/u;`)]);
  assert.deepEqual(duplicate.actual.mutants.map(m => m.replacement), oracle(String.raw`^^(?<word>a+)\k<word>$$`, 'u'));
  literalRuntime(duplicate, String.raw`/^^(?<word>a+)\k<word>$$/u`);
  assert.ok(new Set(duplicate.actual.mutants.map(m => m.replacement)).size < duplicate.actual.mutants.length);
  t.diagnostic(JSON.stringify({ patterns: cases.length + 1, records: records.reduce((n, r) => n + r.mutants.length, 0) + duplicate.actual.mutants.length,
    duplicateCases: duplicateCases + 1 }));
});

const clonedLiteral = String.raw`/^(?<word>[ab]+)\k<word>.$/uydg`;
test('raw names and flag order survive conditional default array logical Boolean and lookaround clone ancestors', async () => {
  const sources = [
    `function calc(x){return x?${clonedLiteral}:/(?<word>b)/u;}`,
    `function calc(x=${clonedLiteral}){return x;}`,
    `function calc(){return [${clonedLiteral},${clonedLiteral}];}`,
    `function calc(x){return x&&${clonedLiteral};}`,
    `function calc(x){return x||${clonedLiteral};}`,
    `function calc(x){return Boolean(x&&${clonedLiteral});}`,
    `function calc(x=${clonedLiteral}){return x?inspect(x):false;}`,
  ];
  for (const content of sources) {
    const pair = await compare([file(content)]);
    assert.ok(pair.actual.files[0].content.includes(clonedLiteral), content);
    runtime(pair, `JSON.stringify([undefined,false,true].map(input=>{try{const value=calc(input);
return value instanceof RegExp?inspect(value):Array.isArray(value)?value.map(p=>p instanceof RegExp?inspect(p):p):value;
}catch(error){return [error.name,error.message];}}))`, { setup: inspectSetup });
  }
  const escaped = String.raw`/^(?<\u0061>a+)\k<\u{61}>$/duy`;
  const pair = await compare([file(`function calc(x=${escaped}){return x;}`)]);
  assert.ok(pair.actual.files[0].content.includes(escaped));
  literalRuntime(pair, escaped, 'JSON.stringify(inspect(calc()))', { setup: inspectSetup });
});

test('same-object g/y state, named replacement strings/callbacks, captures and error/effect order agree', async () => {
  const pair = await compare([file(`const pattern=${clonedLiteral};const saved=pattern;
function calc(t){const before=pattern.lastIndex;const same=pattern===saved;
const first=pattern.exec(t);const fresh=${clonedLiteral};return [same,before,pattern.lastIndex,
first,first&&first.groups,first&&first.indices,first&&first.indices&&first.indices.groups,
fresh.exec(t),fresh.lastIndex,pattern===saved];}`)]);
  runtime(pair, `JSON.stringify(${JSON.stringify(samples)}.map(input=>calc(input)))`);
  const effects = await compare([file(`function calc(t){return receive(t,${clonedLiteral}).exec(next(t));}`)]);
  runtime(effects, `JSON.stringify(${JSON.stringify(samples)}.map(input=>{try{return calc(input);}catch(e){return [e.name,e.message];}}))`, {
    setup: `function receive(value,pattern){console.log('receive',value,pattern.source);if(value==='b')throw new TypeError('receiver failure');return pattern;}
function next(value){console.log('next',value);if(value==='a')throw new RangeError('argument failure');return value;}`,
  });
  const zero = await compare([file(String.raw`const pattern=/(?<word>a*)\k<word>/gu;`)]);
  literalRuntime(zero, String.raw`/(?<word>a*)\k<word>/gu`, `JSON.stringify((()=>{const rows=[];for(let i=0;i<6;i++){
const m=pattern.exec('😀a');rows.push([m&&[...m],m&&m.groups,m&&m.indices,pattern.lastIndex]);if(!m)break;}return rows;})())`);
});

test('selection comments directives namespaces noHeader all-ignored and zero-mutant results preserve complete records', async () => {
  const files = [file(`const astral='😀';\r\nconst pattern=${clonedLiteral};`, 'selected.js', [
    { start: { line: 1, column: 0 }, end: { line: 1, column: 100 } }]),
    file(`const off=${clonedLiteral};`, 'off.js', false),
    file(`// Stryker disable next-line Regex: retained name\nconst pattern=${clonedLiteral};
// Stryker disable Regex: first
const disabled=/(?<word>a+)\\k<word>/u;
// Stryker restore Regex
const restored=/(?<word>a+)\\k<word>/u;`, 'directives.js'),
    file(`namespace Named{export const pattern=${clonedLiteral};}`, 'namespace.ts')];
  for (const config of [options, { ...options, excludedMutations: ['Regex'] }, { ...options, noHeader: true }]) {
    await compare(files, config, [1, 4, 'auto']);
  }
  const namespace = await compare([file(`namespace Named{export const pattern=${clonedLiteral};}`, 'namespace.ts')]);
  runtime(namespace, 'JSON.stringify(inspect(Named.pattern))', { setup: inspectSetup });
  for (const content of [String.raw`const pattern=/(?<word>a)\k<word>/u;`, `// Stryker disable all: intentional\nconst pattern=${clonedLiteral};`]) {
    const pair = await compare([file(content)]);
    assert.ok(pair.actual.mutants.every(m => m.status === 'Ignored'));
    assert.equal(pair.actual.files[0].content, content);
    literalRuntime(pair, content.slice(content.indexOf('=') + 1, -1));
  }
  const excluded = await compare([file(`const pattern=${clonedLiteral};`)], { ...options, excludedMutations: ['Regex'] });
  assert.ok(excluded.actual.mutants.length > 0 && excluded.actual.mutants.every(m => m.status === 'Ignored'));
  literalRuntime(excluded, clonedLiteral);
  const header = (await new Instrumenter(logger).instrument([file('true;')], options)).files[0].content;
  const noHeader = await compare([file(`function calc(){return ${clonedLiteral};}`)], { ...options, noHeader: true });
  runtime(noHeader, 'JSON.stringify(inspect(calc()))', { setup: inspectSetup + header.slice(0, header.lastIndexOf('\n')) });
});

test('actual spawned parallel work recovers opaque relocation to exact serial bytes and a later smaller batch', async t => {
  const content = Array.from({ length: 32 }, (_, i) => `const p${i}=${clonedLiteral}.test('abab')&&(1+2>0);`).join('\n');
  const files = [file(content, 'large.js'), file(content, 'large.ts'),
    file(String.raw`type T=typeof stryMutAct_9fa48;const last=/(?<word>a+)\k<word>/u;`, 'opaque.ts')];
  await compare(files, options, [1, 4, 'auto']);
  const recovered = raw(files, options, 4);
  assert.ok(recovered.execution.spawnedThreads > 0);
  assert.equal(recovered.execution.serialRecoveries, 1);
  assert.equal(recovered.execution.reason, 'unproven-relocation');
  assert.deepEqual(recovered.result, raw(files).result);
  await compare([file(String.raw`const pattern=/(?<word>a+)\k<word>/u;`)], options, [1, 4, 'auto']);
  t.diagnostic(JSON.stringify(recovered.execution));
});

test('legacy numeric escapes unproven names Unicode syntax and empty bodies remain atomic with exact diagnostics', async () => {
  const unsupported = [String.raw`/\1/`, String.raw`/(a)\12+/`, String.raw`/\8+/`, String.raw`/\01+/`,
    '/(?<é>a+)/u', String.raw`/(?<\u00e9>a+)/u`, '/(?<a>)/', '/(?<a-b>a+)/', '/(?<1>a+)/',
    '/(?<a>a)(?<a>b)/', String.raw`/(?<a>a)\k<absent>/u`, String.raw`/\k<missing>/u`,
    '/(?<a>a+)/v', String.raw`/\p{L}+/u`, String.raw`/\u{1F600}+/u`, String.raw`/[a\-z]/u`,
    String.raw`/\x61+/u`, '/(?i:a+)/', '/(?<a>a{02})/u', 'new RegExp("(?<a>a+)","u")'];
  for (const expression of unsupported) {
    const files = [file(`const before=${clonedLiteral};`, 'before.js'), file(`const bad=${expression};`, 'bad.js'),
      file(String.raw`const after=/(?<word>b+)\k<word>/u;`, 'after.ts')];
    const ignored = [file(`// Stryker disable all: grammar still requires proof\nconst bad=${expression};`)];
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
    await native.instrument([file(String.raw`const next=/(?<word>a+)\k<word>/u;`)], options);
    assert.deepEqual([native.stats.nativeBatches, native.stats.fallbackBatches, native.stats.nativeErrors], [1, 0, 0]);
  }
  // Preserve each engine's natural malformed/unsupported compile result, including
  // weapon parse errors, without comparing Node error wording with Bun wording.
  for (const expression of ['/(?<a>)/u', '/(?<a-b>a+)/', '/(?<a>a)(?<a>b)/u', String.raw`/(?<a>a)\k<absent>/u`, '/(?<é>a+)/u']) {
    const original = { files: [file(`const pattern=${expression};`)] };
    const expected = await new Instrumenter(logger).instrument(original.files, options);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    const actual = await auto.instrument(original.files, options);
    runtime({ original, expected, actual }, 'JSON.stringify(inspect(pattern))', { setup: inspectSetup, allowFailure: true });
  }
});

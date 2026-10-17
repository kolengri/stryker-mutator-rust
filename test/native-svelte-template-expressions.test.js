import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { compile, VERSION } from 'svelte/compiler';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';


const require = createRequire(import.meta.url), render = require('svelte/server').render;
const artifact = new URL('../artifacts/native-svelte/template-expressions/', import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const file = (content, name = 'expressions.svelte', mutate = true) => ({ name, content, mutate });
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config, execution: threads === 'auto' ? {} : { threads } })));
async function receipt(name, value) {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
}
const pinned = "<script>\n    const athletes = [\n      { sport: \"Athletics\", name: \"Alice\", age: 16 },\n      { sport: \"Swimming\", name: \"Bob\", age: 18 },\n      { sport: \"Tennis\", name: \"Charlie\", age: 20 },\n    ];\n  \n    let a = 0;\n    let b = 0;\n    $: count = a + b;\n</script>\n  \n<main>\n    <button on:click={() => (a += 1)}>\n        increase a: {a}\n    </button>\n    <button on:click={() => (b += 1)}>\n        increase b: {b}\n    </button>\n    <button disabled={true}>\n        disabled button\n    </button>\n    <p>{a} + {b} = {count}.</p>\n\n    {#if a < 5}\n        <p>a is lower than 5, it's: {a}</p>\n    {:else if b < 5}\n        <p>b is lower than 5, it's: {b}</p>\n    {:else}\n        <p>just right! total: {a + b}</p>\n    {/if}\n\n    <table>\n        <tr>\n        <td>sport</td>\n        <td>name</td>\n        <td>age</td>\n        <td>of age</td>\n        </tr>\n        {#each athletes as athlete}\n        {@const ofAge = athlete.age >= 18}\n        <tr>\n            <td>{athlete.sport}</td>\n            <td>{athlete.name}</td>\n            <td>{athlete.age}</td>\n            <td>{ofAge ? \"Yes\" : \"No\"}</td>\n        </tr>\n        {/each}\n    </table>\n</main>\n  ";
const pinnedSha256 = 'fc3d798c6ef69694508e4f6b50682e76214d78df71cc3b03c06b039d47d38bfb';
// A separate, explicitly repaired companion. Never substitute it for the pinned
// resource: the original's direct table/tr structure must still fail compilation.
const companion = pinned.replace('<table>', '<table>\n        <tbody>').replace('</table>', '        </tbody>\n    </table>');
async function compare(files, config = options, threads = 1) {
  const direct = raw(files, threads, config);
  assert.equal(direct.supported, true, direct.reason);
  const actual = direct.result, expected = plain(await new Instrumenter(logger).instrument(files, config));
  assert.deepEqual(actual.mutants, expected.mutants, 'complete ordered records, including consumed-ID gaps');
  assert.deepEqual(actual.files.map(({ content, ...metadata }) => metadata), expected.files.map(({ content, ...metadata }) => metadata));
  const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
  assert.deepEqual(plain(await sut.instrument(files, config)), actual);
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  return { actual, expected, execution: direct.execution };
}
const programs = new Map();
function program(source) {
  assert.equal(VERSION, '5.57.2');
  if (!programs.has(source)) {
    const server = compile(source, { generate: 'server', dev: false, filename: 'expressions.svelte' });
    const client = compile(source, { generate: 'client', dev: false, filename: 'expressions.svelte' });
    const code = transformSync(server.js.code, { filename: 'expressions.js', configFile: false, babelrc: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
    programs.set(source, { script: new vm.Script(`(function(exports,require){${code}\n})(exports,require);`), serverSha256: hash(server.js.code), clientSha256: hash(client.js.code) });
  }
  return programs.get(source);
}
function execute(source, id, settings = {}) {
  const ns = { ...(!settings.afterLoad && !settings.afterRender ? { activeMutant: id } : {}), ...(settings.hitLimit === undefined ? {} : { hitLimit: settings.hitLimit, hitCount: 0 }) }, logs = [];
  const context = vm.createContext({ exports: {}, require, render, __stryker__: ns, console: { log: (...values) => logs.push(values) } });
  const errorOf = error => { assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT'); return { name: error.name, message: error.message }; };
  let loadError;
  try { program(source).script.runInContext(context, { timeout: 1000 }); } catch (error) { loadError = errorOf(error); }
  const loaded = plain(ns), rendered = [];
  if (settings.afterLoad) ns.activeMutant = id;
  for (let instance = 0; instance < 2; instance++) {
    if (instance === 1 && settings.afterRender) ns.activeMutant = id;
    ns.currentTestId = instance === 0 ? settings.currentTestId : 'second-instance';
    if (!loadError) try { const value = new vm.Script('render(exports.default)').runInContext(context, { timeout: 1000 }); rendered.push({ body: value.body, head: value.head }); } catch (error) { rendered.push({ error: errorOf(error) }); }
  }
  const globals = {};
  for (const name of ['a', 'b', 'count', 'athletes', 'athlete', 'ofAge', 'stryMutAct_9fa48']) globals[name] = vm.runInContext(`typeof ${name}`, context);
  return plain({ loaded, loadError, rendered, logs, ns, globals });
}
function runtime(pair, source) {
  const variants = [source, pair.expected.files[0].content, pair.actual.files[0].content];
  const compiled = variants.map(content => { const { script, ...metadata } = program(content); return metadata; });
  const original = execute(source), baseline = execute(variants[2]);
  assert.deepEqual([baseline.rendered, baseline.logs, baseline.globals], [original.rendered, original.logs, original.globals]);
  const cases = [];
  for (const id of [undefined, ...pair.actual.mutants.map(m => m.id)]) for (const settings of [{}, { afterLoad: true }, { afterRender: true }, { currentTestId: 'first' }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
    const actual = execute(variants[2], id, settings), expected = execute(variants[1], id, settings);
    assert.deepEqual(actual, expected, `${id}: ${JSON.stringify(settings)}`);
    cases.push({ id, settings, actual });
  }
  return { original, baseline, compiled, cases };
}

test('unchanged pinned compiler-invalid expression resource has all 31 native records and preserves genuine diagnostics', async () => {
  assert.equal(hash(pinned), pinnedSha256);
  try { assert.equal(await readFile(join(resolve(process.env.STRYKER_UPSTREAM ?? 'artifacts/upstream/stryker-js'), 'packages/instrumenter/testResources/instrumenter/svelte-template-expressions.svelte'), 'utf8'), pinned); }
  catch (error) { if (process.env.STRYKER_UPSTREAM !== undefined || error.code !== 'ENOENT') throw error; }
  const pair = await compare([file(pinned, 'svelte-template-expressions.svelte')]);
  assert.equal(pair.actual.mutants.length, 31);
  const errors = [];
  for (const [engine, source] of [['original', pinned], ['upstream', pair.expected.files[0].content], ['native', pair.actual.files[0].content]]) for (const generate of ['server', 'client']) {
    let failure;
    try { compile(source, { generate, dev: false, filename: 'svelte-template-expressions.svelte' }); } catch (error) { failure = { name: error.name, code: error.code, message: error.message, start: error.start, end: error.end, frame: error.frame }; }
    assert.equal(failure?.code, 'node_invalid_placement');
    assert.match(failure.message, /`<tr>` cannot be a child of `<table>`/);
    assert.deepEqual([failure.name, failure.code, failure.message], [errors[0]?.failure.name ?? failure.name, errors[0]?.failure.code ?? failure.code, errors[0]?.failure.message ?? failure.message]);
    errors.push({ engine, generate, failure });
  }
  await receipt('pinned', { source: pinned, sha256: hash(pinned), compiler: VERSION, ...pair, errors, diagnosticContract: 'Exact class, code and message. Generated source positions and frames differ; complete error objects are not equal.' });
});

test('separate explicit-tbody companion retains every capability and every mutant has genuine server execution', async () => {
  assert.notEqual(companion, pinned);
  const pair = await compare([file(companion, 'valid-template-expressions.svelte')]);
  assert.equal(pair.actual.mutants.length, 31);
  const pinnedPair = await compare([file(pinned)]);
  assert.deepEqual(pair.actual.mutants.map(({ location, fileName, ...record }) => record), pinnedPair.actual.mutants.map(({ location, fileName, ...record }) => record));
  const proof = runtime(pair, companion);
  assert.equal(proof.original.loadError, undefined);
  assert.ok(proof.original.rendered.every(r => !r.error));
  assert.match(proof.original.rendered[0].body, /Alice/);
  assert.match(proof.original.rendered[0].body, /Charlie/);
  assert.match(proof.original.rendered[0].body, /No/);
  assert.match(proof.original.rendered[0].body, /Yes/);
  assert.ok(proof.cases.some(r => Object.keys(r.actual.ns.mutantCoverage?.static ?? {}).length));
  assert.ok(proof.cases.some(r => Object.keys(r.actual.ns.mutantCoverage?.perTest?.first ?? {}).length));
  assert.ok(proof.cases.some(r => r.actual.rendered.some(v => /Hit count limit reached/.test(v.error?.message ?? ''))));
  await receipt('valid', { name: 'valid-template-expressions', source: companion, sha256: hash(companion), originalSha256: pinnedSha256, repair: 'Only add explicit tbody opening and closing tags around existing table children.', ...pair, runtime: proof });
});

const promoted = [
  '<script>let name="world";</script>{#if name}<p>{name}</p>{/if}',
  '<script>let name="world";</script><p>{name+1}</p>',
  '<script context="module">let name="world";</script><p>{name+1}</p>',
  '<div><script>let n=true;</script></div><p>{n+1}</p>',
  '<script>let n=1;</script><div>{n+1}</div>',
];
test('every exact promoted old negative retains complete ABI public compiler and execution proof', async () => {
  const rows = [];
  for (const [index, source] of promoted.entries()) {
    const pair = await compare([file(source)]), proof = runtime(pair, source);
    rows.push({ name: `promoted-${index}`, source, sha256: hash(source), ...pair, runtime: proof });
  }
  await receipt('promoted', rows);
});

test('expression scopes positions options placement and mixed-batch recovery match complete upstream records', async () => {
  const rows = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `<script context="module">function choose(value){return value;}</script>${newline}<script>let café=1;</script><button on:click={() => (café += 1)} disabled={true}>😀{café+1}{café<5?"low":"high"}{choose(choose(café))}</button>{#if café<2}<p>{café}</p>{:else if café<4}<p>{café+1}</p>{:else}<p>{café+2}</p>{/if}`;
    for (const mutate of [true, false, [], [{ start: { line: 0, column: 0 }, end: { line: 1, column: 999 } }]]) for (const excludedMutations of [[], ['CallExpression'], ['StringLiteral', 'ConditionalExpression'], ['BlockStatement', 'BooleanLiteral', 'ArithmeticOperator', 'AssignmentOperator', 'EqualityOperator', 'ConditionalExpression', 'StringLiteral', 'CallExpression']]) {
      const config = { ...options, noHeader: true, excludedMutations }, pair = await compare([file(source, 'positions.svelte', mutate)], config);
      program(pair.actual.files[0].content);
      assert.equal(pair.actual.files[0].content.includes('function stryNS_9fa48'), pair.actual.mutants.some(m => m.status !== 'Ignored'));
      rows.push({ source, mutate, config, ...pair });
    }
  }
  for (const directive of ['// Stryker disable all: instance only\n', '// Stryker disable next-line ArrayDeclaration: instance array\n']) {
    const source = companion.replace('<script>\n', '<script>\n'+directive), pair = await compare([file(source)]);
    assert.ok(pair.actual.mutants.some(m => m.status === 'Ignored'));
    rows.push({ source, ...pair });
  }
  const files = [file('let before=true;', 'before.js'), file(companion, 'first.svelte'), file(companion, 'second.svelte'), file('let after=false;', 'after.js')];
  const baseline = raw(files);
  for (const threads of [1, 4, 'auto']) {
    const pair = await compare(files, options, threads);
    assert.deepEqual(pair.actual, baseline.result);
    const rejected = [...files, file('<script>let n=1;</script>{#each [n] as {value}}<p>{value}</p>{/each}', 'unproved.svelte')];
    assert.equal(raw(rejected, threads).supported, false); assert.equal(raw(rejected, threads).result, undefined);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    await assert.rejects(sut.instrument(rejected, options), /unsupported/i);
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    assert.deepEqual(plain(await sut.instrument([], options)), raw([]).result);
    if (pair.execution.spawnedThreads) assert.equal(pair.execution.serialRecoveries, 1);
    rows.push({ threads, execution: pair.execution });
  }
  for (const source of ['<script>let n=1;</script><button on:click|once={() => (n+=1)}>x</button>', '<script>let n=1;</script>{#each [n] as item, i}<p>{i}</p>{/each}', '<script>let n=1;</script>{#each [n] as item (item)}<p>{item}</p>{/each}', '<script>let n=1;</script><p>{n?.value}</p>', '<script>let n=1;</script><p>{choose(()=>n)}</p>', '<script>let n=1;</script>{@const value=n}<p>{value}</p>']) assert.equal(raw([file(source)]).supported, false, source);
  await receipt('modes', { files, result: baseline.result, rows });
});

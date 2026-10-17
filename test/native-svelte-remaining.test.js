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
const artifact = new URL('../artifacts/native-svelte/remaining/', import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const file = (content, name = 'component.svelte', mutate = true) => ({ name, content, mutate });
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config, execution: threads === 'auto' ? {} : { threads } })));
const receipt = async (name, value) => {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
};
const fixtures = {
  "svelte-template-call-expression.svelte": "<script>\n  export function sum(a, b) {\n    return a + b;\n  }\n</script>\n\n<main>\n  <p>1 + 2 = {sum(1, 2)}</p>\n</main>\n",
  "svelte-template-expressions.svelte": "<script>\n    const athletes = [\n      { sport: \"Athletics\", name: \"Alice\", age: 16 },\n      { sport: \"Swimming\", name: \"Bob\", age: 18 },\n      { sport: \"Tennis\", name: \"Charlie\", age: 20 },\n    ];\n  \n    let a = 0;\n    let b = 0;\n    $: count = a + b;\n</script>\n  \n<main>\n    <button on:click={() => (a += 1)}>\n        increase a: {a}\n    </button>\n    <button on:click={() => (b += 1)}>\n        increase b: {b}\n    </button>\n    <button disabled={true}>\n        disabled button\n    </button>\n    <p>{a} + {b} = {count}.</p>\n\n    {#if a < 5}\n        <p>a is lower than 5, it's: {a}</p>\n    {:else if b < 5}\n        <p>b is lower than 5, it's: {b}</p>\n    {:else}\n        <p>just right! total: {a + b}</p>\n    {/if}\n\n    <table>\n        <tr>\n        <td>sport</td>\n        <td>name</td>\n        <td>age</td>\n        <td>of age</td>\n        </tr>\n        {#each athletes as athlete}\n        {@const ofAge = athlete.age >= 18}\n        <tr>\n            <td>{athlete.sport}</td>\n            <td>{athlete.name}</td>\n            <td>{athlete.age}</td>\n            <td>{ofAge ? \"Yes\" : \"No\"}</td>\n        </tr>\n        {/each}\n    </table>\n</main>\n  ",
  "svelte-ts.svelte": "<script lang=\"ts\" context=\"module\">\n    function add(a: number, b: number) {\n        return a + b;\n    }\n</script>\n\n<script lang=\"ts\">\n    import type { Athlete } from './athlete.js';\n\n    const athletes: Athlete[] = [\n      { sport: \"Athletics\", name: \"Alice\", age: 16 },\n      { sport: \"Swimming\", name: \"Bob\", age: 18 },\n      { sport: \"Tennis\", name: \"Charlie\", age: 20 },\n    ];\n  \n    let a = 0;\n    let b = 0;\n    $: count = a + b;\n</script>\n\n<main>\n   <script lang=\"ts\">\n    function subtract(a: number, b: number) {\n        return a - b;\n    }\n   </script>\n</main>\n  "
};
const fingerprints = {
  "svelte-template-call-expression.svelte": {
    "sha256": "9ccd566d236b7c99d256146c2cf04e4f9fe59cbe35faabce8384979f84bb2e96",
    "mutants": 3
  },
  "svelte-template-expressions.svelte": {
    "sha256": "fc3d798c6ef69694508e4f6b50682e76214d78df71cc3b03c06b039d47d38bfb",
    "mutants": 31
  },
  "svelte-ts.svelte": {
    "sha256": "eb124c715d0dc2e8a0346145c8d99b7b6eddc7abcb9a63e5e831677f1a577ac0",
    "mutants": 15
  }
};

async function resource(name, source) {
  assert.equal(hash(source), fingerprints[name].sha256);
  try { assert.equal(await readFile(join(resolve(process.env.STRYKER_UPSTREAM ?? 'artifacts/upstream/stryker-js'), 'packages/instrumenter/testResources/instrumenter', name), 'utf8'), source); }
  catch (error) { if (process.env.STRYKER_UPSTREAM !== undefined || error.code !== 'ENOENT') throw error; }
}
async function compare(files, config = options, threads = 1) {
  const direct = raw(files, threads, config);
  assert.equal(direct.supported, true, direct.reason);
  const actual = direct.result, expected = plain(await new Instrumenter(logger).instrument(files, config));
  assert.deepEqual(actual.mutants, expected.mutants);
  assert.deepEqual(actual.files.map(({ content, ...metadata }) => metadata), expected.files.map(({ content, ...metadata }) => metadata));
  const native = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
  assert.deepEqual(plain(await native.instrument(files, config)), actual);
  assert.deepEqual([native.stats.nativeBatches, native.stats.fallbackBatches, native.stats.nativeErrors], [1, 0, 0]);
  return { actual, expected, execution: direct.execution };
}
const programs = new Map();
function program(source) {
  assert.equal(VERSION, '5.57.2');
  if (!programs.has(source)) {
    // Both compiler targets must succeed before runtime errors are collected.
    const server = compile(source, { generate: 'server', dev: false, filename: 'remaining.svelte' });
    const client = compile(source, { generate: 'client', dev: false, filename: 'remaining.svelte' });
    const code = transformSync(server.js.code, { filename: 'remaining.js', configFile: false, babelrc: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
    programs.set(source, { script: new vm.Script(code), clientSha256: hash(client.js.code), serverSha256: hash(server.js.code) });
  }
  return programs.get(source);
}
function execute(source, id, settings = {}) {
  const compiled = program(source), ns = { ...(!settings.afterLoad && !settings.afterRender ? { activeMutant: id } : {}), ...(settings.hitLimit === undefined ? {} : { hitLimit: settings.hitLimit, hitCount: 0 }) }, logs = [];
  const context = vm.createContext({ exports: {}, require, render, __stryker__: ns, console: { log: (...values) => logs.push(values) } });
  const errorOf = error => { assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT'); return { name: error.name, message: error.message }; };
  let loadError;
  try { compiled.script.runInContext(context, { timeout: 1000 }); } catch (error) { loadError = errorOf(error); }
  const loaded = plain(ns), rendered = [];
  if (settings.afterLoad) ns.activeMutant = id;
  for (let instance = 0; instance < 2; instance++) {
    if (instance === 1 && settings.afterRender) ns.activeMutant = id;
    ns.currentTestId = instance === 0 ? settings.currentTestId : 'second-instance';
    if (!loadError) try { const value = new vm.Script('render(exports.default)').runInContext(context, { timeout: 1000 }); rendered.push({ body: value.body, head: value.head }); } catch (error) { rendered.push({ error: errorOf(error) }); }
  }
  return plain({ loaded, loadError, rendered, logs, ns });
}

// Keep the original three resources byte-for-byte. Counts are secondary to full
// ordered records, file metadata, strict public dispatch, compiler and runtime.
test('remaining pinned resources have complete ordered native ABI/public records and real Svelte compiler execution', async () => {
  const rows = [];
  for (const [name, source] of Object.entries(fixtures)) {
    await resource(name, source);
    if (name === 'svelte-template-expressions.svelte') continue;
    const pair = await compare([file(source, name)]);
    assert.equal(pair.actual.mutants.length, fingerprints[name].mutants, name);
    const variants = [source, pair.expected.files[0].content, pair.actual.files[0].content];
    const compiled = variants.map(content => { const { script, ...metadata } = program(content); return metadata; });
    const original = execute(source), baseline = execute(variants[2]);
    assert.equal(original.loadError, undefined); assert.equal(baseline.loadError, undefined);
    assert.ok(original.rendered.every(value => !value.error)); assert.ok(baseline.rendered.every(value => !value.error));
    if (!name.includes('-ts.')) assert.deepEqual([baseline.rendered, baseline.logs], [original.rendered, original.logs]);
    const cases = [];
    for (const id of [undefined, ...pair.actual.mutants.map(mutant => mutant.id)]) for (const settings of [{}, { afterLoad: true }, { afterRender: true }, { currentTestId: 'first' }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(variants[2], id, settings), expected = execute(variants[1], id, settings);
      // Typed nested script text is emitted, never executed, by SSR. Its
      // original natural browser syntax errors are qualified in the client gate.
      if (!name.includes('-ts.')) assert.deepEqual(actual, expected, `${name}: ${id}: ${JSON.stringify(settings)}`);
      else {
        assert.deepEqual(actual.loaded, expected.loaded);
        assert.deepEqual(actual.ns, expected.ns);
        assert.deepEqual(actual.rendered.map(({ error, head }) => ({ error, head })), expected.rendered.map(({ error, head }) => ({ error, head })));
      }
      cases.push({ id, settings, actual, expected });
    }
    rows.push({ name, source, sha256: hash(source), ...pair, compiled, original, baseline, cases });
  }
  await receipt('fixtures', rows);
});

const promoted = [
  '<script lang="ts">let name:string="world";</script>',
  '<script>let name="world";</script><p>{name()}</p>',
  '<script>$: name="world";</script><p>{name}</p>',
  '<div><script lang="ts">let n:boolean=true;</script></div>',
  '<div><script lang="ts">let name:string="nested";</script></div>',
];
test('every promoted exact old boundary keeps strict records compiler acceptance and original natural server behavior', async () => {
  const rows = [];
  for (const source of promoted) {
    const pair = await compare([file(source)]);
    for (const value of [source, pair.actual.files[0].content, pair.expected.files[0].content]) program(value);
    const original = execute(source), actual = execute(pair.actual.files[0].content);
    const nested = source.includes('<div><script');
    assert.deepEqual(actual.rendered.map(value => value.error), original.rendered.map(value => value.error));
    assert.deepEqual(actual.logs, original.logs);
    if (!nested) assert.deepEqual(actual.rendered, original.rendered);
    rows.push({ source, ...pair, original, runtime: actual });
  }
  await receipt('promoted-boundaries', rows);
});

test('template calls use void zero subtree filtering monotonic IDs selections directives and source-relative positions', async () => {
  const rows = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `<script context="module">function choose(value){return value;}</script>${newline}<script>let café=true;</script><div>😀{choose(choose(café))}{choose("value")}{choose(café+1)}</div>`;
    for (const mutate of [true, false, [], [{ start: { line: 0, column: 0 }, end: { line: 2, column: 999 } }]]) for (const excludedMutations of [[], ['CallExpression'], ['StringLiteral']]) {
      const config = { ...options, noHeader: true, excludedMutations }, pair = await compare([file(source, 'positions.svelte', mutate)], config);
      program(pair.actual.files[0].content);
      rows.push({ source, mutate, config, ...pair });
    }
  }
  const source = '<script>function use(value){return value;}let n=true;</script><p>{use(n)}</p><script context="module">const value="module";</script>';
  const pair = await compare([file(source)]);
  assert.equal(pair.actual.mutants[0].mutatorName, 'StringLiteral', 'later module transforms first');
  rows.push({ source, ...pair });
  await receipt('positions-filtering', rows);
});

test('mixed JS Svelte serial four auto recovery inactive empty unsupported and configuration batches remain atomic', async () => {
  const files = [file('let before=true;', 'before.js'), ...Object.entries(fixtures).filter(([name]) => name !== 'svelte-template-expressions.svelte').map(([name, source]) => file(source, name)), file('let after=false;', 'after.js')];
  const baseline = raw(files), rows = [];
  assert.equal(baseline.supported, true, baseline.reason);
  for (const threads of [1, 4, 'auto']) {
    const pair = await compare(files, options, threads);
    assert.deepEqual(pair.actual, baseline.result);
    for (const mutate of [false, []]) {
      const inactive = files.map(value => ({ ...value, mutate }));
      await compare(inactive, options, threads);
    }
    await compare([], options, threads);
    const unsupported = [...files, file('<script>let n=1;</script><p>{(n)}</p>', 'unproved.svelte')];
    assert.equal(raw(unsupported, threads).supported, false);
    assert.equal(raw(unsupported, threads).result, undefined);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    await assert.rejects(sut.instrument(unsupported, options), /unsupported/i);
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    if (pair.execution.spawnedThreads) { assert.equal(pair.execution.serialRecoveries, 1); assert.equal(pair.execution.reason, 'unproven-relocation'); }
    rows.push({ threads, execution: pair.execution });
  }
  for (const config of [{ ...options, plugins: ['jsx'] }, { ...options, ignorers: ['unknown'] }]) { assert.equal(raw(files, 1, config).supported, false); assert.equal(raw(files, 1, config).result, undefined); }
  await receipt('modes', { files, result: baseline.result, rows });
});

test('unchanged expressions resource is native with all 31 records and preserves its genuine compiler-invalid structure', async () => {
  const name = 'svelte-template-expressions.svelte', source = fixtures[name];
  await resource(name, source);
  assert.equal(VERSION, '5.57.2');
  const files = [file(source, name)], pair = await compare(files), expected = pair.expected;
  assert.equal(pair.actual.mutants.length, 31);
  assert.equal(expected.mutants.length, 31);
  const errors = [];
  for (const [engine, content] of [['original', source], ['upstream', expected.files[0].content], ['native', pair.actual.files[0].content]]) for (const generate of ['server', 'client']) {
    let failure;
    try { compile(content, { generate, dev: false, filename: name }); } catch (error) { failure = { name: error.name, code: error.code, message: error.message, start: error.start, end: error.end, frame: error.frame }; }
    assert.equal(failure?.code, 'node_invalid_placement', `${engine} ${generate} must exercise the actual original compiler blocker`);
    assert.match(failure.message, /`<tr>` cannot be a child of `<table>`/);
    errors.push({ engine, generate, failure });
  }
  for (const threads of [1, 4, 'auto']) {
    const mixed = [file('let before=true;', 'before.js'), ...files];
    await compare(mixed, options, threads);
  }
  await receipt('qualified-compiler-invalid-expressions', { name, source, sha256: hash(source), compiler: VERSION, ...pair, errors, diagnosticContract: "Exact class/code/message; generated positions and frames differ." });
});

test('broader template and TypeScript compiler grammar remains unproved atomic fallback', async () => {
  const sources = [
    '<script lang="ts">enum Choice { One }</script>',
    '<script lang="ts">namespace Values { export const n=1; }</script>',
    '<script lang="ts">class Item { constructor(public n:number){} }</script>',
    '<script lang="ts">type Name=string;let name:Name="world";</script>',
    '<script lang="ts">let value:number|boolean=true;</script>',
    '<script lang="ts">let n=1 as number;</script>',
    '<script lang="ts">import value from "module";</script>',
    '<script lang="ts">export let value=true;</script>',
    '<script>let n=1;</script><p>{choose(() => n)}</p>',
    '<script>let n=1;</script><p>{choose(n=2)}</p>',
    '<script>let n=1;</script><p>{choose(n.value)}</p>',
    '<script>let n=1;</script><p>{choose?.(n)}</p>',
    '<script>let n=1;</script><p>{choose<string>(n)}</p>',
    '<script>let n=1;</script><p>{(choose(n))}</p>',
  ];
  for (const source of sources) { const direct=raw([file(source)]); assert.equal(direct.supported, false, source); assert.equal(direct.result, undefined); }
  await receipt('unproved-boundaries', sources);
});

const clientProbes = {
  reactive: '<script lang="ts" context="module">let visits=0;function add(a:number,b:number){return a+b;}visits+=1;</script><script lang="ts">let a:number=0;$: count=a+1;export function step(){a+=1;}export function observe(){return add(visits,0);}</script><p>{count}</p>',
  private: '<script>export function read(){return "private";}</script><p>{read()}</p>',
  other: '<script>export function read(){return "other";}</script><p>{read()}</p>',
};
test('typed reactive declarations and exported function probes keep complete records and genuine compiler behavior', async () => {
  const rows = [];
  for (const [name, source] of Object.entries(clientProbes)) {
    const pair = await compare([file(source, `${name}.svelte`)]);
    for (const value of [source, pair.actual.files[0].content, pair.expected.files[0].content]) program(value);
    const original = execute(source), baseline = execute(pair.actual.files[0].content);
    assert.deepEqual(baseline.rendered, original.rendered);
    rows.push({ name, source, ...pair });
  }
  await receipt('client-probes', rows);
});

test('template-only placements exclusions directives and shared component batches preserve actual-header ownership', async () => {
  const source = '<script>const show=Math.abs;</script><p>{show(1)}</p>';
  const rows = [];
  for (const excludedMutations of [[], ['BlockStatement', 'BooleanLiteral', 'CallExpression']]) for (const mutate of [true, false, []]) {
    const config = { ...options, noHeader: true, excludedMutations }, pair = await compare([file(source, 'header.svelte', mutate)], config);
    const placed = pair.actual.mutants.some(mutant => mutant.status !== 'Ignored');
    assert.ok(pair.actual.mutants.every(mutant => mutant.mutatorName === 'CallExpression'));
    assert.deepEqual(execute(pair.actual.files[0].content).rendered, execute(source).rendered);
    assert.equal(pair.actual.files[0].content.includes('function stryNS_9fa48'), placed);
    program(pair.actual.files[0].content);
    rows.push({ source, mutate, config, ...pair });
  }
  for (const directive of ['// Stryker disable all: template boundary\n', '// Stryker disable next-line CallExpression: one call\n']) {
    const input = `<script>export function show(value){return value;}</script><p>{${directive}show(true)}</p>`;
    const direct = raw([file(input)]);
    // Comments outside supported statement-list boundaries stay atomic fallback.
    assert.equal(direct.supported, false, 'template comment provenance remains unproved');
    assert.equal(direct.result, undefined);
  }
  const shared = await compare([file(clientProbes.private, 'private.svelte'), file(clientProbes.other, 'other.svelte')]);
  await receipt('client-shared', { sources: [clientProbes.private, clientProbes.other], ...shared });
  await receipt('placement-headers', rows);
});

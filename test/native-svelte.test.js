import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { compile, parse, VERSION } from 'svelte/compiler';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from 'stryker-mutator-rust/instrumenter';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const render = require('svelte/server').render;
const artifact = new URL('../artifacts/native-svelte/first-adapter/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const file = (content, name = 'component.svelte', mutate = true) => ({ name, content, mutate });
const sample = "<script>\n\tlet name = 'world';\n</script>\n\n<h1>Hello {name}!</h1>";
const sampleSha = 'd3327c25e3d2bb5279894859695b74889bf29a990b365cc12deaaafcee7dafef';
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));
const receipt = async (name, value) => {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
};

function preservedOuter(original, output) {
  const before = parse(original, { modern: true });
  let after = parse(output, { modern: true });
  if (after.module) {
    assert.equal(after.module.start, 0);
    assert.equal(output[after.module.end], '\n');
    output = output.slice(after.module.end + 1);
    after = parse(output, { modern: true });
  }
  const oldScript = before.instance.content, newScript = after.instance.content;
  assert.equal(output.slice(0, newScript.start), original.slice(0, oldScript.start));
  assert.equal(output.slice(newScript.end), original.slice(oldScript.end));
}

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'strict ABI complete ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public /instrumenter complete ordered records');
  assert.deepEqual(plain(actual), direct.result, 'public and ABI output bytes/metadata');
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  const metadata = result => result.files.map(({ content, ...meta }) => meta);
  assert.deepEqual(metadata(actual), metadata(expected));
  assert.deepEqual(metadata(actual), metadata({ files }));
  for (let index = 0; index < files.length; index++) {
    if (/\.svelte$/i.test(files[index].name)) preservedOuter(files[index].content, actual.files[index].content);
  }
  return { actual, expected };
}

const compiled = new Map();
const compilerOptions = { generate: 'server', dev: false, filename: 'component.svelte' };
function executable(content) {
  assert.equal(VERSION, '5.57.2', 'runtime proof uses the pinned, unchanged real Svelte compiler');
  if (!compiled.has(content)) {
    // Apply identical installed compiler options AFTER instrumentation to each
    // original/upstream/native input. A compile failure is never parity evidence.
    const result = compile(content, compilerOptions);
    const code = transformSync(result.js.code, {
      filename: 'compiled-svelte.js', configFile: false, babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    }).code;
    compiled.set(content, new vm.Script(code, { filename: 'compiled-svelte.js' }));
  }
  return compiled.get(content);
}

function execute(content, id, settings = {}) {
  const ns = { ...(settings.afterLoad || settings.afterRender || settings.fromEnv ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const logs = [];
  const context = vm.createContext({ exports: {}, require, render, __stryker__: ns,
    process: { env: settings.fromEnv && id !== undefined ? { __STRYKER_ACTIVE_MUTANT__: id } : {} },
    console: { log: (...values) => logs.push(values) } });
  const errorOf = error => {
    assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeouts invalidate the proof');
    return { name: error.name, message: error.message };
  };
  const program = executable(content);
  let loadError;
  try { program.runInContext(context, { timeout: 1000 }); }
  catch (error) { loadError = errorOf(error); }
  // Compilation above is outside the catch: syntax errors cannot masquerade as
  // matching runtime outcomes. Module evaluation occurs once, instance code
  // executes on each actual server render, with helpers shared by both instances.
  const loaded = plain(ns);
  const rendered = [];
  if (settings.afterLoad) ns.activeMutant = id;
  for (let instance = 0; instance < 2; instance++) {
    if (instance === 1 && settings.afterRender) ns.activeMutant = id;
    ns.currentTestId = instance === 0 ? settings.currentTestId : 'second-instance';
    try {
      const result = new vm.Script('render(exports.default)').runInContext(context, { timeout: 1000 });
      rendered.push({ body: result.body, head: result.head });
    } catch (error) { rendered.push({ error: errorOf(error) }); }
  }
  return plain({ loaded, loadError, rendered, logs, ns });
}

function runtime(pair, original) {
  // Force all three compiler invocations outside runtime-error capture.
  for (const content of [original, pair.actual.files[0].content, pair.expected.files[0].content]) executable(content);
  const baseline = execute(pair.actual.files[0].content);
  const unchanged = execute(original);
  assert.equal(unchanged.loadError, undefined);
  assert.equal(baseline.loadError, undefined);
  for (const rendered of [...unchanged.rendered, ...baseline.rendered]) {
    assert.equal(rendered.error, undefined, 'baseline must render successfully');
    assert.match(rendered.body, /<!--\[-->/, 'real Svelte renderer ran');
  }
  assert.deepEqual([baseline.rendered, baseline.logs], [unchanged.rendered, unchanged.logs]);
  const cases = [];
  let changed = false, staticCovered = false, perTestCovered = false, limited = false;
  for (const id of [undefined, ...pair.expected.mutants.map(mutant => mutant.id)]) {
    for (const settings of [{}, { afterLoad: true, currentTestId: 'first-instance' }, { afterRender: true },
      { currentTestId: '' }, { currentTestId: 'first-instance' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }, { fromEnv: true }]) {
      const actual = execute(pair.actual.files[0].content, id, settings);
      const expected = execute(pair.expected.files[0].content, id, settings);
      assert.deepEqual(actual, expected, `mutant ${id}: ${JSON.stringify(settings)}`);
      changed ||= id !== undefined && settings.hitLimit === undefined && JSON.stringify([actual.rendered, actual.logs]) !== JSON.stringify([baseline.rendered, baseline.logs]);
      staticCovered ||= Object.keys(actual.ns.mutantCoverage?.static ?? {}).length > 0;
      perTestCovered ||= Object.values(actual.ns.mutantCoverage?.perTest ?? {}).some(coverage => Object.keys(coverage).length > 0);
      limited ||= actual.rendered.some(result => /Hit count limit reached/.test(result.error?.message ?? ''));
      cases.push({ id, settings, actual });
    }
  }
  if (pair.expected.mutants.some(mutant => mutant.status !== 'Ignored')) {
    assert.ok(staticCovered, 'static coverage executes');
    assert.ok(perTestCovered, 'per-test coverage executes across repeated instances');
    assert.ok(limited, 'active mutation hit limits execute');
  }
  return { compilerVersion: VERSION, compilerOptions, original: unchanged, baseline, changed, cases };
}

test('unchanged 63-byte pinned hello world has one complete ordered native record and every mutant really renders', async () => {
  assert.equal(Buffer.byteLength(sample), 63);
  assert.equal(hash(sample), sampleSha);
  const root = resolve(process.env.STRYKER_UPSTREAM ?? 'artifacts/upstream/stryker-js');
  let comparedResource = null;
  try {
    const resource = join(root, 'packages/instrumenter/testResources/instrumenter/svelte-hello-world.svelte');
    assert.equal(await readFile(resource, 'utf8'), sample);
    comparedResource = resource;
  } catch (error) {
    if (process.env.STRYKER_UPSTREAM !== undefined || error.code !== 'ENOENT') throw error;
  }
  const files = [file(sample, 'svelte-hello-world.svelte')];
  const pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 1);
  assert.deepEqual(plain(pair.actual.mutants[0]), {
    id: '0', fileName: 'svelte-hello-world.svelte', mutatorName: 'StringLiteral', replacement: '""',
    location: { start: { line: 1, column: 12 }, end: { line: 1, column: 19 } },
  });
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  assert.deepEqual(await sut.instrument(files, options), pair.actual);
  assert.deepEqual(await sut.instrument(files, options), pair.actual);
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [2, 0, 0]);
  const proof = runtime(pair, sample);
  assert.ok(proof.changed, 'the active pinned mutant changes actual rendering');
  await receipt('hello-world', { sha256: sampleSha, comparedResource, input: files, native: pair.actual, upstream: pair.expected, runtime: proof });
});

test('general balanced markup Unicode identifiers CRLF and instance lifecycle reuse shared module helpers', async () => {
  const ledger = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `<div>😀</div>${newline}<script>${newline}let café = 'world';${newline}console.log(café);${newline}</script>${newline}<section><h2>Hello { café }</h2><p>static</p></section>`;
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants[0].location.start.line, 2);
    assert.equal(pair.actual.mutants[0].location.start.column, 11);
    const proof = runtime(pair, source);
    assert.ok(proof.changed, 'active mutations change rendering or instance lifecycle');
    assert.equal(proof.baseline.logs.length, 2, 'one instance execution on each real render');
    assert.equal(proof.baseline.loaded.mutantCoverage, undefined, 'module header loads without executing instance coverage');
    ledger.push({ source, records: pair.actual.mutants, runtime: proof });
  }
  for (const source of ['<script>const name="outer";function change(){let name="inner";name="changed";return name;}let value=change();</script><p>{value}{name}</p>', '<script>const record={value:"world"};record.value="after";let name=record.value;</script><p>{name}</p>', '<script>const flag=true;</script>', '<script></script>', '<script>let count=1;</script><div>static<span> nested</span></div>', '<div></div><script>let flag=true;</script>', '<script>let name="😀";</script><p>{name}</p>']) {
    const pair = await compare([file(source)]);
    ledger.push({ source, runtime: runtime(pair, source) });
  }
  await receipt('general-subset', ledger);
});

test('original offset projection selection and directive ownership exclusions noHeader and no mutants match upstream', async () => {
  const source = '<p>😀</p>\r\n<script>// Stryker disable next-line StringLiteral: intentional\r\nlet name="world";\r\nlet flag=true;\r\n</script><div>{name}{flag}</div>';
  const ledger = [];
  for (const mutate of [true, false, [], [{ start: { line: 0, column: 0 }, end: { line: 1, column: 99 } }], [{ start: { line: 1, column: 0 }, end: { line: 3, column: 99 } }]]) {
    for (const excludedMutations of [[], ['StringLiteral', 'BooleanLiteral']]) {
      const pair = await compare([file(source, 'selected.svelte', mutate)], { ...options, excludedMutations });
      ledger.push({ mutate, excludedMutations, native: pair.actual, runtime: runtime(pair, source) });
    }
  }
  for (const config of [options, { ...options, noHeader: true }]) {
    const pair = await compare([file(sample)], config);
    assert.equal((pair.actual.files[0].content.match(/<script context="module">/g) ?? []).length, 1);
    assert.equal((pair.actual.files[0].content.match(/function stryNS_9fa48\(/g) ?? []).length, 1);
    runtime(pair, sample);
  }
  for (const [content, mutate, config] of [
    ['<script>// Stryker disable all: intentional\nlet name="world";</script><p>{name}</p>', true, options],
    [sample, false, options], [sample, true, { ...options, excludedMutations: ['StringLiteral'] }],
    ['<script>let count=1;</script>', true, options], ['<script></script>', true, options],
  ]) {
    const pair = await compare([file(content, 'inert.svelte', mutate)], config);
    assert.doesNotMatch(pair.actual.files[0].content, /<script context="module">/);
    runtime(pair, content);
    ledger.push({ input: content, mutate, config, records: pair.actual.mutants });
  }
  await receipt('options-and-locations', ledger);
});

const unsupported = [
  '<script context="module">export const name="world";</script>',
  '<script module>const name="world";</script>',
  '<script lang="js">let name="world";</script>',
  '<script>let name="world";</script><script>let other=true;</script>',
  '<script>let name="world";</script><style>p{color:red}</style>',
  '<script>let name="world";</script><Component/>',
  '<script>let name="world";</script><p class="x">{name}</p>',
  '<script>let name="world";</script><p class:x={name}>{name}</p>',
  '<script>let name="world";</script>{#key name}<p>{name}</p>{/key}',
  '<script>let name="world";</script>{@html name}',
  '<script>let name="world";</script><p>{name?.length}</p>',
  '<script>let name="world";</script><p>{(name)}</p>',
  '<script>let name="world";</script><p>{\\u006eame}</p>',
  '<script>let script0="world";</script><p>{script0}</p>',
  '<script>let name="world";</script><p>&amp;</p>',
  '<script>let name="world";</script><!-- Stryker disable all -->',
  '<svelte:options runes={false}/><script>let name="world";</script>',
  '\ufeff<script>let name="world";</script>',
  '<script>let name="world";</script><p>open',
  '<script>let name="world";</script><p><div>x</div></p>',
  '<script>let name="world";</script><p>{name</p>',
  '<script>let name=;</script><p>{name}</p>',
  '<script/>',
  '<script>let $name="world";</script><p>{$name}</p>',
  '<script>let name=$state("world");</script><p>{name}</p>',
  '<script>export default {name:"world"};</script>',
  '<script>export let name="world";</script><p>{name}</p>',
  '<script>import name from "module";</script><p>{name}</p>',
  '<script>let stryCov_9fa48=true;</script>',
  '<script>let name="world";</script><p>{stryCov_9fa48}</p>',
  '<script>const name="world";name="other";</script><p>{name}</p>',
  '<script>const name="world";function change(){name="other";}</script><p>{name}</p>',
  '<script>const name="world";name++;</script>',
  '<script>const name="world";for(name of ["other"]){};</script>',
  '<script>let globalThis=true;</script>',
  '<script>function calc(Error){return true;}</script>',
  '<script>function calc(){return receiver.tag`x`;}</script>',
];

// Exact remaining resource bytes are preserved across the native/fallback boundary.
const retainedFixtures = {
  "svelte-multiple-script-tags.svelte": "<script context=\"module\">\n\tlet name = 'test';\n</script>\n\n<script>\n\tlet name = 'world';\n</script>\n\n<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<h1>\n\t\t{name}\n\t</h1>\n</div>",
  "svelte-only-template-script-tags.svelte": "<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<script>\n\t\tlet test = 'test'\n\t</script>\n</div>",
  "svelte-template-call-expression.svelte": "<script>\n  export function sum(a, b) {\n    return a + b;\n  }\n</script>\n\n<main>\n  <p>1 + 2 = {sum(1, 2)}</p>\n</main>\n",
  "svelte-template-expressions.svelte": "<script>\n    const athletes = [\n      { sport: \"Athletics\", name: \"Alice\", age: 16 },\n      { sport: \"Swimming\", name: \"Bob\", age: 18 },\n      { sport: \"Tennis\", name: \"Charlie\", age: 20 },\n    ];\n  \n    let a = 0;\n    let b = 0;\n    $: count = a + b;\n</script>\n  \n<main>\n    <button on:click={() => (a += 1)}>\n        increase a: {a}\n    </button>\n    <button on:click={() => (b += 1)}>\n        increase b: {b}\n    </button>\n    <button disabled={true}>\n        disabled button\n    </button>\n    <p>{a} + {b} = {count}.</p>\n\n    {#if a < 5}\n        <p>a is lower than 5, it's: {a}</p>\n    {:else if b < 5}\n        <p>b is lower than 5, it's: {b}</p>\n    {:else}\n        <p>just right! total: {a + b}</p>\n    {/if}\n\n    <table>\n        <tr>\n        <td>sport</td>\n        <td>name</td>\n        <td>age</td>\n        <td>of age</td>\n        </tr>\n        {#each athletes as athlete}\n        {@const ofAge = athlete.age >= 18}\n        <tr>\n            <td>{athlete.sport}</td>\n            <td>{athlete.name}</td>\n            <td>{athlete.age}</td>\n            <td>{ofAge ? \"Yes\" : \"No\"}</td>\n        </tr>\n        {/each}\n    </table>\n</main>\n  ",
  "svelte-ts.svelte": "<script lang=\"ts\" context=\"module\">\n    function add(a: number, b: number) {\n        return a + b;\n    }\n</script>\n\n<script lang=\"ts\">\n    import type { Athlete } from './athlete.js';\n\n    const athletes: Athlete[] = [\n      { sport: \"Athletics\", name: \"Alice\", age: 16 },\n      { sport: \"Swimming\", name: \"Bob\", age: 18 },\n      { sport: \"Tennis\", name: \"Charlie\", age: 20 },\n    ];\n  \n    let a = 0;\n    let b = 0;\n    $: count = a + b;\n</script>\n\n<main>\n   <script lang=\"ts\">\n    function subtract(a: number, b: number) {\n        return a - b;\n    }\n   </script>\n</main>\n  "
};

test('unproved Svelte grammar and unsupported mixed batches retain atomic fallback and exact upstream errors', async () => {
  assert.equal(Object.keys(retainedFixtures).length, 5);
  const ledger = [];
  for (const [name, content] of unsupported.map((source, index) => [`unsupported-${index}.svelte`, source])) {
    const files = [file('const before=true;', 'before.js'), file(sample, 'positive.svelte'), file(content, name)];
    const direct = raw(files);
    assert.equal(direct.supported, false, content);
    assert.equal(direct.result, undefined, 'no partial native batch escapes');
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i);
    const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); }
    catch (error) { failure = error; }
    if (failure) {
      await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message === failure.message);
    } else {
      assert.deepEqual(await automatic.instrument(files, options), expected);
    }
    assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0]);
    let originalCompilerError;
    try { compile(content, compilerOptions); }
    catch (error) { originalCompilerError = { code: error.code, message: error.message }; }
    ledger.push({ name, source: content, sha256: hash(content), reason: direct.reason, upstreamError: failure?.message, upstreamMutants: expected?.mutants.length, originalCompilerError });
  }
  assert.ok(ledger.some(item => item.upstreamError), 'malformed fixtures must actually exercise matching errors');
  await receipt('negative-ledger', ledger);
});

test('serial four auto and serial recovery preserve exact Svelte bytes metadata and global IDs across mixed JS files', async () => {
  const files = [file('const before=true;', 'before.js'), file(sample, 'one.svelte'),
    file('<div>😀</div>\r\n<script>let café="value";</script><p>{café}</p>', 'two.svelte'), file('const after=false;', 'after.js')];
  const pair = await compare(files);
  assert.deepEqual(pair.actual.mutants.map(mutant => mutant.id), ['0', '1', '2', '3']);
  const baseline = raw(files);
  const modes = [];
  for (const threads of [1, 4, 'auto']) {
    const direct = raw(files, threads);
    assert.deepEqual(direct.result, baseline.result);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    const rejected = [...files, file('<script lang="js">let name="world";</script>', 'unproved.svelte')];
    assert.deepEqual(raw(rejected, threads), raw(rejected));
    await assert.rejects(sut.instrument(rejected, options), /unsupported/i);
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [2, 0, 0]);
    if (direct.execution.spawnedThreads) {
      assert.equal(direct.execution.serialRecoveries, 1);
      assert.equal(direct.execution.reason, 'unproven-relocation');
    }
    modes.push({ threads, execution: direct.execution });
  }
  await receipt('modes', { input: files, result: baseline.result, modes });
});

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
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const render = require('svelte/server').render;
const artifact = new URL('../artifacts/native-svelte/scripts/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const file = (content, name = 'scripts.svelte', mutate = true) => ({ name, content, mutate });
const moduleFixture = "<script context=\"module\">\n\tlet name = 'world';\n</script>\n\n<h1>Hello {name}!</h1>";
// EACH exact old negative that becomes positive is retained here, unchanged.
const oldModuleNegative = '<script context="module">const name="world";</script>';
const nestedFixtures = {
  'svelte-multiple-script-tags.svelte': "<script context=\"module\">\n\tlet name = 'test';\n</script>\n\n<script>\n\tlet name = 'world';\n</script>\n\n<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<h1>\n\t\t{name}\n\t</h1>\n</div>",
  'svelte-only-template-script-tags.svelte': "<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<script>\n\t\tlet test = 'test'\n\t</script>\n</div>",
};
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));
async function receipt(name, value) {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
}
async function resource(name, source) {
  const root = resolve(process.env.STRYKER_UPSTREAM ?? 'artifacts/upstream/stryker-js');
  try { assert.equal(await readFile(join(root, 'packages/instrumenter/testResources/instrumenter', name), 'utf8'), source); }
  catch (error) { if (process.env.STRYKER_UPSTREAM !== undefined || error.code !== 'ENOENT') throw error; }
}
function outerBytes(source, output) {
  const before = parse(source, { modern: true });
  let after = parse(output, { modern: true });
  if (!before.module && after.module) {
    assert.equal(after.module.start, 0);
    assert.equal(output[after.module.end], '\n');
    output = output.slice(after.module.end + 1);
    after = parse(output, { modern: true });
  }
  const ranges = ast => [ast.module, ast.instance].filter(Boolean).map(script => script.content).sort((a, b) => a.start - b.start);
  const oldRanges = ranges(before), newRanges = ranges(after);
  assert.equal(oldRanges.length, newRanges.length);
  let oldCursor = 0, newCursor = 0;
  for (let index = 0; index < oldRanges.length; index++) {
    assert.equal(output.slice(newCursor, newRanges[index].start), source.slice(oldCursor, oldRanges[index].start));
    oldCursor = oldRanges[index].end;
    newCursor = newRanges[index].end;
  }
  assert.equal(output.slice(newCursor), source.slice(oldCursor));
}
async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'complete ordered ABI records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'complete ordered public records');
  assert.deepEqual(plain(actual), direct.result, 'ABI/public output and file metadata');
  assert.deepEqual(actual.files.map(({ content, ...meta }) => meta), expected.files.map(({ content, ...meta }) => meta));
  assert.deepEqual(actual.files.map(({ content, ...meta }) => meta), files.map(({ content, ...meta }) => meta));
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  for (let index = 0; index < files.length; index++) if (/\.svelte$/i.test(files[index].name)) outerBytes(files[index].content, actual.files[index].content);
  return { actual, expected };
}

const compiled = new Map();
const compilerOptions = { generate: 'server', dev: false, filename: 'scripts.svelte' };
function executable(content) {
  assert.equal(VERSION, '5.57.2');
  if (!compiled.has(content)) {
    const result = compile(content, compilerOptions);
    const code = transformSync(result.js.code, {
      filename: 'compiled.js', configFile: false, babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    }).code;
    // Model real module lexical isolation. Helpers must not leak onto globalThis.
    compiled.set(content, new vm.Script(`(function(exports,require){${code}\n})(exports,require);`));
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
    assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: error.name, message: error.message };
  };
  const program = executable(content); // Compiler failures cannot count as runtime parity.
  let loadError;
  try { program.runInContext(context, { timeout: 1000 }); } catch (error) { loadError = errorOf(error); }
  const loaded = plain(ns), loadLogs = plain(logs);
  assert.equal(context.stryMutAct_9fa48, undefined, 'module helpers stay lexical');
  const rendered = [];
  if (settings.afterLoad) ns.activeMutant = id;
  if (!loadError) for (let instance = 0; instance < 2; instance++) {
    if (instance === 1 && settings.afterRender) ns.activeMutant = id;
    ns.currentTestId = instance === 0 ? settings.currentTestId : 'second-instance';
    try {
      const result = new vm.Script('render(exports.default)').runInContext(context, { timeout: 1000 });
      rendered.push({ body: result.body, head: result.head });
    } catch (error) { rendered.push({ error: errorOf(error) }); }
  }
  return plain({ loaded, loadLogs, loadError, rendered, logs, ns });
}
const settingsCases = [{}, { fromEnv: true }, { afterLoad: true }, { afterRender: true },
  { currentTestId: 'first-instance' }, { currentTestId: 'first-instance', afterRender: true },
  { hitLimit: 0 }, { hitLimit: 1 }, { hitLimit: 1, afterLoad: true }, { hitLimit: 0, afterRender: true }];
function runtime(pair, source) {
  const native = pair.actual.files[0].content, upstream = pair.expected.files[0].content;
  for (const content of [source, native, upstream]) executable(content);
  const original = execute(source), baseline = execute(native);
  assert.equal(original.loadError, undefined);
  assert.equal(baseline.loadError, undefined);
  assert.ok(baseline.rendered.every(value => value.error === undefined));
  assert.deepEqual([baseline.rendered, baseline.logs], [original.rendered, original.logs], 'unaltered visible SSR body/head and module/instance effects');
  const cases = [];
  for (const id of [undefined, ...pair.expected.mutants.map(mutant => mutant.id)]) for (const settings of settingsCases) {
    const actual = execute(native, id, settings), expected = execute(upstream, id, settings);
    assert.deepEqual(actual, expected, `mutant ${id}: ${JSON.stringify(settings)}`);
    cases.push({ id, settings, actual });
  }
  return { compilerVersion: VERSION, compilerOptions, original, baseline, cases };
}

test('unchanged pinned module fixture and exact former module negative are strict native with real runtime proof', async () => {
  await resource('svelte-module-script-tag.svelte', moduleFixture);
  const ledger = [];
  for (const source of [moduleFixture, oldModuleNegative]) {
    const pair = await compare([file(source, 'svelte-module-script-tag.svelte')]);
    assert.equal(pair.actual.mutants.length, 1);
    assert.equal(pair.actual.mutants[0].id, '0');
    const proof = runtime(pair, source);
    const parsed = parse(pair.actual.files[0].content, { modern: true });
    assert.equal(parsed.instance, undefined);
    assert.equal((pair.actual.files[0].content.match(/function stryNS_9fa48\(/g) ?? []).length, 1);
    assert.deepEqual(proof.baseline.loaded.mutantCoverage.static, { 0: 1 }, 'module executes coverage once before either render');
    assert.deepEqual(proof.baseline.ns.mutantCoverage.perTest, {}, 'module-only coverage is static');
    assert.ok(proof.cases.some(value => value.actual.loadError?.message.includes('Hit count limit reached')));
    if (source === moduleFixture) {
      assert.deepEqual(plain(pair.actual.mutants[0]), { id: '0', fileName: 'svelte-module-script-tag.svelte', mutatorName: 'StringLiteral', replacement: '""',
        location: { start: { line: 1, column: 12 }, end: { line: 1, column: 19 } } });
      assert.notDeepEqual(execute(pair.actual.files[0].content, '0').rendered, proof.baseline.rendered);
      assert.deepEqual(execute(pair.actual.files[0].content, '0', { afterLoad: true }).rendered, proof.baseline.rendered, 'activation after module evaluation cannot rerun its initializer');
    }
    ledger.push({ source, sha256: hash(source), ...pair, runtime: proof });
  }
  await receipt('module-fixture-and-old-negative', ledger);
});

test('module-first IDs source-order printing UTF16 columns and lexical scope survive repeated instances', async () => {
  const ledger = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `<div>😀</div>${newline}<script>${newline}let café="instance";${newline}console.log(café);${newline}</script>${newline}<p>{café}{shared}</p>${newline}<script context="module">${newline}let shared="module";${newline}console.log(shared);${newline}</script>`;
    const pair = await compare([file(source)]);
    assert.equal(pair.actual.mutants.length, 4);
    assert.deepEqual(pair.actual.mutants.map(value => [value.id, value.mutatorName]), [['0', 'StringLiteral'], ['1', 'CallExpression'], ['2', 'StringLiteral'], ['3', 'CallExpression']]);
    assert.deepEqual(pair.actual.mutants.map(value => value.location.start), [{ line: 7, column: 11 }, { line: 8, column: 0 }, { line: 2, column: 9 }, { line: 3, column: 0 }]);
    const proof = runtime(pair, source);
    assert.deepEqual(proof.baseline.loadLogs, [['module']], 'module effect runs once');
    assert.deepEqual(proof.baseline.logs, [['module'], ['instance'], ['instance']], 'instance effect runs per render');
    assert.deepEqual(proof.baseline.loaded.mutantCoverage.static, { 0: 1, 1: 1 });
    assert.deepEqual(proof.baseline.ns.mutantCoverage.perTest, { 'second-instance': { 2: 1, 3: 1 } });
    assert.deepEqual(proof.baseline.ns.mutantCoverage.static, { 0: 1, 1: 1, 2: 1, 3: 1 });
    assert.ok(proof.cases.some(value => value.actual.rendered.some(result => result.error?.message.includes('Hit count limit reached'))));
    ledger.push({ source, ...pair, runtime: proof });
  }
  for (const source of [
    '<script context="module">let name="module";</script><script>let name="instance";</script><h1>{name}</h1>',
    '<script>let script1="instance";</script><p>{script1}</p>',
    '<script context="module">let script2="module";</script><script>let name="instance";</script><p>{script2}{name}</p>',
    '<script context="module">const name="module";</script><script>let name="instance";name="changed";</script><h1>{name}</h1>',
    '<script context="module">const record={value:"module"};</script><script>record.value="changed";</script>',
    '<script context="module">const name="module";</script><script>function change(){let name="inner";name="changed";return name;}let value=change();</script><p>{value}{name}</p>',
  ]) { const pair = await compare([file(source)]); ledger.push({ source, ...pair, runtime: runtime(pair, source) }); }
  await receipt('order-scope-lifecycle', ledger);
});

test('header placement depends on actual placements across both scripts including ignored and selected ranges', async () => {
  const source = '<script>// Stryker disable next-line StringLiteral: instance only\r\nlet local="instance";\r\nlet flag=true;\r\n</script><p>😀 {local}{shared}{flag}</p>\r\n<script context="module">\r\nlet shared="module";\r\n</script>';
  const ledger = [];
  for (const mutate of [true, false, [], [{ start: { line: 0, column: 0 }, end: { line: 3, column: 99 } }], [{ start: { line: 4, column: 0 }, end: { line: 7, column: 0 } }]]) {
    for (const excludedMutations of [[], ['StringLiteral'], ['StringLiteral', 'BooleanLiteral']]) {
      for (const noHeader of [false, true]) {
        const pair = await compare([file(source, 'selection.svelte', mutate)], { ...options, excludedMutations, noHeader });
        const count = pair.actual.mutants.filter(value => value.status !== 'Ignored').length;
        const output = pair.actual.files[0].content;
        assert.equal((output.match(/function stryNS_9fa48\(/g) ?? []).length, count ? 1 : 0);
        assert.equal((output.match(/<script context="module">/g) ?? []).length, 1);
        const parsed = parse(output, { modern: true });
        assert.doesNotMatch(output.slice(parsed.instance.content.start, parsed.instance.content.end), /function stryNS_9fa48/);
        runtime(pair, source);
        ledger.push({ mutate, excludedMutations, noHeader, ...pair });
      }
    }
  }
  for (const content of [
    '<script context="module">// Stryker disable all: only module\nlet shared="module";</script><script>let local="instance";</script><p>{shared}{local}</p>',
    '<script context="module">let shared="module";</script><script>// Stryker disable all: only instance\nlet local="instance";</script><p>{shared}{local}</p>',
    '<script context="module">// Stryker disable all: ignored module\nlet shared="module";</script><script>// Stryker disable all: ignored instance\nlet local="instance";</script><p>{shared}{local}</p>',
    '<script context="module">let count=1;</script><script></script>',
    '<script context="module"></script>',
    '<script context="module"></script><script>let name="instance";</script><p>{name}</p>',
  ]) { const pair = await compare([file(content)]); runtime(pair, content); ledger.push({ content, ...pair }); }
  await receipt('headers-selections-directives', ledger);
});

test('embedded hashbangs retain whole upstream results through atomic fallback', async () => {
  const ledger = [];
  for (const opening of ['<script>', '<script context="module">']) {
    const content = `${opening}#!/usr/bin/env node\nlet name="world";</script><p>{name}</p>`;
    assert.throws(() => compile(content, compilerOptions), error => error.code === 'js_parse_error');
    const files = [file('const before=true;', 'before.js'), file(moduleFixture, 'positive.svelte'), file(content, 'hashbang.svelte')];
    const expected = await new Instrumenter(logger).instrument(files, options);
    assert.equal(expected.mutants.filter(mutant => mutant.fileName === 'hashbang.svelte').length, 1);
    for (const threads of [1, 4, 'auto']) {
      const direct = raw(files, threads);
      assert.equal(direct.supported, false);
      assert.equal(direct.result, undefined, 'no partial native records escape');
      const settings = { cache: false, instrumentationThreads: threads === 'auto' ? undefined : threads };
      const automatic = createInstrumenter(logger, { ...settings, engine: 'auto' });
      assert.deepEqual(await automatic.instrument(files, options), expected, 'complete upstream bytes, records and metadata survive fallback');
      assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0]);
      const strict = createInstrumenter(logger, { ...settings, engine: 'native' });
      await assert.rejects(strict.instrument(files, options), /unsupported/i);
      assert.deepEqual(plain(await strict.instrument([file(moduleFixture)], options)), raw([file(moduleFixture)]).result, 'native recovery after compiler-boundary rejection');
    }
    ledger.push({ source: content, sha256: hash(content), upstream: plain(expected), compilerCode: 'js_parse_error', modes: [1, 4, 'auto'] });
  }
  await receipt('hashbang-fallback', ledger);
});

const unsupported = [
  '<script module>let name="world";</script>',
  "<script context='module'>let name='world';</script>",
  '<script context="module" lang="js">let name="world";</script>',
  '<script context="module" lang="ts">let name:string="world";</script>',
  '<script context="module">export let name="world";</script>',
  '<script context="module">import name from "module";</script>',
  '<script context="module">const name="world";</script><script>name="changed";</script>',
  '<script>function change(){name++}</script><script context="module">const name=1;</script>',
  '<script context="module">const name="world";</script><script>for(name of ["other"]){};</script>',
  '<script context="module">let name="world";</script><p>{script0}</p>',
  '<script>let script1="world";</script><script context="module"></script><p>{script1}</p>',
  '<script context="module"></script><script></script><p>{script0}</p>',
  '<script context="module">let name="world";</script><script context="module"></script>',
  '<script context="module">let name=;</script>',
  '<script context="module">let name="world";</script><script>let name="first";</script><script>let name="second";</script>',
  '<script context="module">let name="world";</script><p><div>x</div></p>',
  '<script context="module">let name="world";</script><p>open',
  '<script context="module">let name="world";</script><p>{name+1}</p>',
  '<script context="module">let $name="world";</script><p>{$name}</p>',
  '<script context="module">let name="world";$:name="reactive";</script>',
];
test('compiler-rejected or unproved module boundaries retain whole-batch fallback', async () => {
  const ledger = [];
  for (const [name, content] of unsupported.map((source, index) => [`boundary-${index}.svelte`, source])) {
    if (name in nestedFixtures) await resource(name, content);
    let compilerError;
    try { compile(content, compilerOptions); } catch (error) { compilerError = { code: error.code, message: error.message }; }
    const files = [file('const before=true;', 'before.js'), file(moduleFixture, 'positive.svelte'), file(content, name)];
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    for (const threads of [1, 4, 'auto']) {
      const direct = raw(files, threads);
      assert.equal(direct.supported, false, content);
      assert.equal(direct.result, undefined);
      const automatic = createInstrumenter(logger, { cache: false, engine: 'auto', instrumentationThreads: threads === 'auto' ? undefined : threads });
      if (failure) await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message === failure.message);
      else assert.deepEqual(await automatic.instrument(files, options), expected);
      assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0]);
      const strict = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
      await assert.rejects(strict.instrument(files, options), /unsupported/i);
    }
    ledger.push({ name, content, sha256: hash(content), compilerError, upstreamError: failure?.message, upstreamMutants: expected?.mutants.length, reason: raw(files).reason });
  }
  assert.equal(ledger.filter(value => value.compilerError?.code === 'constant_assignment').length, 2);
  assert.equal(ledger.find(value => value.content.includes('for(name of')).compilerError, undefined, 'for-of const writes retain the existing conservative guard even though this compiler accepts them');
  await receipt('retained-boundaries', ledger);
});

test('nested runtime evidence distinguishes emitted HTML from JS execution and module helpers from document scope', async () => {
  const ledger = [];
  for (const [name, source] of Object.entries(nestedFixtures)) {
    const expected = await new Instrumenter(logger).instrument([file(source, name)], options);
    assert.equal(expected.mutants.length, name.includes('multiple') ? 3 : 2);
    const output = expected.files[0].content;
    const client = compile(output, { ...compilerOptions, generate: 'client' }).js.code;
    assert.match(client, /\.with_script\(/, 'real client runtime explicitly executes nested scripts');
    assert.match(client, /function stryMutAct_9fa48\(/, 'helper belongs to compiled component module');
    const rendered = execute(output);
    const original = execute(source);
    assert.equal(rendered.loadError, undefined);
    assert.equal(original.loadError, undefined);
    assert.ok(rendered.rendered.every(value => !value.error));
    assert.notDeepEqual(rendered.rendered, original.rendered, 'SSR emits differently printed executable script text');
    const nestedScripts = [];
    const visit = node => {
      if (node.type === 'RegularElement' && node.name === 'script') nestedScripts.push(node.fragment.nodes[0].data);
      if (node.fragment) node.fragment.nodes.forEach(visit);
    };
    parse(output, { modern: true }).fragment.nodes.forEach(visit);
    for (const script of nestedScripts) {
      // Explicit document-scope model, NOT a claim of browser execution. The
      // installed client's run_scripts creates fresh document script elements.
      const context = vm.createContext({ __stryker__: {} });
      assert.throws(() => new vm.Script(script).runInContext(context), /stryMutAct_9fa48 is not defined/);
      assert.equal(context.__stryker__.mutantCoverage, undefined);
    }
    const nestedIds = expected.mutants.slice(name.includes('multiple') ? 2 : 0).map(value => value.id);
    for (const id of nestedIds) assert.deepEqual(execute(output, id).rendered, rendered.rendered, 'SSR never activates nested text');
    ledger.push({ name, source, sha256: hash(source), upstream: expected, original, rendered, client, nestedScripts, nestedIds,
      limitation: 'Document-scope VM model plus installed compiler/runtime source, not a browser receipt. This diagnoses the upstream helper defect, not native behavior. Native document headers are covered separately; no SSR text normalization is used as parity evidence.' });
  }
  await receipt('nested-execution-gap', ledger);
});

test('module-first global IDs and file metadata are stable in serial four auto and recovery after rejection', async () => {
  const source = '<script>let name="instance";</script><h1>{name}{shared}</h1><script context="module">let shared="module";</script>';
  const files = [file('const before=true;', 'before.js'), file(source, 'one.svelte'), file(moduleFixture, 'two.svelte'), file('const after=false;', 'after.js')];
  const pair = await compare(files);
  assert.deepEqual(pair.actual.mutants.map(value => [value.fileName, value.id]), [['before.js', '0'], ['one.svelte', '1'], ['one.svelte', '2'], ['two.svelte', '3'], ['after.js', '4']]);
  const baseline = raw(files);
  const ledger = [];
  for (const threads of [1, 4, 'auto']) {
    const direct = raw(files, threads);
    assert.deepEqual(direct.result, baseline.result);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    for (const input of [files, []]) assert.deepEqual(plain(await sut.instrument(input, options)), raw(input).result);
    const rejected = [...files, file('<div><script lang="js">let name="nested";</script></div>', 'nested.svelte')];
    await assert.rejects(sut.instrument(rejected, options), /unsupported/i);
    assert.equal(raw(rejected, threads).result, undefined);
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    const inactive = files.map(value => ({ ...value, mutate: false }));
    assert.deepEqual(plain(await sut.instrument(inactive, options)), raw(inactive).result);
    assert.deepEqual(raw(inactive, threads).result, raw(inactive).result);
    if (direct.execution.spawnedThreads) {
      assert.equal(direct.execution.serialRecoveries, 1);
      assert.equal(direct.execution.reason, 'unproven-relocation');
    }
    assert.equal(sut.stats.fallbackBatches, 0);
    assert.equal(sut.stats.nativeErrors, 0);
    ledger.push({ threads, execution: direct.execution, stats: sut.stats });
  }
  await receipt('modes', { input: files, result: baseline.result, modes: ledger });
});

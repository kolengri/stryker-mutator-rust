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
const artifact = new URL('../artifacts/native-svelte/nested/', import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const file = (content, name = 'nested.svelte', mutate = true) => ({ name, content, mutate });
const fixtures = {
  'svelte-multiple-script-tags.svelte': "<script context=\"module\">\n\tlet name = 'test';\n</script>\n\n<script>\n\tlet name = 'world';\n</script>\n\n<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<h1>\n\t\t{name}\n\t</h1>\n</div>",
  'svelte-only-template-script-tags.svelte': "<div>\n\t<script>\n\t\tlet name = 'teun'\n\t</script>\n\t<script>\n\t\tlet test = 'test'\n\t</script>\n</div>",
};
const fixtureHashes = {
  'svelte-multiple-script-tags.svelte': '111ddf785d2a1525ad2aaff7df4838d02829816b1c55ff5645c6be9266371112',
  'svelte-only-template-script-tags.svelte': '33f4ce2c9496e5ca857cea34bf20e555951437fbf746973a2f7a855681232371',
};
// All distinct exact negatives that become positive in the two previous JS
// suites, plus the Rust boundary test's exact formerly rejected empty script.
const formerNegatives = [
  ...Object.values(fixtures),
  '<script>let name="world";</script><div><script>let other=true;</script></div>',
  '<script>let n=1;</script><div><script></script></div>',
];
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));
async function receipt(name, value) {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
}
function nested(source) {
  const scripts = [];
  const visit = node => {
    if (node.type === 'RegularElement' && node.name === 'script') {
      assert.equal(node.attributes.length, 0);
      const start = node.start + '<script>'.length, end = node.end - '</script>'.length;
      scripts.push({ start, end, content: source.slice(start, end) });
    } else if (node.fragment) node.fragment.nodes.forEach(visit);
  };
  const root = parse(source, { modern: true });
  root.fragment.nodes.forEach(visit);
  return { root, scripts };
}
function outerBytes(source, output) {
  const before = nested(source);
  let after = nested(output);
  if (!before.root.module && after.root.module) {
    assert.equal(after.root.module.start, 0);
    assert.equal(output[after.root.module.end], '\n');
    output = output.slice(after.root.module.end + 1);
    after = nested(output);
  }
  const ranges = parsed => [...[parsed.root.module, parsed.root.instance].filter(Boolean).map(s => s.content), ...parsed.scripts].sort((a, b) => a.start - b.start);
  const oldRanges = ranges(before), newRanges = ranges(after);
  assert.equal(newRanges.length, oldRanges.length);
  let oldCursor = 0, newCursor = 0;
  for (let i = 0; i < oldRanges.length; i++) {
    assert.equal(output.slice(newCursor, newRanges[i].start), source.slice(oldCursor, oldRanges[i].start));
    oldCursor = oldRanges[i].end; newCursor = newRanges[i].end;
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
  assert.deepEqual(plain(actual), direct.result, 'ABI/public bytes and metadata');
  assert.deepEqual(actual.files.map(({ content, ...meta }) => meta), expected.files.map(({ content, ...meta }) => meta));
  assert.deepEqual(actual.files.map(({ content, ...meta }) => meta), files.map(({ content, ...meta }) => meta));
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  files.forEach((input, i) => { if (/\.svelte$/.test(input.name)) outerBytes(input.content, actual.files[i].content); });
  return { actual, expected };
}
const compiled = new Map();
function executable(source) {
  assert.equal(VERSION, '5.57.2');
  if (!compiled.has(source)) {
    const result = compile(source, { generate: 'server', dev: false, filename: 'nested.svelte' });
    const code = transformSync(result.js.code, { filename: 'compiled.js', configFile: false, babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
    compiled.set(source, new vm.Script(`(function(exports,require){${code}\n})(exports,require);`));
  }
  return compiled.get(source);
}
const errorOf = error => {
  assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
  return { name: error.name, message: error.message };
};
// Server rendering and classic document execution are deliberately separate.
// This is a document VM model; the browser harness independently mounts and
// hydrates the installed Svelte client in fresh iframe realms.
function execute(source, id, settings = {}, reads = ['name', 'test']) {
  const ns = { ...(settings.afterLoad || settings.afterRender ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const logs = [], context = vm.createContext({ exports: {}, require, render, __stryker__: ns, console: { log: (...args) => logs.push(args) } });
  let loadError;
  try { executable(source).runInContext(context, { timeout: 1000 }); } catch (error) { loadError = errorOf(error); }
  assert.equal(context.stryMutAct_9fa48, undefined, 'server module helpers stay lexical');
  const loaded = plain(ns), rendered = [], documents = [];
  if (settings.afterLoad) ns.activeMutant = id;
  if (!loadError) for (let instance = 0; instance < 2; instance++) {
    ns.currentTestId = instance ? 'second-instance' : settings.currentTestId;
    let body;
    try { body = new vm.Script('render(exports.default).body').runInContext(context, { timeout: 1000 }); rendered.push(body); }
    catch (error) { rendered.push({ error: errorOf(error) }); continue; }
    const beforeDocument = plain(ns), errors = [];
    // The server emits script text; it cannot cover document IDs itself.
    const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.equal(scripts.length, nested(source).scripts.length);
    scripts.forEach((script, index) => {
      assert.equal(script, nested(source).scripts[index].content, 'SSR emits the exact nested raw program');
      try { new vm.Script(script).runInContext(context, { timeout: 1000 }); } catch (error) { errors.push(errorOf(error)); }
    });
    const globals = {};
    for (const name of reads) try { globals[name] = new vm.Script(name).runInContext(context, { timeout: 1000 }); } catch (error) { globals[name] = { error: errorOf(error) }; }
    documents.push({ beforeDocument, globals, errors, ns: plain(ns) });
    if (!instance && settings.afterRender) ns.activeMutant = id;
  }
  return plain({ loaded, loadError, rendered, documents, logs, ns });
}

test('unchanged nested fixtures and EACH newly positive exact old boundary have strict ABI API metadata and runtime proof', async () => {
  const ledger = [];
  for (const source of formerNegatives) {
    const name = Object.keys(fixtures).find(name => fixtures[name] === source) ?? 'old-negative.svelte';
    if (name in fixtures) {
      assert.equal(hash(source), fixtureHashes[name], 'embedded pinned fixture bytes remain mandatory');
      try {
        assert.equal(await readFile(join(resolve(process.env.STRYKER_UPSTREAM ?? 'artifacts/upstream/stryker-js'), 'packages/instrumenter/testResources/instrumenter', name), 'utf8'), source);
      } catch (error) {
        if (process.env.STRYKER_UPSTREAM !== undefined || error.code !== 'ENOENT') throw error;
      }
    }
    const pair = await compare([file(source, name)]);
    if (name in fixtures) assert.equal(pair.actual.mutants.length, name.includes('multiple') ? 3 : 2);
    const original = execute(source), baseline = execute(pair.actual.files[0].content);
    assert.equal(baseline.loadError, undefined);
    assert.deepEqual(baseline.documents.map(d => [d.globals, d.errors]), original.documents.map(d => [d.globals, d.errors]), 'document globals and natural redeclaration errors preserved');
    assert.equal(baseline.documents[0].errors.length, 0);
    const nestedIds = pair.actual.mutants.filter(m => nested(source).scripts.some(s => {
      const position = offset => { const lines = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/); return [lines.length - 1, lines.at(-1).length]; };
      const [line, column] = position(s.start), [endLine, endColumn] = position(s.end), at = m.location.start;
      return (at.line > line || at.line === line && at.column >= column) && (at.line < endLine || at.line === endLine && at.column < endColumn);
    })).map(m => m.id);
    const cases = [];
    for (const id of [undefined, ...pair.actual.mutants.map(m => m.id)]) for (const settings of [{}, { afterLoad: true }, { afterRender: true }, { currentTestId: 'first-instance' }, { hitLimit: 0 }, { hitLimit: 1 }]) {
      const actual = execute(pair.actual.files[0].content, id, settings);
      assert.ok(!actual.documents.some(d => d.errors.some(e => /stry(?:NS|Cov|MutAct)_9fa48 is not defined/.test(e.message))));
      cases.push({ id, settings, actual });
    }
    for (const id of nestedIds) {
      assert.equal(baseline.documents[0].beforeDocument.mutantCoverage?.static?.[id], undefined, 'SSR has not executed nested code');
      assert.equal(baseline.documents[0].ns.mutantCoverage.static[id], 1, 'document execution covers every nested ID');
    }
    if (name in fixtures) {
      const upstream = execute(pair.expected.files[0].content);
      assert.ok(upstream.documents[0].errors.every(error => /stryMutAct_9fa48 is not defined/.test(error.message)));
      assert.equal(upstream.documents[0].errors.length, nested(source).scripts.length);
      for (const id of nestedIds) {
        const active = execute(pair.actual.files[0].content, id);
        const key = name.includes('multiple') || id === '0' ? 'name' : 'test';
        assert.equal(active.documents[0].globals[key], '', 'each activated nested mutant changes its document lexical value');
        assert.equal(active.documents[0].ns.mutantCoverage?.static?.[id], undefined);
        const covered = execute(pair.actual.files[0].content, undefined, { currentTestId: 'first-instance' });
        assert.equal(covered.documents[0].ns.mutantCoverage.perTest['first-instance'][id], 1);
        const limited = execute(pair.actual.files[0].content, id, { hitLimit: 0 });
        assert.ok(limited.documents[0].errors.some(error => /Hit count limit reached/.test(error.message)));
      }
    }
    ledger.push({ name, source, sha256: hash(source), ...pair, original, baseline, nestedIds, cases });
  }
  await receipt('fixtures-and-old-negatives', ledger);
});

test('nested scope order module-later IDs global lexical collisions and independent module constants are preserved', async () => {
  const sources = [
    '<div><script>var order="nested";let documentOnly="global";</script></div><script>let local="instance";</script><script context="module">const documentOnly="module";</script>',
    '<script context="module">const shared="module";</script><div><script>var shared="document";shared="changed";</script><script>var observed=shared;</script></div>',
    '<script>let local="private";</script><div><script>var observed=local;</script></div>',
    '<div><script>let repeated="first";</script><script>let repeated="second";</script></div>',
    '<div><script>var order="first";</script><script>order+="second";</script></div>',
    '<div><script>let script9="safe";</script></div><p>{script9}</p>',
  ];
  const ledger = [];
  for (const source of sources) {
    const pair = await compare([file(source)]), reads = ['order', 'documentOnly', 'shared', 'observed', 'repeated'];
    const original = execute(source, undefined, {}, reads), actual = execute(pair.actual.files[0].content, undefined, {}, reads);
    assert.deepEqual(actual.documents.map(d => [d.globals, d.errors]), original.documents.map(d => [d.globals, d.errors]));
    assert.deepEqual(actual.logs, original.logs);
    ledger.push({ source, ...pair, original, runtime: actual });
  }
  assert.deepEqual(ledger[0].actual.mutants.map(m => m.location.start.column), ['module', 'nested', 'global', 'instance'].map(value => sources[0].lastIndexOf(`"${value}"`)));
  await receipt('scope-order', ledger);
});

test('nested original offsets line terminators selection exclusions directive ownership and actual-placement headers', async () => {
  const ledger = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const source = `<div>😀${newline}<script>// Stryker disable next-line StringLiteral: first only${newline}let café="ignored";${newline}</script><script>${newline}let other="nested";let flag=true;${newline}</script></div>${newline}<script context="module">let shared="module";</script>`;
    for (const mutate of [true, false, [], [{ start: { line: 3, column: 0 }, end: { line: 5, column: 99 } }]]) for (const excludedMutations of [[], ['StringLiteral', 'BooleanLiteral']]) {
      const config = { ...options, excludedMutations, noHeader: true }, pair = await compare([file(source, 'selection.svelte', mutate)], config);
      const scripts = nested(pair.actual.files[0].content).scripts;
      assert.doesNotMatch(scripts[0].content, /function stryNS_9fa48/);
      assert.equal(/function stryNS_9fa48/.test(scripts[1].content), pair.actual.mutants.some(m => m.status !== 'Ignored' && m.location.start.line === 4));
      if (mutate === false || Array.isArray(mutate) && !mutate.length || excludedMutations.length) assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_9fa48/);
      ledger.push({ source, mutate, config, ...pair });
    }
  }
  for (const source of ['<div><script></script><script>let n=1;</script></div>', '<div><script>// Stryker disable all: intentional\nlet n="ignored";</script></div>']) {
    const pair = await compare([file(source)]);
    assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_9fa48|context="module"/);
  }
  await receipt('selections', ledger);
});

const unsupported = [
  '<div><script lang="js">let n=true;</script></div>', '<div><script type="module">let n=true;</script></div>',
  '<div><script lang="ts">let n:boolean=true;</script></div>', '<div><script context="module">let n=true;</script></div>',
  '<div><script>let n=;</script></div>', '<div><script>#!/bin/node\nlet n=true;</script></div>',
  '<div><script>export let n=true;</script></div>', '<div><script>import x from "x";</script></div>',
  '<div><script>let n=$state(true);</script></div>', '<div><script>let stryMutAct_9fa48=true;</script></div>',
  '<div><script>let n=true;</script></div><p>{stryCov_9fa48}</p>',
  '<div><script>let n=true;</script></div><p>{script0}</p>',
  '<script>let n=true;</script><div><script>let x=true;</script></div><p>{script1}</p>',
  '<div><script>let n=true;</script><span>open</div>', '<div><script>let n=true;</script></div><p>{n+1}</p>',
  '<div><script>let n=true;</script></div><style></style>', '<div><script>let n=true;</script></div><!--comment-->',
];
test('unsupported nested syntax config guards and mixed batches remain atomic with serial recovery', async () => {
  const files = [file('const before=true;', 'before.js'), ...Object.entries(fixtures).map(([name, source]) => file(source, name)), file('const after=false;', 'after.js')];
  const pair = await compare(files), baseline = raw(files);
  const ledger = [];
  for (const threads of [1, 4, 'auto']) {
    const sut = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    assert.deepEqual(raw(files, threads).result, baseline.result);
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    for (const source of unsupported) {
      const input = [...files, file(source, 'unproved.svelte')], direct = raw(input, threads);
      assert.equal(direct.supported, false, source); assert.equal(direct.result, undefined);
      await assert.rejects(sut.instrument(input, options), /unsupported/i);
      const auto = createInstrumenter(logger, { cache: false, engine: 'auto', instrumentationThreads: threads === 'auto' ? undefined : threads });
      let expected, failure;
      try { expected = await new Instrumenter(logger).instrument(input, options); } catch (error) { failure = error; }
      if (failure) await assert.rejects(auto.instrument(input, options), error => error.name === failure.name && error.message === failure.message);
      else assert.deepEqual(await auto.instrument(input, options), expected);
      assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
    }
    assert.deepEqual(plain(await sut.instrument(files, options)), baseline.result);
    assert.deepEqual(plain(await sut.instrument([], options)), raw([]).result);
    const inactive = files.map(f => ({ ...f, mutate: false }));
    assert.deepEqual(raw(inactive, threads).result, raw(inactive).result);
    assert.deepEqual(plain(await sut.instrument(inactive, options)), raw(inactive).result);
    assert.equal(sut.stats.nativeErrors, 0); assert.equal(sut.stats.fallbackBatches, 0);
    const execution = raw(files, threads).execution;
    if (execution.spawnedThreads) { assert.equal(execution.serialRecoveries, 1); assert.equal(execution.reason, 'unproven-relocation'); }
    ledger.push({ threads, execution, stats: sut.stats });
  }
  for (const config of [{ ...options, plugins: ['jsx'] }, { ...options, ignorers: ['unknown'] }]) {
    const direct = raw(files, 1, config); assert.equal(direct.supported, false); assert.equal(direct.result, undefined);
  }
  await receipt('modes-boundaries', { files, result: pair.actual, modes: ledger, unsupported });
});

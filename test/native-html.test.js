import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { parse, RecursiveVisitor, visitAll } from 'angular-html-parser';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const file = (content, name = 'container.html', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const hash = content => createHash('sha256').update(content).digest('hex');
const artifact = new URL('../artifacts/native-html/attempt-2/', import.meta.url);
const resourceOverride = process.env.STRYKER_HTML_RESOURCE;
const resource = new URL(resourceOverride ?? '../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/html-sample.html', import.meta.url);
// Exact html-sample.html from pinned upstream c931a932. Keep the core proof
// independent of an optional upstream checkout; compare its bytes when present.
const htmlSample = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Document</title>
  </head>

  <body>
    <script>
      function add(a, b) {
        return a + b;
      }
      add(40, 2);
    </script>
  </body>
</html>
`;
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));

// Oracle extraction is TEST ONLY. The native ABI has no JavaScript HTML parser.
function scripts(content) {
  const tree = parse(content, { canSelfClose: true, allowHtmComponentClosingTags: true, isTagNameCaseSensitive: true });
  assert.deepEqual(tree.errors, [], 'emitted HTML must remain accepted by pinned Angular');
  const result = [];
  visitAll(new class extends RecursiveVisitor {
    visitElement(element, context) {
      if (element.name === 'script' && !element.attrs.some(attr => attr.name === 'src')) {
        const format = (element.attrs.find(attr => attr.name === 'type') ?? element.attrs.find(attr => attr.name === 'lang'))?.value.toLowerCase();
        if (format === undefined || ['js', 'text/javascript', 'javascript', 'module', 'ts', 'text/typescript', 'typescript'].includes(format)) {
          const start = element.startSourceSpan.end.offset, end = element.endSourceSpan.start.offset;
          result.push({ start, end, content: content.slice(start, end), typescript: ['ts', 'text/typescript', 'typescript'].includes(format) });
        }
      }
      super.visitElement(element, context);
    }
  }, tree.rootNodes);
  return result;
}

function outer(content) {
  let cursor = 0;
  const result = scripts(content).map(script => {
    const raw = content.slice(cursor, script.start);
    cursor = script.end;
    return raw;
  });
  return [...result, content.slice(cursor)];
}

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'strict ABI full ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public /instrumenter full ordered records');
  assert.deepEqual(plain(actual), direct.result, 'public output equals strict ABI bytes');
  const metadata = result => result.files.map(({ content, ...metadata }) => metadata);
  assert.deepEqual(metadata(actual), files.map(({ content, ...metadata }) => metadata));
  assert.deepEqual(metadata(actual), metadata(expected));
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  for (let index = 0; index < files.length; index++) {
    if (/\.html?$/i.test(files[index].name)) assert.deepEqual(outer(actual.files[index].content), outer(files[index].content), 'outer original bytes');
  }
  return { actual, expected };
}

const transpiled = new Map();
function executable(script) {
  if (!script.typescript) return script.content; // JS reaches vm.Script verbatim.
  if (!transpiled.has(script.content)) {
    // Remove TS only AFTER instrumentation; apply the same compiler to original,
    // native and upstream bodies. No formatting normalization enters comparisons.
    transpiled.set(script.content, transformSync(script.content, {
      filename: 'embedded.ts', configFile: false, babelrc: false,
      presets: [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]],
    }).code);
  }
  return transpiled.get(script.content);
}

function execute(files, observation, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const logs = [];
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, console: { log: (...values) => logs.push(values) } });
  const errorOf = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeout invalidates runtime proof');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const input of files) {
    const programs = /\.html?$/i.test(input.name) ? scripts(input.content) : [{ content: input.content }];
    for (const program of programs) {
      // Compilation failures are test failures, never swallowed as mutant errors.
      const compiled = new vm.Script(executable(program), { filename: input.name });
      try { compiled.runInContext(context, { timeout: 1000 }); }
      catch (caught) { loadErrors.push(errorOf(caught)); }
    }
  }
  ns.currentTestId = settings.currentTestId ?? 'html-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  const observer = new vm.Script(observation);
  try { value = observer.runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = errorOf(caught); }
  return structuredClone({ value, error, logs, loadErrors, ns });
}

function runtime(pair, files, observation) {
  const original = execute(files, observation);
  const baseline = execute(pair.actual.files, observation);
  assert.deepEqual(original.loadErrors, []);
  assert.equal(original.error, undefined);
  assert.deepEqual(baseline.loadErrors, []);
  assert.equal(baseline.error, undefined);
  assert.deepEqual([baseline.value, baseline.logs], [original.value, original.logs]);
  const cases = [];
  let changed = false, limited = false, staticCovered = false, testCovered = false;
  for (const id of [undefined, ...pair.expected.mutants.filter(mutant => mutant.status !== 'Ignored').map(mutant => mutant.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(pair.actual.files, observation, id, settings);
      const expected = execute(pair.expected.files, observation, id, settings);
      assert.deepEqual(actual, expected, `id=${id}; settings=${JSON.stringify(settings)}`);
      if (id !== undefined && settings.hitLimit === undefined && JSON.stringify([actual.value, actual.logs]) !== JSON.stringify([baseline.value, baseline.logs])) changed = true;
      limited ||= [...actual.loadErrors, actual.error].some(error => /Hit count limit reached/.test(error?.message ?? ''));
      staticCovered ||= Object.keys(actual.ns.mutantCoverage?.static ?? {}).length > 0;
      testCovered ||= Object.values(actual.ns.mutantCoverage?.perTest ?? {}).some(coverage => Object.keys(coverage).length > 0);
      cases.push({ id, settings, actual, expected });
    }
  }
  assert.ok(changed, 'active mutations change behavior');
  assert.ok(limited, 'active mutations enforce hit limits');
  assert.ok(staticCovered, 'static coverage executes');
  assert.ok(testCovered, 'per-test coverage executes');
  return { original, baseline, cases };
}

test('unchanged actual HTML corpus is strict native with three full records and every mutant executes', async () => {
  const content = htmlSample;
  assert.equal(hash(content), 'a17f7f804f868a6bee84105728ade574a310d75f39f0dae9e8efb8cbc3bb4d92');
  let comparedResource = null;
  try {
    assert.equal(await readFile(resource, 'utf8'), content, 'pinned resource bytes');
    comparedResource = fileURLToPath(resource);
  } catch (error) {
    if (resourceOverride !== undefined || error.code !== 'ENOENT') throw error;
  }
  const files = [file(content, 'html-sample.html')];
  const pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 3);
  const execution = runtime(pair, files, '[add(40,2),add(2,3)]');
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`resource-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify({
    source: 'embedded pinned html-sample.html', comparedResource, sha256: hash(content), files, ...pair, execution,
  }, null, 2));
});

test('ordered independent JS and TS script programs preserve comments attributes raw text and outer bytes', async () => {
  const content = `<!doctype html>\r\n<html lang="en"><head><meta charset="UTF-8" />
<title>😀 text <script>looks like a tag</title><style>.x{content:"<script>"}</style></head>
<body><!-- <script>bad syntax </script> --><div data-example='<script>invalid!</script>'>😀</div>
<script>const loaded=true;function first(){return 1+2;}</script>
<section><script lang="TS" type="text/javascript">function second(){return loaded?"<script>":"x";}</script></section>
<script type="text/typescript">function third(value:number=3):number{return value+2;}</script>
<script src="elsewhere.js">invalid JavaScript is opaque</script><script type="application/json">{"kept":true}</script>
<script type="">unrecognized and untouched</script><script></script><br><img src="x" /></body></html>`;
  const files = [file(content)];
  const pair = await compare(files);
  runtime(pair, files, '[first(),second(),third(),third(4)]');
  assert.ok(pair.actual.mutants.every(mutant => mutant.fileName === 'container.html'));
  assert.deepEqual(pair.actual.mutants.map(mutant => mutant.id), pair.actual.mutants.map((_, index) => String(index)));
  assert.ok(pair.actual.files[0].content.includes('<script src="elsewhere.js">invalid JavaScript is opaque</script>'));
});

test('all pinned script selectors obey first type before lang and exact src exclusion', async () => {
  for (const [attr, typescript] of [
    ['', false], ['type="JS"', false], ['type="text/javascript"', false], ['type="javascript"', false], ['type="module"', false],
    ['lang="ts"', true], ['type="text/typescript"', true], ['type="typescript"', true], ['lang="tsx" type="js"', false],
  ]) {
    const body = typescript ? 'function calc(value:number=2){return value+1;}' : 'function calc(value=2){return value+1;}';
    for (const name of ['selector.htm', 'selector.HTML']) {
      const files = [file(`<script ${attr}>${body}</script>`, name)];
      const pair = await compare(files);
      runtime(pair, files, '[calc(),calc(4)]');
    }
  }
  for (const attr of ['src', 'src=""', 'src="x" type="ts"', 'type="" lang="js"', 'lang="json"', 'type="application/json" lang="js"']) {
    const files = [file(`<script ${attr}>this is not executable JavaScript!</script>`)];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants.length, 0);
    assert.equal(pair.actual.files[0].content, files[0].content);
  }
});

test('UTF16 Unicode CRLF and pinned absolute first-line column quirk are preserved', async () => {
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const prefix = `<div>😀</div>${newline}<script>`;
    const files = [file(`${prefix}const first=true;${newline}function calc(){return first?"😀":"x";}</script>`)];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants[0].location.start.column, prefix.length + 'const first='.length);
    runtime(pair, files, '[calc(),calc()]');
  }
});

test('script-relative selections directives exclusions and noHeader retain pinned contracts', async () => {
  const content = `<div>outside</div>\n<script>// Stryker disable next-line BooleanLiteral: first only\nconst first=true;\nfunction calc(){return first?1+2:4;}</script><script>const second=false;</script>`;
  for (const mutate of [true, false, [], [{ start: { line: 1, column: 0 }, end: { line: 1, column: 99 } }], [{ start: { line: 2, column: 0 }, end: { line: 2, column: 99 } }]]) {
    for (const excludedMutations of [[], ['ArithmeticOperator']]) {
      await compare([file(content, 'ranges.html', mutate)], { ...options, excludedMutations });
    }
  }
  const noHeader = await compare([file('<script>const value=true;</script>')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
});

const unsupported = [
  '<SCRIPT>const x=true;</SCRIPT>', '<script TYPE="js">const x=true;</script>', '<script SRC="x">const x=true;</script>',
  '<script>const x=true;</SCRIPT>', '<script type="js" type="ts">const x=true;</script>',
  '<script type="js" TYPE="json">const x=true;</script>', '<script type="tsx">const x=<p/>;</script>',
  '<script lang="tsx">const x=true;</script>', '<script/>', '<div/><script>const x=true;</script>',
  '<template><script>const x=true;</script></template>', '<svg><script>const x=true;</script></svg>',
  '<table><script>const x=true;</script><tr><td>x</td></tr></table>',
  '<div><p>implicit</div><script>const x=true;</script>', '<div><span></div></span>',
  '<script>const x=true;', '<script>const x=true;</script extra>', '<script>const x=true;</script/>',
  '<script type="js>const x=true;</script>', '<script type=js/lang=ts>const x=true;</script></div>',
  '<script>const x=true;</ script>', '<script>const x="</ script>";</script>',
  '<script>const x="<!--<script></script>";</script>',
  '<!-- unclosed <script>const x=true;</script>', '<div>&unknown;</div><script>const x=true;</script>',
  '<div>{{ foo() }}</div>', '<script type="text&#47;javascript">const x=true;</script>',
  '<script>const x=<p/>;</script>', '<script>const x=true;</script><script>const y=obj.tag`x`;</script>',
  '<script>const x:number=1;</script>', '<textarea><script>const opaque=true;</script></textarea>',
  '<html><head></head><body></body><script>const moved=true;</script></html>',
  '<html><head></head><body></body></html><span>moved</span>',
  '<script>"use strict";const x=true;</script>', '<script>const f=()=>({method(){return true;}});</script>',
];

test('ambiguous markup and JS reject atomically and auto preserves complete upstream results or errors', async () => {
  for (const content of unsupported) {
    const files = [file('const before=true;', 'before.js'), file(content)];
    const direct = raw(files);
    assert.equal(direct.supported, false, content);
    assert.equal(direct.result, undefined, content);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i, content);
    const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); }
    catch (error) { failure = error; }
    if (failure) {
      await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message === failure.message, content);
    } else assert.deepEqual(await automatic.instrument(files, options), expected, content);
    assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0], content);
  }
});

test('serial four auto serial recovery and cache bypass retain exact native source bytes and global IDs', async () => {
  const files = [file('const before=true;', 'before.js'), file('<script>const x=true;function calc(){return x?1+2:0;}</script>'),
    file('<script type="ts">const y:number=1+2;</script>', 'typed.html'), file('const after=false;', 'after.js')];
  const pair = await compare(files);
  const baseline = raw(files);
  for (const threads of [1, 4, 'auto']) {
    assert.deepEqual(raw(files, threads).result, baseline.result);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    const bad = [...files, file('<template><script>const bad=true;</script></template>', 'bad.html')];
    await assert.rejects(strict.instrument(bad, options), /unsupported/i);
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    assert.equal(strict.stats.nativeErrors, 0);
  }
  const recovery = raw(files, 4);
  if (recovery.execution.spawnedThreads) {
    assert.equal(recovery.execution.serialRecoveries, 1);
    assert.equal(recovery.execution.reason, 'unproven-relocation');
  }
  const cacheDir = new URL(`cache-${process.versions.bun ? 'bun' : 'node'}/`, artifact);
  await rm(cacheDir, { recursive: true, force: true });
  const cached = createInstrumenter(logger, { cacheDir: fileURLToPath(cacheDir), engine: 'native', instrumentationThreads: 4 });
  assert.deepEqual(plain(await cached.instrument(files, options)), baseline.result);
  assert.deepEqual(plain(await cached.instrument(files, options)), baseline.result);
  assert.equal(cached.stats.nativeBatches, 2);
  assert.equal(cached.stats.bypasses, 2);
  assert.equal(cached.stats.hits, 0);
  assert.equal(cached.stats.misses, 0);
  assert.equal(cached.stats.fallbackBatches, 0);
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`modes-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify({ files, ...pair, recovery: recovery.execution, stats: cached.stats }, null, 2));
});

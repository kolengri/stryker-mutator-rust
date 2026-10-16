import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'hashbang.js', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));
const artifact = new URL('../artifacts/native-hashbang/', import.meta.url);
const corpus = new URL(process.env.STRYKER_HASHBANG_RESOURCE || '../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/shebang.js', import.meta.url);
const hash = content => createHash('sha256').update(content).digest('hex');

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'strict ABI ordered full mutant records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public /instrumenter ordered full mutant records');
  assert.deepEqual(plain(actual), direct.result, 'public native output is exactly the ABI output');
  assert.deepEqual(actual.files.map(({ content, ...metadata }) => metadata), files.map(({ content, ...metadata }) => metadata));
  assert.deepEqual(actual.files.map(({ content, ...metadata }) => metadata), expected.files.map(({ content, ...metadata }) => metadata));
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  return { actual, expected };
}

// Compile each file independently, without a prefix, wrapper or TypeScript
// transform: stripping a hashbang would conceal invalid generated syntax.
function execute(files, observation, id, settings = {}, helpers = '') {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const logs = [];
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, console: { log: (...args) => logs.push(args) } });
  const errorOf = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeouts are failed execution proofs');
    return { name: error.name, message: error.message };
  };
  let loadError, error, value;
  if (helpers) new vm.Script(helpers).runInContext(context, { timeout: 1000 });
  try {
    for (const { content, name } of files) new vm.Script(content, { filename: name }).runInContext(context, { timeout: 1000 });
  } catch (caught) { loadError = errorOf(caught); }
  ns.currentTestId = settings.currentTestId ?? 'hashbang-test';
  if (settings.afterLoad) ns.activeMutant = id;
  try { value = new vm.Script(observation).runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = errorOf(caught); }
  return structuredClone({ value, logs, loadError, error, ns });
}

function runtime(pair, files, observation, helpers = '') {
  const original = execute(files, observation, undefined, {}, helpers);
  const baseline = execute(pair.actual.files, observation, undefined, {}, helpers);
  assert.equal(original.loadError, undefined);
  assert.equal(original.error, undefined);
  assert.equal(baseline.loadError, undefined);
  assert.equal(baseline.error, undefined);
  for (const key of ['value', 'logs']) assert.deepEqual(baseline[key], original[key], `original ${key}`);
  let changed = false, limited = false, staticCovered = false, testCovered = false;
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(pair.actual.files, observation, id, settings, helpers);
      assert.deepEqual(actual, execute(pair.expected.files, observation, id, settings, helpers),
        `mutant=${id}, settings=${JSON.stringify(settings)}`);
      if (id !== undefined && settings.hitLimit === undefined
        && JSON.stringify([actual.value, actual.logs]) !== JSON.stringify([baseline.value, baseline.logs])) changed = true;
      if (/Hit count limit reached/.test(actual.loadError?.message ?? actual.error?.message ?? '')) limited = true;
      staticCovered ||= Object.keys(actual.ns.mutantCoverage?.static ?? {}).length > 0;
      testCovered ||= Object.values(actual.ns.mutantCoverage?.perTest ?? {}).some(c => Object.keys(c).length > 0);
    }
  }
  assert.ok(changed, 'an active mutant changes observable behavior');
  assert.ok(limited, 'an active mutant reaches the hit limit');
  assert.ok(staticCovered, 'load or falsy-test execution records static coverage');
  return { staticCovered, testCovered };
}

const terminators = [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'], ['U2028', '\u2028'], ['U2029', '\u2029']];
for (const [label, newline] of terminators) {
  test(`parsed hashbang with ${label} keeps safe header placement and runtime semantics`, async () => {
    const prefix = `#! /usr/bin/env node 😀${newline}// preamble${newline}`;
    for (const extension of ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']) {
      const files = [file(`${prefix}const loaded=true;function calc(){return [loaded,"😀",false];}`, `hashbang.${extension}`)];
      const pair = await compare(files);
      assert.ok(pair.actual.files[0].content.startsWith(prefix + 'function stryNS_9fa48'));
      assert.ok(pair.expected.files[0].content.startsWith('#! /usr/bin/env node 😀\n'));
      assert.ok(runtime(pair, files, '[calc(),calc()]').testCovered);
    }
  });
}

test('unchanged pinned upstream shebang resource has one complete native record and executable mutants', { skip: !existsSync(corpus) }, async () => {
  const content = await readFile(corpus, 'utf8');
  const files = [file(content, 'shebang.js')];
  const pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 1);
  runtime(pair, files, 'undefined');
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`resource-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify({
    resource: fileURLToPath(corpus), sha256: hash(content), input: files, native: pair.actual, upstream: pair.expected,
    execution: 'Original, native and upstream run as separate unmodified vm.Script sources; baseline and every mutant; activation before/after load, static coverage and hit limits.',
  }, null, 2));
});

test('exact former negative source now has positive ABI public and runtime proof', async () => {
  const content = '#!/usr/bin/env node\nconst a = true;';
  const files = [file(content, 'unsupported.js')];
  runtime(await compare(files), files, 'a');
});

test('hashbang text is opaque, and missing final newline never creates code or a header', async () => {
  for (const content of ['#!', '#!/usr/bin/env node', '#!/usr/bin/env node; const a = true;',
    '#!/usr/bin/env node // Stryker disable all 😀', '#!/usr/bin/env node\r\n', '#!/usr/bin/env node\n// end']) {
    const files = [file(content)];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants.length, 0);
    assert.equal(pair.actual.files[0].content, content, 'native keeps exact uninstrumented bytes');
    assert.equal(execute(pair.actual.files, 'undefined').loadError, undefined);
    assert.deepEqual(execute(pair.actual.files, 'undefined'), execute(pair.expected.files, 'undefined'));
  }
  const files = [file('#! Stryker disable all\nconst a=true;')];
  assert.equal((await compare(files)).actual.mutants.length, 1, 'hashbang is not a Stryker comment');
  const empty = [file('#!\nconst a=true;')];
  runtime(await compare(empty), empty, 'a');
});

function position(source, offset) {
  const lines = source.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/u);
  return { line: lines.length - 1, column: lines.at(-1).length };
}

test('hashbang directives ranges Unicode offsets exclusions and global IDs reuse native semantics', async () => {
  const content = '#!/usr/bin/env node 😀\r\n// Stryker disable StringLiteral: preserve text\r\nconst text="😀";const first=true;\r\n// Stryker restore StringLiteral\r\nfunction calc(){return [text,"live",false];}';
  const start = content.indexOf('false');
  const selected = [{ start: position(content, start), end: position(content, start + 5) }];
  for (const mutate of [true, false, [], selected]) {
    for (const excludedMutations of [[], ['StringLiteral'], ['BooleanLiteral'], ['all']]) {
      const files = [file('const before=true;', 'before.js'), file(content, 'hashbang.ts', mutate), file('const after=false;', 'after.js')];
      const pair = await compare(files, { ...options, excludedMutations });
      assert.deepEqual(raw(files, 4, { ...options, excludedMutations }).result, plain(pair.actual));
      if (mutate === false) assert.equal(pair.actual.files[1].content, content);
      if (mutate === true && !excludedMutations.length) {
        const ignored = pair.actual.mutants.find(m => m.status === 'Ignored');
        assert.equal(ignored.statusReason, 'preserve text');
        assert.ok(runtime(pair, files, '[calc(),calc()]').testCovered);
      }
      if (mutate === selected && !excludedMutations.length) {
        const middle = pair.actual.mutants.filter(m => m.fileName === 'hashbang.ts');
        assert.equal(middle.length, 1);
        assert.deepEqual(middle[0].location, selected[0]);
      }
    }
  }
});

test('noHeader and supplied helpers preserve hashbang activation coverage and hit limits', async () => {
  const files = [file('#!/usr/bin/env node\nconst loaded=true;function calc(){return [loaded,false];}')];
  const pair = await compare(files, { ...options, noHeader: true });
  assert.ok(pair.actual.files[0].content.startsWith('#!/usr/bin/env node\nconst'));
  assert.ok(!pair.actual.files[0].content.includes('function stryNS_9fa48'));
  const control = await compare([file('const control=true;')]);
  const end = control.actual.files[0].content.indexOf('const control');
  assert.ok(end > 0);
  assert.ok(runtime(pair, files, '[calc(),calc()]', control.actual.files[0].content.slice(0, end)).testCovered);
});

test('serial parallel auto recovery and cache preserve complete native output exactly', async () => {
  const files = [file('const before=true;', 'before.js'), file('#!/usr/bin/env node\nconst a=true;', 'hashbang.js'),
    file('#!', 'empty.ts'), file('#!/bin/sh\nconst untouched=false;', 'off.cjs', false), file('const after=false;', 'after.js')];
  const pair = await compare(files);
  const serial = raw(files);
  const recovery = [...files, file('type T=typeof stryMutAct_9fa48;const live=true;', 'opaque.ts')];
  const recoverySerial = raw(recovery);
  assert.equal(recoverySerial.supported, true, recoverySerial.reason);
  for (const threads of [1, 4, 'auto']) {
    assert.deepEqual(raw(files, threads).result, serial.result);
    const recovered = raw(recovery, threads);
    assert.deepEqual(recovered.result, recoverySerial.result);
    if (threads === 4 && availableParallelism() > 1) {
      assert.ok(recovered.execution.spawnedThreads > 0);
      assert.equal(recovered.execution.serialRecoveries, 1);
    }
    assert.deepEqual(raw(files, threads).result, serial.result);
  }
  const cacheDir = new URL(`cache-${process.versions.bun ? 'bun' : 'node'}/`, artifact);
  await rm(cacheDir, { recursive: true, force: true });
  const cached = createInstrumenter(logger, { cacheDir: fileURLToPath(cacheDir), engine: 'native' });
  assert.deepEqual(await cached.instrument(files, options), pair.actual);
  assert.deepEqual(await cached.instrument(files, options), pair.actual);
  assert.deepEqual([cached.stats.misses, cached.stats.hits, cached.stats.nativeBatches], [1, 1, 1]);
});

test('malformed misplaced BOM second hashbang and existing boundaries retain atomic fallback and errors', async () => {
  for (const content of ['\ufeff#!/usr/bin/env node\nconst a=true;', ' #!/usr/bin/env node\nconst a=true;',
    '\n#!/usr/bin/env node\nconst a=true;', '# /usr/bin/env node\nconst a=true;',
    '#!/usr/bin/env node\n#!/bin/sh\nconst a=true;', '#!/usr/bin/env node\n"use strict";\nconst a = true;',
    '#!/usr/bin/env node\nconst a=(call?.())();']) {
    for (const extension of ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']) {
      const files = [file('const before=true;', 'before.js'), file(content, `boundary.${extension}`)];
      const rejected = raw(files);
      assert.equal(rejected.supported, false, content);
      assert.equal(rejected.result, undefined);
      for (const threads of [4, 'auto']) assert.deepEqual(raw(files, threads), rejected);
      const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
      await assert.rejects(strict.instrument(files, options), /unsupported/i);
      let expected, failure;
      try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
      const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
      if (failure) await assert.rejects(auto.instrument(files, options), error =>
        error.name === failure.name && error.message === failure.message);
      else assert.deepEqual(await auto.instrument(files, options), expected);
      assert.deepEqual([auto.stats.nativeBatches, auto.stats.fallbackBatches, auto.stats.nativeErrors], [0, 1, 0]);
    }
  }
});

// Actual module loaders also see the original first byte. Node's native TS
// stripping and Bun's loader are used directly, never a transform that can fix
// an invalid hashbang. Each emitted baseline and every mutant is executed.
test('JS TS mjs cjs mts cts files execute through the real runtime loader with hashbang intact', async () => {
  const directory = new URL(`loader-${process.versions.bun ? 'bun' : 'node'}/`, artifact);
  await mkdir(directory, { recursive: true });
  const wrapper = new URL('run.mjs', directory);
  await writeFile(wrapper, `
import { pathToFileURL } from 'node:url';
const [target,id,after,limit]=process.argv.slice(2);
const ns=globalThis.__stryker__={...(after==='1'?{}:{activeMutant:id||undefined}),...(limit?{hitCount:0,hitLimit:Number(limit)}:{})};
let loadError,error,value;
try{await import(pathToFileURL(target));}catch(e){loadError={name:e.name,message:e.message};}
ns.currentTestId='loader-test';if(after==='1')ns.activeMutant=id||undefined;
try{value=[globalThis.calc(2),globalThis.calc(2)];}catch(e){error={name:e.name,message:e.message};}
console.log(JSON.stringify({loaded:globalThis.loaded,value,loadError,error,ns}));
`);
  const runs = [];
  for (const extension of ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']) {
    const typed = ['ts', 'mts', 'cts'].includes(extension);
    const module = ['mjs', 'mts'].includes(extension);
    const content = `#!/usr/bin/env node\n${module ? 'export ' : ''}function calc(value${typed ? ': number' : ''})${typed ? ': boolean' : ''}{return value>0;}\nglobalThis.calc=calc;globalThis.loaded=true;`;
    const files = [file(content, `loader.${extension}`)];
    const pair = await compare(files);
    const paths = [];
    for (const [name, result] of [['original', { files }], ['native', pair.actual], ['upstream', pair.expected]]) {
      const path = new URL(`${name}.${extension}`, directory);
      assert.ok(result.files[0].content.startsWith('#!/usr/bin/env node\n'));
      await writeFile(path, result.files[0].content);
      paths.push(fileURLToPath(path));
    }
    function run(path, id, settings = {}) {
      const child = spawnSync(process.execPath, [fileURLToPath(wrapper), path, id ?? '', settings.afterLoad ? '1' : '0', String(settings.hitLimit ?? '')], {
        encoding: 'utf8', timeout: 15000, env: { ...process.env, __STRYKER_ACTIVE_MUTANT__: '' },
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr || child.stdout);
      return JSON.parse(child.stdout);
    }
    const original = run(paths[0]);
    assert.equal(original.loadError, undefined);
    assert.equal(original.error, undefined);
    assert.deepEqual(original.value, [true, true]);
    let changed = false, limited = false;
    for (const id of [undefined, ...pair.expected.mutants.map(m => m.id)]) {
      for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
        const actual = run(paths[1], id, settings);
        assert.deepEqual(actual, run(paths[2], id, settings), `${extension} mutant=${id} ${JSON.stringify(settings)}`);
        if (id === undefined) {
          assert.equal(actual.loadError, undefined);
          assert.deepEqual(actual.value, original.value);
          assert.equal(actual.loaded, true);
        } else {
          changed ||= JSON.stringify(actual.value) !== JSON.stringify(original.value);
          limited ||= /Hit count limit reached/.test(actual.loadError?.message ?? actual.error?.message ?? '');
        }
      }
    }
    assert.ok(changed);
    assert.ok(limited);
    runs.push({ extension, mutants: pair.actual.mutants.length, sourceSha256: hash(content), original: true, allMutants: true });
  }
  await writeFile(new URL('result.json', directory), JSON.stringify(runs, null, 2));
});

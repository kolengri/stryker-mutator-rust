import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

// Exercise the frozen native ABI directly, independently of the JS bridge.
const file = (content, name = 'parallel.js', mutate = true) => ({ name, content, mutate });
const raw = (files, threads, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === undefined ? {} : { execution: { threads } }),
})));
const plain = value => JSON.parse(JSON.stringify(value));
const digest = result => createHash('sha256').update(JSON.stringify(result)).digest('hex');

function execution(response, count, { recovery = false, auto = false } = {}) {
  const stats = response.execution;
  assert.ok(stats, 'successful native batches report actual execution');
  assert.equal(Object.hasOwn(response.result, 'execution'), false);
  if (!count || count === 1 || availableParallelism() === 1 || auto) {
    assert.equal(stats.threadsUsed, count ? 1 : 0);
    assert.equal(stats.spawnedThreads, 0);
    assert.equal(stats.parallelFiles, 0);
    assert.equal(stats.serialRecoveries, 0);
  } else if (recovery) {
    assert.equal(stats.threadsUsed, 1);
    assert.ok(stats.spawnedThreads > 0);
    assert.equal(stats.parallelFiles, 0);
    assert.equal(stats.serialRecoveries, 1);
    assert.equal(stats.reason, 'unproven-relocation');
  } else {
    assert.ok(stats.threadsUsed > 1);
    assert.equal(stats.spawnedThreads, stats.threadsUsed - 1);
    assert.ok(stats.spawnedThreads <= Math.min(7, count - 1));
    assert.equal(stats.parallelFiles, count);
    assert.equal(stats.serialRecoveries, 0);
  }
}

async function pair(files, config = options, settings) {
  const serial = raw(files, 1, config);
  const parallel = raw(files, 8, config);
  assert.equal(serial.supported, true, serial.reason);
  assert.equal(parallel.supported, true, parallel.reason);
  assert.deepEqual(parallel.result, serial.result, 'all code bytes, ordered files and ordered records');
  execution(parallel, files.length, settings);
  const expected = await new Instrumenter(logger).instrument(files, config);
  assert.deepEqual(parallel.result.mutants, plain(expected.mutants), 'pinned upstream complete ordered records');
  return { actual: parallel.result, expected, execution: parallel.execution };
}

test('native execution validation and empty/single/auto serial fast paths', () => {
  for (const execution of [null, [], 1, { threads: 0 }, { threads: -1 }, { threads: 1.5 },
    { threads: null }, { threads: '2' }, { threads: Number.MAX_SAFE_INTEGER + 1 }]) {
    const response = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files: [], options, execution })));
    assert.equal(response.supported, false, JSON.stringify(execution));
    assert.match(response.reason, /Invalid instrumentation input/);
    assert.equal(response.result, undefined);
  }
  for (const files of [[], [file('const x=true;')]]) {
    const response = raw(files, 8);
    assert.equal(response.supported, true, response.reason);
    execution(response, files.length);
  }
  const files = [file('const a=true;'), file('const b=false;')];
  const auto = raw(files);
  const omittedThreads = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options, execution: {} })));
  assert.deepEqual(omittedThreads, auto);
  execution(auto, 2, { auto: true });
  assert.deepEqual(raw(files, 8).result, raw(files, Number.MAX_SAFE_INTEGER).result);
  execution(raw(files, 8), 2);
});

test('prefix sums cross 9/10 and 99/100 and include filtered and ignored IDs', async () => {
  const files = [
    file('consume(true);\n' + Array.from({ length: 60 }, (_, i) => `const a${i}=true;`).join('\n'), 'first.js'),
    file('consume(false);\nconsume(function(){try{}catch(e:any){}});\n' + Array.from({ length: 42 }, (_, i) => `const b${i}=false;`).join('\n'), 'second.ts'),
    file('// Stryker disable next-line BooleanLiteral: intentional\nconst ignored=true;\nconst last=false;', 'last.js'),
  ];
  const result = await pair(files);
  const ids = result.actual.mutants.map(m => Number(m.id));
  assert.ok(ids.includes(9) && ids.includes(10) && ids.includes(99) && ids.includes(100));
  assert.equal(ids[0], 1, 'filtered call deletion still consumed ID 0');
  assert.ok(ids.some((id, index) => index > 0 && id > ids[index - 1] + 1), 'typed catch/filter gaps survive relocation');
  assert.ok(result.actual.mutants.some(m => m.status === 'Ignored'));
  assert.ok(Number(result.actual.mutants.at(-1).id) > 100);
});

test('selection, directives, opaque types, defaults and noHeader preserve all output bytes', async () => {
  const selected = 'const unselected=true;\nconst selected=false;';
  const cases = [
    [file('const inert=1;'), file('const selected=true;', 'selected.js', false)],
    [file('const first=true;', 'duplicate.js'), file('const next=false;', 'duplicate.js')],
    [file('const emoji="😀";\r\nconst x=true;', 'utf16.js'), file('const y=false;', 'range.js', [])],
    [file(selected, 'ranges.js', [{ start: { line: 1, column: 0 }, end: { line: 1, column: 21 } }]), file('const later=true;', 'later.js')],
    [file('// Stryker disable BooleanLiteral: reason\nconst first=true;\n// Stryker restore BooleanLiteral\nconst last=false;'), file('const x=true;', 'next.js')],
    [file('type T=true; interface I {x:"type";} declare function f<T extends true>(x?:"inert"):false;\nconst value=(true) as boolean;', 'opaque.ts'), file('function calc(x:number=2){return x+1;}', 'defaults.ts')],
    [file('consume(function(){try{}catch(e:any){}});', 'filtered.ts'), file('function later(){return true;}', 'later.js')],
    [file('function a(){try{return 1+2;}catch(e){return 3;}finally{consume(4);}}'), file('function b(){function inner(){return true;}return inner();}', 'nested.js')],
  ];
  for (const files of cases) await pair(files);
  for (const config of [{ ...options, noHeader: true }, { ...options, excludedMutations: ['BooleanLiteral'] }]) {
    await pair([file('const a=true;'), file('const b=false;', 'next.js')], config);
  }
});

test('helper-like source strings, escaped values, comments and numeric clone literals are untouched', async () => {
  const marker = 'stryMutAct_9fa48("0") / stryCov_9fa48("10") / __STRYKER_ID_0__';
  const files = [file('const first=true;'), file(`
// stryMutAct_9fa48("1") stryCov_9fa48("2")
const text=${JSON.stringify(marker)};
const escaped="stryMutAct_9fa48(\\\"0\\\")";
const decoded="\\x73tryCov_9fa48";
const digits="0";
const clone=obj.startsWith("0");`, 'strings.js')];
  const result = await pair(files);
  assert.ok(result.actual.files[1].content.includes('// stryMutAct_9fa48("1") stryCov_9fa48("2")'));
  assert.ok(result.actual.mutants.some(m => m.replacement.includes('endsWith("0")')));
});

test('complete original AST scan forces whole-batch recovery for opaque helper identifiers', async () => {
  for (const source of [
    'const hidden=stryMutAct_9fa48("0") as unknown;',
    'const hidden=stryCov_9fa48("0") as unknown;',
    'const hidden=stry\\u004dutAct_9fa48("0") as unknown;',
    'type T=typeof stryMutAct_9fa48; const later=true;',
    'interface I {x:typeof stryCov_9fa48;} const later=true;',
    'declare function f<T extends typeof stryMutAct_9fa48>():typeof stryNS_9fa48; const later=true;',
    'declare const stryMutAct_9fa48:unknown; const later=true;',
    'declare namespace Hidden { const stryCov_9fa48:unknown; } const later=true;',
  ]) {
    await pair([file('const first=true;', 'first.js'), file(source, 'opaque.ts'), file('const last=false;', 'last.js')], options, { recovery: true });
  }
  await pair([file('// Stryker disable BooleanLiteral:   \nconst first=true;', 'empty-reason.js'),
    file('const last=false;', 'last.js')], options, { recovery: true });
  // A successful fresh parallel call after every recovery proves no retained
  // lease, arena, ID counter or directive state is poisoning future calls.
  await pair([file('const first=true;'), file('const last=false;', 'last.js')]);
});

test('unsupported batches select the lowest input index regardless of worker completion', async () => {
  const good = i => file(Array.from({ length: i === 0 ? 50 : 1 }, (_, n) => `const x${n}=true;`).join('\n'), `${i}.js`);
  for (const failures of [[0], [2], [5], [1, 3, 5], [0, 2, 4]]) {
    const files = Array.from({ length: 6 }, (_, i) => failures.includes(i) ? file('const = ;', `${i}.js`) : good(i));
    const reference = raw(files, 1);
    assert.equal(reference.supported, false);
    assert.ok(reference.reason.startsWith(`${failures[0]}.js:`));
    for (let repeat = 0; repeat < 4; repeat++) {
      const response = raw(files, 8);
      assert.deepEqual(response, reference);
      assert.equal(response.result, undefined);
    }
  }
  // These preflight failures must still reject even in unselected/opaque trees.
  for (const source of ['const hidden=(function(x=(a as any)=1){}) as unknown;', 'function f(x=(a)=1){}']) {
    const files = [good(0), file(source, 'parser.ts', false)];
    assert.deepEqual(raw(files, 8), raw(files, 1));
    assert.equal(raw(files, 8).supported, false);
  }
  await pair([good(0), good(1)]);
});

const stripped = new Map();
function executable(output) {
  if (!/\.[cm]?ts$/.test(output.name)) return output.content;
  if (!stripped.has(output.content)) stripped.set(output.content, stripTypeScriptTypes(output.content, { mode: 'strip' }));
  return stripped.get(output.content);
}

function run(result, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = source => new vm.Script(source).runInContext(context, { timeout: 1000 });
  evaluate('const events=[];');
  const errorValue = error => {
    assert.notEqual(error?.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return error && typeof error === 'object' ? { name: error.name, message: error.message } : { primitive: error };
  };
  const compileErrors = [], loadErrors = [];
  for (const output of result.files) {
    let script;
    try { script = new vm.Script(`${settings.strict ? '"use strict";\n' : ''}${executable(output)}`); } catch (error) { compileErrors.push(errorValue(error)); continue; }
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(errorValue(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'parallel-test';
  if (settings.afterLoad) ns.activeMutant = id;
  const observations = [];
  for (const expression of ['alpha(2)', 'beta(2)', 'gamma(2)']) {
    const before = evaluate('events.length');
    let value, error;
    try { value = evaluate(expression); } catch (caught) { error = errorValue(caught); }
    observations.push({ value, error, events: evaluate(`events.slice(${before})`) });
  }
  return structuredClone({ observations, ns, compileErrors, loadErrors });
}

test('every global active ID preserves pinned runtime, effects, errors, coverage and hit limits in its own file', async t => {
  const padding = Array.from({ length: 35 }, (_, i) => `const pad${i}=true;`).join('');
  const files = [
    file(`function alpha(x){${padding}events.push("a");try{return x+1;}finally{events.push("done");}}`, 'alpha.js'),
    file(`function beta(x){${padding}let sum=0;if(x>1){sum+=2;}return sum+3;}`, 'beta.js'),
    file(`function gamma(x:number=2):number{${padding}return x+2;}`, 'gamma.ts'),
  ];
  const result = await pair(files);
  t.diagnostic(JSON.stringify({ execution: result.execution, activeIds: result.actual.mutants.filter(m => m.status !== 'Ignored').map(m => m.id) }));
  const baseline = run(result.actual);
  assert.ok(Number(result.actual.mutants.at(-1).id) > 100);
  assert.deepEqual(baseline, run(result.expected));
  assert.deepEqual(baseline.observations.map(o => o.value), [3, 5, 4]);
  const fileIndex = new Map(files.map((f, i) => [f.name, i]));
  for (const mutant of result.actual.mutants.filter(m => m.status !== 'Ignored')) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = run(result.actual, mutant.id, settings);
      assert.deepEqual(actual, run(result.expected, mutant.id, settings), `global ID ${mutant.id}, ${JSON.stringify(settings)}`);
      assert.deepEqual(actual.compileErrors, []);
      assert.deepEqual(actual.loadErrors, []);
      for (let i = 0; i < files.length; i++) {
        if (i !== fileIndex.get(mutant.fileName)) assert.deepEqual(actual.observations[i], baseline.observations[i], `ID ${mutant.id} must not activate another file`);
      }
    }
  }
});

test('parallel output preserves upstream compilation outcomes for duplicated nested declarations', async () => {
  const source = 'function alpha(){function inner(){return 1;}function inner(){return 2;}return inner();}';
  for (const [first, config, compileError] of [
    [file(source, 'alpha.js'), options, true],
    [file(source, 'alpha.js'), { ...options, excludedMutations: ['BlockStatement'] }, false],
    [file(`// Stryker disable BlockStatement: keep declarations\n${source}`, 'alpha.js'), options, false],
    [file(source, 'alpha.js', false), options, false],
  ]) {
    const result = await pair([first, file('function beta(){return true;}function gamma(){return false;}', 'others.js')], config);
    const actual = run(result.actual, undefined, { strict: true });
    assert.deepEqual(actual, run(result.expected, undefined, { strict: true }));
    assert.equal(Boolean(actual.compileErrors.length), compileError);
  }
});

test('concurrent Node workers share a nonblocking process lease and recover without retained state', { timeout: 120_000 }, async t => {
  const files = Array.from({ length: 12 }, (_, i) => file(Array.from({ length: 350 }, (_, j) => `const v${j}=true;`).join('\n'), `${i}.js`));
  const recoveryFiles = [file('const first=true;', 'first.js'), file('const hidden=stryMutAct_9fa48("0") as unknown;', 'opaque.ts')];
  const expected = digest(raw(files, 1).result);
  const recovered = digest(raw(recoveryFiles, 1).result);
  const gate = new SharedArrayBuffer(4);
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    const { createHash } = require('node:crypto');
    (async () => {
      const { loadNative } = await import(workerData.nativeUrl);
      const call = files => JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: workerData.options, execution: { threads: 4 } })));
      const hash = result => createHash('sha256').update(JSON.stringify(result)).digest('hex');
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage({ ready: true });
      if (Atomics.wait(gate, 0, 0, 30000) === 'timed-out') throw new Error('worker gate timed out');
      const response = call(workerData.files);
      if (!response.supported) throw new Error(response.reason);
      const recoveries = [];
      for (let i=0; i<3; i++) {
        const failure = call([workerData.files[0], { name:'bad.js', mutate:true, content:'const = ;' }]);
        if (failure.supported || failure.result || !failure.reason.startsWith('bad.js:')) throw new Error('non-atomic failure');
        const recovered = call(workerData.recoveryFiles);
        if (!recovered.supported) throw new Error(recovered.reason);
        recoveries.push({ hash: hash(recovered.result), execution: recovered.execution });
      }
      parentPort.postMessage({ hash: hash(response.result), execution: response.execution, recoveries });
    })().catch(error => { throw error; });`;
  const workers = [], ready = [], completed = [];
  for (let i = 0; i < 4; i++) {
    const worker = new Worker(source, { eval: true, workerData: {
      nativeUrl: new URL('../lib/native.js', import.meta.url).href, files, recoveryFiles, options, gate,
    } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message.ready) resolve(); }); worker.once('error', reject); }));
    completed.push(new Promise((resolve, reject) => { worker.on('message', message => { if (!message.ready) resolve(message); }); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`worker exited ${code}`)); }); }));
  }
  try {
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = await Promise.all(completed);
    t.diagnostic(JSON.stringify({ concurrentWorkers: results }));
    for (const result of results) {
      assert.equal(result.hash, expected);
      for (const recovery of result.recoveries) {
        assert.equal(recovery.hash, recovered);
        assert.equal(recovery.execution.threadsUsed, 1);
        assert.equal(recovery.execution.parallelFiles, 0);
        assert.ok(['busy', 'serial', 'unproven-relocation'].includes(recovery.execution.reason));
        assert.equal(recovery.execution.serialRecoveries, recovery.execution.reason === 'unproven-relocation' ? 1 : 0);
      }
    }
    if (availableParallelism() > 1) {
      assert.ok(results.some(result => result.execution.threadsUsed > 1));
      assert.ok(results.some(result => result.execution.reason === 'busy'), 'competing native calls run serially without starting another Rust pool');
      for (const result of results) assert.ok(result.execution.spawnedThreads <= 3);
    }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  await pair([file('const after=true;'), file('const final=false;', 'final.js')]);
});

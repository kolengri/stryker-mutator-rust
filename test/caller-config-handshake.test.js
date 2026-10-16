import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve, dirname, win32 } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { runNativeMutationTest } from '../lib/runtime.js';
import { loadNative } from '../lib/native.js';
import { configDataJson, importConfig } from '../lib/config-compat.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts/caller-config-handshake');
const require = createRequire(import.meta.url);
const coreRoot = dirname(require.resolve('@stryker-mutator/core/package.json'));
const { ConfigReader } = await import(pathToFileURL(join(coreRoot, 'dist/src/config/config-reader.js')));
const { OptionsValidator } = await import(pathToFileURL(join(coreRoot, 'dist/src/config/options-validator.js')));
const { strykerCoreSchema } = await import('@stryker-mutator/api/core');
const { noopLogger, deepMerge } = await import('@stryker-mutator/util');
const reader = new ConfigReader(noopLogger, { validate() {} });
const quoted = (value) => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const base = {
  testRunner: 'command', plugins: [], appendPlugins: [], checkers: [], reporters: [],
  coverageAnalysis: 'off', mutate: [], allowEmpty: true, concurrency: 1,
  commandRunner: { command: `${quoted(process.execPath)} -e ""` },
  cleanTempDir: 'always', logLevel: 'off',
};
async function fixture(t, files = {}) {
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(join(artifacts, 'case-'));
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [name, text] of Object.entries(files)) await writeFile(join(cwd, name), text);
  const previous = process.cwd();
  process.chdir(cwd);
  t.after(async () => { process.chdir(previous); await rm(cwd, { recursive: true, force: true }); });
  return cwd;
}
const esm = (extra = '') => `export default ${JSON.stringify(base)}; ${extra}`;
const request = (cwd, overrides = {}) => JSON.stringify({ version: 1, cwd, overrides });
function assertStopped(pid) {
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', `Child ${pid} remains active`);
    return;
  }
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(status.error, undefined, status.error?.message);
  assert.ok(status.status === 0 || status.status === 1, status.stderr);
  // Adopted POSIX descendants may remain zombies until init reaps them. Match
  // the native-runtime cancellation oracle: no child may still execute code.
  assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), `Child ${pid} remains active: ${status.stdout}`);
}
const success = async (input, options) => {
  const result = await runNativeMutationTest(input, options);
  assert.equal(result.supported, true, result.reason);
  assert.equal(result.stats.coordinator, 'rust');
  return result;
};

test('ESM, JS and CJS extraction matches exact core; defaults and CLI precedence stay in Rust', async (t) => {
  const cwd = await fixture(t);
  for (const extension of ['js', 'mjs', 'cjs']) {
    const name = `explicit.${extension}`;
    const options = { ...base, timeoutMS: 7, thresholds: { high: 95 }, warnings: { slow: false } };
    await writeFile(name, extension === 'cjs' ? `module.exports = ${JSON.stringify(options)};` : `export default ${JSON.stringify(options)};`);
    const upstream = await reader.loadOptionsFromConfigFile({ configFile: name });
    const extracted = await importConfig(resolve(name), name);
    assert.deepEqual(extracted.extracted, upstream);
    const overrides = { timeoutMS: 19, thresholds: { low: 25 }, commandRunner: ['annotation'] };
    const arguments_ = { configFile: name, timeoutMS: 13 };
    deepMerge(arguments_, overrides);
    deepMerge(upstream, arguments_);
    new OptionsValidator(structuredClone(strykerCoreSchema), noopLogger).validate(upstream);
    const native = await success({ cwd, args: [name, '--timeoutMS', '13'], overrides });
    assert.deepEqual(native.report.config, upstream);
    assert.equal(JSON.stringify(native.report.config.commandRunner), JSON.stringify(upstream.commandRunner));
  }
});

test('module TLA and main import cache are preserved without awaiting an exported Promise', async (t) => {
  await fixture(t, {
    'cache.mjs': `globalThis.configImports = (globalThis.configImports ?? 0) + 1; await new Promise(r => setTimeout(r, 15)); export default ${JSON.stringify(base)};`,
    'promise.mjs': 'export default new Promise(() => {});',
  });
  t.after(() => delete globalThis.configImports);
  await success({ args: ['cache.mjs'] });
  await success({ args: ['cache.mjs'] });
  assert.equal(globalThis.configImports, 1);
  // node:test's async hooks can add enumerable symbol IDs to Promise objects.
  // Pinned spread retains those; our bounded transport must reject them, not
  // hang awaiting the default Promise or silently discard its symbols.
  const promised = await reader.importJSConfig('promise.mjs');
  const result = await runNativeMutationTest({ args: ['promise.mjs'], overrides: base });
  if (Reflect.ownKeys(promised).some(key => typeof key === 'symbol')) {
    assert.equal(result.supported, false); assert.match(result.reason, /symbol keys/);
  } else assert.equal(result.supported, true, result.reason);
});

test('root spread, export errors and thrown causes match pinned extraction ordering', async (t) => {
  await fixture(t, {
    'root.mjs': `export default Object.defineProperty(Object.create({hidden: 1}), 'timeoutMS', {enumerable:true, get() { globalThis.rootReads = (globalThis.rootReads ?? 0)+1; return 11; }});`,
    'null.mjs': 'export default null;',
    'array.mjs': 'export default [1,2];',
    'named.mjs': 'export const options = {};',
    'primitive.mjs': 'export default 42;',
    'factory.mjs': 'export default () => { globalThis.factoryCalled = true; return {}; };',
    'getter.mjs': 'export default { get timeoutMS() { throw globalThis.configCause; } };',
    'throw.mjs': 'throw globalThis.configCause;',
  });
  globalThis.configCause = new Error('exact original cause');
  t.after(() => { delete globalThis.configCause; delete globalThis.rootReads; delete globalThis.factoryCalled; });
  for (const name of ['root.mjs', 'null.mjs', 'array.mjs']) {
    assert.deepEqual((await importConfig(resolve(name), name)).extracted, await reader.importJSConfig(name));
  }
  assert.equal(globalThis.rootReads, 2);
  for (const name of ['named.mjs', 'primitive.mjs', 'factory.mjs']) {
    const native = await importConfig(resolve(name), name).catch(e => e);
    const upstream = await reader.importJSConfig(name).catch(e => e);
    assert.equal(native.message, upstream.message);
    assert.equal(native.name, upstream.name);
    await assert.rejects(runNativeMutationTest({ args: [name], overrides: base }), e => e.message === upstream.message);
  }
  assert.equal(globalThis.factoryCalled, undefined);
  for (const name of ['getter.mjs', 'throw.mjs']) {
    const actual = await runNativeMutationTest({ args: [name], overrides: base }).catch(e => e);
    const upstream = await reader.importJSConfig(name).catch(e => e);
    assert.equal(actual.message, upstream.message);
    assert.equal(name === 'getter.mjs' ? actual : actual.cause, globalThis.configCause);
  }
  await success({ args: ['null.mjs'], overrides: base });
});

test('Rust discovery matches priority, case-insensitive explicit JSON and fail-fast access/load errors', async (t) => {
  const cwd = await fixture(t, {
    'stryker.conf.mjs': esm(), 'stryker.config.json': JSON.stringify({ ...base, timeoutMS: 23 }),
    '.stryker.conf.json': JSON.stringify({ ...base, timeoutMS: 29 }),
    'upper.JSON': JSON.stringify(base), 'stryker.config.ts': 'throw new Error("no discovery");',
  });
  assert.equal(await reader.findConfigFile(), 'stryker.conf.mjs');
  assert.equal((await success()).report.config.timeoutMS, 5000);
  await writeFile('stryker.conf.json', JSON.stringify({ ...base, timeoutMS: 31 }));
  assert.equal(await reader.findConfigFile(), 'stryker.conf.json');
  assert.equal((await success()).report.config.timeoutMS, 31);
  assert.equal((await success({ args: ['upper.JSON'] })).supported, true);
  await writeFile('stryker.conf.json', '{broken');
  assert.match((await runNativeMutationTest()).reason, /File contains invalid JSON/);
  await rm('stryker.conf.json');
  await mkdir('stryker.conf.json');
  assert.match((await runNativeMutationTest()).reason, /Cannot read configuration/);
  const empty = await runNativeMutationTest({ overrides: { configFile: '' } });
  assert.equal(empty.reason, (await reader.loadOptionsFromConfigFile({configFile: ''}).catch(e => e)).message);
  const missing = await runNativeMutationTest({ args: ['missing.mjs'] });
  const upstream = await reader.loadOptionsFromConfigFile({ configFile: 'missing.mjs' }).catch(e => e);
  assert.equal(missing.reason, upstream.message);
  await writeFile('not-directory', '');
  assert.match((await runNativeMutationTest({ args: ['not-directory/file.mjs'] })).reason, /Cannot access configuration/);
  assert.equal((await success({ cwd, args: ['upper.JSON'] })).supported, true);
});

test('descriptor-first transport rejects opaque graphs without nested execution', async (t) => {
  await fixture(t);
  let effects = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { effects++; } });
  const toJSON = { toJSON() { effects++; } };
  const proxy = new Proxy({}, { ownKeys() { effects++; return []; }, getPrototypeOf() { effects++; return null; } });
  const shared = {};
  const cycle = {}; cycle.self = cycle;
  const cases = [getter, toJSON, proxy, Object.freeze({value:1}), Object.preventExtensions({}), Object.defineProperty({}, "fixed", {value:1,enumerable:true}), { fn() {} }, { undefined }, { value: undefined }, { value: NaN }, new Date(), new Map(), /x/, cycle, { a: shared, b: shared }, { [Symbol()]: 1 }, [1, , 3], Object.create({ inherited: 1 })];
  for (const value of cases) assert.throws(() => configDataJson({ value }), /Unsupported executable configuration capability/);
  assert.equal(effects, 0);
  assert.equal(configDataJson({ z: 1, a: { y: 2, x: null } }), '{"z":1,"a":{"y":2,"x":null}}');
  assert.equal(configDataJson(Object.assign(Object.create(null), { safe: true })), '{"safe":true}');
  await writeFile('opaque.mjs', 'export default { warnings: Object.defineProperty({}, "slow", {enumerable:true,get(){throw new Error("nested getter ran");}}) };');
  const result = await runNativeMutationTest({ args: ['opaque.mjs'], overrides: base });
  assert.equal(result.supported, false);
  assert.match(result.reason, /nested accessor/);
  await writeFile('good.mjs', esm());
  await success({ args: ['good.mjs'] });
});

test('executable cwd and SDK mutations are explicit unsupported capabilities and release ownership', async (t) => {
  const cwd = await fixture(t, { 'good.mjs': esm(), 'schema.mjs': `import { strykerCoreSchema } from '@stryker-mutator/api/core'; strykerCoreSchema.properties.timeoutMS.default = 111; export default ${JSON.stringify(base)};` });
  const other = join(cwd, 'other'); await mkdir(other);
  await writeFile(join(other, 'side-effect.mjs'), 'globalThis.shouldNotImport = true; export default {};');
  const different = await runNativeMutationTest({ cwd: other, args: ['side-effect.mjs'] });
  assert.equal(different.supported, false); assert.match(different.reason, /canonical cwd/);
  assert.equal(globalThis.shouldNotImport, undefined);
  const original = strykerCoreSchema.properties.timeoutMS.default;
  try {
    const result = await runNativeMutationTest({ args: ['schema.mjs'] });
    assert.equal(result.supported, false); assert.match(result.reason, /caller SDK core schema/);
  } finally { strykerCoreSchema.properties.timeoutMS.default = original; }
  await writeFile('chdir.mjs', `process.chdir(${JSON.stringify(other)}); export default ${JSON.stringify(base)};`);
  const changed = await runNativeMutationTest({ args: ['chdir.mjs'] });
  assert.equal(changed.supported, false); assert.match(changed.reason, /process.chdir/);
  assert.equal(process.cwd(), other, 'Config side effect must not be silently restored');
  process.chdir(cwd);
  await success({ args: ['good.mjs'] });
  await writeFile(join(other, 'stryker.config.json'), JSON.stringify(base));
  await success({ cwd: other }); // JSON retains multi-cwd support.
});

test('TLA cancellation retains exclusive ownership until JS settles; JSON recovers afterward', async (t) => {
  const cwd = await fixture(t, { 'wait.mjs': `globalThis.importStarted = true; await new Promise(resolve => { globalThis.finishImport = resolve; }); globalThis.importEffectFinished = true; export default ${JSON.stringify(base)};` });
  t.after(() => { delete globalThis.importStarted; delete globalThis.finishImport; delete globalThis.importEffectFinished; });
  const controller = new AbortController();
  const reason = new Error('cancel during import');
  let settled = false;
  const pending = runNativeMutationTest({ args: ['wait.mjs'] }, { signal: controller.signal }).then(v => ({ value: v }), e => ({ error: e })).finally(() => settled = true);
  while (!globalThis.importStarted) await delay(5);
  controller.abort(reason);
  await delay(10); assert.equal(settled, false);
  const binding = loadNative();
  assert.throws(() => binding.runNativeMutationTest(request(cwd)), /exclusive native run ownership/);
  await assert.rejects(runNativeMutationTest({ overrides: { ...base, configFile: false } }), /exclusive native run ownership/);
  globalThis.finishImport();
  assert.equal((await pending).error, reason);
  assert.equal(globalThis.importEffectFinished, true);
  assert.equal(binding.cancelNativeRun('absent'), false);
  await writeFile('stryker.config.json', JSON.stringify(base));
  const results = await Promise.all([success(), success()]);
  assert.ok(results.every(r => r.supported));
});

test('preparation is authoritative, single-use, cancellable and explicitly closeable', async (t) => {
  const cwd = await fixture(t, { 'config.mjs': esm(), 'stryker.config.json': JSON.stringify(base) });
  const binding = loadNative();
  const prep = binding.prepareNativeMutationTest(request(cwd, { configFile: 'config.mjs' }), 'owned-id');
  assert.equal(prep.configPath, join(cwd, 'config.mjs'));
  assert.throws(() => { prep.configPath = '/rewritten'; }, TypeError);
  assert.equal(binding.cancelNativeRun('owned-id'), true);
  prep.close();
  assert.equal(binding.cancelNativeRun('owned-id'), false);
  assert.throws(() => prep.run(), /consumed or closed/);
  const ready = binding.prepareNativeMutationTest(request(cwd), 'cancel-before-queue');
  assert.equal(binding.cancelNativeRun('cancel-before-queue'), true);
  await assert.rejects(ready.run(), e => e.code === 'Cancelled');
  ready.close();
  assert.equal(binding.cancelNativeRun('cancel-before-queue'), false);
  await success();
});

test('ownership spans worker_threads and environment teardown releases abandoned preparation', async (t) => {
  const cwd = await fixture(t, { 'config.mjs': esm(), 'stryker.config.json': JSON.stringify(base) });
  const nativeUrl = new URL('../lib/native.js', import.meta.url).href;
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData.url).then(({loadNative})=>{ global.preparation=loadNative().prepareNativeMutationTest(workerData.input,'worker-preparation'); parentPort.on('message',()=>{}); parentPort.postMessage('ready'); });`, { eval: true, workerData: { url: nativeUrl, input: request(cwd, { configFile: 'config.mjs' }) } });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  assert.throws(() => loadNative().prepareNativeMutationTest(request(cwd)), /exclusive native run ownership/);
  await worker.terminate();
  assert.equal(loadNative().cancelNativeRun('worker-preparation'), false);
  await success();
});


test('original caller load hooks observe the exact requested file URL', async (t) => {
  const cwd = await fixture(t, { 'hooked.mjs': 'throw new Error("loader not used");' });
  const url = pathToFileURL(join(cwd, 'hooked.mjs')).href;
  let loads = 0;
  const hook = registerHooks({ load(candidate, context, next) {
    if (candidate === url) { loads++; return { format: 'module', source: `export default ${JSON.stringify(base)};`, shortCircuit: true }; }
    return next(candidate, context);
  } });
  try { await success({ args: ['hooked.mjs'] }); assert.equal(loads, 1); } finally { hook.deregister(); }
});

for (const [runner, key] of [['mocha', 'mochaOptions'], ['vitest', 'vitest']]) {
  test(`caller ${runner} schema mutations are rejected before isolated plugin validation`, async (t) => {
    const module = `@stryker-mutator/${runner}-runner`;
    await fixture(t, { 'runner-schema.mjs': `import {strykerValidationSchema} from '${module}'; strykerValidationSchema.properties.${key}.default = {unmodeled:true}; export default ${JSON.stringify({ ...base, testRunner:runner, coverageAnalysis:'perTest', plugins:[module] })};` });
    const { strykerValidationSchema } = await import(module);
    const original = strykerValidationSchema.properties[key].default;
    try {
      const result = await runNativeMutationTest({ args: ['runner-schema.mjs'] });
      assert.equal(result.supported, false); assert.match(result.reason, /caller plugin schema/);
    } finally { strykerValidationSchema.properties[key].default = original; }
    await writeFile('good-after-schema.mjs', esm());
    await success({ args: ['good-after-schema.mjs'] });
  });
}

test('JSON leases block executable evaluation but allow overlapping JSON preparations', async (t) => {
  const cwd = await fixture(t, { 'effect.mjs': `globalThis.conflictingImport = true; export default ${JSON.stringify(base)};`, 'stryker.config.json': JSON.stringify(base) });
  const binding = loadNative();
  const first = binding.prepareNativeMutationTest(request(cwd), 'json-one');
  const second = binding.prepareNativeMutationTest(request(cwd), 'json-two');
  try {
    await assert.rejects(runNativeMutationTest({ args: ['effect.mjs'] }), /exclusive native run ownership/);
    assert.equal(globalThis.conflictingImport, undefined);
  } finally { first.close(); second.close(); }
  const result = JSON.parse(await binding.runNativeMutationTest(request(cwd), 'direct-json'));
  assert.equal(result.supported, true, result.reason);
  assert.equal(binding.cancelNativeRun('direct-json'), false);
});

test('worker teardown awaits active native Task and releases child, registration and lease state', { timeout: 10000 }, async (t) => {
  const cwd = await fixture(t);
  const pidFile = join(cwd, 'active-pid');
  await writeFile('hold.cjs', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>{},200);`);
  const options = { ...base, commandRunner: { command: `${quoted(process.execPath)} hold.cjs` } };
  await writeFile('stryker.config.json', JSON.stringify(options));
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData.url).then(({loadNative})=>{ loadNative().runNativeMutationTest(workerData.input,'worker-active').catch(()=>{}); parentPort.postMessage('queued'); });`, { eval: true, workerData: { url: new URL('../lib/native.js', import.meta.url).href, input: request(cwd) } });
  t.after(async () => { loadNative().cancelNativeRun('worker-active'); await worker.terminate(); });
  assert.deepEqual(await once(worker, 'message'), ['queued']);
  let pid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const candidate = Number(await readFile(pidFile, 'utf8'));
      if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(5);
  }
  assert.ok(pid > 0);
  await worker.terminate();
  assert.equal(loadNative().cancelNativeRun('worker-active'), false);
  assertStopped(pid);
  await assert.rejects(readFile(join(cwd, '.stryker-tmp')), e => e.code === 'ENOENT');
  await success({ overrides: base });
});

test('public abort after executable preparation keeps registration and lease through native cleanup', { timeout: 10000 }, async (t) => {
  const cwd = await fixture(t);
  const pidFile = join(cwd, 'exec-pid');
  await writeFile('hold.cjs', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
  const options = { ...base, commandRunner: { command: `${quoted(process.execPath)} hold.cjs` } };
  await writeFile('active.mjs', `export default ${JSON.stringify(options)};`);
  const controller = new AbortController();
  const reason = new Error('abort after executable handoff');
  t.after(() => controller.abort(reason));
  const settled = runNativeMutationTest({ args: ['active.mjs'] }, { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  let pid;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
      const candidate = Number(await readFile(pidFile, 'utf8'));
      if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(5);
    }
    assert.ok(pid > 0);
    assert.throws(() => loadNative().runNativeMutationTest(request(cwd)), /exclusive native run ownership/);
    assert.throws(() => assertStopped(pid), /remains active/, 'The termination oracle must reject the live command');
  } finally { controller.abort(reason); }
  assert.equal((await settled).error, reason);
  assertStopped(pid);
  await assert.rejects(readFile(join(cwd, '.stryker-tmp')), e => e.code === 'ENOENT');
  await writeFile('recovered.mjs', esm());
  await success({ args: ['recovered.mjs'] });
});

test('root getter exceptions retain identity without cancellation/capability inspection', async (t) => {
  await fixture(t, { 'getter-errors.mjs': `export default { get thresholds() { globalThis.getterController?.abort(globalThis.getterAbortReason); throw globalThis.getterThrown; } };`, 'recovery.mjs': esm() });
  const { UnsupportedConfigCapability } = await import('../lib/config-compat.js');
  const controller = new AbortController();
  const ownError = Object.assign(new Error('getter owns this error'), { code: 'Cancelled' });
  globalThis.getterController = controller;
  globalThis.getterAbortReason = new Error('distinct abort reason');
  globalThis.getterThrown = ownError;
  t.after(() => { delete globalThis.getterController; delete globalThis.getterAbortReason; delete globalThis.getterThrown; });
  await assert.rejects(runNativeMutationTest({ args: ['getter-errors.mjs'], overrides: base }, { signal: controller.signal }), error => error === ownError);
  delete globalThis.getterController;
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error('exception get trap'); }, getPrototypeOf() { traps++; throw new Error('exception prototype trap'); } });
  for (const thrown of [proxy, new UnsupportedConfigCapability('user-owned instance')]) {
    globalThis.getterThrown = thrown;
    const caught = await runNativeMutationTest({ args: ['getter-errors.mjs'], overrides: base }).then(() => ({ resolved: true }), error => ({ error }));
    assert.equal(caught.error, thrown);
    await success({ args: ['recovery.mjs'] });
  }
  assert.equal(traps, 0);
});

test('cached exports retain pinned nested merge/default/deprecation effects, order and identities', async (t) => {
  await fixture(t);
  const cases = [
    { name: 'valid', values: { thresholds: { high: 95 }, warnings: { slow: false } }, cli: { thresholds: { low: 25 }, commandRunner: ['numeric-key'] }, valid: true },
    { name: 'schema-error', values: { thresholds: { high: 95 }, warnings: {}, timeoutMS: 'bad' }, cli: { thresholds: { low: 25 } } },
    { name: 'custom-error', values: { thresholds: { high: 10 }, warnings: {} }, cli: {} },
    { name: 'deprecated', values: { mutator: { name: 'javascript' }, htmlReporter: { baseDir: 'old/../output' }, jest: { enableBail: true }, thresholds: { high: 95 } }, cli: {} },
    { name: 'detached', values: { thresholds: [95], warnings: { slow: false } }, cli: { thresholds: { high: 95 } }, valid: true },
    { name: 'partial-merge', values: { warnings: {}, thresholds: null }, cli: { warnings: { slow: false }, thresholds: { high: 95 } } },
    { name: 'array-object', values: { thresholds: { high: 95 } }, cli: { thresholds: [1, 2] } },
  ];
  const validator = new OptionsValidator(strykerCoreSchema, noopLogger);
  const exactReader = new ConfigReader(noopLogger, validator);
  for (const { name, values, cli, valid } of cases) {
    const initial = { ...base, ...values };
    for (const mode of ['oracle', 'native']) await writeFile(`${name}-${mode}.mjs`, `export default ${JSON.stringify(initial)};`);
    const oracleExport = (await import(pathToFileURL(resolve(`${name}-oracle.mjs`)))).default;
    const nativeExport = (await import(pathToFileURL(resolve(`${name}-native.mjs`)))).default;
    const originals = Object.fromEntries(Object.entries(nativeExport).filter(([, value]) => value && typeof value === 'object'));
    const beforeKeys = Object.keys(nativeExport);
    let oracle;
    try { oracle = await exactReader.readConfig({ configFile: `${name}-oracle.mjs`, ...structuredClone(cli) }); }
    catch (error) { assert.equal(valid, undefined, `${name}: ${error}`); }
    const native = await runNativeMutationTest({ args: [`${name}-native.mjs`], overrides: cli });
    assert.equal(native.supported, Boolean(valid), `${name}: ${native.reason}`);
    assert.equal(JSON.stringify(nativeExport), JSON.stringify(oracleExport), name);
    assert.deepEqual(Object.keys(nativeExport), beforeKeys, `${name}: root spread must not add defaults to export`);
    for (const [key, value] of Object.entries(originals)) {
      assert.equal(nativeExport[key], value, `${name}.${key}: export identity`);
      assert.equal(Object.isFrozen(value), false);
      assert.equal(Object.isExtensible(value), true);
    }
    if (valid) {
      delete oracle.configFile;
      const actual = { ...native.report.config }; delete actual.configFile;
      assert.equal(JSON.stringify(actual), JSON.stringify(oracle), `${name}: report config/order`);
      const repeated = await success({ args: [`${name}-native.mjs`], overrides: cli });
      const repeatedOracle = await exactReader.readConfig({ configFile: `${name}-oracle.mjs`, ...structuredClone(cli) });
      delete repeatedOracle.configFile;
      const repeatActual = { ...repeated.report.config }; delete repeatActual.configFile;
      assert.equal(JSON.stringify(repeatActual), JSON.stringify(repeatedOracle));
      assert.equal(JSON.stringify(nativeExport), JSON.stringify(oracleExport));
    }
  }
});

for (const [runner, key, invalidKey] of [['mocha', 'mochaOptions', 'grep'], ['vitest', 'vitest', 'related']]) {
  const module = `@stryker-mutator/${runner}-runner`;
test(`${runner} defaults and failed validation happen before project work and preserve cached writable originals`, async (t) => {
  await fixture(t);
  const { strykerValidationSchema } = await import(module);
  const schema = { ...strykerCoreSchema, properties: { ...strykerCoreSchema.properties, ...strykerValidationSchema.properties }, definitions: { ...strykerCoreSchema.definitions, ...strykerValidationSchema.definitions } };
  for (const invalid of [false, true]) {
    const options = { ...base, testRunner: runner, plugins: [module], thresholds: { high: 95 }, ...(invalid ? { [key]: { [invalidKey]: 42 } } : {}) };
    for (const mode of ['oracle', 'native']) await writeFile(`plugin-${invalid}-${mode}.mjs`, `export default ${JSON.stringify(options)};`);
    const oracleExport = (await import(pathToFileURL(resolve(`plugin-${invalid}-oracle.mjs`)))).default;
    const nativeExport = (await import(pathToFileURL(resolve(`plugin-${invalid}-native.mjs`)))).default;
    const thresholds = nativeExport.thresholds;
    const exactReader = new ConfigReader(noopLogger, new OptionsValidator(strykerCoreSchema, noopLogger));
    const oracle = await exactReader.readConfig({ configFile: `plugin-${invalid}-oracle.mjs`, thresholds: { low: 25 } });
    let failed = false;
    try { new OptionsValidator(schema, noopLogger).validate(oracle, true); } catch { failed = true; }
    assert.equal(failed, invalid);
    // A forbidden project symlink fails only after successful plugin validation.
    await symlink('missing-target', 'project-link');
    const result = await runNativeMutationTest({ args: [`plugin-${invalid}-native.mjs`], overrides: { thresholds: { low: 25 } } });
    await rm('project-link');
    if (invalid) { assert.equal(result.supported, false); assert.match(result.reason, /Invalid plugin options/); }
    else { assert.equal(result.supported, false); assert.match(result.reason, /symlink|symbolic link/i); }
    assert.equal(nativeExport.thresholds, thresholds);
    assert.equal(JSON.stringify(nativeExport), JSON.stringify(oracleExport));
    assert.equal(Object.isFrozen(thresholds), false);
    assert.equal(Object.isExtensible(thresholds), true);
    thresholds.proof = 1; delete thresholds.proof;
    assert.equal(key in nativeExport, invalid, 'root plugin default must not mutate original export');
    // The cached export stays admissible on repetition after native preparation.
    if (invalid) assert.match((await runNativeMutationTest({ args: [`plugin-${invalid}-native.mjs`] })).reason, /Invalid plugin options/);
  }
});
}

for (const [runner, key, invalidKey] of [['mocha', 'mochaOptions', 'grep'], ['vitest', 'vitest', 'related']]) {
  const module = `@stryker-mutator/${runner}-runner`;
test(`selected actual ${runner} evaluation observes core effects; plugin failure retains subsequent defaults`, async (t) => {
  const cwd = await fixture(t);
  const options = { ...base, testRunner: runner, plugins: [module], thresholds: { high: 95 }, [key]: { [invalidKey]: 42 } };
  await writeFile('observed.mjs', `const options = ${JSON.stringify(options)}; globalThis.cachedExport = options; export default options;`);
  await writeFile('observe.mjs', `
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const native = process.argv[2] === 'native';
registerHooks({resolve(specifier, context, next) {
  if (native && (specifier === '@stryker-mutator/core' || specifier.startsWith('@stryker-mutator/core/'))) throw new Error('Forbidden upstream coordinator import');
  return next(specifier, context);
}, load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/@stryker-mutator/${runner}-runner/dist/src/index.js')) return {...loaded, source:
    'globalThis.beforePlugin = JSON.stringify(globalThis.cachedExport.thresholds); delete globalThis.cachedExport.thresholds.low;'  + loaded.source};
  return loaded;
}});
let failure;
if (native) {
  const {runNativeMutationTest} = await import(${JSON.stringify(new URL('../lib/runtime.js', import.meta.url).href)});
  const result = await runNativeMutationTest({args:['observed.mjs'],overrides:{thresholds:{low:25}}});
  if (result.supported || !result.reason.includes('Invalid plugin options')) throw new Error(JSON.stringify(result));
  failure = true;
} else {
  const {ConfigReader} = await import(${JSON.stringify(pathToFileURL(join(coreRoot, 'dist/src/config/config-reader.js')).href)});
  const {OptionsValidator} = await import(${JSON.stringify(pathToFileURL(join(coreRoot, 'dist/src/config/options-validator.js')).href)});
  const {strykerCoreSchema} = await import('@stryker-mutator/api/core');
  const {noopLogger, deepFreeze} = await import('@stryker-mutator/util');
  const options = await new ConfigReader(noopLogger,new OptionsValidator(strykerCoreSchema,noopLogger)).readConfig({configFile:'observed.mjs',thresholds:{low:25}});
  const {strykerValidationSchema: plugin} = await import('${module}');
  const schema = {...strykerCoreSchema,properties:{...strykerCoreSchema.properties,...plugin.properties},definitions:{...strykerCoreSchema.definitions,...plugin.definitions}};
  try {new OptionsValidator(schema,noopLogger).validate(options,true);deepFreeze(options);} catch {failure=true;}
}
const exported = (await import(pathToFileURL(resolve('observed.mjs')))).default;
console.log(JSON.stringify({failure,beforePlugin:globalThis.beforePlugin,thresholds:exported.thresholds,keys:Object.keys(exported.thresholds),frozen:Object.isFrozen(exported.thresholds),extensible:Object.isExtensible(exported.thresholds)}));
`);
  await mkdir(join(artifacts, 'caller-effects'), { recursive: true });
  const receipts = [];
  for (const mode of ['oracle', 'native']) {
    const child = spawn(process.execPath, ['observe.mjs', mode], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const [code, signal] = await once(child, 'close');
    await writeFile(join(artifacts, 'caller-effects', `plugin-order-${runner}-${mode}.log`), output);
    assert.equal(code, 0, output); assert.equal(signal, null);
    receipts.push(JSON.parse(output.trim()));
  }
  assert.deepEqual(receipts[1], receipts[0]);
  assert.equal(receipts[1].beforePlugin, '{"high":95,"low":25,"break":null}');
  assert.deepEqual(receipts[1].keys, ['high', 'break', 'low']);
});
}


test('null-prototype records retain identity and deprecated coercion failures preserve preceding effects', async (t) => {
  await fixture(t);
  for (const fail of [false, true]) {
    const code = `const options=${JSON.stringify(base)}; options.thresholds=Object.assign(Object.create(null),{high:95}); ${fail ? "options.mutator={name:'javascript'}; options.htmlReporter={baseDir:Object.create(null)};" : ''} export default options;`;
    for (const mode of ['oracle', 'native']) await writeFile(`null-proto-${fail}-${mode}.mjs`, code);
    const oracleExport = (await import(pathToFileURL(resolve(`null-proto-${fail}-oracle.mjs`)))).default;
    const nativeExport = (await import(pathToFileURL(resolve(`null-proto-${fail}-native.mjs`)))).default;
    const thresholds = nativeExport.thresholds;
    let failed = false;
    try { await new ConfigReader(noopLogger, new OptionsValidator(strykerCoreSchema, noopLogger)).readConfig({ configFile: `null-proto-${fail}-oracle.mjs`, thresholds: { low: 25 } }); } catch { failed = true; }
    assert.equal(failed, fail);
    const result = await runNativeMutationTest({ args: [`null-proto-${fail}-native.mjs`], overrides: { thresholds: { low: 25 } } });
    assert.equal(result.supported, !fail, result.reason);
    assert.equal(nativeExport.thresholds, thresholds);
    assert.equal(Object.getPrototypeOf(thresholds), null);
    assert.equal(JSON.stringify(nativeExport), JSON.stringify(oracleExport));
    if (fail) { assert.match(result.reason, /Cannot convert object/); assert.deepEqual(nativeExport.mutator, {}); assert.equal('break' in thresholds, false); }
  }
});


test('Windows legacy HTML path fixture is an exact Node path.win32.join oracle on every host', async () => {
  const cases = JSON.parse(await readFile(new URL('./fixtures/windows-html-paths.json', import.meta.url), 'utf8'));
  for (const { base, joined } of cases) assert.equal(win32.join(base, 'index.html'), joined, base);
});

test('Windows bare-drive HTML deprecation preserves exact cached effects and report config order', { skip: process.platform !== 'win32' }, async (t) => {
  await fixture(t);
  const cases = JSON.parse(await readFile(new URL('./fixtures/windows-html-paths.json', import.meta.url), 'utf8'));
  for (const [index, { base: baseDir, joined }] of cases.entries()) {
    if (!baseDir) continue; // Falsy legacy baseDir is deliberately not rewritten upstream.
    const options = { ...base, htmlReporter: { baseDir }, thresholds: { high: 95 } };
    for (const mode of ['oracle', 'native']) await writeFile(`drive-${index}-${mode}.mjs`, `export default ${JSON.stringify(options)};`);
    const oracleExport = (await import(pathToFileURL(resolve(`drive-${index}-oracle.mjs`)))).default;
    const nativeExport = (await import(pathToFileURL(resolve(`drive-${index}-native.mjs`)))).default;
    const original = nativeExport.htmlReporter;
    const oracle = await new ConfigReader(noopLogger, new OptionsValidator(strykerCoreSchema, noopLogger)).readConfig({ configFile: `drive-${index}-oracle.mjs` });
    const result = await success({ args: [`drive-${index}-native.mjs`] });
    assert.equal(nativeExport.htmlReporter, original);
    assert.equal(nativeExport.htmlReporter.fileName, joined);
    assert.equal(JSON.stringify(nativeExport), JSON.stringify(oracleExport));
    assert.deepEqual(Object.keys(original), ['fileName']);
    const actual = { ...result.report.config }; delete actual.configFile; delete oracle.configFile;
    assert.equal(JSON.stringify(actual), JSON.stringify(oracle));
    assert.equal(Object.isFrozen(original), false);
  }
  for (const [index, baseDir] of ['C:logs', String.raw`\\server\share`, String.raw`\\?\C:\logs`, 'logs:stream'].entries()) {
    await writeFile(`unsupported-drive-${index}.mjs`, `export default {...${JSON.stringify(base)},mutator:{name:'javascript'},htmlReporter:{baseDir:${JSON.stringify(baseDir)}}};`);
    const exported = (await import(pathToFileURL(resolve(`unsupported-drive-${index}.mjs`)))).default;
    const result = await runNativeMutationTest({ args: [`unsupported-drive-${index}.mjs`] });
    assert.equal(result.supported, false);
    assert.match(result.reason, /Windows htmlReporter.baseDir/);
    assert.deepEqual(exported.mutator, {});
    assert.deepEqual(exported.htmlReporter, { baseDir }, 'no incorrect path set/delete on rejection');
  }
});

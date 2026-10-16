import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestStatus } from '@stryker-mutator/api/test-runner';
import { createInjector } from 'typed-inject';
import { deduplicateInjectorDisposables, disposeInjector } from '../lib/compat/injector-disposal.js';
import { errorDetails } from '../lib/compat/errors.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('../lib/compat/worker.js', import.meta.url));
const fixtures = new URL('./fixtures/compatibility-bridge/', import.meta.url);
const plugin = new URL('plugin.js', fixtures).href;
const artifacts = path.join(root, 'artifacts/native-compatibility-bridge');

async function launch(t, { nodeArgs = [], env = {} } = {}) {
  await mkdir(artifacts, { recursive: true });
  const cwd = await mkdtemp(path.join(artifacts, 'fixture-'));
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const token = randomUUID();
  const connected = once(server, 'connection');
  const child = spawn(process.execPath, [...nodeArgs, worker], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      STRYKER_RUST_BRIDGE_ADDRESS: `127.0.0.1:${server.address().port}`,
      STRYKER_RUST_BRIDGE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  let socket;
  t.after(async () => {
    socket?.destroy();
    server.close();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    await rm(cwd, { recursive: true, force: true });
  });
  [socket] = await Promise.race([
    connected,
    exited.then(([code, signal]) => { throw new Error(`Worker exited before connecting (${code}, ${signal}): ${stderr}`); }),
  ]);
  server.close();
  socket.setEncoding('utf8');
  const events = new EventEmitter();
  const frames = [];
  let input = '';
  let closed = false;
  socket.on('data', (chunk) => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const frame = JSON.parse(line);
      frames.push(frame);
      events.emit('frame', frame);
    }
  });
  socket.on('close', () => { closed = true; events.emit('closed'); });
  socket.on('error', () => {});
  function waitFor(predicate, description = 'response') {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}; stderr: ${stderr}`)), 10000);
      function finish(error, frame) {
        clearTimeout(timer);
        events.off('frame', onFrame);
        events.off('closed', onClose);
        if (error) reject(error); else resolve(frame);
      }
      function onFrame(frame) { if (predicate(frame)) finish(undefined, frame); }
      function onClose() { finish(new Error(`Connection closed waiting for ${description}; stderr: ${stderr}`)); }
      events.on('frame', onFrame);
      events.on('closed', onClose);
      if (closed) onClose();
    });
  }
  const hello = await waitFor((frame) => frame.event === 'hello', 'hello');
  assert.deepEqual(hello, { version: 1, event: 'hello', params: { token, pid: child.pid } });
  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    const received = waitFor((frame) => frame.id === id, `${method}:${id}`);
    socket.write(`${JSON.stringify({ version: 1, id, method, params })}\n`);
    return received;
  }
  async function call(method, params) {
    const response = await request(method, params);
    assert.equal(response.error, undefined, response.error?.stack ?? response.error?.message);
    assert.equal(Object.hasOwn(response, 'result'), true);
    return response.result;
  }
  return {
    cwd, child, socket, frames, waitFor, request, call, exited, token,
    output: () => ({ stdout, stderr }),
    initialize: (name = 'class', overrides = {}) => call('initialize', {
      cwd, options: { nested: { frozen: true }, logLevel: 'debug' },
      fileDescriptions: { 'test.js': { isTestFile: true } }, modules: [plugin],
      plugin: { kind: 'TestRunner', name }, ...overrides,
    }),
  };
}

async function lines(file) {
  return (await readFile(file, 'utf8')).trim().split('\n');
}

test('SDK class DI, schemas, logs, and arbitrary user output use separate channels', async (t) => {
  const bridge = await launch(t);
  const initialized = await bridge.initialize('CLASS');
  assert.deepEqual(initialized.plugin, { kind: 'TestRunner', name: 'class' });
  assert.deepEqual(initialized.schemaContributions, [{ properties: { bridgeFixture: { type: 'boolean' } } }]);
  assert.equal(initialized.loadedModules[0].moduleName, plugin);
  assert.equal(initialized.loadedModules[0].plugins.some(({ name }) => name === 'class'), true);
  assert.deepEqual(await bridge.call('runner.capabilities'), {
    reloadEnvironment: true, optionsFrozen: true, filesFrozen: true, hasInjector: true,
    target: null, controlEnvAbsent: true,
  });
  assert.deepEqual(await bridge.call('runner.init'), null);
  const runOptions = { coverageAnalysis: 'perTest', disableBail: false, timeout: 123, files: ['a.js'], label: 'original' };
  const result = await bridge.call('runner.dryRun', runOptions);
  assert.deepEqual(result.params, runOptions);
  assert.deepEqual(result.files, { 'test.js': { isTestFile: true } });
  assert.deepEqual(result.options.nested, { frozen: true });
  const mutantOptions = { activeMutant: { id: 'm1' }, sandboxFileName: '/sandbox/a.js', mutantActivation: 'runtime', reloadEnvironment: false, timeout: 456, disableBail: true, hitLimit: 10, testFilter: ['one'] };
  assert.deepEqual((await bridge.call('runner.mutantRun', mutantOptions)).params, mutantOptions);
  await bridge.waitFor((frame) => frame.event === 'log' && frame.params.category === 'CustomCategory');
  assert.equal(bridge.frames.some(({ params, event }) => event === 'log' && params.category === 'ExampleRunner' && params.message === 'constructed %s'), true);
  assert.match(bridge.output().stdout, /plugin stdout: not JSON/);
  assert.match(bridge.output().stdout, /\{direct stdout without a newline\}/);
  assert.match(bridge.output().stderr, /plugin stderr/);
  assert.equal(JSON.stringify(bridge.frames.filter(({ event }) => event !== 'hello')).includes(bridge.token), false);
  await bridge.call('dispose');
});

test('prepare returns SDK/plugin schemas before construction and preserves validated module selection', async (t) => {
  const bridge = await launch(t);
  const metadata = await bridge.call('prepare', { cwd: bridge.cwd, modules: [plugin] });
  assert.equal(metadata.sdkVersion, '10.0.0');
  assert.equal(metadata.coreSchema.title, 'StrykerOptions');
  assert.deepEqual(metadata.schemaContributions, [{ properties: { bridgeFixture: { type: 'boolean' } } }]);
  assert.equal(bridge.output().stdout, '', 'metadata preparation must not construct a plugin');
  assert.equal(bridge.frames.some(({ event }) => event === 'log'), false);
  assert.equal((await bridge.request('runner.capabilities')).error.name, 'StateError');
  assert.equal((await bridge.request('prepare', { cwd: bridge.cwd, modules: [plugin] })).error.name, 'StateError');
  assert.equal((await bridge.request('initialize', {
    cwd: bridge.cwd, modules: [], options: {}, fileDescriptions: {}, plugin: { kind: 'TestRunner', name: 'class' },
  })).error.name, 'StateError');
  await bridge.initialize('class', { modules: metadata.loadedModules.map(({ moduleName }) => moduleName) });
  assert.match(bridge.output().stdout, /plugin stdout/);
});

test('metadata-only prepared workers dispose without constructing plugins', async (t) => {
  const bridge = await launch(t);
  await bridge.call('prepare', { cwd: bridge.cwd, modules: [plugin] });
  await bridge.call('dispose');
  assert.equal(bridge.output().stdout, '');
});

test('runner result postprocessing matches SDK worker Error and legacy coverage behavior', async (t) => {
  const bridge = await launch(t);
  await bridge.initialize('result-compatibility');
  const dryError = await bridge.call('runner.dryRun', { returnError: true });
  assert.equal(dryError.status, 'error');
  assert.match(dryError.errorMessage, /^TypeError: dry run result error\nTypeError: dry run result error/);
  const mutantError = await bridge.call('runner.mutantRun', {});
  assert.match(mutantError.errorMessage, /^Error: mutant result error\nError: mutant result error/);
  assert.deepEqual((await bridge.call('runner.dryRun', { coverageAnalysis: 'perTest' })).mutantCoverage, { static: { one: 1 }, perTest: {} });
  assert.equal(Object.hasOwn(await bridge.call('runner.dryRun', { coverageAnalysis: 'off' }), 'mutantCoverage'), false);
  assert.deepEqual((await bridge.call('runner.dryRun', { coverageAnalysis: 'perTest', ownCoverage: true })).mutantCoverage, { static: { own: 2 } });
});

test('fragmented UTF-8 frames and pipelined requests retain order without overlapping plugin calls', async (t) => {
  const bridge = await launch(t);
  const frame = Buffer.from(`${JSON.stringify({ version: 1, id: 99, method: 'initialize', params: {
    cwd: bridge.cwd, options: { nested: {}, logLevel: 'off' }, fileDescriptions: {}, modules: [plugin], plugin: { kind: 'TestRunner', name: 'class' },
  } })}\n`);
  const initialized = bridge.waitFor(({ id }) => id === 99);
  bridge.socket.write(frame.subarray(0, 17));
  bridge.socket.write(frame.subarray(17));
  assert.equal((await initialized).error, undefined);
  await bridge.call('runner.init');
  const first = bridge.request('runner.dryRun', { label: 'first☃', delay: 40 });
  const second = bridge.request('runner.dryRun', { label: 'second' });
  assert.deepEqual((await first).result.trace, ['start:first☃', 'end:first☃']);
  assert.deepEqual((await second).result.trace, ['start:first☃', 'end:first☃', 'start:second', 'end:second']);
  const responses = bridge.frames.filter(({ id }) => id === 2 || id === 3);
  assert.deepEqual(responses.map(({ id }) => id), [2, 3]);
  const unicodeFrame = Buffer.from(`${JSON.stringify({ version: 1, id: 100, method: 'runner.dryRun', params: { label: 'split☃' } })}\n`);
  const unicodeOffset = unicodeFrame.indexOf(Buffer.from('☃'));
  const unicodeResponse = bridge.waitFor(({ id }) => id === 100);
  bridge.socket.write(unicodeFrame.subarray(0, unicodeOffset + 1));
  bridge.socket.write(unicodeFrame.subarray(unicodeOffset + 1));
  assert.equal((await unicodeResponse).result.params.label, 'split☃');
});

test('unknown methods, lifecycle errors, malformed frames, missing plugins and methods fail explicitly', async (t) => {
  const bridge = await launch(t);
  assert.equal((await bridge.request('runner.dryRun')).error.name, 'StateError');
  assert.equal((await bridge.request('config.evaluate')).error.name, 'UnsupportedMethodError');
  const malformed = bridge.waitFor(({ id, error }) => id === null && error?.name === 'ProtocolError');
  bridge.socket.write('not JSON\n');
  assert.equal((await malformed).error.name, 'ProtocolError');
  const invalidId = bridge.waitFor(({ id, error }) => id === null && error?.message.includes('positive safe integer'));
  bridge.socket.write('{"version":1,"id":9007199254740992,"method":"initialize","params":{}}\n');
  await invalidId;
  await bridge.initialize('missing');
  assert.equal((await bridge.request('runner.dryRun', {})).error.name, 'UnsupportedMethodError');
  assert.equal((await bridge.request('checker.check', [])).error.name, 'UnsupportedMethodError');
  assert.equal((await bridge.request('initialize', {})).error.name, 'StateError');
  await bridge.call('dispose');
  assert.equal((await bridge.request('runner.capabilities')).error.name, 'StateError');
  await bridge.call('dispose');
});

test('plugin lookup and falsey value declarations report meaningful errors', async (t) => {
  for (const name of ['nonexistent', 'false', 'zero', 'null', 'undefined']) {
    await t.test(name, async (t) => {
      const bridge = await launch(t);
      const response = await bridge.request('initialize', {
        cwd: bridge.cwd, options: {}, fileDescriptions: {}, modules: [plugin], plugin: { kind: 'TestRunner', name },
      });
      assert.equal(response.error.name, name === 'nonexistent' ? 'PluginNotFoundError' : 'InvalidPluginError');
      if (name !== 'nonexistent') assert.match(response.error.message, /must produce an object/);
      assert.equal((await bridge.request('runner.capabilities')).error.name, 'StateError');
      await bridge.call('dispose');
    });
  }
});

test('factory and value plugins dispose exactly once, including injected factory dependencies', async (t) => {
  for (const name of ['factory', 'value']) {
    await t.test(name, async (t) => {
      const bridge = await launch(t);
      const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
      await bridge.initialize(name, { options: { nested: {}, cleanupFile } });
      await bridge.call('runner.init');
      await bridge.call('runner.dryRun', { cleanupFile, label: 'run' });
      await Promise.all([bridge.call('dispose'), bridge.call('dispose')]);
      const events = await lines(cleanupFile);
      if (name === 'factory') {
        assert.equal(events.filter((event) => event === 'plugin disposed').length, 1);
        assert.equal(events.filter((event) => event === 'dependency disposed').length, 1);
      } else assert.deepEqual(events, ['value disposed']);
    });
  }
});

test('callable factory/value instances and callable declarations preserve SDK structural plugin contracts', async (t) => {
  for (const name of ['callable-factory', 'callable-value', 'CallableDeclaration', 'inherited-factory', 'inactive-factory']) {
    await t.test(name, async (t) => {
      const bridge = await launch(t);
      const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
      await bridge.initialize(name);
      assert.deepEqual(await bridge.call('runner.capabilities'), { callable: true });
      await bridge.call('runner.dryRun', { cleanupFile });
      await Promise.all([bridge.call('dispose'), bridge.call('dispose')]);
      assert.deepEqual(await lines(cleanupFile), ['callable disposed']);
    });
  }
});

test('failed construction and failed runner init clean up registered instances', async (t) => {
  for (const phase of ['construction', 'init']) {
    await t.test(phase, async (t) => {
      const bridge = await launch(t);
      const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
      const params = {
        cwd: bridge.cwd, options: { nested: {}, cleanupFile, failConstruction: phase === 'construction', failInit: phase === 'init' },
        fileDescriptions: {}, modules: [plugin], plugin: { kind: 'TestRunner', name: 'factory' },
      };
      const initialized = await bridge.request('initialize', params);
      if (phase === 'construction') assert.match(initialized.error.message, /construction failed deliberately/);
      else {
        assert.equal(initialized.error, undefined);
        assert.match((await bridge.request('runner.init')).error.message, /init failed deliberately/);
      }
      await bridge.call('dispose');
      const events = await lines(cleanupFile);
      assert.equal(events.filter((event) => event === 'dependency disposed').length, 1);
      assert.equal(events.filter((event) => event === 'plugin disposed').length, phase === 'init' ? 1 : 0);
    });
  }
});

test('thrown Error, primitive errors, and unserializable results retain explicit correlated failures', async (t) => {
  const bridge = await launch(t);
  await bridge.initialize();
  await bridge.call('runner.init');
  const thrown = await bridge.request('runner.dryRun', { error: 'error' });
  assert.equal(thrown.error.name, 'TypeError');
  assert.equal(thrown.error.message, 'plugin failure');
  assert.match(thrown.error.stack, /plugin\.js/);
  assert.equal(Object.hasOwn(thrown, 'result'), false);
  assert.deepEqual((await bridge.request('runner.dryRun', { error: 'primitive' })).error, { name: 'Error', message: 'primitive plugin failure' });
  assert.equal((await bridge.request('runner.dryRun', { error: 'serialization' })).error.name, 'TypeError');
  assert.equal((await bridge.request('runner.dryRun', { error: 'function' })).error.name, 'TypeError');
  assert.equal((await bridge.request('runner.dryRun', { error: 'symbol' })).error.name, 'TypeError');
  assert.equal((await bridge.call('runner.dryRun', { label: 'recovered' })).status, 'complete');
});

test('a failed dispose is reported consistently and never repeated', async (t) => {
  const bridge = await launch(t);
  const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
  await bridge.initialize('bad-dispose');
  await bridge.call('runner.dryRun', { cleanupFile });
  const first = bridge.request('dispose');
  const second = bridge.request('dispose');
  assert.equal((await first).error.message, 'dispose failed deliberately');
  assert.equal((await second).error.message, 'dispose failed deliberately');
  assert.deepEqual(await lines(cleanupFile), ['bad dispose']);
});

test('frozen plugins aliased through multiple providers preserve identity and dispose once', async (t) => {
  const bridge = await launch(t);
  const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
  await bridge.initialize('aliased', { options: { cleanupFile } });
  assert.deepEqual(await bridge.call('runner.capabilities'), { frozen: true, aliasesSame: true });
  await bridge.call('runner.dryRun', {});
  await Promise.all([bridge.call('dispose'), bridge.call('dispose')]);
  assert.deepEqual(await lines(cleanupFile), ['aliased runner disposed']);
});

test('a failing dependency retains its error while independent dependencies and aliased plugin are attempted once', async (t) => {
  const bridge = await launch(t);
  const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
  await bridge.initialize('aliased', { options: { cleanupFile, failDependencyDisposal: true } });
  assert.deepEqual(await bridge.call('runner.capabilities'), { frozen: true, aliasesSame: true });
  const first = await bridge.request('dispose');
  assert.equal(first.error.name, 'Error');
  assert.equal(first.error.message, 'dependency disposal failed deliberately');
  assert.match(first.error.stack, /plugin\.js/);
  const second = await bridge.request('dispose');
  assert.deepEqual(second.error, first.error);
  assert.deepEqual((await lines(cleanupFile)).sort(), [
    'aliased runner disposed', 'failing dependency disposed', 'healthy dependency disposed',
  ]);
});

test('pinned injector layout validation fails before mutating ownership or invoking accessors', async () => {
  const injector = createInjector();
  const disposable = Object.freeze({ dispose() {} });
  const first = injector.provideFactory('first', () => disposable);
  const second = first.provideFactory('second', () => disposable);
  second.resolve('first');
  second.resolve('second');
  let accessorCalls = 0;
  Object.defineProperty(second, 'childInjectors', { configurable: true, enumerable: true, get() { accessorCalls++; return new Set(); } });
  assert.throws(() => deduplicateInjectorDisposables(injector), { name: 'InjectorCompatibilityError' });
  assert.equal(accessorCalls, 0);
  assert.equal(first.disposables.has(disposable), true);
  assert.equal(second.disposables.has(disposable), true);
  Object.defineProperty(second, 'childInjectors', { configurable: true, enumerable: true, writable: true, value: new Set() });
  deduplicateInjectorDisposables(injector);
  assert.equal(first.disposables.has(disposable), false);
  assert.equal(second.disposables.has(disposable), true);
  await injector.dispose();
});

test('cleanup attempts ancestor disposables after child failure and preserves the original single error identity', async () => {
  const injector = createInjector();
  const events = [];
  const original = new Error('original child failure');
  const ancestor = injector.provideFactory('ancestor', () => Object.freeze({ dispose() { events.push('ancestor'); } }));
  const child = ancestor.provideFactory('child', () => Object.freeze({ dispose() { events.push('child'); throw original; } }));
  child.resolve('ancestor');
  child.resolve('child');
  await assert.rejects(disposeInjector(injector), (error) => error === original);
  assert.deepEqual(events, ['child', 'ancestor']);
  assert.equal(Object.hasOwn(ancestor, 'disposeInjectedValues'), false);
  assert.equal(Object.hasOwn(child, 'disposeInjectedValues'), false);
});

test('cleanup keeps independent branches parallel and restores successful dispatch overrides', { timeout: 5000 }, async () => {
  const injector = createInjector();
  const firstStarted = Promise.withResolvers();
  const secondStarted = Promise.withResolvers();
  const first = injector.provideFactory('first', () => ({ async dispose() { firstStarted.resolve(); await secondStarted.promise; } }));
  const second = injector.provideFactory('second', () => ({ async dispose() { secondStarted.resolve(); await firstStarted.promise; } }));
  first.resolve('first');
  second.resolve('second');
  await disposeInjector(injector);
  assert.equal(Object.hasOwn(first, 'disposeInjectedValues'), false);
  assert.equal(Object.hasOwn(second, 'disposeInjectedValues'), false);
});

test('cleanup dispatch validation rejects accessors before changing any disposable ownership', async () => {
  const injector = createInjector();
  const value = Object.freeze({ dispose() {} });
  const first = injector.provideFactory('first', () => value);
  const second = first.provideFactory('second', () => value);
  second.resolve('first'); second.resolve('second');
  let calls = 0;
  Object.defineProperty(second, 'disposeInjectedValues', { configurable: true, get() { calls++; return () => {}; } });
  await assert.rejects(disposeInjector(injector), { name: 'InjectorCompatibilityError' });
  assert.equal(calls, 0);
  assert.equal(first.disposables.has(value), true);
  assert.equal(second.disposables.has(value), true);
  assert.equal(Object.hasOwn(first, 'disposeInjectedValues'), false);
  delete second.disposeInjectedValues;
  await disposeInjector(injector);
});

test('sync and async dependency failures both cross the wire after frozen ancestor cleanup runs exactly once', async (t) => {
  const bridge = await launch(t);
  const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
  await bridge.initialize('cleanup-errors', { options: { cleanupFile } });
  assert.deepEqual(await bridge.call('runner.capabilities'), { frozen: true });
  const response = await bridge.request('dispose');
  assert.equal(response.error.name, 'AggregateError');
  assert.deepEqual(response.error.errors.map(({ name, message }) => ({ name, message })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'RangeError', message: 'async cleanup failure' }, { name: 'TypeError', message: 'sync cleanup failure' },
  ]);
  assert.equal(response.error.errors.every(({ stack }) => stack.includes('plugin.js')), true);
  const events = await lines(cleanupFile);
  assert.equal(events.filter((event) => event === 'ancestor plugin disposed').length, 1);
  assert.ok(events.indexOf('ancestor plugin disposed') > events.indexOf('sync dependency disposed'));
  assert.ok(events.indexOf('ancestor plugin disposed') > events.indexOf('async dependency disposed'));
  assert.deepEqual((await bridge.request('dispose')).error, response.error);
});

test('aggregate error serialization retains ordinary nested details and bounds cycles/depth/count explicitly', () => {
  const original = new TypeError('original');
  const error = new AggregateError([original, new AggregateError([original], 'nested')], 'outer');
  const details = errorDetails(error);
  assert.equal(details.errors[0].stack, original.stack);
  assert.equal(details.errors[1].errors[0].stack, original.stack);
  error.errors.push(error);
  assert.equal(errorDetails(error).errors.at(-1).name, 'TruncatedError');
  const wide = errorDetails(new AggregateError(Array.from({ length: 300 }, () => original), 'wide'));
  assert.equal(wide.errors.at(-1).name, 'TruncatedError');
  let deep = original;
  for (let i = 0; i < 20; i++) deep = new AggregateError([deep], 'deep');
  assert.match(JSON.stringify(errorDetails(deep)), /nesting limit/);
});

test('connection loss serializes cleanup after the active operation and drops queued calls', async (t) => {
  const bridge = await launch(t);
  const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
  await bridge.initialize('factory', { options: { nested: {}, cleanupFile } });
  await bridge.call('runner.init');
  bridge.socket.write(`${JSON.stringify({ version: 1, id: 500, method: 'runner.dryRun', params: { label: 'active', delay: 100 } })}\n`);
  // A log emitted when the operation starts provides an observable synchronization
  // point without inventing an execution-time expectation.
  while (!(await lines(cleanupFile)).includes('start:active')) await delay(5);
  bridge.socket.write(`${JSON.stringify({ version: 1, id: 501, method: 'runner.dryRun', params: { label: 'queued' } })}\n`);
  bridge.socket.destroy();
  const [exitCode] = await bridge.exited;
  assert.equal(exitCode, 0);
  const events = await lines(cleanupFile);
  assert.equal(events.includes('start:queued'), false);
  assert.equal(events.filter((event) => event === 'plugin disposed').length, 1);
  assert.equal(events.filter((event) => event === 'dependency disposed').length, 1);
  assert.ok(events.indexOf('plugin disposed') > events.indexOf('end:active'));
});

test('duplicate outstanding IDs and oversized frames close the protocol without extra plugin work', async (t) => {
  await t.test('duplicate', async (t) => {
    const bridge = await launch(t);
    const cleanupFile = path.join(bridge.cwd, 'cleanup.txt');
    await bridge.initialize('class', { options: { nested: {}, cleanupFile } });
    await bridge.call('runner.init');
    const rejected = bridge.waitFor(({ id, error }) => id === 200 && error?.name === 'DuplicateRequestError');
    bridge.socket.write([
      { version: 1, id: 200, method: 'runner.dryRun', params: { label: 'one', delay: 20 } },
      { version: 1, id: 200, method: 'runner.dryRun', params: { label: 'two' } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n');
    await rejected;
    await bridge.exited;
    const events = await lines(cleanupFile);
    assert.equal(events.some((event) => event.startsWith('start:')), false);
    assert.equal(events.filter((event) => event === 'plugin disposed').length, 1);
  });
  await t.test('oversized', async (t) => {
    const bridge = await launch(t);
    const rejected = bridge.waitFor(({ error }) => error?.name === 'FrameTooLargeError');
    bridge.socket.write(Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    assert.equal((await rejected).id, null);
    await bridge.exited;
  });
});

test('checker methods retain SDK array payloads and optional singleton grouping', async (t) => {
  for (const name of ['checker', 'singular']) {
    await t.test(name, async (t) => {
      const bridge = await launch(t);
      await bridge.initialize(name, { plugin: { kind: 'Checker', name } });
      assert.equal((await bridge.request('checker.check', [])).error.name, 'StateError');
      await bridge.call('checker.init');
      const mutants = [{ id: 'one' }, { id: 'two' }];
      assert.deepEqual(await bridge.call('checker.group', mutants), name === 'checker' ? [['one', 'two']] : [['one'], ['two']]);
      assert.deepEqual(await bridge.call('checker.check', mutants), name === 'checker' ? { one: { status: 'Passed' }, two: { status: 'Passed' } } : {});
      await bridge.call('dispose');
    });
  }
});

test('consumer-relative ESM resolution preserves import/custom conditions and installed loader hooks', async (t) => {
  const bridge = await launch(t, { nodeArgs: ['--conditions=bridge-test', '--loader', new URL('loader.mjs', fixtures).href] });
  const packageDirectory = path.join(bridge.cwd, 'node_modules/bridge-condition-plugin');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: {
    'bridge-test': './condition.js', import: './import.js', require: './require.cjs', default: './default.js',
  } }));
  for (const name of ['import', 'default']) await writeFile(path.join(packageDirectory, `${name}.js`), 'throw new Error("Wrong export condition");\n');
  await writeFile(path.join(packageDirectory, 'require.cjs'), 'throw new Error("require condition must never be selected");\n');
  await writeFile(path.join(packageDirectory, 'condition.js'), `
    import { fromCustomLoader } from 'bridge-loader-dependency';
    export const strykerPlugins = [{ kind: 'TestRunner', name: 'conditional', value: {
      capabilities() { return { fromCustomLoader, condition: 'bridge-test' }; },
      async dryRun() { return { status: 'complete', tests: [] }; },
      async mutantRun() { return { status: 'survived', nrOfTests: 0 }; }
    } }];
  `);
  const initialized = await bridge.initialize('conditional', { modules: ['bridge-condition-plugin'] });
  assert.equal(initialized.loadedModules[0].moduleName, pathToFileURL(path.join(packageDirectory, 'condition.js')).href);
  assert.deepEqual(await bridge.call('runner.capabilities'), { fromCustomLoader: true, condition: 'bridge-test' });
});

test('bare package imports use the import condition rather than require resolution', async (t) => {
  const bridge = await launch(t);
  const packageDirectory = path.join(bridge.cwd, 'node_modules/bridge-import-plugin');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: {
    import: './import.js', require: './require.cjs',
  } }));
  await writeFile(path.join(packageDirectory, 'require.cjs'), 'throw new Error("Wrong require export condition");\n');
  await writeFile(path.join(packageDirectory, 'import.js'), `
    export const strykerPlugins = [{ kind: 'TestRunner', name: 'import', value: {
      capabilities() { return { condition: 'import' }; },
      async dryRun() { return { status: 'complete', tests: [] }; },
      async mutantRun() { return { status: 'survived', nrOfTests: 0 }; }
    } }];
  `);
  await bridge.initialize('import', { modules: ['bridge-import-plugin'] });
  assert.deepEqual(await bridge.call('runner.capabilities'), { condition: 'import' });
});

test('installed Mocha runner preserves async tests, hooks and real mutant outcomes without upstream coordination imports', async (t) => {
  await mkdir(artifacts, { recursive: true });
  const traceFile = path.join(artifacts, 'mocha-module-trace.txt');
  const hooksFile = path.join(artifacts, 'mocha-hook-events.txt');
  await Promise.all([writeFile(traceFile, ''), writeFile(hooksFile, '')]);
  const bridge = await launch(t, {
    nodeArgs: ['--import', new URL('inspector.js', fixtures).href],
    env: { BRIDGE_TEST_MODULE_TRACE: traceFile, BRIDGE_TEST_HOOKS: hooksFile },
  });
  const mochaModule = import.meta.resolve('@stryker-mutator/mocha-runner');
  const metadata = await bridge.call('prepare', { cwd: bridge.cwd, modules: [mochaModule] });
  assert.equal(metadata.loadedModules[0].moduleName, mochaModule);
  assert.equal(metadata.schemaContributions[0].properties.mochaOptions.default !== undefined, true);
  await bridge.initialize('mocha', {
    modules: [mochaModule], options: { logLevel: 'debug', mochaOptions: {
      spec: [fileURLToPath(new URL('mocha-test.cjs', fixtures))], 'no-config': true, 'no-package': true,
    } },
  });
  assert.deepEqual(await bridge.call('runner.capabilities'), { reloadEnvironment: false });
  await bridge.call('runner.init');
  const baseline = await bridge.call('runner.dryRun', { coverageAnalysis: 'off', disableBail: false, timeout: 5000 });
  assert.equal(baseline.status, 'complete');
  assert.deepEqual(baseline.tests.map(({ id, status }) => ({ id, status })), [
    { id: 'bridge fixture async mutation', status: TestStatus.Success }, { id: 'bridge fixture callback', status: TestStatus.Success },
  ]);
  const options = { timeout: 5000, disableBail: false, activeMutant: { id: 'kill' }, sandboxFileName: 'unused.js', mutantActivation: 'runtime', reloadEnvironment: false };
  const killed = await bridge.call('runner.mutantRun', options);
  assert.equal(killed.status, 'killed');
  assert.deepEqual(killed.killedBy, ['bridge fixture async mutation']);
  assert.equal(killed.nrOfTests, 1);
  const survived = await bridge.call('runner.mutantRun', { ...options, activeMutant: { id: 'survive' }, testFilter: ['bridge fixture callback'] });
  assert.deepEqual(survived, { status: 'survived', nrOfTests: 1 });
  const hooks = await lines(hooksFile);
  assert.equal(hooks.filter((event) => event === 'before').length, 3);
  assert.equal(hooks.filter((event) => event === 'after').length, 3);
  assert.equal(hooks.filter((event) => event === 'beforeEach:async mutation').length, 2);
  assert.equal(hooks.filter((event) => event === 'afterEach:async mutation').length, 2);
  assert.equal(hooks.filter((event) => event === 'beforeEach:callback').length, 2);
  assert.equal(hooks.some((event) => event.includes('pending')), false);
  await bridge.call('dispose');
  bridge.socket.end();
  await bridge.exited;
  const trace = await lines(traceFile);
  assert.equal(trace.some((url) => url.includes('/@stryker-mutator/mocha-runner/')), true);
  assert.equal(trace.some((url) => url.includes('/@stryker-mutator/core/')), false, 'Mocha compatibility must not import the upstream core runtime');
  assert.equal(trace.some((url) => /StrykerCLI|process-executor|pool\.js/i.test(url)), false);
  await writeFile(path.join(artifacts, 'mocha-evidence.json'), JSON.stringify({
    nodeVersion: process.version, sdkVersion: '10.0.0', runner: 'installed @stryker-mutator/mocha-runner',
    baseline: baseline.tests.map(({ id, status }) => ({ id, status })), killed, survived,
    hookEvents: hooks, parsedScripts: trace.length, upstreamCoreScripts: trace.filter((url) => url.includes('/@stryker-mutator/core/')),
  }, null, 2) + '\n');
});

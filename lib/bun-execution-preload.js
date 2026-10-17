// Opt-in collection only; ordinary inactive and mutant runs are untouched.
import { openSync, writeSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import * as childNamespace from 'node:child_process';
import workerThreads from 'node:worker_threads';
import * as workerNamespace from 'node:worker_threads';
import timers from 'node:timers';
import * as timerNamespace from 'node:timers';
import timerPromises from 'node:timers/promises';
import * as timerPromiseNamespace from 'node:timers/promises';

const context = process.env.STRYKER_RUST_FILE_COVERAGE;
if (context) {
  const config = JSON.parse(context);
  const path = join(config.directory, `${config.id}.ndjson`);
  const fd = openSync(path, 'wx', 0o600);
  const append = (event) => {
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    try { if (writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete coverage write'); }
    catch (error) { try { unlinkSync(path); } catch {} throw error; }
  };
  append({ type: 'start', version: 1, session: config.session, file: config.file, id: config.id, parent: config.parent });
  const issues = new Set();
  const guarded = [];
  const issue = (reason) => { if (!issues.has(reason)) { issues.add(reason); append({ type: 'issue', reason }); } };
  if (process.versions.bun !== '1.4.3') issue('Unqualified Bun runtime');
  if (process.env.__STRYKER_ACTIVE_MUTANT__) issue('Active mutation during coverage');
  const namespace = globalThis.__stryker__ ??= {};
  const coverage = namespace.mutantCoverage ??= { static: {}, perTest: {} };
  function counts(target, phase) {
    const seen = new Set();
    const observe = (mutant, value) => {
      if (typeof mutant !== 'string' || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) issue('Invalid coverage counter');
      else if (value > 0 && !seen.has(mutant)) { seen.add(mutant); append({ type: 'hit', mutant, phase }); }
    };
    for (const [mutant, value] of Object.entries(target)) observe(mutant, value);
    return new Proxy(target, { set(object, mutant, value) { observe(mutant, value); return Reflect.set(object, mutant, value); } });
  }
  coverage.static = counts(coverage.static, 'static');
  coverage.perTest = new Proxy(coverage.perTest, {
    set(object, test, value) {
      if (test !== config.file || config.parent !== null) issue('Unknown test-file identity');
      return Reflect.set(object, test, counts(value, 'test'));
    },
  });
  // Instrumentation reads these exact counter objects once and caches them.
  // Only novel positive hits are journaled; original numerical counters remain intact.
  if (config.parent === null) {
    const { beforeEach, afterEach, afterAll } = await import('bun:test');
    beforeEach(() => { namespace.currentTestId = config.file; });
    afterEach(() => { namespace.currentTestId = undefined; checkGuards(); });
    afterAll(() => { checkGuards(); });
  }
  // Child top-level execution remains static, even when launched by a test.
  // Conservatively keep these mutants on the full suite.
  function checkGuards() {
    if (!guarded.every((check) => check()) || globalThis.__stryker__ !== namespace || namespace.mutantCoverage !== coverage) issue('Replaced coverage/boundary guard');
  }
  function guard(object, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const installed = replacement(object[key]);
    let current = installed;
    if (descriptor?.configurable === false) object[key] = installed;
    else Object.defineProperty(object, key, { configurable: true,
        enumerable: descriptor?.enumerable ?? true, get() { return current; },
        set(value) { issue(`Replaced boundary: ${key}`); current = value; } });
    guarded.push(() => object[key] === installed);
  }
  const unsupported = (name) => (original) => function (...args) {
    issue(`Unsupported boundary: ${name}`);
    return Reflect.apply(original, this, args);
  };
  // Bun test can exit with unawaited timers still pending. Do not seal such a
  // collection as complete merely because its test summary says success.
  for (const [schedule, cancel] of [['setTimeout', 'clearTimeout'], ['setImmediate', 'clearImmediate']]) {
    const original = globalThis[schedule];
    const alias = timers[schedule];
    const handles = new Map();
    guard(globalThis, schedule, () => function (callback, ...args) {
      if (typeof callback !== 'function') {
        issue('Unsupported timer callback');
        return original.call(this, callback, ...args);
      }
      const task = randomUUID();
      append({ type: 'openTask', task });
      let handle;
      handle = original.call(this, function (...values) {
        handles.delete(handle);
        const settled = () => append({ type: 'settledTask', task });
        try {
          const result = callback.apply(this, values);
          if (result && typeof result.then === 'function') issue('Async timer callback');
          settled();
        } catch (error) { settled(); throw error; }
      }, ...args);
      handles.set(handle, task);
      if (typeof handle?.refresh === 'function') {
        const refresh = handle.refresh;
        handle.refresh = function (...values) { issue('Timer refresh'); return refresh.apply(this, values); };
      }
      return handle;
    });
    guard(globalThis, cancel, (originalCancel) => function (handle) {
      const task = handles.get(handle);
      if (task) { handles.delete(handle); append({ type: 'cancelTask', task }); }
      return originalCancel.call(this, handle);
    });
    if (alias !== original) issue('Unqualified timer alias');
    guard(timers, schedule, () => globalThis[schedule]);
    guard(timers, cancel, () => globalThis[cancel]);
  }
  guard(globalThis, 'setInterval', unsupported('setInterval'));
  guard(timers, 'setInterval', unsupported('node:timers.setInterval'));
  for (const key of ['setTimeout', 'setImmediate', 'setInterval']) guard(timerPromises, key, unsupported(`node:timers/promises.${key}`));
  for (const key of ['wait', 'yield']) if (typeof timerPromises.scheduler?.[key] === 'function') guard(timerPromises.scheduler, key, unsupported(`node:timers/promises.scheduler.${key}`));
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    guard(childProcess, key, unsupported(`node:child_process.${key}`));
  }
  guard(childProcess, 'ChildProcess', (Original) => new Proxy(Original, {
    construct(target, args, newTarget) {
      issue('Unsupported boundary: ChildProcess');
      return Reflect.construct(target, args, newTarget);
    },
  }));
  guard(workerThreads, 'Worker', (Original) => new Proxy(Original, {
    construct(target, args, newTarget) {
      issue('Unsupported boundary: node:worker_threads.Worker');
      return Reflect.construct(target, args, newTarget);
    },
  }));
  // Bun's syncBuiltinESMExports does not update every named builtin export.
  // Its supported module-mock seam updates both ESM and CJS before user imports.
  const { mock } = await import('bun:test');
  for (const [name, namespace, value] of [
    ['node:worker_threads', workerNamespace, workerThreads], ['node:child_process', childNamespace, childProcess],
    ['node:timers', timerNamespace, timers], ['node:timers/promises', timerPromiseNamespace, timerPromises],
  ]) {
    const exports = { ...namespace, ...value, default: value };
    mock.module(name, () => exports);
  }
  const protectedModules = new Set(['node:worker_threads', 'worker_threads', 'node:child_process', 'child_process',
    'bun', 'bun:test', 'node:timers', 'timers', 'node:timers/promises', 'timers/promises']);
  guard(mock, 'module', (original) => function (name, ...args) {
    if (protectedModules.has(name)) issue('Replaced boundary module');
    return original.call(this, name, ...args);
  });
  if (typeof globalThis.Worker === 'function') guard(globalThis, 'Worker', (Original) => new Proxy(Original, {
    construct(target, args, newTarget) {
      issue('Unsupported boundary: Worker');
      return Reflect.construct(target, args, newTarget);
    },
  }));
  guard(Bun, 'spawn', unsupported('Bun.spawn'));
  guard(Bun, 'sleep', unsupported('Bun.sleep'));
  guard(Bun, 'spawnSync', (original) => function (command, options) {
    if (issues.size) return Reflect.apply(original, this, arguments);
    const objectForm = !Array.isArray(command);
    const cmd = objectForm ? command?.cmd : command;
    const opts = (objectForm ? command : options) ?? {};
    let direct = false;
    try {
      direct = Array.isArray(cmd) && realpathSync(cmd[0]) === realpathSync(process.execPath);
    } catch { /* Unknown executables retain their original execution. */ }
    const args = cmd?.slice(1);
    if (args?.[0] === '--no-env-file') args.shift();
    const evalForm = args?.length === 2 && ['-e', '--eval'].includes(args[0]) && typeof args[1] === 'string';
    const fileForm = args?.length === 1 && typeof args[0] === 'string' && /\.[cm]?[jt]sx?$/.test(args[0]) && !args[0].startsWith('-');
    if (!direct || (!evalForm && !fileForm) || opts.detached || opts.ipc || opts.onExit
      || opts.env?.__STRYKER_ACTIVE_MUTANT__) {
      issue('Unsupported boundary: Bun.spawnSync command/options');
      return Reflect.apply(original, this, arguments);
    }
    const id = randomUUID();
    append({ type: 'open', child: id }); // Registration precedes launch; missing preload/EOF fails closed.
    const childContext = { ...config, id, parent: config.id };
    const childOptions = { ...opts, env: { ...(opts.env ?? process.env),
      STRYKER_RUST_FILE_COVERAGE: JSON.stringify(childContext) } };
    const childCommand = [cmd[0], '--preload', import.meta.path, ...cmd.slice(1)];
    try {
      const result = original.call(Bun, childCommand, childOptions);
      append({ type: 'settled', child: id, exitCode: result.exitCode, signal: result.signalCode || null });
      checkGuards();
      return result; // spawnSync has settled the process and both output pipes.
    } catch (error) {
      issue('Child launch failed');
      throw error;
    }
  });
  const originalExit = process.exit;
  guard(process, 'exit', () => function (...args) {
    issue('Explicit process.exit');
    return originalExit.apply(this, args);
  });
}

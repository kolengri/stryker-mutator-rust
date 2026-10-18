// Scoped foreign-runtime I/O observation; coverage decisions remain in Rust.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { etaErrorMessage } from './eta-errors.js';

const scope = new AsyncLocalStorage();
const cleanupMs = 2000; // Same bounded drain allowance as the native process supervisor.
// 1.6.0 original and the exact quiet bail-count patch. The latter changes only
// output summary counting, not spawn, cancellation, EOF or close semantics.
const sdkHashes = new Set([
  '6be2e6f1b685c6655682de8cc8f1989f66cc420d16b9fc5b963b93bf018588f0',
  '42465984c4ef1f0003773c8c8b1d72d8526bc944ab68aea427ac191630bd60ee',
]);
const wrapperHash = '00d78044e28dd8348fcc29cb9fcb451a35889aee95664774e69fb47a07ad9429';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const value = (object, key) => Object.getOwnPropertyDescriptor(object ?? {}, key)?.value;

function environment(options, key) {
  const pairs = value(options, 'envPairs');
  if (Array.isArray(pairs)) {
    const prefix = `${key}=`;
    const matches = pairs.filter((pair) => typeof pair === 'string' && pair.startsWith(prefix));
    if (matches.length > 1) throw new Error('Ambiguous producer environment');
    return matches[0]?.slice(prefix.length);
  }
  return value(value(options, 'env'), key);
}

function executable(file, path, cwd = process.cwd()) {
  if (typeof file !== 'string') throw new Error('Missing producer executable');
  const candidates = isAbsolute(file) || file.includes('/') ? [resolve(cwd, file)]
    : String(path ?? '').split(delimiter).filter(Boolean).map((directory) => resolve(cwd, directory, file));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* Try next PATH entry. */ }
  }
  throw new Error('Producer executable is unavailable');
}

function qualify(options) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || (process.versions.bun ? process.versions.bun !== '1.4.3' : process.version !== 'v26.10.0')) {
    throw new Error('Unqualified completion host');
  }
  const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const expected = process.versions.bun ? ['85f6ceddb2153c0cadc51544e4eac68e941d6a4a6fc9c73114de6cfe87ecd699', false]
    : ['32e03df11886a4c8f16d9016b5f6d3cc13c225952cb9de1f995feb00bb5b3dbc', true];
  if (!descriptor?.writable || !descriptor.configurable || descriptor.enumerable !== expected[1]
    || typeof descriptor.value !== 'function' || hash(Function.prototype.toString.call(descriptor.value)) !== expected[0]) {
    throw new Error('Replaced or overlapping ChildProcess spawn boundary');
  }
  if (!options || typeof options.bunPath !== 'string') throw new Error('Owned Bun producer configuration required');
  const binary = executable(options.bunPath, process.env.PATH);
  const wrapped = basename(binary) === 'mutation-bun.sh' && hash(readFileSync(binary)) === wrapperHash;
  if (basename(binary) !== 'bun' && !wrapped) throw new Error('Unqualified Bun producer executable');
  const identities = new Map(wrapped ? [[binary, wrapperHash]] : []);
  if (options.runnerModule !== undefined) {
    const path = realpathSync(options.runnerModule);
    const packagePath = realpathSync(join(dirname(path), '../package.json'));
    const packageSource = readFileSync(packagePath);
    const pkg = JSON.parse(packageSource);
    const digest = hash(readFileSync(path));
    if (pkg.name !== '@hughescr/stryker-bun-runner' || pkg.version !== '1.6.0' || !sdkHashes.has(digest)) {
      throw new Error('Unqualified Bun runner completion seam');
    }
    identities.set(path, digest);
    identities.set(packagePath, hash(packageSource));
  }
  const verify = () => {
    if ([...identities].some(([path, digest]) => realpathSync(path) !== path || hash(readFileSync(path)) !== digest)) {
      throw new Error('Qualified Bun producer source changed during collection');
    }
  };
  return { descriptor, binary, wrapped, verify };
}

function qualifyWrapperLaunch(options, context) {
  // Do not rewrite the command or its environment. The pinned shell script
  // must take its existing exec-only branch, preserving cwd/BUN_OPTIONS/preloads.
  if (environment(options, 'MUTATION_DRY_RUN_LOG') !== '' || environment(options, '__STRYKER_ACTIVE_MUTANT__')) {
    throw new Error('Bun wrapper collection requires inactive exec-only mode');
  }
  const pairs = value(options, 'envPairs');
  const keys = Array.isArray(pairs) ? pairs.map((pair) => pair.slice(0, pair.indexOf('='))) : Object.keys(value(options, 'env') ?? {});
  if (keys.some((key) => key.startsWith('BASH_FUNC_'))
    || ['BASH_ENV', 'ENV', 'CDPATH', 'SHELLOPTS', 'BASHOPTS'].some((key) => environment(options, key) !== undefined)) {
    throw new Error('Unqualified Bun wrapper shell environment');
  }
  const directory = environment(options, 'MUTATION_TEST_DIRECTORY');
  const cwd = realpathSync(resolve(context.cwd, directory || '.'));
  if (!statSync(cwd).isDirectory()
    || executable('bun', environment(options, 'PATH'), cwd) !== executable('bun', process.env.PATH)) {
    throw new Error('Unqualified Bun wrapper cwd/runtime');
  }
}

/** Own exactly one matching, detached Bun test producer and its real pipes.
 * No result or caller-supplied flag is a completion observation. The temporary
 * prototype seam also catches the pinned SDK's previously imported spawn alias.
 */
export class BunProducer {
  constructor(options) {
    this.options = options;
    this.controller = new AbortController();
  }

  cancel(reason) { this.controller.abort(new Error(reason)); }

  assertLaunch() {
    // The pinned SDK awaits file metadata before executeMutantRun. Its consumer
    // calls this at that synchronous spawn boundary, including after cancellation
    // has restored the temporary prototype descriptor. Unrelated runs are free.
    const active = scope.getStore();
    if (active?.producer === this && !active.live()) throw new Error('Owned producer collection is no longer active');
  }

  async run(context, deadline, callback, signal) {
    const { descriptor, binary, wrapped, verify } = qualify(this.options);
    const drainMs = this.options.drainTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(drainMs) || drainMs < 1 || drainMs > 60_000) throw new Error('Invalid producer drain allowance');
    const token = JSON.stringify(context);
    const events = [];
    const listeners = [];
    let child, closed = false, live = true, closeTimer, timer;
    let failure;
    let resolveClose, fail;
    const close = new Promise((resolve) => { resolveClose = resolve; });
    const failed = new Promise((_, reject) => { fail = reject; });
    // All rejections have an observer before any process can emit an event.
    failed.catch(() => {});
    const append = (event) => { if (live) events.push(event); };
    const abort = (reason) => {
      failure ??= reason instanceof Error ? reason : new Error(etaErrorMessage(reason));
      fail(failure);
    };
    const listen = (target, name, callback) => {
      target.on(name, callback); listeners.push(() => target.removeListener(name, callback));
    };
    const wrapper = function (options, ...rest) {
      if (scope.getStore() !== owner) {
        return Reflect.apply(descriptor.value, this, [options, ...rest]);
      }
      try {
        if (environment(options, 'STRYKER_RUST_FILE_COVERAGE') !== token) {
          throw new Error('Unowned process launch inside coverage collection');
        }
        if (!live || failure || child) throw new Error('Duplicate or late owned producer');
        verify();
        const args = value(options, 'args');
        const command = Array.isArray(args) ? args.slice(1) : [];
        if (command[0] === '--no-env-file') command.shift();
        const stdio = value(options, 'stdio');
        if (value(options, 'detached') !== true || command[0] !== 'test'
          || !Array.isArray(stdio) || stdio[0] !== 'ignore' || stdio[1] !== 'pipe' || stdio[2] !== 'pipe'
          || executable(value(options, 'file'), environment(options, 'PATH')) !== binary
          || realpathSync(value(options, 'cwd') ?? process.cwd()) !== context.cwd) {
          throw new Error('Unsupported owned Bun launch mode');
        }
        if (wrapped) qualifyWrapperLaunch(options, context);
        const returned = Reflect.apply(descriptor.value, this, [options, ...rest]);
        child = this;
        if (!Number.isSafeInteger(child.pid) || child.pid < 1 || !child.stdout || !child.stderr) {
          abort(new Error('Missing owned process/pipe handles'));
          return returned;
        }
        append({ type: 'spawn', version: 2, session: context.session, file: context.file, pid: child.pid });
        for (const [stream, fd] of [[child.stdout, 1], [child.stderr, 2]]) {
          listen(stream, 'end', () => append({ type: 'eof', pid: child.pid, fd }));
        }
        listen(child, 'exit', (code, signal) => {
          append({ type: 'exit', pid: child.pid, code, signal });
          closeTimer = setTimeout(() => abort(new Error('Owned producer drain deadline expired')), drainMs);
        });
        listen(child, 'close', (code, signal) => {
          append({ type: 'close', pid: child.pid, code, signal });
          closed = true; clearTimeout(closeTimer); resolveClose();
        });
        return returned;
      } catch (error) {
        // SDK monitoring/caller catches must not erase a rejected observation.
        abort(error);
        throw error;
      }
    };
    const owner = { producer: this, live: () => live && !failure };
    const onAbort = () => abort(signal?.reason ?? new Error('Coverage collection cancelled'));
    const onCancel = () => abort(this.controller.signal.reason);
    Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: wrapper });
    try {
      timer = setTimeout(() => abort(new Error('Coverage collection budget exhausted')), Math.max(0, deadline - performance.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.controller.signal.addEventListener('abort', onCancel, { once: true });
      if (signal?.aborted) onAbort();
      if (this.controller.signal.aborted) onCancel();
      if (failure) throw failure;
      const work = scope.run(owner, async () => {
        const result = await callback();
        const early = !closed;
        append({ type: 'result', pid: child?.pid ?? 0 });
        if (!child) throw new Error('Missing owned Bun producer');
        await close;
        if (early) throw new Error('Runner result preceded owned process/pipe close');
        verify();
        return { result, completion: events.map((event) => JSON.stringify(event) + '\n').join('') };
      });
      // A cancelled SDK operation may settle later; consume its rejection without
      // retaining interception or allowing that result to become a coverage proof.
      work.catch(() => {});
      return await Promise.race([work, failed]);
    } catch (error) {
      failure ??= error;
      // Own the detached process group even after its leader exits. An inherited
      // pipe holder remains in that group in the supported non-escaping contract.
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure = error; }
        let cleanupTimer;
        await Promise.race([close, new Promise((resolve) => { cleanupTimer = setTimeout(resolve, cleanupMs); })]);
        clearTimeout(cleanupTimer);
        if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
      }
      throw failure;
    } finally {
      live = false; clearTimeout(timer); clearTimeout(closeTimer);
      // Like the native Group owner, disarm all non-escaping descendants even
      // when the leader and its pipes closed successfully (e.g. ignored stdio).
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
      }
      signal?.removeEventListener('abort', onAbort);
      this.controller.signal.removeEventListener('abort', onCancel);
      for (const remove of listeners) remove();
      const current = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
      if (current?.value === wrapper) Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor);
      else throw new Error('Owned producer spawn boundary changed during collection');
      if (failure) throw failure;
    }
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BunProducer } from '../lib/bun-producer.js';
import { BunFileCoverageSession } from '../lib/bun-execution.js';
import { assertProcessStopped } from './helpers.js';

const artifacts = resolve(process.env.STRYKER_RUST_ACCELERATION_ARTIFACT_DIR ?? 'artifacts/bun-execution-acceleration/completion-boundary');
mkdirSync(artifacts, { recursive: true });
const host = process.platform === 'darwin' && process.arch === 'arm64'
  && (process.versions.bun ? process.versions.bun === '1.4.3' : process.version === 'v26.10.0');
const bun = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim() === '1.4.3';
const owned = (name, fn) => test(name, { skip: !host || !bun }, fn);

function fixture(body = "test('pass',()=>{});") {
  const directory = mkdtempSync(join(artifacts, 'owner-'));
  const file = join(directory, 'case.test.js');
  writeFileSync(file, "import {test} from 'bun:test';\n" + body);
  const context = { directory, session: randomUUID(), file, id: 'root', parent: null, cwd: process.cwd() };
  return { directory, file, context };
}

function launch(f, { early = false, stdio = ['ignore', 'pipe', 'pipe'], binary = 'bun' } = {}) {
  const child = spawn(binary, ['--no-env-file', 'test', f.file], {
    detached: true, stdio, env: { ...process.env, STRYKER_RUST_FILE_COVERAGE: JSON.stringify(f.context) },
  });
  let stdout = '', stderr = '';
  const seen = [];
  child.stdout.on('data', (bytes) => { stdout += bytes; seen.push({ fd: 1, data: bytes.toString() }); });
  child.stderr.on('data', (bytes) => { stderr += bytes; seen.push({ fd: 2, data: bytes.toString() }); });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on(early ? 'exit' : 'close', (code) => resolve({ status: code === 0 ? 'survived' : 'error', stdout, stderr }));
  });
  return { child, result, seen };
}

function sameDescriptor(before) {
  assert.deepEqual(Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn'), before);
}

test('a status or caller flag without an owned producer cannot authorize file selection', async () => {
  const f = fixture();
  try {
    let called = false;
    const session = new BunFileCoverageSession({ files: [f.file], identityFiles: [f.file], qualification: 'independent-files-bun-sync-v1' });
    await session.collect(async () => { called = true; return { status: 'survived', complete: true }; }, { status: 'survived' });
    assert.equal(called, false);
    assert.equal(session.select('m').files, undefined);
    assert.match(session.reason, /completion host|producer configuration/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

owned('owned streams drain late bytes; an early unchanged result is rejected and a second run is clean', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const f = fixture(`const child=Bun.spawn([process.execPath,'--no-env-file','-e',${JSON.stringify("setTimeout(()=>{process.stdout.write('late-out');process.stderr.write('late-err')},100)")}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});child.unref();test('root',()=>console.log('root-out'));`);
  const rows = [];
  try {
    for (const early of [false, true]) {
      f.context.session = randomUUID();
      let launched, callbackResult;
      const producer = new BunProducer({ bunPath: 'bun' });
      const pending = producer.run(f.context, performance.now() + 3000, async () => {
        launched = launch(f, { early });
        callbackResult = await launched.result;
        return callbackResult;
      });
      if (early) await assert.rejects(pending, /preceded owned/);
      else {
        const outcome = await pending;
        assert.strictEqual(outcome.result, callbackResult);
        assert.match(outcome.result.stdout, /late-out/); assert.match(outcome.result.stderr, /late-err/);
        const events = outcome.completion.trim().split('\n').map(JSON.parse);
        assert.equal(events[0].session, f.context.session);
        assert.equal(events[0].pid, launched.child.pid);
        assert.deepEqual(events.filter((e) => e.type === 'eof').map((e) => e.fd).sort(), [1, 2]);
        assert.equal(events.at(-1).type, 'result');
      }
      assert.equal(callbackResult.status, 'survived');
      const output = launched.seen.map((entry) => entry.data).join('');
      assert.match(output, /late-out/); assert.match(output, /late-err/);
      if (early) assert.doesNotMatch(callbackResult.stdout, /late-out/);
      assertProcessStopped(launched.child.pid); sameDescriptor(before);
      rows.push({ early, callbackResult, observed: launched.seen });
    }
    const clean = fixture();
    try {
      const outcome = await new BunProducer({ bunPath: 'bun' }).run(clean.context, performance.now() + 2000, () => launch(clean).result);
      assert.equal(outcome.result.status, 'survived'); sameDescriptor(before);
    } finally { rmSync(clean.directory, { recursive: true, force: true }); }
    writeFileSync(join(artifacts, 'late-pipe-owner.json'), JSON.stringify(rows, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

owned('deadline, cancellation, missing close and process API failure reject ownership with bounded cleanup', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const rows = [];
  for (const kind of ['deadline', 'cancel', 'missing-close', 'process-error', 'missing-producer']) {
    const f = fixture(kind === 'deadline' || kind === 'cancel' ? "test('hang',async()=>{await new Promise(()=>{})},10000);" : undefined);
    const producer = new BunProducer({ bunPath: 'bun', drainTimeoutMs: 50 });
    const controller = new AbortController();
    let launched, timer;
    const originalEmit = ChildProcess.prototype.emit;
    if (kind === 'missing-close') ChildProcess.prototype.emit = function (event, ...args) {
      if (event === 'close' && this.spawnargs?.includes(f.file)) return false;
      return Reflect.apply(originalEmit, this, [event, ...args]);
    };
    try {
      const pending = producer.run(f.context, performance.now() + (kind === 'deadline' ? 100 : 1000), () => {
        if (kind === 'missing-producer') return { status: 'survived', completion: true };
        if (kind === 'process-error') return launch(f, { stdio: ['ignore', 'pipe', 'pipe', 'invalid-stdio'] }).result;
        launched = launch(f, { early: kind === 'missing-close' });
        return launched.result;
      }, controller.signal);
      if (kind === 'cancel') timer = setTimeout(() => controller.abort(new Error('fixture cancellation')), 50);
      await assert.rejects(pending);
      if (launched) assertProcessStopped(launched.child.pid);
      sameDescriptor(before); rows.push({ kind, pid: launched?.child.pid, failedClosed: true });
    } finally {
      clearTimeout(timer); ChildProcess.prototype.emit = originalEmit;
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
  const clean = fixture();
  try {
    const outcome = await new BunProducer({ bunPath: 'bun' }).run(clean.context, performance.now() + 2000, () => launch(clean).result);
    assert.equal(outcome.result.status, 'survived'); sameDescriptor(before);
  } finally { rmSync(clean.directory, { recursive: true, force: true }); }
  writeFileSync(join(artifacts, 'owner-failures.json'), JSON.stringify(rows, null, 2));
});

owned('runtime/source replacements and unsupported launch modes fail closed without persistent interception', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const f = fixture();
  try {
    for (const options of [{ bunPath: '/bin/sh' }, { bunPath: 'bun', runnerModule: f.file }]) {
      await assert.rejects(new BunProducer(options).run(f.context, performance.now() + 1000, () => { throw Error('must not run'); }));
      sameDescriptor(before);
    }
    Object.defineProperty(ChildProcess.prototype, 'spawn', { ...before, value: function replacement() {} });
    await assert.rejects(new BunProducer({ bunPath: 'bun' }).run(f.context, performance.now() + 1000, () => {}), /Replaced/);
  } finally {
    Object.defineProperty(ChildProcess.prototype, 'spawn', before);
    rmSync(f.directory, { recursive: true, force: true });
  }
});

owned('cancelled SDK metadata continuations cannot launch later or contaminate another collection', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const first = fixture(), second = fixture();
  const producer = new BunProducer({ bunPath: 'bun' });
  let resume, continuation, spawned = false;
  try {
    const pending = producer.run(first.context, performance.now() + 20, () => {
      continuation = (async () => {
        await new Promise((resolve) => { resume = resolve; });
        producer.assertLaunch(); // Same guard as the saved SDK consumer.
        spawned = true;
        return launch(first).result;
      })();
      return continuation;
    });
    await assert.rejects(pending, /budget/);
    sameDescriptor(before);
    resume();
    await assert.rejects(continuation, /no longer active/);
    assert.equal(spawned, false);
    // The old async scope remains cancelled; a separate one and ordinary callers
    // are unaffected by its guard or the already-restored global descriptor.
    producer.assertLaunch();
    const next = new BunProducer({ bunPath: 'bun' });
    const outcome = await next.run(second.context, performance.now() + 2000, () => {
      next.assertLaunch(); return launch(second).result;
    });
    assert.equal(outcome.result.status, 'survived'); sameDescriptor(before);
  } finally {
    resume?.();
    rmSync(first.directory, { recursive: true, force: true });
    rmSync(second.directory, { recursive: true, force: true });
  }
});

owned('a real spawn error retains the caller error path and cannot become completion evidence', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const f = fixture();
  const binary = join(f.directory, 'bun');
  // X_OK and a stable direct path, but an unavailable interpreter causes an
  // actual OS spawn error; no Bun/runtime/preload receipt can be manufactured.
  writeFileSync(binary, '#!/stryker-rust-missing-interpreter\n', { mode: 0o700 });
  let callerError;
  try {
    await assert.rejects(new BunProducer({ bunPath: binary }).run(f.context, performance.now() + 1000, async () => {
      try { return await launch(f, { binary }).result; }
      catch (error) { callerError = error; throw error; }
    }));
    // Bun may throw synchronously; Node emits the same asynchronous error that
    // the original caller handles. The observer installs no error listener.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callerError?.code, 'ENOENT'); sameDescriptor(before);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

owned('unrelated async scopes pass through; missing producer context is rejected before launch', async () => {
  const before = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  const f = fixture();
  let resume;
  try {
    const pending = new BunProducer({ bunPath: 'bun' }).run(f.context, performance.now() + 2000, async () => {
      await new Promise((resolve) => { resume = resolve; });
      return launch(f).result;
    });
    // The temporary descriptor is installed, but this caller is outside the
    // collector's async scope. Complete it before starting the Bun test root.
    const unrelated = spawn(process.execPath, [...(process.versions.bun ? ['--no-env-file'] : []),
      '-e', "process.stdout.write('unrelated')"], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    unrelated.stdout.on('data', (bytes) => { output += bytes; });
    await new Promise((resolve, reject) => { unrelated.on('error', reject); unrelated.on('close', resolve); });
    assert.equal(output, 'unrelated');
    resume(); await pending; sameDescriptor(before);
    await assert.rejects(new BunProducer({ bunPath: 'bun' }).run(f.context, performance.now() + 1000, () => {
      // Reject at the spawn boundary; no unknown process is left to clean up.
      spawn('bun', ['--no-env-file', 'test', f.file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {} });
    }), /Unowned process launch/);
    sameDescriptor(before);
  } finally { resume?.(); rmSync(f.directory, { recursive: true, force: true }); }
});

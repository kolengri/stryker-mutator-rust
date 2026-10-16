import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runNativeMutationTest } from '../lib/runtime.js';

async function project(t, script = '') {
  const suffix = process.platform === 'win32' ? ' Windows spaces & paths' : '';
  const directory = resolve('artifacts/native-runtime/public-api', `${process.pid}-${randomUUID()}${suffix}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'test.mjs'), script);
  await writeFile(join(directory, 'stryker.config.json'), JSON.stringify({
    testRunner: 'command', plugins: [], appendPlugins: [], checkers: [], coverageAnalysis: 'off',
    commandRunner: { command: `${quote(process.execPath)} test.mjs` },
    mutate: [], allowEmpty: true, reporters: [], cleanTempDir: 'always', logLevel: 'off',
  }));
  return directory;
}

const quote = (value) => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;

test('public native pre-abort preserves the reason without running a command or creating a sandbox', async (t) => {
  const cwd = await project(t, "throw new Error('must not execute');");
  const controller = new AbortController();
  const reason = new Error('cancelled before enqueue');
  controller.abort(reason);
  await assert.rejects(runNativeMutationTest({ cwd }, { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual((await readdir(cwd)).sort(), ['package.json', 'stryker.config.json', 'test.mjs']);
});

test('public native requests do not invoke configuration accessors', async () => {
  let reads = 0;
  const request = Object.defineProperty({}, 'cwd', { enumerable: true, get() { reads++; return process.cwd(); } });
  await assert.rejects(runNativeMutationTest(request), /plain JSON/);
  assert.equal(reads, 0);
});

test('public unsupported preflight never starts user code or creates reports and sandboxes', async (t) => {
  const cwd = await project(t, "throw new Error('must not execute');");
  const result = await runNativeMutationTest({ cwd, overrides: { reporters: ['unimplemented-reporter'] } });
  assert.equal(result.supported, false);
  assert.equal(typeof result.reason, 'string');
  assert.deepEqual((await readdir(cwd)).sort(), ['package.json', 'stryker.config.json', 'test.mjs']);
});

if (process.platform !== 'win32') {
  test('public abort keeps Node responsive and settles after descendants stop and sandbox cleanup finishes', { timeout: 15000 }, async (t) => {
    const cwd = await project(t);
    const pidFile = join(cwd, 'children.json');
    await writeFile(join(cwd, 'test.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const reason = new Error('public cancellation reason');
    const pending = runNativeMutationTest({ cwd }, { signal: controller.signal });
    // Observe the rejection immediately, including if startup unexpectedly fails.
    const settled = pending.then((value) => ({ value }), (error) => ({ error }));
    const started = performance.now();
    let pids;
    let result;
    try {
      while (performance.now() - started < 10000) {
        try {
          pids = JSON.parse(await readFile(pidFile, 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(10);
      }
      assert.equal(pids?.length, 2, 'Node must keep handling timers/files while Rust runs the baseline');
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0), 'Both command processes must have started');
      const sibling = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      try {
        assert.deepEqual(await once(sibling, 'close', { signal: AbortSignal.timeout(5000) }), [0, null], 'Tokio must preserve Node child-process completion');
      } finally {
        if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGKILL');
      }
    } finally {
      controller.abort(reason);
      result = await settled;
    }
    assert.equal(result.error, reason, 'AbortSignal reason is preserved after native cleanup');
    assert.ok(!(await readdir(cwd)).includes('.stryker-tmp'), 'Promise settled before sandbox cleanup');
    for (const pid of pids) {
      const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      assert.ok(status.status === 0 || status.status === 1, status.stderr);
      // POSIX may retain an already terminated orphan as a zombie until init
      // reaps it; it cannot execute code or retain our command's output streams.
      assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), `Child ${pid} remains active: ${status.stdout}`);
    }
    const recovered = await runNativeMutationTest({ cwd, overrides: { commandRunner: { command: ':' } } });
    assert.equal(recovered.supported, true);
    assert.equal(recovered.stats.coordinator, 'rust');
    assert.equal(recovered.stats.commandStarts, 1);
  });
}

if (process.platform === 'win32') {
  test('public Windows abort awaits root and grandchildren exit and junction cleanup while preserving dependency targets', { timeout: 20000 }, async (t) => {
    const cwd = await project(t);
    const sentinel = join(cwd, 'node_modules', 'original-sentinel');
    await mkdir(join(cwd, 'node_modules'));
    await writeFile(sentinel, 'dependency target must survive');
    const pidFile = join(cwd, 'children.json');
    const branch = `
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([Number(process.argv[1]), process.pid, leaf.pid]));
setInterval(() => {}, 1000);
`;
    await writeFile(join(cwd, 'test.mjs'), `
import {spawn} from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(branch)}, String(process.pid)], {stdio:'ignore'});
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const reason = new Error('Windows public cancellation reason');
    const settled = runNativeMutationTest({ cwd }, { signal: controller.signal })
      .then((value) => ({ value }), (error) => ({ error }));
    let pids;
    let result;
    try {
      const started = performance.now();
      while (performance.now() - started < 12000) {
        try {
          pids = JSON.parse(await readFile(pidFile, 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(10);
      }
      assert.equal(pids?.length, 3, 'Root, child and grandchild must start while Node remains responsive');
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    } finally {
      controller.abort(reason);
      result = await settled;
    }
    assert.equal(result.error, reason, 'AbortSignal reason follows native tree and sandbox cleanup');
    assert.ok(!(await readdir(cwd)).includes('.stryker-tmp'), 'Promise settled before junction/sandbox cleanup');
    assert.equal(await readFile(sentinel, 'utf8'), 'dependency target must survive');
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', `Process ${pid} remains active after settlement`);
    }
    const recovered = await runNativeMutationTest({ cwd, overrides: { commandRunner: { command: 'exit /B 0' } } });
    assert.equal(recovered.supported, true);
    assert.equal(recovered.stats.coordinator, 'rust');
    assert.equal(recovered.stats.commandStarts, 1);
    assert.equal(await readFile(sentinel, 'utf8'), 'dependency target must survive');
  });
}

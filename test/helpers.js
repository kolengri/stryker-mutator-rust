import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isTraceEnabled: () => false,
};
export const options = { ignorers: [], excludedMutations: [], plugins: null };

export function assertProcessStopped(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid child PID: ${pid}`);
  if (process.platform === 'linux') {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
      throw error;
    }
    // comm may contain closing parentheses; state follows its final delimiter.
    const end = stat.lastIndexOf(') ');
    assert.ok(stat.startsWith(`${pid} (`) && end > 0, `Invalid process state: ${stat}`);
    assert.equal(stat[end + 2], 'Z', `Child ${pid} remains active: ${stat}`);
    return;
  }
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', `Child ${pid} remains active`);
    return;
  }
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(status.error, undefined, status.error?.message);
  assert.ok(status.status === 0 || status.status === 1, status.stderr);
  assert.equal(status.stderr, '', status.stderr);
  // Adopted descendants can remain zombies until init reaps them.
  assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), `Child ${pid} remains active: ${status.stdout}`);
}

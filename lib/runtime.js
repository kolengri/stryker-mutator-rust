import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializePlain } from './cache.js';
import { loadNative } from './native.js';

/** Run one mutation test entirely under the Rust coordinator. */
export async function runNativeMutationTest(request = {}, { signal } = {}) {
  // Validate descriptors before accessing them: configuration accessors/functions
  // belong in the JavaScript compatibility worker, not in this JSON boundary.
  try {
    serializePlain(request);
  } catch (cause) {
    throw new TypeError('Native run requests must contain plain JSON data', { cause });
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Native run request must be an object');
  }
  for (const key of Object.keys(request)) {
    if (!['cwd', 'args', 'overrides'].includes(key)) throw new TypeError(`Unknown native run request field: ${key}`);
  }
  const { cwd = process.cwd(), args = [], overrides = {} } = request;
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd must be a nonempty string');
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('overrides must be an object');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  signal?.throwIfAborted();

  const binding = loadNative();
  if (typeof binding.runNativeMutationTest !== 'function' || typeof binding.cancelNativeRun !== 'function') {
    throw new Error('Installed Rust addon does not support the native coordinator. Build this checkout with npm run build.');
  }
  const payload = JSON.stringify({
    version: 1,
    cwd: resolve(cwd),
    args,
    overrides,
    nodeExecutable: process.execPath,
    bridgeModule: fileURLToPath(new URL('./compat/worker.js', import.meta.url)),
  });
  const cancellationId = randomUUID();
  // Registration happens synchronously inside the addon before work is queued.
  // Await the native cleanup even after abort; a child may still need to be reaped.
  const pending = binding.runNativeMutationTest(payload, cancellationId);
  const abort = () => binding.cancelNativeRun(cancellationId);
  try {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const result = JSON.parse(await pending);
    if (result?.version !== 1 || typeof result.supported !== 'boolean') {
      throw new Error('Rust coordinator returned an incompatible response');
    }
    if (!result.supported) {
      if (typeof result.reason !== 'string' || !result.reason) throw new Error('Rust coordinator omitted its unsupported reason');
    } else if (!Number.isInteger(result.exitCode) || !Array.isArray(result.mutants) || result.stats?.coordinator !== 'rust') {
      throw new Error('Rust coordinator returned an incomplete run result');
    }
    return result;
  } catch (error) {
    // Preserve AbortSignal's public reason after the native promise confirms
    // that cancellation and cleanup have finished.
    if (error?.code === 'Cancelled') signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

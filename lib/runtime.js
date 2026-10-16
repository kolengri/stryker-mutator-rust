import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializePlain } from './cache.js';
import { loadNative } from './native.js';

// Caller graph identity stays local for the lifetime of an executable run.
const callerConfigs = new WeakMap();

/** Run one mutation test entirely under the Rust coordinator. */
export async function runNativeMutationTest(request = {}, { signal } = {}) {
  // Request overrides remain a JSON-only boundary; executable file extraction
  // runs separately in the original caller environment.
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
  if (typeof binding.prepareNativeMutationTest !== 'function' || typeof binding.cancelNativeRun !== 'function') {
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
  // Rust discovers and registers cancellation synchronously before import or
  // AsyncTask submission. Preparation owns the exclusive lease through TLA.
  const preparation = binding.prepareNativeMutationTest(payload, cancellationId);
  const abort = () => binding.cancelNativeRun(cancellationId);
  let configCompatibility;
  try {
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    // Keep the extracted root and its nested identities alive for this run.
    // Opaque main reporters remain unsupported; worker options stay JSON-lossy.
    let imported;
    if (preparation.configPath !== undefined && preparation.configPath !== null) {
      // Keep the JSON command graph thin. This import and its dependencies can
      // await TLA too, so retain ownership until settlement and recheck abort
      // before evaluating the selected user config.
      configCompatibility = await import('./config-compat.js');
      signal?.throwIfAborted();
      // Import/TLA cannot be stopped. Even after abort we await it before
      // releasing ownership, so no clean settlement hides later import effects.
      const { options: exported } = await configCompatibility.loadConfigDefault(preparation.configPath, preparation.configName);
      const rootReason = configCompatibility.rootConfigUnsupportedReason(exported);
      if (rootReason) return { version: 1, supported: false, reason: rootReason };
      // This user execution stage stays outside adapter/native error handlers.
      imported = { extracted: configCompatibility.spreadConfig(exported) };
      callerConfigs.set(preparation, imported.extracted);
      signal?.throwIfAborted();
      const data = configCompatibility.projectConfigData(imported.extracted);
      if (data.reason) return { version: 1, supported: false, reason: data.reason };
      const schema = configCompatibility.projectConfigData(configCompatibility.callerCoreSchema());
      if (schema.reason) return { version: 1, supported: false, reason: schema.reason };
      configCompatibility.applyConfigEffects(imported.extracted, preparation.complete(data.json, schema.json, data.nullPrototypes));
      if (!preparation.unsupportedReason) {
        const loadedMetadata = await configCompatibility.loadCallerMetadata(preparation.pluginModules);
        signal?.throwIfAborted();
        const projectedMetadata = configCompatibility.projectConfigData(loadedMetadata);
        if (projectedMetadata.reason) return { version: 1, supported: false, reason: projectedMetadata.reason };
        // Imports can mutate retained nested data. Reproject descriptors before
        // native plugin validation and replay its effects before any task starts.
        const current = configCompatibility.projectConfigData(imported.extracted);
        if (current.reason) return { version: 1, supported: false, reason: current.reason };
        configCompatibility.applyConfigEffects(imported.extracted,
          preparation.completePlugins(current.json, projectedMetadata.json, current.nullPrototypes));
      }
    }
    const pending = preparation.run(undefined, snapshotCallerEnvironment());
    let response;
    try { response = await pending; }
    catch (error) {
      // Only the native Promise can report a native cancellation status.
      if (error?.code === 'Cancelled') signal?.throwIfAborted();
      throw error;
    }
    const result = JSON.parse(response);
    if (result?.version !== 1 || typeof result.supported !== 'boolean') {
      throw new Error('Rust coordinator returned an incompatible response');
    }
    if (!result.supported) {
      if (typeof result.reason !== 'string' || !result.reason) throw new Error('Rust coordinator omitted its unsupported reason');
    } else if (!Number.isInteger(result.exitCode) || !Array.isArray(result.mutants) || result.stats?.coordinator !== 'rust') {
      throw new Error('Rust coordinator returned an incomplete run result');
    }
    return result;
  } finally {
    callerConfigs.delete(preparation);
    preparation.close();
    signal?.removeEventListener('abort', abort);
  }
}

// Node child_process normalizes Windows env keys by JS lexical order, retaining
// the first case-insensitive spelling before skipping undefined values. Capture
// in this caller environment (worker process.env need not be native OS env).
function snapshotCallerEnvironment() {
  let keys = [];
  for (const key in process.env) keys.push(key);
  if (process.platform === 'win32') {
    const seen = new Set();
    keys = keys.sort().filter((key) => {
      const folded = key.toUpperCase();
      if (seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
  }
  const pairs = [];
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (key.includes('\0') || value.includes('\0')) throw new TypeError('Caller environment must not contain null bytes');
    pairs.push([key, value]);
  }
  return JSON.stringify({ pairs, shell: process.platform === 'win32' ? process.env.comspec || 'cmd.exe' : null,
    hasWorker: keys.some((key) => (process.platform === 'win32' ? key.toUpperCase() : key) === 'STRYKER_MUTATOR_WORKER' && process.env[key] !== undefined) });
}

import { cacheEligibility, serializePlain } from './cache.js';
import { loadNative } from './native.js';
import { executionMetadata, recordExecution } from './execution.js';

export function createBackend(original, settings, stats, instrumentationStats, instrumentationThreads) {
  const engine = settings.engine ?? process.env.STRYKER_RUST_ENGINE ?? 'auto';
  if (!['auto', 'upstream', 'native'].includes(engine)) throw new TypeError('engine must be auto, upstream or native');
  return async (files, options) => {
    if (engine !== 'upstream') {
      let reason;
      try {
        serializePlain({ files, options });
        if (await cacheEligibility(files, options)) {
          const binding = loadNative();
          if (typeof binding.instrumentBatch !== 'function') throw new Error('Native instrumenter API unavailable');
          const request = { files, options };
          if (instrumentationThreads !== undefined) request.execution = { threads: instrumentationThreads };
          const native = JSON.parse(binding.instrumentBatch(JSON.stringify(request)));
          if (native.supported) {
            if (!native.result || !Array.isArray(native.result.files) || !Array.isArray(native.result.mutants)
              || Object.hasOwn(native.result, 'execution')) {
              throw new Error('Invalid native instrumenter response');
            }
            const execution = executionMetadata(native, files.length, instrumentationThreads);
            // The JSON bridge must preserve the complete upstream object contract.
            for (const mutant of native.result.mutants) {
              mutant.status ??= undefined;
              mutant.statusReason ??= undefined;
            }
            stats.nativeBatches++;
            recordExecution(instrumentationStats, execution);
            return native.result;
          }
          reason = native.reason;
        } else {
          reason = 'External parser configuration, framework or ignorer';
        }
      } catch (error) {
        stats.nativeErrors++;
        if (engine === 'native') throw error;
        reason = error.message;
      }
      if (engine === 'native') throw new Error(`Native instrumentation unsupported: ${reason}`);
    }
    stats.fallbackBatches++;
    return original(files, options);
  };
}

import { InstrumentationCache } from './cache.js';
import { createBackend } from './backend.js';

const INSTALLATION = Symbol.for('stryker-mutator-rust.instrumenter.v1');

/** Create an isolated instrumenter without loading upstream until fallback is needed. */
export function createInstrumenter(logger, options) {
  let upstream;
  const original = async (files, config) => {
    upstream ??= import('@stryker-mutator/instrumenter').then(({ Instrumenter }) => {
      const instrumenter = new Instrumenter(logger);
      // An installed acceleration hook must not wrap this factory's fallback.
      const instrument = Instrumenter.prototype[INSTALLATION]?.original ?? Instrumenter.prototype.instrument;
      return instrument.bind(instrumenter);
    });
    return (await upstream)(files, config);
  };
  const cache = new InstrumentationCache(options);
  const backend = createBackend(original, options ?? {}, cache.stats, cache.instrumentationStats, cache.instrumentationStats.configuredThreads);
  return { instrument: (files, config) => cache.instrument(backend, files, config), stats: cache.stats, instrumentationStats: cache.instrumentationStats };
}

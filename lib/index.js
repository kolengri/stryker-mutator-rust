import { Instrumenter } from '@stryker-mutator/instrumenter';
import { Stryker as UpstreamStryker } from '@stryker-mutator/core';
import { InstrumentationCache } from './cache.js';
import { createBackend } from './backend.js';
import { installCoreAcceleration, resolveCoreEngine } from './core.js';

export { analyze, nativeStatus } from './native.js';
export { InstrumentationCache } from './cache.js';

const INSTALLATION = Symbol.for('stryker-mutator-rust.instrumenter.v1');
const originalInstrument = Instrumenter.prototype[INSTALLATION]?.original ?? Instrumenter.prototype.instrument;
const defaultPipeline = new Instrumenter(undefined);
const pipelineKeys = ['_createParser', '_print', '_transform'];

/** Patch the pinned instrumenter once; config, plugins and test execution stay upstream. */
export function installAcceleration(options = {}) {
  const registration = Object.getOwnPropertyDescriptor(Instrumenter.prototype, INSTALLATION);
  if (registration) {
    const record = registration.value;
    const cache = record && Object.getOwnPropertyDescriptor(record, 'cache')?.value;
    const original = record && Object.getOwnPropertyDescriptor(record, 'original')?.value;
    if (!cache || typeof cache.instrument !== 'function' || typeof original !== 'function') throw new TypeError('Conflicting instrumenter installation');
    return cache;
  }
  const cache = new InstrumentationCache(options);
  const instrumentationThreads = cache.instrumentationStats.configuredThreads;
  // Resolve executable configuration before the final mutation-target preflight.
  const coreEngine = resolveCoreEngine(options);
  const instrumentDescriptor = Object.getOwnPropertyDescriptor(Instrumenter.prototype, 'instrument');
  if (!instrumentDescriptor || typeof instrumentDescriptor.value !== 'function' || !instrumentDescriptor.writable
    || !Object.isExtensible(Instrumenter.prototype) || INSTALLATION in Instrumenter.prototype) {
    throw new TypeError('Instrumenter hook and installation marker are not installable');
  }
  cache.coreStats = installCoreAcceleration({ coreEngine });
  Instrumenter.prototype.instrument = function (files, instrumenterOptions) {
    if (this.constructor !== Instrumenter || pipelineKeys.some((key) =>
      Object.getOwnPropertyDescriptor(this, key)?.value !== defaultPipeline[key])) {
      cache.event('bypasses', 'custom instrumenter pipeline');
      cache.stats.fallbackBatches++;
      return originalInstrument.call(this, files, instrumenterOptions);
    }
    const backend = createBackend(originalInstrument.bind(this), options, cache.stats, cache.instrumentationStats, instrumentationThreads);
    return cache.instrument(backend, files, instrumenterOptions);
  };
  Object.defineProperty(Instrumenter.prototype, INSTALLATION, { value: { cache, original: originalInstrument } });
  return cache;
}

export function createInstrumenter(logger, options) {
  const instrumenter = new Instrumenter(logger);
  const cache = new InstrumentationCache(options);
  const backend = createBackend(originalInstrument.bind(instrumenter), options ?? {}, cache.stats, cache.instrumentationStats, cache.instrumentationStats.configuredThreads);
  return { instrument: (files, config) => cache.instrument(backend, files, config), stats: cache.stats, instrumentationStats: cache.instrumentationStats };
}

export class Stryker extends UpstreamStryker {
  constructor(options, acceleration) {
    installAcceleration(acceleration);
    super(options);
  }
}

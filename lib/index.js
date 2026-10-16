import { Instrumenter } from '@stryker-mutator/instrumenter';
import { Stryker as UpstreamStryker } from '@stryker-mutator/core';
import { InstrumentationCache } from './cache.js';
import { createBackend } from './backend.js';
import { installCoreAcceleration } from './core.js';

export { analyze, nativeStatus } from './native.js';
export { InstrumentationCache } from './cache.js';

const INSTALLATION = Symbol.for('stryker-mutator-rust.instrumenter.v1');
const originalInstrument = Instrumenter.prototype[INSTALLATION]?.original ?? Instrumenter.prototype.instrument;
const defaultPipeline = new Instrumenter(undefined);
const pipelineKeys = ['_createParser', '_print', '_transform'];

/** Patch the pinned instrumenter once; config, plugins and test execution stay upstream. */
export function installAcceleration(options = {}) {
  if (Instrumenter.prototype[INSTALLATION]) return Instrumenter.prototype[INSTALLATION].cache;
  const cache = new InstrumentationCache(options);
  cache.coreStats = installCoreAcceleration(options);
  Instrumenter.prototype.instrument = function (files, instrumenterOptions) {
    if (this.constructor !== Instrumenter || pipelineKeys.some((key) =>
      Object.getOwnPropertyDescriptor(this, key)?.value !== defaultPipeline[key])) {
      cache.event('bypasses', 'custom instrumenter pipeline');
      cache.stats.fallbackBatches++;
      return originalInstrument.call(this, files, instrumenterOptions);
    }
    const backend = createBackend(originalInstrument.bind(this), options, cache.stats);
    return cache.instrument(backend, files, instrumenterOptions);
  };
  Object.defineProperty(Instrumenter.prototype, INSTALLATION, { value: { cache, original: originalInstrument } });
  return cache;
}

export function createInstrumenter(logger, options) {
  const instrumenter = new Instrumenter(logger);
  const cache = new InstrumentationCache(options);
  const backend = createBackend(originalInstrument.bind(instrumenter), options ?? {}, cache.stats);
  return { instrument: (files, config) => cache.instrument(backend, files, config), stats: cache.stats };
}

export class Stryker extends UpstreamStryker {
  constructor(options, acceleration) {
    installAcceleration(acceleration);
    super(options);
  }
}

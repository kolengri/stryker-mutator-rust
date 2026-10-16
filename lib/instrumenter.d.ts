import type { InstrumenterOptions, InstrumentResult, File } from '@stryker-mutator/instrumenter';
import type { Logger } from '@stryker-mutator/api/logging';
import type { AccelerationOptions, AccelerationStats, InstrumentationStats } from './index.js';

export type { InstrumenterOptions, InstrumentResult, File, Logger, AccelerationOptions, AccelerationStats, InstrumentationStats };

/** Synchronous factory; upstream fallback is initialized asynchronously once per factory. */
export function createInstrumenter(logger: Logger, options?: AccelerationOptions): {
  instrument(files: readonly File[], options: InstrumenterOptions): Promise<InstrumentResult>;
  stats: AccelerationStats;
  instrumentationStats: InstrumentationStats;
};

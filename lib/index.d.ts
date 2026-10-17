import { Stryker as UpstreamStryker } from '@stryker-mutator/core';
import type { Instrumenter, InstrumenterOptions, InstrumentResult, File } from '@stryker-mutator/instrumenter';
import type { Logger } from '@stryker-mutator/api/logging';
export { CampaignEta, createEtaIdentity, formatEta } from './eta.js';
export type { EtaEstimate, EtaPlan, EtaJob, EtaEvent, EtaHistory, EtaIdentityComponents } from './eta.js';

export interface AccelerationStats { hits: number; misses: number; bypasses: number; errors: number; nativeBatches: number; fallbackBatches: number; nativeErrors: number }
export interface InstrumentationStats {
  configuredThreads?: number;
  parallelBatches: number;
  serialBatches: number;
  serialRecoveries: number;
  lastThreadsUsed: number;
  lastSpawnedThreads: number;
  lastParallelFiles: number;
  lastReason?: string;
}
export interface CoreStats {
  engine: 'auto' | 'upstream' | 'native';
  nativeCoreStages: ('coverage' | 'planning')[];
  nativeCoverageBatches: number;
  nativePlanningBatches: number;
  nativePlannedMutants: number;
  javascriptCoverageFallbacks: number;
  javascriptPlanningFallbacks: number;
  nativeErrors: number;
  lastFallbackReason?: string;
}
export interface AccelerationOptions {
  cache?: boolean;
  engine?: 'auto' | 'upstream' | 'native';
  coreEngine?: 'auto' | 'upstream' | 'native';
  /** Captured once; undefined uses STRYKER_RUST_THREADS, then native auto selection. */
  instrumentationThreads?: number;
  cacheDir?: string;
  onEvent?: (event: { type: keyof AccelerationStats; reason?: string }) => void;
}
export interface Candidate { start: number; end: number; replacement: string; mutatorName: string }
/** Experimental candidates only; supported is false until complete semantic parity. */
export function analyze(source: string, fileName?: string): { supported: false; reason: string; mutants: Candidate[] };
export function nativeStatus(): { available: boolean; target: string; nativeCoordinator: boolean; nativeInstrumentation: boolean; nativeCoverage: boolean; nativePlanning: boolean; napi?: number; candidateEngine?: string; error?: string };
export class InstrumentationCache {
  constructor(options?: AccelerationOptions);
  readonly stats: AccelerationStats;
  readonly coreStats?: CoreStats;
  readonly instrumentationStats: InstrumentationStats;
  instrument(instrument: Instrumenter['instrument'], files: readonly File[], options: InstrumenterOptions): Promise<InstrumentResult>;
}
/** Process-wide; the first call sets options for all subsequent Stryker instances. */
export function installAcceleration(options?: AccelerationOptions): InstrumentationCache & { readonly coreStats: CoreStats };
export function createInstrumenter(logger: Logger, options?: AccelerationOptions): {
  instrument(files: readonly File[], options: InstrumenterOptions): Promise<InstrumentResult>;
  stats: AccelerationStats;
  instrumentationStats: InstrumentationStats;
};
export class Stryker extends UpstreamStryker {
  constructor(options?: ConstructorParameters<typeof UpstreamStryker>[0], acceleration?: AccelerationOptions);
}

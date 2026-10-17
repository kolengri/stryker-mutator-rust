export interface EtaIdentityComponents {
  sources: string;
  tests: string;
  configuration: string;
  lockfile: string;
  /** Include actual test runtime/version, OS/arch and relevant environment. */
  runtime: string;
  /** Include package/core/plugin versions and execution mode. */
  engine: string;
}
export function createEtaIdentity(components: EtaIdentityComponents): string;

export interface EtaJob {
  id: string;
  /** Measured inactive execution cost, including applicable startup/reload. */
  baselineMs?: number | null;
  timeoutMs?: number | null;
  reload?: boolean;
}
export interface EtaPlan {
  /** Actual runnable jobs in the scheduler's order, never raw mutation candidates. */
  jobs: EtaJob[];
  /** Currently available test runners; exclude occupied checker resources. */
  runners: number;
  /** Matching measured preparation cost for a scope not yet prepared. */
  preparationMs?: number | null;
  baselineMs?: number | null;
  /** False if additional runnable work remains unknown. Defaults to true. */
  complete?: boolean;
  notes?: string[];
  /** Unmeasured work keeps the total ETA partial until explicitly resolved. */
  unmeasuredWork?: string[];
}
export interface EtaSample { baselineMs: number | null; durationMs: number; reload: boolean; attempts: number; timedOut: boolean }
export interface EtaHistory {
  version: 1;
  model: 'plan-replay-v1';
  generatedAtUnixMs: number;
  scopes: { id: string; identity: string; measuredAtUnixMs: number; preparationMs: number | null; baselineMs: number | null; samples: EtaSample[] }[];
}
interface EtaEventTime { scopeId: string; /** Monotonic campaign-relative milliseconds; omit for the Rust clock. */ atMs?: number }
export type EtaEvent = EtaEventTime & (
  | { type: 'begin' }
  | { type: 'plan'; plan: EtaPlan }
  | { type: 'capacity'; runners: number; unmeasuredWork?: string[] }
  | { type: 'degrade'; reason: string }
  | { type: 'start'; jobId: string }
  | { type: 'finish'; jobId: string; durationMs?: number | null; attempts?: number | null; timedOut?: boolean; /** False for checker/early results. */ sample?: boolean }
  | { type: 'end' }
);
export interface EtaScopeEstimate {
  id: string;
  state: 'unknown' | 'partial' | 'estimated' | 'complete';
  plannedJobs: number | null;
  completedJobs?: number;
  runningJobs?: number;
  queuedJobs?: number;
  effectiveRunners?: number;
  remainingMs: number | null;
  knownRemainingMs: number;
  range: { lowerMs: number; upperMs: number | null };
  unknown: string[];
  provenance?: { baselineMs: number | null; preparationMs: number | null; plannedAtMs: number | null; currentSamples: number; matchingHistorySamples: number; window: number; notes: string[]; timedOutSamples: number; retryAttempts: number };
}
export interface EtaEstimate {
  version: 1;
  observedAtMs: number;
  state: 'unknown' | 'partial' | 'estimated' | 'complete';
  /** Null whenever declared work or preparation is unknown. */
  remainingMs: number | null;
  knownRemainingMs: number;
  range: { lowerMs: number; upperMs: number | null };
  scopes: EtaScopeEstimate[];
  provenance: { model: 'plan-replay-v1'; history: string[]; rangeKind: string; scopeScheduling: 'sequential'; excludes: string[]; accuracy: string };
}
export class CampaignEta {
  constructor(options: { scopes: { id: string; identity?: string; plan?: EtaPlan }[]; /** Malformed, incompatible and >30-day-old history is ignored with provenance. */ history?: unknown; nowUnixMs?: number });
  /** Returns the normalized event with a timestamp and measured finish duration. */
  record(event: EtaEvent): EtaEvent & { atMs: number };
  snapshot(atMs?: number): EtaEstimate;
  /** Local, explicit persistence only. Omits scopes without a matching identity. */
  history(nowUnixMs?: number): EtaHistory;
}
export function formatEta(estimate: EtaEstimate): string;

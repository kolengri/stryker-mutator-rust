export const bunCoveragePreload: string;
export interface FileSelection { files: string[] | undefined; reason: string; }
export interface CoverageEvidenceInspection {
  /** Investigative candidates only; never pass these as a production filter. */
  candidateFiles: string[] | undefined;
  reason: string;
  diagnostics: {
    /** Complete receipts/completion, not independent-file qualification. */
    complete: boolean;
    reason: string;
    files: number;
    participants: number;
    roots: { file: string; session: string; pid: number }[] | null;
  };
  /** Bounded raw input with qualified:false, available only after validation. */
  evidenceJson: string | undefined;
}
export class BunFileCoverageSession {
  constructor(options?: {
    files?: string[];
    identityFiles?: string[];
    qualification?: 'independent-files-bun-sync-v1';
    env?: Record<string, string | undefined>;
    collectionBudgetMs?: number;
    /** Direct Bun or the exact qualified mutation-bun.sh in inactive exec-only mode;
     * SDK adapters also pin their actual module path. */
    completion?: { bunPath: string; runnerModule?: string; drainTimeoutMs?: number };
  });
  readonly env: Record<string, string | undefined>;
  readonly stats: { nativeSelections: number; selectedPlans: number; fullSuiteFallbacks: number; collectedFiles: number; participants: number; ownedRoots: number };
  readonly reason: string;
  collect(runInactiveFile: (files: string[], remainingMs: number) => Promise<{ status: string }>, exhaustiveBaseline: { status: string }, options?: { signal?: AbortSignal }): Promise<void>;
  /** One diagnostic-only attempt, without qualification or a combined baseline.
   * Uses the same inactive runs, owned completion and limits as collect().
   * A session cannot retry or promote this attempt through collect(). */
  collectEvidence(runInactiveFile: (files: string[], remainingMs: number) => Promise<{ status: string }>, options?: { signal?: AbortSignal }): Promise<void>;
  /** Rechecks identity/cancellation; invalidation removes diagnostics and raw data.
   * Saved snapshots are historical evidence, not live authority. */
  inspect(mutantId: string, options?: { staticMutation?: boolean }): CoverageEvidenceInspection;
  select(mutantId: string, options?: { staticMutation?: boolean }): FileSelection;
  invalidate(reason: string): void;
  /** Call immediately before the pinned SDK's synchronous spawn boundary. */
  assertProducerLaunch(): void;
}

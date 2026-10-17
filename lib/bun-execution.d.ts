export const bunCoveragePreload: string;
export interface FileSelection { files: string[] | undefined; reason: string; }
export class BunFileCoverageSession {
  constructor(options?: {
    files?: string[];
    identityFiles?: string[];
    qualification?: 'independent-files-bun-sync-v1';
    env?: Record<string, string | undefined>;
    collectionBudgetMs?: number;
    /** Direct Bun executable; SDK adapters also pin their actual module path. */
    completion?: { bunPath: string; runnerModule?: string; drainTimeoutMs?: number };
  });
  readonly env: Record<string, string | undefined>;
  readonly stats: { nativeSelections: number; selectedPlans: number; fullSuiteFallbacks: number; collectedFiles: number; participants: number; ownedRoots: number };
  readonly reason: string;
  collect(runInactiveFile: (files: string[], remainingMs: number) => Promise<{ status: string }>, exhaustiveBaseline: { status: string }, options?: { signal?: AbortSignal }): Promise<void>;
  select(mutantId: string, options?: { staticMutation?: boolean }): FileSelection;
  invalidate(reason: string): void;
  /** Call immediately before the pinned SDK's synchronous spawn boundary. */
  assertProducerLaunch(): void;
}

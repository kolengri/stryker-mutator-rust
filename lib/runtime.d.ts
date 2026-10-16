export interface NativeRunRequest {
  /** Project directory. Executable configs require the caller’s canonical cwd. */
  cwd?: string;
  /** Stryker CLI arguments after `run`. */
  args?: string[];
  /** Plain JSON overrides; Rust merges them after data-shaped JS/MJS/CJS config extraction. */
  overrides?: Record<string, unknown>;
}

export interface NativeRunResult {
  version: 1;
  supported: true;
  exitCode: number;
  mutants: Record<string, unknown>[];
  report?: Record<string, unknown>;
  stats: { coordinator: 'rust'; [key: string]: unknown };
}

export interface UnsupportedNativeRun {
  version: 1;
  supported: false;
  reason: string;
}

/** Settles after native cleanup. Executable imports run in this Node environment.
 * Cancellation during import waits for import/TLA settlement; never-settling TLA cannot be cancelled.
 * Executable configs exclude other overlapping native runs and reject cwd/schema mutations and opaque values.
 * Plain shared nested config data retains pinned merge/default/deprecation mutations, even on validation failure.
 * Child processes use this caller environment captured after config/metadata imports; direct addon calls can omit it.
 * Successful native cancellation preserves the AbortSignal reason; cleanup failures remain errors.
 */
export function runNativeMutationTest(
  request?: NativeRunRequest,
  options?: { signal?: AbortSignal },
): Promise<NativeRunResult | UnsupportedNativeRun>;

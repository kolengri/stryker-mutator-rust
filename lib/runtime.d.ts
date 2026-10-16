export interface NativeRunRequest {
  /** Project directory. Defaults to the current working directory. */
  cwd?: string;
  /** Stryker CLI arguments after `run`. */
  args?: string[];
  /** Plain JSON configuration overrides. Executable configuration is not yet supported. */
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

/** Settles after native cleanup. Successful cancellation preserves the AbortSignal reason; cleanup failures remain errors. */
export function runNativeMutationTest(
  request?: NativeRunRequest,
  options?: { signal?: AbortSignal },
): Promise<NativeRunResult | UnsupportedNativeRun>;

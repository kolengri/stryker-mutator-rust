import type { Reporter } from '@stryker-mutator/api/report';
import type { Plugin, PluginKind } from '@stryker-mutator/api/plugin';
import type { CampaignEta, EtaEstimate, EtaEvent } from './eta.js';

/** Opt-in, pinned Core 10 lifecycle integration; one active reporter per process. */
export function createEtaReporter(options?: {
  campaign?: CampaignEta;
  scopeId?: string;
  concurrency?: number | string;
  checkers?: readonly string[];
  allowEmpty?: boolean;
  dryRunOnly?: boolean;
  /** False when the consumer already emitted begin before external workspace preparation. */
  beginScope?: boolean;
  intervalMs?: number;
  onEstimate?: (estimate: EtaEstimate) => void;
  /** Numeric events include Rust-measured durationMs; useful for consumer-owned IPC. */
  onEvent?: (event: EtaEvent & { atMs: number }) => void;
  write?: (line: string) => void;
}): Reporter & { dispose(): void };
export const strykerPlugins: Plugin<PluginKind.Reporter>[];

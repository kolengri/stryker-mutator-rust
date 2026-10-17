import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadNative } from './native.js';
import { MutantRunStatus } from '@stryker-mutator/api/test-runner';

export const bunCoveragePreload = fileURLToPath(new URL('./bun-execution-preload.js', import.meta.url));
const qualifiedMode = 'independent-files-bun-sync-v1';
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** One runner instance, one frozen sandbox, serialized fresh-process runs.
 * The consumer explicitly qualifies independent test-file semantics and a frozen
 * dependency/configuration closure; this helper cannot infer those properties.
 */
export class BunFileCoverageSession {
  constructor({ files = [], identityFiles = [], qualification, env = {}, collectionBudgetMs = 60_000 } = {}) {
    this.env = { ...env };
    delete this.env.STRYKER_RUST_FILE_COVERAGE;
    this.files = files;
    this.identityFiles = identityFiles;
    this.qualification = qualification;
    this.collectionBudgetMs = collectionBudgetMs;
    this.stats = { nativeSelections: 0, selectedPlans: 0, fullSuiteFallbacks: 0, collectedFiles: 0, participants: 0 };
    this.reason = 'Coverage not collected';
  }

  invalidate(reason) { this.index = undefined; this.reason = reason; this.generation = (this.generation ?? 0) + 1; }

  async collect(runInactiveFile, exhaustiveBaseline) {
    if (this.collecting) { this.invalidate('Concurrent coverage collection'); return; }
    if (this.attempted) return;
    this.attempted = true;
    if (this.qualification !== qualifiedMode) { this.invalidate('File isolation/boundaries are unqualified'); return; }
    if (exhaustiveBaseline?.status !== MutantRunStatus.Survived) { this.invalidate('Exhaustive inactive baseline failed'); return; }
    if (!Number.isSafeInteger(this.collectionBudgetMs) || this.collectionBudgetMs < 1 || this.collectionBudgetMs > 300_000) {
      this.invalidate('Invalid coverage collection budget'); return;
    }
    this.collecting = true;
    const deadline = performance.now() + this.collectionBudgetMs;
    const generation = this.generation ?? 0;
    let directory;
    try {
      this.cwd = realpathSync(process.cwd());
      const canonical = (file) => {
        const absolute = resolve(file);
        if (!statSync(absolute).isFile() || realpathSync(absolute) !== absolute) throw new Error('Missing or aliased file identity');
        return absolute;
      };
      const files = this.files.map(canonical);
      this.coverageFiles = new Set(files);
      if (!files.length || new Set(files).size !== files.length || !this.identityFiles.length) throw new Error('Incomplete file identity set');
      this.identities = new Map([...files, ...this.identityFiles.map(canonical)].map((file) => [file, digest(file)]));
      const runs = [];
      for (const file of files) {
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs < 1) throw new Error('Coverage collection budget exhausted');
        directory = mkdtempSync(join(tmpdir(), 'stryker-rust-file-coverage-'));
        const session = randomUUID();
        this.env.STRYKER_RUST_FILE_COVERAGE = JSON.stringify({ directory, session, file, id: 'root', parent: null });
        const result = await runInactiveFile([file], remainingMs);
        delete this.env.STRYKER_RUST_FILE_COVERAGE;
        if (result?.status !== MutantRunStatus.Survived) throw new Error(`Inactive file baseline failed: ${result?.status ?? 'unknown'}`);
        if (performance.now() >= deadline) throw new Error('Coverage collection budget exhausted');
        const names = readdirSync(directory);
        if (names.length > 1024 || names.some((name) => !/^(root|[0-9a-f-]{36})\.ndjson$/.test(name))) throw new Error('Unsettled or excessive coverage receipts');
        const receipts = names.map((name) => {
          const path = join(directory, name);
          if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Coverage receipt exceeds 4 MiB');
          return readFileSync(path, 'utf8');
        });
        runs.push({ file, session, baseline: result?.status ?? 'Error', receipts });
        rmSync(directory, { recursive: true, force: true });
        directory = undefined;
      }
      if ((this.generation ?? 0) !== generation) throw new Error('Coverage collection was invalidated');
      const binding = loadNative();
      if (typeof binding.ExecutionCoverage !== 'function') throw new Error('Native file coverage API unavailable');
      this.index = new binding.ExecutionCoverage(JSON.stringify({ version: 1, qualified: true, files, runs }));
      const summary = JSON.parse(this.index.summary());
      this.reason = summary.reason;
      this.stats.collectedFiles = summary.files;
      this.stats.participants = summary.participants;
      if (!summary.complete) this.index = undefined;
      this.checkIdentity();
    } catch (error) { this.invalidate(error.message); }
    finally {
      delete this.env.STRYKER_RUST_FILE_COVERAGE;
      if (directory) rmSync(directory, { recursive: true, force: true });
      this.collecting = false;
    }
  }

  checkIdentity() {
    if (!this.index) return;
    try {
      if (realpathSync(process.cwd()) !== this.cwd || [...this.identities].some(([file, hash]) => realpathSync(file) !== file || digest(file) !== hash)) {
        this.invalidate('Frozen source/test/cwd identity changed');
      }
    } catch { this.invalidate('Frozen file identity missing'); }
  }

  select(mutantId, { staticMutation = false } = {}) {
    this.checkIdentity();
    let selection = { files: null, reason: this.reason };
    if (this.index) {
      this.stats.nativeSelections++;
      try {
        selection = JSON.parse(this.index.select(String(mutantId), staticMutation));
        if (!selection || typeof selection.reason !== 'string' || (selection.files !== null
          && (!Array.isArray(selection.files) || !selection.files.length || selection.files.length >= this.files.length
            || new Set(selection.files).size !== selection.files.length
            || selection.files.some((file) => !this.coverageFiles.has(file))))) throw new Error('Invalid native file selection');
      }
      catch (error) { this.invalidate(error.message); selection = { files: null, reason: this.reason }; }
    }
    if (selection.files) this.stats.selectedPlans++;
    else this.stats.fullSuiteFallbacks++;
    return { ...selection, files: selection.files ?? undefined };
  }
}

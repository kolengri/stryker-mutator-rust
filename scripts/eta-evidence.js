// Read only task-owned frozen receipts. Never inspect a live campaign.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = 'artifacts/eta-release/';
const frozenBytes = await readFile(`${root}dealyv-progress-snapshot.json`);
const frozen = JSON.parse(frozenBytes);
const receipts = JSON.parse(await readFile(`${root}fixture-receipts.json`, 'utf8'));
const comparisons = [];
for (const receipt of receipts.filter((r) => r.enabled === 'on')) {
  const snapshots = receipt.estimates;
  const planned = snapshots.find((s) => s.scopes[0]?.provenance?.plannedAtMs != null);
  const done = snapshots.find((s) => s.scopes[0]?.plannedJobs > 0 && s.scopes[0].completedJobs === s.scopes[0].plannedJobs);
  if (!planned || !done) continue;
  const planAt = planned.scopes[0].provenance.plannedAtMs;
  const points = snapshots.filter((s) => s.observedAtMs < done.observedAtMs && s.scopes[0].completedJobs > 0).map((s) => {
    const scope = s.scopes[0];
    const truth = done.observedAtMs - s.observedAtMs;
    // The fixture runs one identical selected test set for every mutant, so the
    // pinned Core 10 netTime ticks are equal. No such assumption for Dealyv.
    const tick = (s.observedAtMs - planAt) / scope.completedJobs * (scope.plannedJobs - scope.completedJobs);
    return { completed: scope.completedJobs, actualRemainingMs: truth, planEtaMs: s.remainingMs, elapsedTickEtaMs: tick,
      planAbsoluteErrorMs: s.remainingMs == null ? null : Math.abs(s.remainingMs - truth), elapsedTickAbsoluteErrorMs: Math.abs(tick - truth) };
  });
  comparisons.push({ mode: receipt.mode, runtime: receipt.runtime, coreStats: receipt.coreStats, inputSha256: receipt.inputs, jobs: planned.scopes[0].plannedJobs,
    initialPlanEtaMs: planned.remainingMs, initialElapsedTickEtaMs: null, points });
}
const report = {
  frozenSnapshot: { sha256: createHash('sha256').update(frozenBytes).digest('hex'), sourceHead: frozen.sourceHead, sourceDiffSha256: frozen.sourceDiffSha256,
    scopes: Object.keys(frozen.progressByWorkspace).length, sampledPoints: Object.values(frozen.progressByWorkspace).reduce((n, p) => n + p.length, 0), completedScopes: frozen.completedWorkspaceResults.length,
    limitation: 'Rounded displays and scope totals lack timestamped plans/baselines/job occupancy; no fair estimator replay or campaign-wide accuracy measurement.' },
  actualFixtureComparisons: comparisons,
  limitation: 'Tiny contract fixture, same-run observations, no independent held-out run. Errors are descriptive only; neither representative accuracy nor superiority is established.',
};
await writeFile(`${root}evidence.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ comparedRuns: comparisons.length, frozenPoints: report.frozenSnapshot.sampledPoints, heldOutRuns: 0 }));

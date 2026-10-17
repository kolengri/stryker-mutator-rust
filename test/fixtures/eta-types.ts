import { CampaignEta, createEtaIdentity, formatEta, type EtaEstimate } from 'stryker-mutator-rust';
import { createEtaReporter, strykerPlugins } from 'stryker-mutator-rust/eta-reporter';
import { runNativeMutationTest } from 'stryker-mutator-rust/native';
import type { Reporter } from '@stryker-mutator/api/report';

const identity = createEtaIdentity({ sources: 's', tests: 't', configuration: 'c', lockfile: 'l', runtime: 'r', engine: 'e' });
const campaign = new CampaignEta({ scopes: [{ id: 's', identity }] });
campaign.record({ type: 'begin', scopeId: 's' });
campaign.record({ type: 'plan', scopeId: 's', plan: { jobs: [{ id: 'a', baselineMs: 10, reload: false }], runners: 1, complete: true } });
const estimate: EtaEstimate = campaign.snapshot();
formatEta(estimate);
campaign.history().scopes[0]?.measuredAtUnixMs.toFixed();
const reporter: Reporter = createEtaReporter({ campaign, scopeId: 's', beginScope: false, onEvent(event) {
  event.atMs.toFixed();
  if (event.type === 'finish') event.durationMs?.toFixed();
} });
reporter.wrapUp?.();
strykerPlugins[0]?.name;
void runNativeMutationTest({}, { eta: { campaign, scopeId: 's', beginScope: false, onEstimate: (e) => { formatEta(e); } } });
// @ts-expect-error Event discriminators are part of the supported contract.
campaign.record({ type: 'progress', scopeId: 's' });
// @ts-expect-error Unknown is represented by null/absence, not strings.
campaign.record({ type: 'plan', scopeId: 's', plan: { runners: 1, jobs: [{ id: 'a', baselineMs: 'unknown' }] } });

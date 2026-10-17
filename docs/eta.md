# Advisory plan and campaign ETA

The opt-in ETA uses the actual runnable plan, measured inactive execution and
preparation, current runner occupancy, and a rolling window of completed wall
durations. Rust owns the model, state, history validation and schedule replay.
JavaScript forwards lifecycle events and formats the result. ETA never changes
selection, ordering, coverage, timeouts, retries, thresholds or baseline behavior.

## Existing Node and Bun compatibility runs

Add the reporter alongside existing plugins and reporters in your Stryker config:

```js
export default {
  // Keep your existing runner, plugins and all other execution options.
  plugins: ['@stryker-mutator/mocha-runner', 'stryker-mutator-rust/eta-reporter'],
  reporters: ['progress', 'json', 'rust-eta'],
};
```

For a Bun command runner, keep its existing command and `coverageAnalysis: 'off'`.
The reporter works when the compatibility coordinator itself runs under Node or
Bun. It does not infer execution coverage from imports or ordinary Bun coverage.

`rust-eta` starts with `ETA unknown`. After Core emits its normal dry-run and
post-incremental-diff plan, it reports a point and heuristic range. Missing
preparation, checker work, cold runner initialization or undisclosed work is
reported as partial, with the modeled portion and `total unknown`. Existing
reporters continue to receive their original events.

The optional lifecycle adapter verifies the installed **exact Core 10.0.0 method
sources** before wrapping the outer retry decorator. Starts and finishes measure
all retry, restart and reload time. Effective runners initially exclude checker
resources and expand only as workers initialize after checker release. It allows
one active ETA reporter per process. An incompatible seam fails when importing
the opt-in module; the default package entry does not load or patch this module.
The built-in plugin registers idempotent cleanup with its Stryker injector owner,
including failed baselines and other exceptional exits. Dispose a manually
created reporter with `dispose()` or `wrapUp()` when its run ends or fails.
Observer callback failures are isolated from their first invocation; invalid
configuration and campaign state still fail normally.

## Native coordinator

```sh
STRYKER_RUST_ETA=1 STRYKER_RUST_COORDINATOR_ENGINE=native stryker-rust run
```

Or use the native API. Observation is optional, and callback failures are returned
as `etaError` without changing the mutation results. Callbacks must be synchronous:

```js
import { CampaignEta, formatEta } from 'stryker-mutator-rust/eta';
import { runNativeMutationTest } from 'stryker-mutator-rust/native';

const campaign = new CampaignEta({ scopes: [{ id: 'backend' }] });
const result = await runNativeMutationTest({ cwd: process.cwd() }, {
  eta: {
    campaign, scopeId: 'backend', intervalMs: 1000,
    onEstimate: (estimate) => console.error(formatEta(estimate)),
  },
});
console.log(result.eta);
```

Native command and SDK paths feed Rust directly. The command baseline includes
process startup; SDK samples include full worker calls and recovery. Cold SDK
workers are unmeasured until initialized. The result includes the final campaign
snapshot. Failed, unsupported or cancelled runs retain their incomplete state;
they never export a successful completion for unexecuted jobs.

## A sequential multi-scope runner

Scope discovery belongs to the consumer. Declare **all** scopes before starting
the campaign; an undeclared scope cannot appear in any package's forecast. A
scope without an actual runnable plan stays unknown. A partial plan has
`complete: false`. This is useful immediately without repeating expensive dry
runs: consume each scope's normal preparation and planning events as it runs.
A complete initial campaign forecast requires explicit actual plans and matching
measured preparation costs for all pending scopes. History does not turn old
candidate counts into a current runnable plan.

```js
// campaign.mjs: shared by the runner and a local Stryker reporter plugin
import { CampaignEta, formatEta } from 'stryker-mutator-rust/eta';
export const campaign = new CampaignEta({
  scopes: [{ id: 'api', identity: apiIdentity }, { id: 'web', identity: webIdentity }],
  history: previousMetrics, // optional local JSON; incompatible data is ignored
});
export const onEstimate = (estimate) => console.error(formatEta(estimate));
```

```js
// eta-plugin.mjs: register alongside the runner's existing plugins
import { declareFactoryPlugin, PluginKind } from '@stryker-mutator/api/plugin';
import { createEtaReporter } from 'stryker-mutator-rust/eta-reporter';
import { campaign, onEstimate } from './campaign.mjs';

function reporter(options) {
  return createEtaReporter({
    campaign, scopeId: process.env.CURRENT_SCOPE, onEstimate,
    concurrency: options.concurrency, checkers: options.checkers,
    allowEmpty: options.allowEmpty, dryRunOnly: options.dryRunOnly,
  });
}
reporter.inject = ['options'];
export const strykerPlugins = [declareFactoryPlugin(PluginKind.Reporter, 'campaign-eta', reporter)];
```

Run scopes sequentially in the same coordinator process, updating `CURRENT_SCOPE`
before creating each Stryker instance, and append `campaign-eta` to the configured
reporters. For subprocess-based compatibility consumers, use the reporter's
`onEvent` callback to forward plain numeric events over consumer-owned IPC to one
parent-owned `CampaignEta`; do not share JS objects across processes. Each event
includes the Rust clock timestamp and finishes include measured `durationMs`.
Native
consumers pass the same campaign and current scope through `options.eta` instead.
Overlapping scope execution is deliberately outside this first model's contract.

For example, a child plugin can use `onEvent: (event) => process.send(event)`.
The parent declares all scopes and records `begin` before workspace preparation,
ignores the child's `begin`, and forwards other events with
`campaign.record({ ...event, atMs: undefined })`. This uses parent arrival time,
preserves measured job durations, and includes IPC delivery in observed setup;
it does not pretend that clocks in different processes have the same origin.
Consumers needing tighter start-time alignment can supply their measured clock
offset. The package creates no IPC channels or external messages itself.

If the consumer prepares a workspace before invoking Stryker, emit `begin` before
that preparation and pass `beginScope: false` to `createEtaReporter` or the native
`eta` option. This measures the consumer preparation too. Otherwise preparation
is measured from reporter construction (or native API attachment), so earlier
consumer/config-discovery work is outside that measurement. Represent unmeasured
remaining external work with `unmeasuredWork`; do not fill its cost with zero.

A custom scheduler can bypass reporters and send plain events:

```js
campaign.record({ type: 'begin', scopeId: 'api' }); // preparation starts
campaign.record({ type: 'plan', scopeId: 'api', plan: {
  runners: 2,
  baselineMs: 120,
  jobs: [
    { id: 'a', baselineMs: 120, timeoutMs: 1000 },
    { id: 'b', baselineMs: 30, timeoutMs: 1000, reload: true },
  ],
} });
campaign.record({ type: 'start', scopeId: 'api', jobId: 'a' });
campaign.record({ type: 'finish', scopeId: 'api', jobId: 'a', durationMs: 250, attempts: 2, timedOut: true });
// Send starts/finishes for every remaining job, capacity changes as they occur,
// and end only when the scope's work actually finishes.
```

Jobs are replayed in caller-supplied order. List only runnable work, after early
results and valid no-coverage decisions. An empty plan means zero runnable work;
an unavailable plan means unknown. `capacity` changes the currently effective
runner count, including zero for a pause; in-flight jobs still occupy resources.
Use `unmeasuredWork` on the plan/capacity event to preserve unknown setup/checker
work until it is measured or finished. `snapshot()` polls the live model without
requiring completions, so a long-running job does not disappear at its prediction.

## Matching history and privacy

There is no automatic disk cache, global service or telemetry. Explicitly persist
`campaign.history()` to a consumer-owned local file and supply it next time.
It contains version/model, generation time, scope IDs, opaque identity hashes,
preparation/baseline durations, measurement timestamps, and at most 32 numeric
execution samples per scope. Re-exporting untouched history preserves its age.
It contains no paths to tests, test source, mutation replacements or environment
values. Scopes without an explicit identity are omitted. Choose nonsecret IDs.

```js
import { createEtaIdentity } from 'stryker-mutator-rust/eta';
const identity = createEtaIdentity({
  sources: completeSourceDigest,
  tests: completeTestAndFixtureDigest,
  configuration: resolvedConfigAndCommandDigest,
  lockfile: lockfileDigest,
  runtime: runtimeVersionPlatformAndRelevantEnvironmentDigest,
  engine: rustCoreAndPluginVersionsAndExecutionModeDigest,
});
```

All six components must cover the **actual** inputs. Include dirty file contents,
test helpers, config imports, lockfiles, relevant environment, runner versions,
runtime, engine mode and timeout/retry/concurrency configuration. A Git commit
alone does not cover dirty or untracked inputs. The helper hashes the components;
it cannot verify that a caller included every input. Any component change changes
the identity. History with a different identity, version/model, future timestamp,
age over 30 days, malformed metrics or impossible numbers is ignored and its
reason appears under `provenance.history`. Explicit plans are still validated
strictly. For a pending scope, matching history supplies measured preparation cost,
but never supplies a runnable plan automatically.

## Model and limits

The model replays FIFO jobs over currently effective runner slots, including the
residual work of occupied workers. It scales the job's measured inactive cost
using a rolling window of up to 32 end-to-end observations, separately for reload
and warm jobs. Current-run observations replace matching older observations.
Timeouts and retries contribute their full observed wall cost. Before observations
exist, inactive cost provides the point and a broad heuristic range; timeout is a
horizon, never a hard upper bound. Right-censored running jobs use surviving
observations, or a positive residual horizon when they outlast every sample.
Checker failures retire jobs without training zero-duration runner samples.

`remainingMs` is null when declared work is incomplete or unmeasured.
`knownRemainingMs` describes only the modeled portion; it is not a guaranteed
lower bound. `range` is a heuristic spread, **not a confidence interval or deadline
guarantee**. The forecast excludes final reporting/teardown and undisclosed external
contention. A previously unseen failure mode or workload change can fall outside
the range. There is no measured real-project forecasting accuracy claim.

Deterministic schedule replays cover unequal jobs, running tails, capacity
changes, unknown/partial plans, retries/timeouts, pace changes and bad history.
Small actual fixture runs check Node/Bun public contracts and unchanged mutation
results with ETA on/off. They establish wiring, not representative forecasting
accuracy. The frozen Dealyv progress snapshot has rounded elapsed/remaining
displays and only three completed scope totals; it lacks timestamped job plans,
starts, baselines and finishes for a fair replay comparison. No campaign-wide
accuracy can be inferred from it. Future validation should capture these numeric
events with complete source identities and evaluate separate held-out runs.

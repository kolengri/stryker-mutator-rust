# Bun execution acceleration candidate

This opt-in candidate uses fresh Bun processes and the existing runner's supported
file filter. It adds no persistent test process and never reports `NoCoverage`.
The ordinary Node/Mocha runner paths do not use the file collector.

## Public seam

Import `BunFileCoverageSession` and `bunCoveragePreload` from
`stryker-mutator-rust/bun-execution`. Construct one session per runner instance,
pass its `env` object unchanged to `BunTestRunner`'s `bun.env`, and put
`['--preload', bunCoveragePreload]` before user `bunArgs`. Keep Core
`coverageAnalysis: 'off'` so incomplete upstream coverage cannot skip work.

After an **exhaustive** inactive full-suite result of `MutantRunStatus.Survived`,
call `session.collect(runInactiveFile, baselineResult)`. The callback runs the
provided files through the existing runner with no active mutant (`id: ''`), no
hit limit, `disableBail: true`, and a timeout bounded by the second callback argument (`remainingMs`).
The collection budget defaults to 60 seconds (maximum 300 seconds), across all
files. Budget exhaustion discards the entire proof and stops subsequent launches.
Its promise must
settle only after the process and output pipes close, including timeout or
cancellation cleanup. Call `select(id, { staticMutation })` for each actual mutant;
`files: undefined` means the full suite. The optional `staticMutation` flag means
a proven source classification. Core uses its global file filter in off mode when `testFiles` is configured;
activation can be runtime or static according to that filter. Neither lifecycle
value proves source coverage. The adapter recognizes an exact full-scope file
filter before narrowing it and preserves a narrower caller filter unchanged. The consumer relies on its complete journal instead. Preserve a selected-file inactive
baseline and full-suite retry on a failed selected-file baseline, as in the
Dealyv adapter. Actual mutant runs retain the existing runner's process isolation,
activation, output parsing, timeout, and result classification.

The consumer patches and executable qualification are under
`artifacts/bun-execution-acceleration/consumer/` and `fixture/`. They are parent
applied artifacts, outside the npm package. No Dealyv worktree is edited.

## Qualification is explicit

`qualification: 'independent-files-bun-sync-v1'` is an assertion of a bounded
execution contract, not something the helper can discover from imports or from a
passing baseline. Leave it unset unless all of these conditions are established:

- Test files have independent behavior when executed individually. Full-suite
  module caches, mocks, ordering, globals, and hooks do not create additional
  covering behavior that disappears in an isolated file. A passing isolated
  baseline alone does not prove this.
- The sandbox, configuration, dependency closure, runtime, and execution options
  remain frozen. Supply all relevant source/test/config files in `identityFiles`;
  their content and canonical identity are checked before selection. Dependency
  or configuration changes outside that list require explicit invalidation.
- Collection runs Bun **1.4.3**, after the known runner preload and before any
  user code. Other preloads/configuration that execute user code before the
  collector are unqualified.
- Every subprocess boundary uses the interposed JavaScript APIs. Cached originals
  from earlier preloads, native/FFI/system launchers, hidden realms, rewritten
  coverage globals/counter descriptors, API identity/reflection-dependent behavior,
  and boundary-guard bypasses are outside
  the contract. Detection is conservative, not a proof against arbitrary code.

Supported child execution is direct synchronous `Bun.spawnSync`: the current
Bun executable, optional `--no-env-file`, then either `-e`/`--eval` with one string
or one JS/TS module path. Both array/options and object forms are supported;
ordinary environment, cwd, and output options retain their behavior. Descendant
sync Bun processes use the same protocol recursively. Detached, IPC, onExit,
shell/CLI commands, other flags/executables, and explicit mutation activation in a
coverage child are unqualified. Async `Bun.spawn`, Node child-process APIs, and
both Web and Node Worker creation record an issue and keep the full suite.

Finite callback timers are tracked through firing or explicit cancellation.
Pending timers at EOF, intervals, promise-based timers, async timer callbacks, and
timer refresh, and `Bun.sleep` retain full-suite fallback. This matters because Bun test can exit
without waiting for an unawaited timer.

Children are conservatively **static**: coverage from a child never licenses
selective execution for that mutant. The child union matters because otherwise a
root-only map could select a root test while silently missing coverage in another
file's child. Dynamic root mutants without child/static hits can use a subset.
Workers do not yet have an admitted collection/completion protocol. Bun 1.4.3's
`syncBuiltinESMExports` does not replace every named builtin export; the collector
uses Bun's supported `mock.module` seam for guarded Node boundary modules so
named/default/CJS imports all record the fallback. Re-mocking boundary modules invalidates proof.

No Dealyv scope has been qualified by this package fixture. The saved consumer
patch keeps `QUALIFIED_COVERAGE_SCOPES` empty. The isolated adapter fixture admits
only its own independent files. Async/Worker and mixed stateful suites remain on
full-suite fallback pending separate integrated proof.

## Completion and fallback

Bun 1.4.3 `bun test` does not emit Node's `beforeExit`/`exit` events. The collector
therefore synchronously journals each novel positive coverage hit, without
changing the numerical counters or application output. This includes late timer
and cleanup hits through process EOF. Pending finite timer work at EOF invalidates
the journal rather than accepting a premature test summary. A child registration precedes launch; its
parent records completion only after `spawnSync` returns with settled output.
Rust validates all journal syntax, session/file identity, the complete ownership
tree, and successful child completions before admitting **any** selection.

A failed full or isolated baseline, missing/corrupt/truncated/extra journal,
unsettled child, signal/error/timeout/cancellation, unsupported boundary, unknown
phase/identity, changed source/test/cwd, absent native API, static mutation, no
positive hit, or every-file coverage keeps the full suite. Coverage evidence is
not cached across runner instances or campaigns. Collection directories are
removed after awaited completion; supported descendants share the runner's
process group and timeout/cancellation cleanup. Unqualified external launchers
retain their existing semantics; this helper does not promise to contain arbitrary
native or detached processes outside its contract.

## Companion consumer changes

The regex checker implements Stryker 10's public `group` hook, returning the
current buffer as one group. `check` and invalid-regex classification are unchanged.
Do not delete this checker: deferred invalid regex constructors would change
`CompileError` accounting.

`MUTATION_FIRST_FAILURE_BAIL=1` opts actual mutants into the runner's supported
bail option only for an explicitly admitted `QUALIFIED_BAIL_SCOPES` entry. Both
qualification sets are empty in the saved consumer patch. Full and selected
inactive baselines remain exhaustive. This policy
can reduce failing-test diagnostics and test counts; a first failure followed by
a later hang can become **Killed instead of Timeout**. The raw outcomes are
retained in the qualification artifact. This is an intentional policy difference,
not universal exact result or score equivalence. The Bun 1.4.3 witness also shows that bail skips the file
`afterAll`; a baseline-created cleanup marker must not be mistaken for mutant
cleanup. Suites requiring skipped hooks/teardown are unqualified and remain
exhaustive even when the env flag is set. No-hook suites or separately proven
external cleanup can be admitted under the stated policy. Every actual mutant
still uses a fresh process. Bail is disabled by default in the patch.

## Native Core admission

`lib/core-runtime.js` adds Bun 1.4.3-specific function fingerprints for the same
published Core 10.0.0 seam. All three installed source files must also match their
pinned SHA-256 values. Existing constructor, function, prototype, injection,
descriptor, sandbox mapping, and replacement guards remain in place. Node keeps
its original fingerprints. Unknown Bun versions or changed sources fall back
(or throw in forced-native mode). This admission is independent of instrumentation
whole-batch support; no instrumentation syntax or safety guard changed.

## Evidence and remaining acceptance

Run the focused Rust `execution_coverage` tests and the Node tests
`bun-execution`, `bun-core-admission`, `native-core`, and `native-core-modes` with
one runner at a time. The saved copied-runner fixture exercises the exact consumer
patch with only its qualification set changed to admit `fixture`; it preserves
both raw full-suite and candidate results, including `nrOfTests` differences.
All production acceptance, independent review, CPU-idle integrated validation,
and publication belong to the primary agent. No real-project speedup has been
measured. Per-runner collection and synchronous journaling have preparation costs;
selection and bail benefits are expected, not measured end-to-end gains.

Primary API reference: [Bun module mocks](https://bun.sh/docs/test/mocks).
Installed runner/Core sources and runtime-specific fingerprints are preserved in
the local evidence manifest; external documentation does not replace those probes.

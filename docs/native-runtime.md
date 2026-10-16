# Native runtime contract

The target runtime owns the mutation run in Rust. Node is an adapter for executable
JavaScript configuration, existing plugin interfaces, and JavaScript test tools.
It must not delegate scheduling to `Stryker.runMutationTest`, `Pool`, or upstream
process executors. The existing runner remains a migration oracle until the native
runtime has equivalent coverage; it is not evidence of a native coordinator.

Rust owns configuration discovery, option merge/defaults/validation, file selection,
instrumentation, sandbox files, caches, coverage indexing, test planning, bounded
process scheduling, deadlines, retries, cancellation, incremental selection, and
report assembly. Existing native instrumentation/coverage/planning modules are reused.
The Node adapter owns only operations requiring JavaScript execution or plugin objects.
Built-in command tests are spawned directly by Rust; there is no Node pool around them.
Bun is the primary new execution target through this command path; see the
[Bun contract](bun.md). Mocha and Vitest are compatibility adapters for existing
projects, sharing one Rust SDK coordinator.

Upstream defects and unnecessary work may be corrected. A correction must identify
the original behavior, intended behavior, and a regression oracle. Preserve public
configuration/plugin interfaces, mutation records, test outcomes, hook behavior,
isolation, timeouts, and cleanup. Do not promise a speed ratio before measuring the
same complete useful work. Performance modes with additional assumptions must say so.

## Addon entry

The existing precompiled Node-API distribution is retained. The public wrapper
uses an opaque, single-use `NativePreparation`: Rust discovers configuration
synchronously, the original caller imports executable files when requested, and
Rust performs option merge, defaults and validation before background execution.
The adapter applies ordered Rust-authored effects to retained caller records.
JSON preparation does not load the executable compatibility SDK graph.
The direct addon `runNativeMutationTest(requestJson, cancellationId?)` remains
available for JSON-only callers. No second native distribution format is introduced.
See the [bounded caller configuration contract](native-caller-config.md) for
import, identity, error, concurrency and cancellation semantics.

The public `stryker-mutator-rust/native` entry accepts `{cwd, args, overrides}` and
an optional second `{signal}` argument. It supplies the Node executable and adapter
path and snapshots the actual caller environment after compatibility effects.
Rust applies that per-run context to command and compatibility-worker spawns.
`cancelNativeRun(cancellationId)` signals Rust; the original promise settles
only after cleanup. Pre-aborted signals create no native work.
Confirmed cancellation uses the native `Cancelled` error code; the public wrapper
then rejects with the signal's reason. Cleanup failures retain their own errors.

During the migration, `STRYKER_RUST_COORDINATOR_ENGINE=native stryker-rust run`
selects the native coordinator explicitly. Unsupported preflight exits with code 2
and never silently runs the upstream coordinator. The default legacy entry remains
available as the comparison oracle until native configuration coverage is complete.

The first request shape is:

```json
{
  "version": 1,
  "cwd": "/absolute/project",
  "args": [],
  "overrides": {},
  "nodeExecutable": "/absolute/node",
  "bridgeModule": "/absolute/package/lib/compat/worker.js"
}
```

`args` are the arguments after `run`; Rust interprets them. `overrides` are the
programmatic Stryker options and take precedence over the configuration file.
The Node fields are needed only for JavaScript compatibility operations.
Unsupported execution features must be identified before commands, sandboxes or
report writes. Required caller-config import, merge and validation effects follow
the pinned contract even when a later preflight rejects execution. No native proof
may contain a hidden upstream coordinator fallback.

A successful response contains `version: 1`, `supported: true`, `exitCode`,
`mutants`, a full report when requested, and `stats.coordinator: "rust"`.
When Mocha discovers no tests and `allowEmpty` is true, the run returns an empty
mutant list without report generation or threshold evaluation, matching upstream.
An unsupported preflight response has `supported: false` and `reason`.
Operational errors after starting a run are errors, not unsupported preflight.
All started children must be reaped and owned sandbox files cleaned according to
the configured cleanup policy on completion, failure, timeout, and cancellation.

The current vertical slice supports JSON and a bounded plain-data executable
configuration handshake, the built-in `command` runner with coverage off, and
the explicitly selected pinned 10.0.0 Mocha or Vitest SDK plugin with coverage
collection. Rust discovers and instruments selected files, preprocesses its
supported JSONC tsconfig subset, creates isolated persistent worker sandboxes,
runs baseline and mutants, indexes coverage, plans tests and assembles the full
JSON report. The selected framework executes in Node through its actual SDK plugin.
Checker plugins, arbitrary executable object graphs and other reporters are not
yet wired into this coordinator. Unsupported syntax and options are rejected explicitly;
the existing legacy entry remains available independently.

SDK runner admission requires exactly one corresponding plugin module in
`plugins`; default/wildcard discovery, extra plugins, checkers, custom Node
arguments, build/incremental/in-place execution and arbitrary caller object
graphs remain unsupported. Vitest acceptance uses `@stryker-mutator/vitest-runner`
10.0.0 with Vitest 4.1.12. This does not establish arbitrary third-party runner
support or a performance result. CLI defaults and the direct Bun command path
are unchanged.

The SDK dry run receives only selected mutation input files, including selected
files without mutants, as sandbox paths in `files`. A nonempty ordered explicit
test selection is forwarded as sandbox paths in `testFiles`, both at runner
initialization (needed by Mocha) and in `dryRun` (needed by Vitest). Test IDs remain
opaque throughout native coverage/planning and are mapped to numeric report IDs
using the baseline test index. The plugin owns interpretation of its test filters.

For explicit Vitest selections, all-selected-test plans also pass the opaque
selected baseline IDs to `mutantRun`; init/dry-run file selection alone does not
constrain Vitest's later discovery. Covered plans retain their coverage filter,
and runs without an explicit resolved file selection retain the plugin's
unfiltered behavior. Supplying these IDs does not change static activation or
reload decisions. This intentionally corrects pinned core 10.0.0's filename-based
global filter, which activates static mutants at runtime and can report them as
survivors. The SDK regression exercises selected and unselected tests importing
the same source with coverage off/perTest and Vitest related mode on/off.

`node scripts/native-runtime-integration.js vitest` compares complete upstream CLI
and native JSON reports, canonicalizing only outer mutant completion order. The
smoke requires native instrumentation, coverage and planning diagnostics, killed,
uncovered and static mutants, preserved sources, sandbox cleanup, and a guard
against upstream coordinator imports. Existing `command` and `mocha` cases remain.

### Windows candidate boundary

Windows uses a retained, owned Job Object for each command or compatibility worker.
The root is created suspended, assigned before user code resumes, then cleanup
terminates the job, reaps the root and waits for zero active job members and
signaled retained member process handles before bounded pipe drains. A private
completion port is associated before assignment; observed process notifications
must reconcile with the job's lifetime process count. Missing coverage produces
a bounded cleanup error. Accounting alone is not a process completion barrier.
Cancellation cannot hide a cleanup failure. POSIX retains
its existing process groups and post-reap termination retry.

Project and sandbox cwd must safely normalize to ordinary absolute drive paths;
paths still requiring verbatim, device or UNC cwd identities fail explicitly.
TSConfig preprocessing supports native Windows separators and safely simplified
absolute drives; ambiguous case aliases and drive-relative forms are rejected.
Different-drive external paths remain absolute. Report source/test keys use `/`.
Generated output filesystem paths become literal, root-anchored project-name rules;
internal absolute outputs are excluded without treating drive separators as glob
syntax. External outputs do not match project inputs, and explicit ordered
ignore reinclusion remains effective.

Dependency junctions are owned individually. Cleanup detaches each reparse point
and removes only its owned empty directory before recursive sandbox removal.
Either failure blocks recursion and retains the completed stage for retry;
original dependency targets must survive. Included project reparse entries other
than deliberately handled node_modules dependencies, and report reparse ancestors,
are rejected. The junction library's administrative helper feature is disabled.

This candidate requires real Windows default-feature builds, process/bridge/project
tests, public cancellation, command/Mocha complete-report parity and packed-consumer
smoke on the matrix. A feature-scoped cross-target typecheck is only compile evidence.

Two upstream defects are corrected intentionally: selected test filenames are
used to select Mocha files rather than incorrectly becoming title filters, and
dependency disposal continues after individual cleanup failures without disposing
aliased provider objects twice. Compatibility checks preserve the intended test
selection and lifecycle contracts, with separate regressions for those fixes.

## JavaScript worker protocol

Each worker has one Rust owner and a dedicated loopback TCP connection. User stdout
and stderr remain separate streams; arbitrary test output must not corrupt control
frames. Rust chooses an ephemeral address and a random per-worker token, passed in
`STRYKER_RUST_BRIDGE_ADDRESS` and `STRYKER_RUST_BRIDGE_TOKEN`; tokens are never logged
or included in reports. The Node script connects and sends a newline-delimited JSON
hello before accepting work:

```json
{"version":1,"event":"hello","params":{"token":"opaque","pid":123}}
```

Subsequent frames are newline-delimited JSON. A request is:

```json
{"version":1,"id":1,"method":"initialize","params":{}}
```

The reply has the same ID and either `result` or `error`, never both. Errors contain
`name`, `message`, and `stack` when available, retaining thrown JavaScript details.
Aggregate errors may additionally include nested `errors`; bounded serialization
uses explicit markers for cycles or truncation.
IDs are positive safe integers, unique among outstanding requests. Invalid frames,
duplicate outstanding IDs, calls before initialization, unknown methods, and calls
after disposal have explicit error responses without executing plugin work.

Before validation, `prepare` receives `{cwd, modules}` and returns resolved module
metadata, schema contributions, the installed core schema, and SDK version without
constructing a plugin. Rust applies defaults and validates the configuration.
A metadata worker may be retired before actual workers start in their sandboxes;
executable module objects remain local to their corresponding JavaScript worker.

`initialize` receives `cwd`, `options`, `fileDescriptions`, resolved `modules`, and
`plugin: {kind, name}`. Kind is an existing Stryker SDK plugin kind. The worker
imports modules, retains executable plugin objects locally, supplies the existing
`commonTokens`/typed-inject context, and selects the requested plugin. It returns
loaded module metadata and schema contributions; functions are never stringified
and re-evaluated. Module resolution and custom loader behavior remain JavaScript
compatibility responsibilities.

For a test runner, methods are `runner.init`, `runner.capabilities`, `runner.dryRun`,
`runner.mutantRun`, and `dispose`. Run-option and result payloads follow the installed
StrykerJS 10.0.0 SDK. For a checker, methods are `checker.init`, `checker.group`,
`checker.check`, and `dispose`; `checker.group` and `checker.check` receive the SDK
mutant array directly as `params`. Reporter
and executable-config operations can extend this method set without replacing the
request envelope. Unimplemented methods must fail explicitly.

Calls on one plugin instance execute in order. Rust schedules across workers and
owns timeout, restart, retry, and cancellation policy. The adapter must not create
its own test pool, coverage planner, or sandbox. Dispose is idempotent and each
plugin/dependency is disposed once; connection loss also initiates cleanup. A hung
plugin is terminated by the Rust owner rather than blocking cancellation forever.
The pinned SDK adapter deduplicates provider ownership and continues ancestor
cleanup after a dependency rejects. It preserves plugin identity, marks injector
contexts disposed before callbacks, retains child-before-parent ordering and
parallel independent branches, and returns cleanup failures explicitly.

Structured logs use event frames with `event: "log"`; user output remains on the
normal process streams. Native diagnostics distinguish actual Rust coordination,
instrumentation, compatibility calls, worker starts/restarts, and fallback reasons.

## Acceptance

- Compare complete ordered upstream mutant records and actual outcomes. Full JSON
  reports may canonicalize asynchronous outer mutant completion order only.
- Compare hooks, retries, async completion, pending tests, bail, coverage/hit limits,
  static activation, duplicate IDs/titles, errors, deadlines, and cleanup where used.
- Native command fixtures must run without importing the upstream core in a Node
  coordinator. Node-adapter tests must prove runner initialization does not load the
  upstream CLI or process executor graph.
- Measure full CLI startup through report completion and child disposal, with the
  same fixture, mutants, tests, concurrency, and cache state. Report cold and warm
  behavior separately; do not turn an instrumentation ratio into a full-run claim.
- Preserve selected Dealyv scope; do not run its whole platform test suite.

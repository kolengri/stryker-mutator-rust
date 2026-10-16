# Bun whole-suite union: completeness blocker

No Bun coverage optimization is installed by this change. The existing Rust
command runner continues to execute every runnable mutant; its configuration,
Mocha compatibility, instrumentation policy, planner and reports are unchanged.
There is no new `testRunner: "bun"` option and no production `NoCoverage` decision.

The investigation found a failing prerequisite for trusting absent mutation IDs:
the existing native counters are local to each JavaScript global. A completed
main-realm collector, successful process exit and reconciled passing JUnit do
not establish a complete union. This is a concrete counterexample to the proposed
snapshot protocol, not proof that a Bun runner is impossible.

## Reproduce

Build this checkout's addon, then run the investigation tool on POSIX:

```sh
npm ci --ignore-scripts
npm run build
BUN_BIN=/absolute/path/to/bun node scripts/bun-union-proof.js
```

Without `BUN_BIN`, the tool resolves Bun from `PATH`. It requires revision
`1.4.3+c6da4a4d3`, corresponding to published source commit
`c6da4a4d3010e5553438c60f6bd76d981976867c`. It creates a fresh directory below
`artifacts/native-runtime/bun-union/probes/` for each invocation. Set
`STRYKER_RUST_BUN_ARTIFACTS` to another subdirectory of
`artifacts/native-runtime/bun-union/` if needed. No source project is modified.

The tool is evidence collection, not an alternative coordinator. Node loads the
native instrumenter and invokes Bun serially with owned argv; the final mutation
run uses the existing Rust command coordinator through an owned Node subprocess.
Both arms start from the same environment copy: HOME/XDG point at the owned probe
configuration directory, and inherited Node/Bun options, inspector preload, drain
mode and active mutation selection are removed. The subprocess records its
observed controlled variables; its argv, stdout/stderr, request and result remain
in the run directory. The parent never mutates `process.env`.
The deliberately incomplete
collector is generated inside the artifacts directory and never selects mutants.
Its versioned payload and invalidation control use separate files, not user
stdout/stderr. It does not set `currentTestId` or claim per-test/static coverage.
Python's standard-library ElementTree parses JUnit; no XML parser or new runtime
dependency is added to the product. XML validity is reported separately from
suite completion.

## Observed counterexamples

The source `function answer() { return 20 + 22; }` produces two native mutations.

- A normal test calls `answer()`. The root collector contains both mutation IDs.
- A VM test evaluates the same native-instrumented source with
  `node:vm.runInNewContext`, then calls `answer()`. Exit is zero, the complete
  JUnit document has one passing testcase and no failure/error elements, the
  collector completion marker exists, and the root union is empty. The context's
  own counters contain both IDs. The context is given `process.env` so active
  mutation selection works during fresh mutant executions.
- The same test, with the original source passed through the existing Rust
  command coordinator, produces **2 Killed, 3 command starts, 0 compatibility
  calls**. Treating the empty root union as uncovered would skip both killed
  mutations. This remains unsafe even if an exit-listener sentinel is present:
  default Bun does not execute that sentinel.
- A `node:worker_threads` Worker imports the same instrumented module and returns
  its result/counters. The parent JUnit passes and root collection completes, but
  the root union is empty while the Worker's counters contain both IDs.

VM and Worker diagnostic reads use optional access with an empty-object fallback
when a mutant executes no coverage calls. The proof requires both execute-all
VM kills to reach the business assertion: expected 42, received `undefined` for
BlockStatement and `-2` for ArithmeticOperator, with no diagnostic TypeError.
A focused active BlockStatement Worker probe also reaches its expected-42
assertion with empty diagnostic counts. Earlier receipts from the initial proof
are preserved; their VM BlockStatement kill could originate from the unguarded
diagnostic read and does not establish this stronger assertion-failure evidence.

These cases use the existing native header without changing mutation selection
or rebuilding Bun. The namespace is initialized from the current global in
[`src/instrument.rs`](../src/instrument.rs); a root snapshot cannot observe the
other globals. VM contexts also lack `require`, `process` and `Bun` by default,
so simply injecting an unconditional filesystem-backed `require` into every
instrumented module would change their execution semantics.

## Lifecycle evidence

The tool retains 19 actual Bun probe runs, their argv, stdout/stderr, payload/control
files, raw JUnit and machine-readable assertions:

- Unused code has an empty payload; ordinary execution covers both IDs. Skipped
  tests remain selected and appear in JUnit accounting.
- A user `--preload` global `afterAll` registered before the collector executes
  first, and its function call is included in the union.
- A textual `--import user --preload collector` runs the import preload after
  the collector preload. The user's global `afterAll` then executes after the
  collector, producing an empty snapshot despite executed mutations.
- Default Bun skips both a user exit listener and an owned prepended sentinel.
  Importing `node:test` or setting `BUN_TEST_DRAIN_EVENT_LOOP=1` executes the
  sentinel and late instrumented code, correctly producing an invalidation file.
- A user exit listener sets code 7 with and without the sentinel; both runs
  retain code 7. Removing exit listeners during a test does not suppress the
  sentinel registered later by the collector.
- A later `--import` teardown can remove all exit listeners, including the
  sentinel, then install a listener that executes mutations. With `node:test`,
  exit is zero, JUnit passes, the collector is complete, and no invalidation file
  exists. This demonstrates why unknown preload ordering must disable coverage;
  it does not establish a failure when the collector is proven last.
- `process.exit(0)` in file evaluation, `beforeAll`, or a test yields exit zero
  but neither the fresh owned JUnit file nor the collector payload.
- Bail produces partial, well-formed JUnit with one testcase out of two and exit
  one. The collector does not complete.
- An unhandled rejection after a passing test yields exit one with valid JUnit
  containing one passing testcase and zero failure/error elements. The collector
  completes; exit status must still invalidate optimization.

## Exact-source constraints

The following links are pinned to the installed Bun revision, not rolling docs:

- [`Arguments.rs`, preload assembly](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/Arguments.rs#L1062):
  config preloads, then all `--preload` entries, all `--require` entries, all
  `--import` entries, then `BUN_INSPECT_PRELOAD`. Textual alias order is not
  execution order.
- [`bunfig` loading](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bunfig/arguments.rs#L30)
  and [preload replacement](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bunfig/bunfig.rs#L246)
  introduce configuration and home/XDG state that an eligibility check must own
  or reject.
- [`bun_test.rs`, final-file hooks](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/test_runner/bun_test.rs#L1070)
  and [`Order.rs`, registration order](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/test_runner/Order.rs#L44)
  explain why a last registered preload collector can include preceding global
  teardown, and why the alias case loses coverage.
- [`test_command.rs`, exit policy](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/test_command.rs#L932)
  derives draining/listener policy from the drain flag and node-test usage, not
  the existence of the sentinel. Registering this sentinel does not enable drain.
- [`test_command.rs`, final JUnit and exit](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/test_command.rs#L2669)
  writes JUnit before exit determination/listener execution. The
  [bail writer](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/test_command.rs#L2958)
  writes partial XML. Neither XML validity nor absence of error elements proves
  complete successful execution.
- [`events.ts`, listener removal](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/js/node/events.ts#L507)
  permits ordinary listener removal; an owned sentinel must not be assumed
  permanent.

## Required next decision

Before implementing negative coverage, establish a source-backed transport or
invalidation mechanism that observes **every** execution of instrumented code in
another realm/process without changing test behavior. Aggregation must finish
before Rust trusts absence; an unobserved realm must force Rust execute-all.
The VM and Worker probes above are acceptance tests for that mechanism.

Once that is proven, a bounded builtin Bun runner can own argv, explicit
preloads, a pinned revision check, fresh per-run JUnit/payload/control paths and
strict Rust validation. Unknown configuration/preload order, watch/repeat/shard/
parallel/isolation modes, unsupported versions, late exit execution, malformed
payloads, count mismatches, missing completion, timeout or cancellation must
execute all mutants or abort the baseline according to the existing lifecycle.
This investigation does not implement those gates or claim their regression
coverage. No new runtime option is partially exposed.

An approved union must be stored as whole-suite union, independent of the
instrumenter's internal `static` field. Covered runtime and module-initializer
mutations must still execute the complete suite in fresh processes, without
per-test filtering or hit limits. Unused mutations may then become `NoCoverage`
instead of coverage-off `Survived`; reports across those modes intentionally
differ and must not be described as fully equal. Performance remains unmeasured
for this proposed capability.

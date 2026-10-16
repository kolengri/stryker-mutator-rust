# Bun execution contract

Bun is the primary test runtime for new fixtures and performance investigations.
The Rust command coordinator executes existing `bun:test` suites directly. No
Mocha adapter, Node test-runner worker or test-source conversion is involved.
Existing Mocha projects keep their compatibility adapter.

## Configuration

Use the existing Stryker command-runner contract:

```json
{
  "testRunner": "command",
  "plugins": [],
  "coverageAnalysis": "off",
  "mutate": ["src/**/*.js", "src/**/*.ts"],
  "commandRunner": {
    "command": "bun --no-env-file test ./test"
  },
  "reporters": ["json"],
  "cleanTempDir": "always"
}
```

```sh
STRYKER_RUST_COORDINATOR_ENGINE=native npx stryker-rust run
```

The CLI currently uses Node to load its precompiled Rust addon. Rust performs
configuration preparation, project selection, instrumentation, sandbox creation,
baseline execution, mutation planning, concurrent process scheduling, cancellation
and reporting. It spawns the Bun command directly through the configured command
shell. The command path has zero SDK compatibility calls.

The same native CLI also passes a bounded JSON-command fixture when started with
Bun itself, without production CLI changes:

```sh
STRYKER_RUST_COORDINATOR_ENGINE=native bun --no-env-file ./node_modules/stryker-mutator-rust/bin/stryker-rust.js run
```

This Bun bootstrap probe does not establish compatibility for executable configs
or Node SDK plugins. Keep the Node entry for those tool contracts.

Install Bun separately. Validation uses Bun 1.4.3; the package does not download or
replace the consumer's runtime. Prefix explicit test paths with `./` so Bun treats
them as paths rather than name filters. `--no-env-file` keeps fixture runs from
implicitly loading local environment files; projects can deliberately configure
their own environment loading.

## Isolation and current limits

One fresh Bun process executes the baseline. Each runnable mutant then gets a new
process with its active mutation selected before module evaluation. Rust limits
the number of simultaneous commands with `concurrency`; leave Bun's internal
parallel execution off when measuring that bound. Existing process containment,
deadlines, complete pipe draining and sandbox cleanup apply.

This is the coverage-off command-runner abstraction: the report has one synthetic
`All tests` test, and unused mutations are executed rather than classified as
`NoCoverage`. Test-to-mutant coverage, hit-limit classification, individual test
selection and persistent Bun workers require an additional protocol. Bun's LCOV
and JUnit outputs alone do not supply mutation-to-test associations. No supported
fresh-module persistent rerun API has been established for this integration.

The existing native syntax/configuration/reporting limits still apply. Unsupported
native input is explicit and never silently invokes the upstream coordinator.
Bun's Jest-like API does not establish transparent compatibility with every
Mocha/Jest/Vitest project.

## Verification

```sh
npm run test:bun
```

The JS and TS fixtures use explicit `bun:test` imports. The harness executes the
same Bun command with upstream Stryker's command runner and the Rust coordinator,
retains raw reports/logs, compares mutation records and outcomes, checks native
execution receipts and confirms original sources and sandbox cleanup.
It resolves Bun from `PATH`, or accepts an absolute `BUN_BIN` override, and checks
the pinned validation version and executable hash. CI is configured to run both fixtures on its
existing Linux x64 GNU job. Other platform jobs retain the Node compatibility
checks; they do not establish Bun runtime acceptance.

Bun diagnostics contain elapsed times and independently named sandbox paths.
Comparisons retain every report field, including failure reasons, with narrowly
declared normalization of those volatile details. An upstream-only evidence tap
also corrects the pinned command runner's extra stream-chunk newlines and output
lost when it resolves at process exit before stdio drains. Each raw failure reason
must exactly match the captured exit prefix; the replacement comes from that same
upstream command's complete stdout/stderr chunks, with matching process status and
observed EOF and close on both streams. Incomplete evidence fails the comparison.
The tap preserves upstream results, callbacks and installed source. Raw reports
and captures remain available. Assertion values, test names and test-source
frames remain significant. A normalized comparison is not byte-identical output.

Functional fixture runs establish compatibility, not speed. Whole-run comparisons
must use the same Bun command, source, tests, mutation selection and concurrency,
with balanced repeated samples and no competing local builds or test runs.

References: [Bun test runner](https://bun.com/docs/test),
[lifecycle hooks](https://bun.com/docs/test/lifecycle), and
[test reporters](https://bun.com/docs/test/reporters).

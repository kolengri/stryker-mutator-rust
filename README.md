# Stryker Mutator Rust

A **preview** Rust-backed runner for StrykerJS 10.0.0, distributed as a precompiled
Node-API addon. Existing Stryker configuration, test runners, reporters, coverage
analysis and incremental behavior remain provided by the pinned StrykerJS core.

**This is not a completed Rust rewrite.** Native instrumentation currently supports
a conservative JavaScript subset. An unsupported batch is delegated in full to
StrykerJS rather than silently losing mutations. TypeScript, JSX, frameworks,
complex expressions and arbitrary Babel plugins still use the compatibility path.
The planner, sandbox and test-runner orchestration have not been ported to Rust.

## Build and install

Development needs Node.js `^22.18.0 || >=24.11.0` and Rust 1.97 or newer. The tested
local environment is macOS arm64, Rust 1.99 and Node 26.10. Build a release addon
and create an installable tarball:

```sh
npm ci
npm run build
npm run pack:local
```

The archive is written under `artifacts/package/local/`. It contains the compiled
addon and is restricted to the build host's OS, CPU and libc. Consumers install
that archive normally; they need neither Cargo nor Rust nor install scripts:

```sh
npm install --save-dev /absolute/path/stryker-mutator-rust-0.1.0.tgz
npx stryker-rust run
```

Keep the runner plugin already used by the target project installed, for example
`@stryker-mutator/mocha-runner@10.0.0`. This package does not replace its test
framework. No npm release has been published.

## CLI and API

All upstream commands and flags are forwarded, including config files, `init`,
`serve`, `--coverageAnalysis`, `--concurrency` and `--incremental`.

```sh
npx stryker-rust --rust-info
npx stryker-rust run stryker.config.json
npx stryker-rust run --rust-no-cache
STRYKER_RUST_DIAGNOSTICS=1 npx stryker-rust run
```

`--version` reports the embedded StrykerJS version. `--rust-info` reports native
binding availability and target. `STRYKER_RUST_ENGINE` selects `auto` (default,
with atomic fallback), `upstream`, or `native` (reject unsupported batches; useful
for verifying that a test actually exercises Rust).

```js
import { Stryker, nativeStatus } from 'stryker-mutator-rust';

console.log(nativeStatus());
const stryker = new Stryker({ configFile: 'stryker.config.json' }, {
  engine: 'auto',
  cache: true,
});
await stryker.runMutationTest();
```

`installAcceleration(options)` installs the process-wide instrumenter hook; its
first call owns the settings for subsequent instances. `createInstrumenter(logger,
options)` creates an isolated instrumenter without a global hook. Importing the
package alone does not install the hook.

`analyze(source, fileName)` is a broader **experimental candidate preview**. Its
UTF-16, zero-based, end-exclusive offsets can be used with JavaScript `slice`.
It always reports `supported: false`: it is neither the production instrumenter
nor a proof of full mutation parity.

## Native boundary and compatibility

The accepted native grammar includes ordinary JS named function declarations,
simple parameters/bindings, variable declarations, concise/block arrows,
return/if/block/expression statements, plain imports/named exports and pure
arithmetic, comparisons, equality, boolean, logical, unary and conditional
expressions. Mutation records, IDs, locations, exclusions and runtime coverage
follow the pinned Stryker contract. Calls, members, strings/templates, regex,
collections, assignments/updates, loops, classes, async/generators, comments,
directives, mutation ranges, noncanonical number spellings and other unsupported
constructs trigger whole-batch fallback. See `src/instrument.rs` for the definitive
acceptance checks. The native engine does not claim the broader preview's scope.

Node stays responsible for running existing JavaScript tests and plugins. Custom
ignore plugins receive real Babel `NodePath` objects in Stryker; an ordinary JSON
AST cannot preserve this API. Configurations with external Babel configuration or
custom ignorers are therefore processed by the original engine.

The integration hook modifies the pinned `Instrumenter.prototype.instrument`.
Upstream does not offer an instrumenter plugin API. This is an explicit version
boundary: upgrades require re-running the compatibility harness, not widening a
semver range. A separately installed, different Stryker core is not patched.

## Instrumentation cache

The optional cache stores **instrumented files and mutant metadata, never test
outcomes**. It uses Rust BLAKE3 keys, lossless V8 payload serialization, integrity
checks, atomic writes, a 64 MiB entry limit and a best-effort 256 MiB directory
limit. Source, file order, paths, mutation selection/options, backend mode,
implementation/runtime versions, working directory and relevant environment
participate in the key. Test changes still cause tests to run.

The default directory is `node_modules/.cache/stryker-rust`, outside sandbox input.
Use `STRYKER_RUST_CACHE_DIR` to move it or `STRYKER_RUST_CACHE=0` to disable it.
Caches bypass custom ignorers, framework parsers and ambient Babel configurations;
cache I/O failures fall back to normal execution. Clear development caches after
rebuilding an unpublished native binary without changing the package version.

Instrumentation cache hits do not establish whole-run acceleration. Stryker's own
incremental result cache is separate and retains its original semantics.

## Verification and performance

```sh
npm run check
npm run test:integration
node scripts/integration.js native
node scripts/integration.js vitest
npm run test:corpus
npm run bench
```

The corpus and benchmark commands expect the upstream source at
`artifacts/upstream/stryker-js` (corpus: `STRYKER_UPSTREAM` can override it). The
reference used during development is commit
`c931a93237816901f1e9f48da411170beeb3dfca`, package version 10.0.0.

The harness compares full ordered mutant records, then executes instrumented
baseline and each active mutant independently, comparing observable values,
static/per-test coverage and hit limits. Real-run reports are compared by mutant
ID because asynchronous completion order is nondeterministic. Fallback execution
is counted separately and cannot pass a test requiring native execution.

Logs, raw benchmark samples and reports belong under `artifacts/verification/`
and `artifacts/benchmark/`. Benchmark reports explicitly distinguish native
instrumentation, compatibility/caching, cold/warm cache and end-to-end execution.
A parser microbenchmark or a single full-run sample is not a whole-run speed claim.

One upstream corpus fixture, `non-null-expression.ts`, currently fails in the
reference 10.0.0 instrumenter/Babel combination (`TSNonNullExpression` in an update
expression). Matching this existing error is recorded separately from successful
instrumentation; it is not a compatibility success for that syntax.

## Platform release bundle

Compile all configured targets into `native/` before `npm run pack:release`.
`scripts/targets.js` lists the required native artifacts. The command refuses an
incomplete bundle, generates platform packages with `os`/`cpu`/`libc` constraints,
then generates the root package with exact-version `optionalDependencies` and
SHA-256 manifests. It does not publish anything. Publish platform packages before
the root package only after native install/run checks on those platforms.

Only macOS arm64 has been verified locally. Unexecuted CI and cross-platform
recipes are not evidence that other binaries work.

Architecture references: [Rspack's Rust/JS boundary](https://www.rspack.dev/api/javascript-api/architecture),
[Oxc AST design](https://oxc.rs/docs/learn/architecture/parser.html),
[Oxc test infrastructure](https://oxc.rs/docs/learn/architecture/test.html),
[SWC distribution](https://swc.rs/docs/getting-started), and
[Stryker plugin lifecycle](https://stryker-mutator.io/docs/stryker-js/guides/create-a-plugin/).

Independent project; not an official Stryker Mutator release. Apache-2.0; see
[NOTICE](NOTICE) and dependency licenses.

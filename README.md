# Stryker Mutator Rust

A **preview** Rust-backed runner for StrykerJS 10.0.0, distributed as a precompiled
Node-API addon. Existing Stryker configuration, test runners, reporters, coverage
collection and incremental diff remain provided by the pinned StrykerJS core.

**This is not a completed Rust rewrite.** Native instrumentation currently supports
a conservative JavaScript subset. An unsupported batch is delegated in full to
StrykerJS rather than silently losing mutations. TypeScript, JSX, frameworks,
complex expressions and arbitrary Babel plugins still use the compatibility path.
Rust also indexes coverage and calculates batched test-plan decisions. Node still
owns incremental diff, plugins, sandbox, worker lifecycle and test execution.

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
  coreEngine: 'auto',
  cache: true,
});
await stryker.runMutationTest();
```

`installAcceleration(options)` installs the process-wide instrumentation and core
hooks; its first call owns the settings for subsequent instances. `createInstrumenter(logger,
options)` creates an isolated instrumenter without a global hook. Importing the
package alone does not install the hook.

`analyze(source, fileName)` is a broader **experimental candidate preview**. Its
UTF-16, zero-based, end-exclusive offsets can be used with JavaScript `slice`.
It always reports `supported: false`: it is neither the production instrumenter
nor a proof of full mutation parity.

`coreEngine` independently selects `auto` (default), `upstream` (no core hooks),
or `native` (reject unsupported core inputs without JavaScript fallback).
`STRYKER_RUST_CORE_ENGINE` supplies the default when the option is omitted.
`createInstrumenter` remains instrumentation-only. `nativeStatus()` reports
`nativeCoverage` and `nativePlanning` separately from `nativeInstrumentation`.

The core adapter targets exactly StrykerJS 10.0.0's internal `TestCoverage.from`
and `MutantTestPlanner.prototype.makePlan`; it checks the pinned classes,
key-specific method/getter fingerprints, constructor identities and descriptors
before installation. Instrumenter installation targets are preflighted before
any core hooks are installed. Rust receives ordered
coverage pairs and one batch of post-diff planning inputs. Node retains original
test/mutant objects, Map/Set order, constructor snapshots, test-filter aliases,
warnings, reporter events and sandbox calls. Custom helpers, subclasses,
accessors, proxies, coverage instances created outside the installed factory and
values the JSON boundary cannot preserve use the original path in `auto` mode.
Coverage containing unknown test IDs also uses upstream indexing: its warning
callbacks can change coverage before hit totals are calculated. Native planning
accepts only the pinned `Sandbox.sandboxFileFor` method on its data receiver with
an ordinary, unmodified Map; custom sandbox callbacks use upstream planning
before diff or row callbacks run. Forced `native` mode rejects these cases.
After incremental diff, fallback invokes the live `planMutant` method for each
already-diffed mutant, without repeating the diff. Errors from diff, loggers,
sandbox and reporters propagate without replay.

`installAcceleration()` returns the existing numeric `cache.stats` plus separate
`cache.coreStats`: engine, actual `nativeCoreStages`, native coverage/planning
batch counts, native planned-mutant count, JavaScript coverage/planning fallback
counts and native errors (with a last fallback reason when applicable). CLI
diagnostics retain every existing counter and add these under `core`.
This slice makes no speed claim. Full Rust core replacement remains unfinished.

## Native boundary and compatibility

The accepted native grammar includes ordinary JS named function declarations,
simple parameters/bindings, variable declarations, concise/block arrows,
return/if/block/expression statements, plain imports/named exports and pure
arithmetic, comparisons, equality, boolean, logical, unary and conditional
expressions. Strings, untagged templates, dense array literals and plain object
literals are supported in compatible placement and printing contexts. Mutation
records, IDs, locations, exclusions and runtime coverage follow the pinned
Stryker contract. Ordinary calls, continuous optional chains, public
static/computed members, `this`, direct `Array(...)` mutations and method
mutations are supported. Chain
placement preserves receivers and argument evaluation. Call-statement filtering
can leave gaps in otherwise ordered global mutant IDs, matching upstream.
Assignments and prefix/postfix updates support identifier and public-member
targets. Getter/setter order, logical assignment and update return values follow
JavaScript semantics. Active mutations on an update target's object spine use
upstream fallback to preserve its existing placement errors.
Ordinary loops, synchronous `for-in`/`for-of`, switch cases, labels,
break/continue and sequence expressions are supported. Loop-test mutations,
omitted-test `for` clones and switch fallthrough follow upstream placement.
Active mutations on an iteration target's object spine, and omitted-test
labelled loops whose mutation invalidates a labelled continue, use fallback.
Comments attached to whole-for clones and incompatible clone formatting also
require fallback.
Mutation ranges select candidates using upstream UTF-16
locations. Ordinary comments and Stryker disable/restore directives are accepted
in unambiguous gaps between statements, including `next-line` and ignore reasons.
Comments inside expressions, ambiguous attachments and directives requiring
upstream warnings still trigger whole-batch fallback.

Parenthesized optional-chain operands on a callee/object spine require fallback;
parentheses around an entire optional expression remain supported.
Private members, `super`, `new`, dynamic imports, regex,
argument spread, array holes/spread, object methods,
accessors/spread, complex computed keys, destructuring targets, classes,
async/generators, `for-await`, directive prologues and hashbangs trigger whole-batch fallback.
Noncanonical number spellings and incompatible raw string/template spellings
inside printed mutation replacements also fall back, as do objects and arrays
with more than two elements inside those replacements. See `src/instrument.rs`
for the definitive acceptance checks. The native engine does not claim the
broader preview's scope.

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
Caches bypass custom ignorers, framework parsers and ambient Babel configurations.
Potential `Stryker disable`/`restore` text also bypasses the cache so upstream
warnings are emitted on every invocation. This conservative text check can also
match string contents; native dispatch remains available for supported directives.
Cache I/O failures fall back to normal execution. Clear development caches after
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

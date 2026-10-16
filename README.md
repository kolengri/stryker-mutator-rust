# Stryker Mutator Rust

A **preview** Rust-backed runner for StrykerJS 10.0.0, distributed as a precompiled
Node-API addon. Existing Stryker configuration, test runners, reporters, coverage
collection and incremental diff remain provided by the pinned StrykerJS core.

**This is not a completed Rust rewrite.** Native instrumentation currently supports
a conservative JavaScript and erasable TypeScript subset. An unsupported batch is
delegated in full to StrykerJS rather than silently losing mutations. Unproven
TypeScript constructs, JSX, frameworks,
complex expressions and arbitrary Babel plugins still use the compatibility path.
Rust also indexes coverage and calculates batched test-plan decisions. In the
default legacy runner, Node still owns incremental diff, plugins, sandboxes,
worker lifecycle and test execution.

An experimental native coordinator is being added separately from that legacy
runner. `STRYKER_RUST_COORDINATOR_ENGINE=native stryker-rust run` selects it without
an upstream coordinator fallback. Its current scope includes JSON and
[data-shaped caller-executed JS/MJS/CJS configuration](docs/native-caller-config.md),
the built-in command runner executing `bun test` with coverage off, or existing
Mocha or Vitest projects through the explicitly selected pinned 10.0.0
`@stryker-mutator/mocha-runner` or `@stryker-mutator/vitest-runner` plugin.
Checker plugins are not yet supported;
reporters are limited to JSON or none. Rust owns file selection, instrumentation,
coverage indexing, test planning, sandboxes, process scheduling, deadlines,
cancellation, cleanup, and report assembly. Node workers retain the selected SDK
plugin and test framework. Unsupported configuration exits before starting a
mutation run. This scope does not establish full compatibility; performance must
be measured for the chosen runner and workload.

The Windows backend is a candidate requiring actual Windows CI verification.
It uses owned Job Objects and dependency junctions, and accepts only project and
sandbox paths that safely normalize to ordinary absolute drive paths. UNC/device
and still-verbatim project paths, and ambiguous TSConfig path aliases, are rejected
explicitly. POSIX retains process-group cleanup. Cross-compilation alone does not
establish Windows runtime support.

The corresponding API is `runNativeMutationTest({ cwd, args, overrides }, { signal })`
from `stryker-mutator-rust/native`. Cancellation settles only after native cleanup.

## Bun execution

Bun is the primary execution target for new fixtures and performance work. Existing
tests written with `bun:test` run unchanged. Select the Rust coordinator explicitly
and configure its built-in command runner:

```json
{
  "testRunner": "command",
  "plugins": [],
  "coverageAnalysis": "off",
  "mutate": ["src/**/*.js", "src/**/*.ts"],
  "commandRunner": { "command": "bun --no-env-file test ./test" },
  "reporters": ["json"]
}
```

```sh
STRYKER_RUST_COORDINATOR_ENGINE=native npx stryker-rust run
```

Rust owns instrumentation, sandboxes, scheduling, deadlines, process cleanup and
reporting. Bun executes the tests directly; this path creates no Node SDK runner
worker and performs no test conversion. Bun must be installed separately and
available on `PATH`. The local Bun validation version is 1.4.3.

Each mutant currently starts a fresh Bun process and runs the selected test
command. This preserves module initialization isolation. Per-test mutation
coverage, hit limits and persistent Bun test workers are not implemented. Ordinary
Bun LCOV coverage is not a substitute for mutation-to-test coverage. Mocha remains
an adapter for existing projects; its test APIs are not automatically converted.
See [the Bun execution contract](docs/bun.md).

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

For existing projects, keep their selected test framework and runner plugin
installed. Bun command execution needs no Stryker framework plugin. No npm release
has been published.

## CLI and API

The default legacy entry forwards upstream commands and flags, including config
files, `init`, `serve`, `--coverageAnalysis`, `--concurrency` and `--incremental`.
The explicit native coordinator supports only its documented migration scope.

```sh
npx stryker-rust --rust-info
npx stryker-rust run stryker.config.json
npx stryker-rust run --rust-no-cache
STRYKER_RUST_DIAGNOSTICS=1 npx stryker-rust run
STRYKER_RUST_THREADS=4 npx stryker-rust run
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

For standalone instrumentation in Node or Bun, use
`stryker-mutator-rust/instrumenter`. Supported native calls and cache hits avoid
loading the upstream instrumenter and core; auto-mode fallback loads one original
upstream instance per factory on demand. The root compatibility API retains its
real `Stryker` subclass and process-wide hooks. See the [instrumentation API](docs/instrumenter.md).

`analyze(source, fileName)` is a broader **experimental candidate preview**. Its
UTF-16, zero-based, end-exclusive offsets can be used with JavaScript `slice`.
It always reports `supported: false`: it is neither the production instrumenter
nor a proof of full mutation parity.

`coreEngine` independently selects `auto` (default), `upstream` (no core hooks),
or `native` (reject unsupported core inputs without JavaScript fallback).
`STRYKER_RUST_CORE_ENGINE` supplies the default when the option is omitted.
`createInstrumenter` remains instrumentation-only. `nativeStatus()` reports
`nativeCoverage` and `nativePlanning` separately from `nativeInstrumentation`.

### Instrumentation threads

`instrumentationThreads` selects a positive safe integer thread limit. The option
overrides `STRYKER_RUST_THREADS`; an omitted option uses that environment variable,
then native automatic selection. The setting is captured when the instrumenter
or process-wide hook is created. `1` selects serial execution. Empty environment
values select automatic mode; invalid values throw before hooks are installed.

```js
import { createInstrumenter } from 'stryker-mutator-rust/instrumenter';

const instrumenter = createInstrumenter(logger, {
  engine: 'native',
  instrumentationThreads: 4,
  cache: false,
});
const result = await instrumenter.instrument(files, instrumenterOptions);
console.log(instrumenter.instrumentationStats);
```

Rust distributes files among bounded scoped threads; each owns its parser and
arena. The calling thread participates. The limit is capped by available CPUs
and file count. Automatic mode currently stays serial: measured workloads have
not established a convincing parallel gain. Use an explicit limit above `1` to
opt into parallel execution. Empty/single-file inputs remain serial.
A nonblocking process-wide lease keeps simultaneous Node worker calls from
creating multiple Rust worker groups: contending calls run serially.

Files and records retain input order and serial global IDs. Relocation edits only
verified generated ID argument spans. When provenance cannot be established, the
whole batch retries serially in Rust. Unsupported syntax retains the existing
atomic compatibility behavior. This parallelism operates between files; one file
is not split, and test execution still uses Stryker's existing Node workers.

`instrumentationStats` is separate from the seven cache counters in `stats`.
It reports successful native serial/parallel batches, serial recoveries, the
configured limit, and the last actual thread/spawn/file counts and reason.
CLI diagnostics include it under `instrumentation`. Requested limits alone do
not prove parallel execution. Cache hits skip instrumentation and leave these
execution counters unchanged; thread settings do not change cache identity.

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
synchronous function expressions,
identifier parameters/bindings, identifier defaults and final identifier rest
parameters, variable declarations, concise/block arrows,
return/if/block/expression statements, plain imports/named exports and pure
arithmetic, bitwise/shift traversal, comparisons, equality, boolean, logical, unary and conditional
expressions. Strings, untagged templates, identifier-tagged templates without type
arguments (including ordinary `html`/`svg` tags), dense array literals and plain
object literals are supported in compatible placement and printing contexts. Tagged
quasi mutations wrap the complete tagged expression; substitutions retain their
own placements. Member/call tags remain unsupported. Spread arguments are supported
for ordinary nonoptional identifier calls, excluding built-ins with special mutation
semantics (`Array`, `RegExp`, `require`, `Symbol`, and `eval`). Mutation
records, IDs, locations, exclusions and runtime coverage follow the pinned
Stryker contract. Bitwise operators visit their operands without inventing arithmetic
mutants. Cloned replacement records preserve each string literal's original quotes
and escapes and each numeric token's radix, separators and exponent spelling. Physical multiline string tokens inside whole-for replacements still
require fallback, as do unproven generated literal ranges.
Printed replacement ancestors also accept concise arrows and synchronous simple
block arrows with untyped identifier parameters, including nested callback chains.
Simple blocks contain return/expression statements and single identifier variable
declarations. Their indentation and parameter parentheses follow upstream formatting.
Async block bodies, control-flow block bodies, defaults, rest, destructuring and
typed arrow signatures inside these printed ancestors still require fallback.
Nongeneric zero-argument identifier construction, including `value ?? new Logger()`,
is supported in expression clones; other constructor clone forms remain fallback.
Variable declarations also accept recursive object/array binding patterns with
static keys, aliases, holes and identifier rest bindings. Their original syntax
preserves JavaScript property access, iteration and binding semantics. Binding
defaults, computed keys, non-identifier rest, whole-for clone serialization and
unproven grouped/conditional initializer formatting still require fallback.
Destructured parameters, catches and assignment targets remain unsupported.
Ordinary calls, continuous optional chains, public
static/computed members, `this`, direct `Array(...)` mutations and method
mutations are supported. Chain
placement preserves receivers and argument evaluation. Call-statement filtering
can leave gaps in otherwise ordered global mutant IDs, matching upstream.
Assignments and prefix/postfix updates support identifier, public-member and private-field
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
Synchronous `try`/`catch`/`finally` preserves catch lexical bindings and completion
through the original constructs. Catch bindings can be absent or identifiers;
supported TS annotations retain their actual skipped-node filter behavior.
Ordinary nested synchronous declarations are accepted in statement lists without
conversion or a new hoisting pass. Upstream's strict/sloppy behavior and possible
duplicate-declaration compilation errors are preserved. Destructured catches,
unbraced/labelled declarations and unproven whole-for serialization still use
fallback.
Mutation ranges select candidates using upstream UTF-16
locations. Ordinary comments and Stryker disable/restore directives are accepted
in unambiguous gaps between statements, including `next-line` and ignore reasons.
Comments inside expressions, ambiguous attachments and directives requiring
upstream warnings still trigger whole-batch fallback.

TypeScript bindings, identifier parameters, optional parameters, generic
function/arrow signatures and return annotations preserve the original source.
Type aliases, interfaces, enum declarations and ambient declarations are opaque
to mutation traversal, matching upstream. Enum initializers retain their runtime
effects and consume no mutant IDs. `as` expressions
remain opaque, matching upstream's skipped subtree. Generic calls retain type
arguments in original code and drop them only in the replacements reconstructed
by upstream. Statement-call filtering preserves the pinned TS skip behavior.
`.ts`, `.mts`, `.cts` and their declaration extensions use the same runtime
parsing policy as the reference instrumenter. `satisfies`,
angle-bracket assertions, typed updates/iteration targets,
TSX and unproven typed replacement printing still require fallback.
Runtime TypeScript namespaces preserve executable exports and initialization in
source order, including merged and nested namespaces. Their module bodies are
statement lists without a BlockStatement removal mutant. Ambient declarations and
type-only descendants stay opaque. Namespace statement-list comments and ordinary
comments between unbraced branches are preserved; unproven directive ownership
still requires fallback.
Plain `=` targets wrapped in `as` remain opaque; compound cast assignments and
unproven printed ancestors still require fallback.
Non-null assertions participate in ordinary public call/member chains without
changing syntactic mutator recognition. Arguments and computed keys keep local
placement. Public member `delete` preserves the reference by placing spine
mutations around the whole delete expression; optional short-circuiting and key
evaluation follow upstream. Non-null assignment/update/iteration targets remain
on fallback, including the pinned upstream invalid-update error.

Bounded class declarations and expressions support public instance/static fields,
private fields, ordinary identifier-keyed methods, getters/setters, constructors,
heritage and static blocks. Field initialization and method execution retain their
original timing. Constructor-body deletion follows upstream's public-field and
direct-super-call predicate; static blocks have no own block deletion. Ordinary
`new` expressions and syntactic `new Array(...)` mutations are supported, as are
direct `super(...)` and unmapped super property calls. Throw-new deletion preserves
the statement-call filter and its ID gaps. Class/member directive ownership is
accepted only in proven statement/member gaps.
Simple constructor parameter properties support accessibility/readonly modifiers
and proven combinations with `override`. Constructor-body deletion also follows
upstream's parameter-property/direct-super-call predicate. A standalone `override`
uses fallback because the pinned Babel generator drops that modifier, changing
subsequent parameter-property transformation. Identifier parameter properties can
have supported defaults; decorated and destructured forms remain unsupported.
Defaults retain signature evaluation and parameter environments;
rest parameters do not enable spread expressions. Typed or parenthesized-identifier
assignment targets inside defaults use fallback for pinned Babel/Oxc parser
differences, including conservatively excluded grouped variants. Rust preserves original TypeScript;
runtime syntax such as enum and parameter properties still needs the project's
TypeScript transformation. Runtime tests transform completed upstream/native
instrumentation identically; they do not transpile before mutation.

Parenthesized optional-chain operands on a callee/object spine require fallback;
parentheses around an entire optional expression remain supported.
Non-null private/super combinations and unsupported delete argument shapes also
require fallback.
Regex literals support a bounded subset with no flags: start/end anchors,
ASCII letters, digits, spaces, underscores and hyphens, escaped slashes and
backslashes, positive literal character classes, digit classes (`\d`/`\D`),
and greedy `?`/`+` quantifiers. Native mutations preserve upstream ordering and
duplicates. Flags, ranges, groups, alternation, other escapes and unproven forms
trigger whole-batch fallback, as do string-pattern `new RegExp` calls.
Private methods/accessors, optional private members, decorators, auto-accessors,
unsupported parameter-property forms, computed/quoted method keys, computed fields,
mapped super calls, dynamic imports,
argument spread, array holes/spread, object methods,
accessors/spread, complex computed keys, destructuring targets,
async/generators, `for-await`, directive prologues and hashbangs trigger whole-batch fallback.
Noncanonical number spellings and incompatible raw string/template spellings
inside printed mutation replacements also fall back, as do objects and arrays
with more than two elements inside those replacements. One guarded logical-clone
case preserves a sole, simple ASCII single-quoted RHS; mixed quotes, escapes,
raw Unicode and enclosing replacement clones keep the general fallback. See `src/instrument.rs`
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
npm run test:bun
npm run test:integration
node scripts/integration.js native
node scripts/integration.js vitest
node scripts/integration.js typescript
node scripts/integration.js classes
npm run test:corpus
npm run bench
node scripts/benchmark-parallelism.js
node scripts/benchmark-parallelism.js --e2e
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
Real-project Bun checks also compare mutation records/outcomes and error messages.
Native and Babel printers can produce different generated code frames and
production stack coordinates; the preview does not claim text-identical raw
diagnostic rendering. Raw reports are retained before semantic normalization.
The parallelism benchmark writes to `artifacts/native-parallelism/benchmark/`.
It compares explicit serial/parallel execution for 2/8/32 balanced and skewed
files, including repeated uncached batches. Its separate end-to-end run imports
and tests all eight generated modules and compares complete reports with upstream.

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

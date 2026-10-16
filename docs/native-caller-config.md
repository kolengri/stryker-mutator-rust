# Native caller configuration handshake

This is a bounded data configuration slice, not arbitrary executable configuration
or plugin compatibility. The legacy runner remains a separate explicit mode;
unsupported native input never falls back to its coordinator.

## Boundary and ownership

`lib/runtime.js` calls `prepareNativeMutationTest` synchronously. Rust parses the
request and CLI, resolves the project, discovers the first accessible config, and
owns the selected path and options inside a nonconstructible `NativePreparation`
object. That object is the single-use ticket: callers cannot replace its path or
recover its internal parsed request. JSON/no-file preparations continue directly.
The existing direct addon `runNativeMutationTest` remains available for JSON;
executable input there explicitly requires the caller handshake.

For an executable file, the original Node environment performs exactly
`import(pathToFileURL(path.resolve(file)).toString())`. It checks the default
export and spreads it once. Module evaluation, loaders, module cache, TLA, main
SDK identities and process environment effects remain in that caller. No TSFN,
libuv task, isolated PluginSession worker, synthetic wrapper or cache-busting
import is used while loading the config. Root getter failures propagate directly;
import failures retain pinned Stryker error formatting, `innerError`, and their
actual thrown `cause`. Factories are rejected without invocation. Exported
Promise objects are spread, never awaited as configuration; enumerable symbols
added to them by async hooks can make the resulting data unsupported.

Rust then merges CLI/overrides, inserts schema defaults, validates options and
selects supported modules. Only those Rust-selected modules are imported in the
caller for schema extraction, after core validation. The actual caller core
schema is checked before core normalization and again after those imports.
Caller core and selected pinned Mocha/Vitest schema changes, including property reordering,
are rejected against pinned snapshots. Node does not validate or merge options.
Rust retains project preparation, SDK bridge scheduling, execution and reporting.
Core and plugin validation are separate synchronous native preparation phases.
Rust emits ordered set/delete operations even when a merge or validation fails;
the thin adapter applies them to the exact retained graph before proceeding.
Root-relative paths follow preceding replacements, preserving detached originals
and nested identities rather than rebuilding caller objects. A descriptor
projection after selected module imports captures their data mutations before
plugin validation. Core effects precede module evaluation; plugin effects
precede project preparation or task submission. Deprecated removals, Ajv-style
default insertion order and partial effects survive errors. The pinned util
`deepFreeze` creates frozen copies, and PrepareExecutor discards its return;
this slice likewise leaves cached original records and arrays writable and
extensible, including on repeated runs.

The shallow caller graph remains local in a private WeakMap for the run lifetime;
there is no opaque handle transport or main plugin callback framework.

## Represented configuration and explicit limits

Accepted transport values are null, booleans, finite numbers, strings, dense
ordinary arrays, and plain/null-prototype records with enumerable string data
properties. Root prototype/nonenumerable properties disappear through the pinned
spread; enumerable root getters execute. Key order and absent properties are
preserved, including JS numeric-key enumeration order after object/array merges.
Numbers follow JSON number transport, including signed-zero report
normalization. Strings or keys with unpaired UTF-16 surrogates fail explicitly
at Rust transport decoding. Graphs are limited to 128 levels and 100,000 values.

The descriptor-first projection never calls nested getters or `toJSON` and
rejects proxies (including root proxies), nested accessors/nonenumerables,
readonly/nonconfigurable properties, nonextensible data, functions, undefined,
symbols/keys, BigInt, nonfinite numbers, custom prototypes,
sparse/extended arrays, cycles and shared object references. Undefined is rejected
rather than tagged, omitted or substituted with null, even where CLI/defaults
might have eliminated it upstream. Date/RegExp/Map/class instances are not revived
in SDK workers. All existing native option, runner, reporter, mutation grammar,
project and output-path restrictions still apply; unknown options remain explicit
unsupported results. Warning/log emission is not identical to core's ConfigReader.

Discovery follows pinned core 10.0.0's prefix/suffix/extension order, without an
automatic TypeScript candidate, package.json field, preset/extends chain or
factory convention. Explicit `.json` detection is case insensitive and strict
JSON. Explicit other extensions use the caller Node runtime's ordinary loader.
Rust uses following filesystem metadata for existence, accepts directories as
candidates, and only treats NotFound/ENOENT as absence; malformed first candidates
and other access/read errors do not resume discovery. Empty explicit names fail
as missing files. A JSON root must remain an object under the existing native
contract. Pinned asymmetric object/array/null CLI merge is implemented in Rust;
missing schema defaults are inserted instead of merging defaults over explicit
nulls or array values. When Windows deprecated `htmlReporter.baseDir` rewriting
must derive `fileName`, it supports ordinary relative/rooted paths, absolute
drive paths and bare drives (`C:` becomes `C:\index.html`). UNC/namespace paths,
other drive-relative paths, extra colons and embedded NULs are explicitly
unsupported before emitting that derived path or deleting `baseDir`; earlier
merge/deprecation effects still apply. An existing truthy `fileName` follows the
pinned deletion-only behavior without deriving a new path.

Executable configuration requires request cwd to equal the actual canonical
process cwd before import. Post-import cwd changes are unsupported and are **not
restored**. After config and selected metadata imports and native preparation,
the public wrapper snapshots the actual caller's `process.env`. Rust applies
that per-run context with `env_clear`/`envs` before its own protocol variables;
bridge secrets are still stripped by the worker before plugin/user execution.
This includes worker_threads' private environment copies, setting and deletion,
and inheritance by command/bridge grandchildren, without changing native global
environment state. Windows keys follow Node child_process's JS lexical sorting
and first case-insensitive spelling. On Windows only, missing libuv-required
names are restored from the native OS environment before owned worker variables;
supplied values (including empty) and spelling are preserved, and arbitrary
custom deletions remain deleted. Required-name comparison uses Windows ordinal
case mapping; the native size probe retains libuv's empty/absent behavior.
The caller's `process.env.comspec` shell choice is captured too. JSON public calls take the same snapshot without loading
the SDK/helper graph; direct addon callers omitting the optional context retain
OS environment inheritance. This is a compatibility-boundary snapshot, not
synchronization with unrelated application async mutations. Unrelated application code can still mutate global
state concurrently; this slice does not sandbox JS, roll back its effects, or
reproduce arbitrary monkeypatches of Node builtins, SDK methods or plugin
implementations. Custom main plugins/reporters and opaque options remain future
work. Metadata checks concern the pinned SDK/module instances actually consumed,
not every separately installed duplicate SDK in a consumer's dependency tree.

## Concurrency, cancellation and lifetime

A nonblocking native process-global lease excludes executable preparation/runs
from **all** other overlapping native runs using this loaded addon, including
worker_threads and direct JSON addon calls. JSON preparations/runs retain shared
concurrency when no executable owner exists. Conflicts fail before config code
runs; they are not queued. Distinct independently loaded addon binary copies and
unrelated application code are outside this lease. No lease framework or process
resources are retained after a completed/rejected preparation. A process may hold
one pending executable import indefinitely if its TLA never settles.

Cancellation IDs register synchronously before import/task queueing. The opaque
preparation owns registration until it transfers once into the native task.
`close`, finalization, unsupported completion, import/export/projection failure,
abort, task submission failure and task destruction release ownership. Submission
uses `Env::spawn` with an explicit error branch: locked napi 3.14.2 leaks its task
box on certain queue/create errors, so release is idempotent and does not depend
on that leaked box dropping. This native fault path is source-checked, not forced
through a production fault-injection API.

Pre-abort skips imports. Abort during import waits for import/TLA settlement
before releasing ownership; it cannot forcibly stop JS. A never-settling TLA
therefore also prevents cancellation settlement. Actual import/getter exceptions
are never inspected by adapter capability classification or cancellation mapping,
and keep their original causes instead of being replaced by cancellation. Once native
work starts, the public Promise waits for child and sandbox cleanup and preserves
the AbortSignal reason on successful cancellation.

`worker.terminate()` itself does not cancel an active NAPI task: Node drains
native requests before invoking addon cleanup hooks. Abort and await the run
before terminating its worker, or wait for its native run/deadline and cleanup.
This pre-existing native-task limitation is retained. Abandoned preparation
finalization and completed task teardown release their registry/lease state;
there is no ineffective teardown hook claiming earlier cancellation.

## Pinned sources and validation

Sources are installed core/API/util/Mocha runner 10.0.0:

- core `dist/src/config/config-reader.js`, `config-file-formats.js`,
  `options-validator.js`, `utils/file-utils.js`, `di/plugin-loader.js`;
- util `dist/src/deep-merge.js`, `stryker-error.js`, `immutable.js`; core
  `dist/src/process/1-prepare-executor.js` (discarded deepFreeze return);
- API `dist/src/core/stryker-options-schema.js`, `dist/schema/stryker-core.json`;
- Mocha `dist/schema/mocha-runner-options.json`, copied unchanged into
  `src/runtime/mocha-schema.json` for explicit caller mutation rejection;
- locked napi 3.14.2 `src/async_work.rs` and task/drop implementation.

Caller environment evidence: installed Node 26.10.0's embedded `child_process`
source (shell and environment normalization), archived with the check receipts;
Node 22.18.0/24.11.0/26.10.0 libuv `deps/uv/src/win/process.c` required-variable
list, `CompareStringOrdinal` and `GetEnvironmentVariableW` fallback, plus Rust
1.99.0 Windows `EnvKey`/`make_envp` and bare-drive `Path::push` sources;
[Node process.env documentation](https://nodejs.org/api/process.html#processenv)
explains worker copies and main-thread-only visibility to native addons.

Node 26.10.0 teardown evidence is
[`src/env.cc`](https://github.com/nodejs/node/blob/v26.10.0/src/env.cc#L1509)
(`RunCleanup` calls `CleanupHandles` before draining cleanup hooks), and
[`src/node_api.cc`](https://github.com/nodejs/node/blob/v26.10.0/src/node_api.cc#L1200)
(`Work` uses `ThreadPoolWork`).

`test/caller-config-handshake.test.js` uses the exact installed ConfigReader and
OptionsValidator as differential oracles. `test/caller-config-execution.test.js`
compares actual command and Mocha full reports and forbids upstream core imports
on native CLI/descendant paths. Additional coverage exercises descriptor
negatives, original load hooks, cache/TLA, cwd/schema mutations, native and
import cancellation, single-use ownership, cross-environment exclusion, JSON
concurrency, and environment/task teardown. Existing native runtime/bridge tests
remain applicable. Receipts, full failed iterations, final commands, source and
addon fingerprints are under `artifacts/caller-config-handshake/`. No benchmark,
corpus rerun, Dealyv suite, publication, or parent source write is part of this slice.

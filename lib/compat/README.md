# JavaScript compatibility worker

`worker.js` runs one existing SDK test runner or checker for a Rust owner. It has no
CLI, file planner, sandbox, test pool, deadlines, or upstream core runtime imports.
Launch it with `STRYKER_RUST_BRIDGE_ADDRESS=127.0.0.1:<port>` (also `localhost` or
`[::1]`) and a per-worker `STRYKER_RUST_BRIDGE_TOKEN`. The owner authenticates the
first `hello` event. Both variables are deleted before importing plugin code.
Plugin code is trusted executable code, not a security sandbox.

Control frames use the dedicated TCP stream described in `docs/native-runtime.md`.
User stdout and stderr remain ordinary process streams. Requests are limited to
8 MiB each and 64 outstanding IDs; buffered replies are limited to 16 MiB. An
invalid envelope returns a protocol error, with `id: null` if no valid ID exists.
Oversized requests, duplicate outstanding IDs, or queue overflow are terminal.
Each operation is awaited before the next starts, including disposal. Rust must
kill a worker when a plugin hangs; the worker introduces no execution timeout.

Before configuration validation, `prepare` accepts `{cwd, modules}` and returns
`loadedModules`, `schemaContributions`, `coreSchema` (the SDK's strykerCoreSchema)
and `sdkVersion`, without constructing a plugin. Rust applies defaults and
validates options. Dispose this metadata worker, then initialize actual runner
workers in their Rust-owned sandbox using the returned explicit module URLs.
Same-worker prepared initialization is allowed only for the same cwd and module
selection; changing imported module context after validation is rejected.

Initialize with absolute `cwd`, JSON `options` and `fileDescriptions`, `modules`,
and `plugin: {kind: "TestRunner" | "Checker", name}`. Options and file descriptions
are recursively frozen. The reply contains `plugin`, `loadedModules` (module name
and declared plugin names/kinds), and `schemaContributions`. No function crosses
the protocol. Runner methods receive their SDK run-options object directly;
checker `group` and `check` receive their mutant arrays directly. `runner.init` is
optional for SDK plugins without init; `checker.group` defaults to singleton IDs
when omitted by the checker, as specified by the SDK. `dispose` is idempotent.
Other missing methods and unsupported plugin kinds fail explicitly.
Runner results retain the pinned worker's compatibility postprocessing:
`@stryker-mutator/util.errorToString` formats returned error messages, and complete
dry runs inherit legacy `global.__mutantCoverage__` when coverage is requested and
the runner did not supply its own coverage. Rust still owns all run planning.

Prefer explicit resolved file URLs from Rust. Absolute paths and relative/bare
module specifiers also work. Relative paths resolve from the consumer `cwd`.
Bare specifiers use a temporary synchronous Node resolution hook when
`module.registerHooks` is available; older Node versions require resolved file URLs
for bare packages and return an actionable error otherwise.
The hook changes only this import's parent URL, and preserves Node import
conditions, export maps, and existing resolution/load hooks. It does not use
`require.resolve`, generate executable source, or evaluate serialized functions.
Pass Node conditions and custom loader arguments when launching the worker, just
as when launching the existing JavaScript tool.

The worker uses SDK declarations and typed-inject directly. A selected plugin is
registered as a provider, including value plugins, so the injector owns its
disposal alongside injected dependencies. Failed construction or init and lost
connections also dispose the injector. Reporter and executable-config operations
are not implemented in this slice.

Two related pinned SDK defects are corrected: typed-inject 5.0.0's
`dist/src/InjectorImpl.js` registers a disposable separately for every provider.
A factory returning an already provided instance otherwise disposes that same
object twice. Immediately before disposal, the adapter validates the complete
injector-owned `childInjectors`/`disposables` Set layout, then removes duplicate
identities while retaining the deepest owner. It never walks the plugin object
graph or changes plugin methods, including on frozen instances. Unexpected SDK
versions/layouts fail explicitly. Its default dispatch also stops ancestor cleanup
when a child fails. The adapter temporarily overrides only injector-owned
`disposeInjectedValues` dispatch, awaits every callback with `allSettled`, and
restores the overrides in `finally`. Normal public SDK disposal still marks
contexts disposed before callbacks, runs children before parents, and runs
independent branches in parallel. Single failures retain the original thrown
object; multiple failures become AggregateError with all original errors.
The protocol's optional `error.errors` retains nested error details. Aggregate
serialization is bounded to depth eight and 256 ordinary error records, with explicit
truncation markers for cycles or exceeded limits. Ordinary error graphs are
lossless within these limits.

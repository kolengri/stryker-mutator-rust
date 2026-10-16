# Instrumentation API

Use `stryker-mutator-rust/instrumenter` for standalone instrumentation in Bun or Node:

```js
import { createInstrumenter } from 'stryker-mutator-rust/instrumenter';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isTraceEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
};
const instrumenter = createInstrumenter(logger, {
  engine: 'auto',
  instrumentationThreads: 2,
});
const result = await instrumenter.instrument([
  { name: 'example.ts', content: 'export const enabled = true;', mutate: true },
], { ignorers: [], excludedMutations: [], plugins: null });

console.log(result.mutants);
console.log(instrumenter.stats, instrumenter.instrumentationStats);
```

The factory is synchronous and returns an async `instrument(files, options)` method plus the same cache counters and instrumentation statistics as the root factory. The subpath re-exports `File`, `InstrumenterOptions`, `InstrumentResult`, `Logger`, `AccelerationOptions`, `AccelerationStats` and `InstrumentationStats` as types.

The entry imports only the existing cache and backend graph. Native instrumentation and cache hits do not import `@stryker-mutator/instrumenter` or `@stryker-mutator/core`. Native calls use the real Rust addon; supported syntax, native failures, cache eligibility, events and thread selection follow the existing backend and cache policies.

With `engine: 'auto'`, unsupported inputs or an unavailable native addon use the pinned upstream instrumenter. `engine: 'upstream'` always uses that fallback when instrumentation is required. The first fallback dynamically imports upstream and constructs one instrumenter per factory. Concurrent first calls share that initialization; separate factories keep separate upstream instances. A failed initialization remains rejected for that factory, and upstream instrumentation errors propagate unchanged. The original method is used even if `installAcceleration()` was installed before or after factory creation, so fallback does not re-enter the global hook.

`engine: 'native'` rejects unsupported inputs and native failures according to the existing strict policy. It never initializes upstream as a recovery path. Cache configuration and the `STRYKER_RUST_ENGINE`, `STRYKER_RUST_CACHE`, `STRYKER_RUST_CACHE_DIR` and `STRYKER_RUST_THREADS` environment variables retain their existing behavior. Thread configuration is captured when the factory is created.

The root entry remains the compatibility API for the actual `Stryker` subclass, `installAcceleration()` and other existing exports. It retains its eager upstream imports and process-wide installation behavior. This additive subpath changes the standalone instrumentation import graph; it makes no performance claim for the Bun CLI or a full mutation-testing run. The native CLI already uses the separate `lib/runtime.js` graph.

# Native calls implementation slice

Implemented the bounded ordinary-call/public-member slice in the prepared isolated worktree. This is not completion of the full Rust rewrite. Pinned StrykerJS Node orchestration and whole-batch fallback remain in place.

## Identity and ownership

- Worktree: `/Users/kolengri/.t3/worktrees/stryker-mutator-rust/t3-d73e7ba5`.
- Initial prepared branch: `t3/d73e7ba5`; host-renamed final branch: `t3/rust-call-member-instrumentation`; parent: `1adaa6cb03d2948c1f1be024ee134a02c6dd832f`.
- Authoritative source checkout: `/Users/kolengri/.t3/projects/stryker-mutator-rust/artifacts/upstream/stryker-js`, verified HEAD `c931a93237816901f1e9f48da411170beeb3dfca`.
- Runtime oracle: locally installed `@stryker-mutator/instrumenter@10.0.0`.
- Host: Darwin arm64; Node `26.10.0`; rustc `1.99.0 (b940084d7 2026-09-28)`; cargo `1.99.0 (5f94df478 2026-08-27)`.
- Primary model retained. No additional agents, remote operations, publishing, services, global installs, shared instructions, or skill edits.
- No README, JS compatibility/cache APIs, corpus script, package metadata, or lockfile changes.

Changed files:

- `src/instrument.rs`: native grammar, chain placement, method/Array mutations, statement filtering and switches, monotonic batch IDs, two Rust regression tests, and necessary old rejection-fixture substitutions.
- `test/native-calls.test.js`: 73 new oracle comparison tests, including exact upstream resource bytes and optional live-checkout verification through `STRYKER_UPSTREAM`.
- `test/instrumenter.test.js`, `test/native-directives.test.js`, `test/native-literals.test.js`: only substitutions for rejection fixtures that became supported; all rejection assertions retained.
- `artifacts/native-calls/report.md`: this report, explicitly staged despite the repository artifact ignore rule.

Implementation source SHA-256: `7572eeed5ac201fd28c08e69fbe9a239e6af6ed8be30d7e4fde837a0db18d775`.
New suite SHA-256: `e212fed12df5a1649254663813349e94cb151075d2a33ce564b257c15b2ddd1a`.

## Behavior and architecture

Ordinary calls, public static/computed members, and `this` are accepted within the prior native grammar and printer constraints. Callees are traversed before arguments; member objects before computed keys. Static names are not expression children. Direct string arguments of Identifier `require` and `Symbol` are skipped, including shadowed bindings; nested strings, templates, and methods with these names still mutate normally.

A switch now retains its metadata target span independently of its legal placement. Call/member mutations on callee/object spines are collected in preorder and deferred to the nearest legal expression root. Computed keys and arguments retain independent switches. Active ancestor branches are built by replacing the target in a cloned, uninstrumented AST, then printing the whole ancestor with precedence protection. The original branch retains independently instrumented children. No intermediate call/member wrapper loses a method Reference, and Identifier `eval` remains a direct callee.

The complete literal MethodExpression map and generated reverse behavior are ported. `setUTCDate -> setTime` does not overwrite `setTime -> setDate`. Computed Identifier keys match the mapping; computed string keys do not. Removal skips property/key and argument evaluation; rename uses a static replacement property and preserves argument order/evaluation.

Direct Identifier `Array(...)` collects ArrayDeclaration before descendants, including when shadowed. Empty calls become `Array([])`; calls with arguments become `Array()`. Member calls named Array do not match.

Normal-JS CallExpression is a statement mutation: a call ExpressionStatement yields `;` at the complete statement span, including a present semicolon. Calls in initializers, returns, and arguments have no such own candidate. Its filter runs after descendants and their filters. It counts surviving active records; when that count differs from one it removes only its own record with an undefined reason. Ignored records survive. Explicit empty reasons remain active and defined, so survive removal. IDs use an independent monotonically increasing batch counter, preserving removal gaps across files. Removed switches, coverage IDs, and header contributions are removed. Statement switches use an enclosing block to preserve dangling-else binding.

Examples asserted against complete ordered oracle objects:

- `foo();` retains CallExpression `0`.
- `foo(a+b);` removes candidate `0` and retains ArithmeticOperator `1`.
- `obj.trim();` removes candidate `0` and retains MethodExpression `1`.
- `Array();` retains ArrayDeclaration `1`.
- `Array(1+2);` retains ArrayDeclaration `1`, ArithmeticOperator `2`.
- `foo(); bar(a+b); baz();` retains IDs `0,2,3`.

## Applicable mutator audit

Read the pinned upstream registry `packages/instrumenter/src/mutators/mutate.ts` and the source of method-expression, empty-expression, array-declaration, string-literal, expression/statement placers, and Babel transformer filtering.

- Existing ArithmeticOperator, ArrowFunction, BlockStatement, BooleanLiteral, ConditionalExpression, EqualityOperator, LogicalOperator, ObjectLiteral, StringLiteral, and UnaryOperator continue to apply to accepted grammar.
- ArrayDeclaration is extended to ordinary direct Array calls.
- CallExpression is implemented for normal-JS call statements with its subtree filter.
- MethodExpression implements every nonoptional map entry, including reverse mappings.
- UpdateOperator, Regex, OptionalChaining, and AssignmentOperator require syntax still rejected for the whole batch.
- Throw/new-based CallExpression and new-based ArrayDeclaration remain rejected grammar; framework expression-context rules remain upstream-only.

No applicable call mutator is silently omitted.

## Acceptance evidence

All new supported comparisons use forced `engine: 'native'` and assert one native batch, zero fallback batches, and complete ordered mutant-object equality. Runtime comparisons observe baseline and every active ID with activation before/after load, hit limits absent/0/1, static and per-test coverage, namespace state, values, errors, and side-effect traces. Data-only observers preserve undefined and non-finite values through structured cloning; no JSON normalization weakens runtime comparisons.

Coverage includes all 36 method mappings, receiver/getter counts, argument evaluation order/skipping, computed Identifier key getters versus string keys, call/member chains and computed-key calls, conditional/parenthesized/unary/numeric receivers, precedence, `this`, direct eval lexical scope, direct/nested require/Symbol strings and templates, inferred names, Array/shadowing/member nonmatches, exclusions, nonempty/empty reasons, nested filters, ranges including semicolon/parenthesis distinctions, dangling else, and cross-file ID gaps with execution.

Unsupported batches assert a raw response with no result, forced-native rejection, and a complete exact automatic upstream result. Cases include optional-chain/member/call flags, parenthesized optional chains, super/private/class syntax, new/import, spread arguments, assignments, updates, delete, tagged templates, TS/frameworks, printed comments/raw spelling, and arrows in unproven printed contexts.

Actual pinned upstream `console-sample.js` and `js-sample.js` were read during the forced-native suite through `STRYKER_UPSTREAM`; their exact fixture bytes are also embedded so the tests remain portable. Both pass complete metadata and runtime checks. Resource SHA-256:

- `console-sample.js`: `352265f8735f792a0a30180cd68ab7a15c8133a6d8ece1557898005de4433c97`.
- `js-sample.js`: `053ecd51440ef8e922ab84ef281618dd6af9be0a626760617a23bca7410f9438`.

Measured corpus: 33 inputs, **3 native / 30 fallback**, zero native errors. Native files: `console-sample.js` (2 mutants), `excluded-mutations.js` (2), `js-sample.js` (3). One invalid corpus fixture retains its matching upstream error. `functional-chains.js` remains fallback. This is correctness/dispatch evidence, not a speed measurement.

A supplemental printer-boundary probe compared serializable raw records over 126 receiver/argument combinations: 119 accepted exact matches, seven conservative object-printing rejections, zero metadata mismatches. Full public-object comparisons remain in the persistent suite.

## Commands and logs

Run from the worktree root. No rustdoc shim was created. All final required gates passed:

```sh
cargo fmt --check
RUSTDOC=/Users/kolengri/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustdoc cargo clippy --locked --all-targets -- -D warnings
RUSTDOC=/Users/kolengri/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustdoc cargo test --locked
npm run build
npm test
STRYKER_UPSTREAM=/Users/kolengri/.t3/projects/stryker-mutator-rust/artifacts/upstream/stryker-js node --test test/native-calls.test.js
STRYKER_UPSTREAM=/Users/kolengri/.t3/projects/stryker-mutator-rust/artifacts/upstream/stryker-js npm run test:corpus
node artifacts/native-calls/printer-probe.mjs
```

Results: 15 Rust tests; 176 Node tests, including 73 new call tests; release addon build; all 33 corpus dispatch/comparison cases.

Local verification files (ignored artifacts, retained in this implementation worktree):

- `artifacts/native-calls/fmt.log`
- `artifacts/native-calls/clippy.log`
- `artifacts/native-calls/cargo-test.log`
- `artifacts/native-calls/build.log`
- `artifacts/native-calls/npm-test.log`
- `artifacts/native-calls/native-calls.log`
- `artifacts/native-calls/corpus.log`
- `artifacts/native-calls/corpus-result.json`
- `artifacts/native-calls/printer-probe.mjs` and `printer-probe.json`

Dependencies were prepared locally with `npm ci --ignore-scripts`. Initial suite development exposed observer cloning errors on proxy/object results and an overbroad test-setup replacement; those fixture issues were corrected. Final runtime observers return explicit data and record side effects without cloning proxies.

## Exact rejection-fixture substitutions

Assertions and rejection intent were preserved. Supported forms now have positive coverage in the new suite.

- Rust rejection list: `function f(){ return call(); }` becomes `function f(){ return call?.(); }`; `const x = a.value;` becomes `const x = a?.value;`.
- Rust atomic two-file rejection: second-file `call();` becomes `call?.();`.
- `test/instrumenter.test.js`: `value => value.trim().toLowerCase()` becomes `value => value?.trim().toLowerCase()`.
- `test/native-directives.test.js`: `const a = call();` becomes `const a = call?.();`.
- `test/native-literals.test.js`: direct `require("x")`, `Symbol("x")`, `Array()`, `[1].length`, and `"x".length` become `require?.("x")`, `Symbol?.("x")`, `Array?.()`, `[1]?.length`, and `"x"?.length` respectively.

## Conservative boundaries and handoff

Whole-batch fallback is retained for optional chains and optional flags; super/private/new/import; spread; assignment/update/delete/tagged templates; TS/JSX/frameworks; and all previous unsupported statements, directives, parameters, printing, and comment attachments. In particular, method/chain printing conservatively inherits guards for differing raw spellings, objects, large printed arrays, and nested arrows. This can reject semantically tractable calls; it avoids claiming unverified printer compatibility.

Independent integrated review, parent acceptance/commits, JS compatibility/cache changes, packaging, and continuation belong to the primary. They were not performed here and are not claimed. No unmet implementation-slice acceptance issue is known after the listed checks. Full functionality parity and full Rust orchestration remain unfinished, with 30 corpus inputs still falling back. No performance claim is made.

Suggested follow-up, not applied: consolidate VM observer setup/execution in a shared native-test helper. The new proxy cases exposed repeated clone pitfalls; a shared contract is expected to reduce fixture-only failures but adds common-helper maintenance. Leaving it unchanged requires each suite to reproduce that handling.

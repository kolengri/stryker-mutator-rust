import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAcceleration, createInstrumenter, nativeStatus } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { TestCoverage, MutantTestPlanner, originalFrom, originalMakePlan, logger, testResult, mutant, planner, prohibitOriginals, observeSandbox } from './native-core-helpers.js';

const cache = installAcceleration({ engine: 'upstream', coreEngine: 'auto', cache: false });
const stats = cache.coreStats;
const binding = loadNative();
const nativeCoverage = binding.coverageBatch;
const nativePlanning = binding.planningBatch;
const coverage = (tests = [], mutantCoverage) => TestCoverage.from({ tests, mutantCoverage }, logger());

function compareCoverage(actual, expected, tests) {
  assert.ok(actual instanceof TestCoverage);
  assert.deepEqual(actual.testsById, expected.testsById);
  assert.deepEqual(actual.testsByMutantId, expected.testsByMutantId);
  assert.deepEqual(actual.hitsByMutantId, expected.hitsByMutantId);
  assert.equal(actual.hasCoverage, expected.hasCoverage);
  for (const [id, value] of actual.testsById) assert.equal(value, tests.findLast((test) => test.id === id));
  for (const [id, set] of actual.testsByMutantId) {
    assert.deepEqual([...set], [...expected.forMutant(id)]);
    [...set].forEach((value, i) => assert.equal(value, [...expected.forMutant(id)][i]));
  }
}

test('installation is idempotent, independent of instrumentation, with separate stats', () => {
  assert.equal(installAcceleration({ coreEngine: 'upstream' }), cache);
  assert.equal(stats.engine, 'auto');
  assert.deepEqual(TestCoverage.from.inject, originalFrom.inject);
  assert.equal(TestCoverage.from.inject, originalFrom.inject);
  const originalDescriptor = Object.getOwnPropertyDescriptor(TestCoverage, Symbol.for('stryker-mutator-rust.core.v1')).value.coverageDescriptor;
  for (const flag of ['writable', 'enumerable', 'configurable']) assert.equal(Object.getOwnPropertyDescriptor(TestCoverage, 'from')[flag], originalDescriptor[flag]);
  assert.ok(Object.values(cache.stats).every((value) => typeof value === 'number'));
  const isolated = createInstrumenter(undefined, { coreEngine: 'native' });
  assert.equal(isolated.coreStats, undefined);
  assert.equal(nativeStatus().nativeCoverage, true);
  assert.equal(nativeStatus().nativePlanning, true);
});

test('warning-free native coverage preserves ordered Maps/Sets, duplicate objects and original static reference', async () => {
  const tests = [testResult('10'), testResult('2'), testResult('10', 21), testResult('alpha', -1)];
  const raw = { static: { later: 0, 2: -3, 1: 2 }, perTest: {
    alpha: { 2: 3, zero: 0, negative: -2, later: 1 }, 10: { later: 2, 1: 5 }, 2: { later: 3 },
  } };
  const expectedLog = logger();
  const expected = originalFrom({ tests, mutantCoverage: raw }, expectedLog);
  const actualLog = logger();
  const before = stats.nativeCoverageBatches;
  const actual = await prohibitOriginals(() => TestCoverage.from({ tests, mutantCoverage: raw }, actualLog));
  assert.equal(stats.nativeCoverageBatches, before + 1);
  compareCoverage(actual, expected, tests);
  assert.deepEqual([...actual.testsById.keys()], ['10', '2', 'alpha']);
  assert.deepEqual([...actual.forMutant('later')], [tests[1], tests[2], tests[3]]);
  assert.equal(actual.hitsByMutantId.get('later'), 6);
  assert.deepEqual(actualLog.warnings, expectedLog.warnings);
  raw.static.later = 4;
  assert.equal(actual.hasStaticCoverage('later'), true, 'static coverage must retain the original reference');
  const replacement = testResult('10', 50);
  actual.addTest(replacement);
  actual.addCoverage('later', ['10', 'missing']);
  assert.equal(actual.testsById.get('10'), replacement);
  assert.deepEqual([...actual.forMutant('later')], [tests[1], tests[2], tests[3], replacement]);
  actual.addCoverage('new', ['alpha']);
  assert.deepEqual(actual.forMutant('new'), new Set([tests[3]]));
});

test('warning-bearing coverage retains unknown hits through upstream fallback and the raw native ABI', () => {
  const tests = [testResult('10'), testResult('2'), testResult('10', 21), testResult('alpha', -1)];
  const raw = { static: { later: 0, 2: -3, 1: 2 }, perTest: {
    alpha: { 2: 3, zero: 0, negative: -2, later: 1 }, 10: { later: 2, 1: 5 }, 2: { later: 3 },
    unknown: { later: 7, unseen: -5 }, emptyUnknown: {},
  } };
  const expectedLog = logger();
  const expected = originalFrom({ tests, mutantCoverage: raw }, expectedLog);
  const actualLog = logger();
  const beforeFallback = stats.javascriptCoverageFallbacks;
  const beforeNative = stats.nativeCoverageBatches;
  const actual = TestCoverage.from({ tests, mutantCoverage: raw }, actualLog);
  compareCoverage(actual, expected, tests);
  assert.equal(actual.hitsByMutantId.get('later'), 13);
  assert.equal(actual.hitsByMutantId.get('unseen'), -5);
  assert.deepEqual(actualLog.warnings, expectedLog.warnings);
  assert.equal(actualLog.warnings.length, 2);
  assert.equal(stats.javascriptCoverageFallbacks, beforeFallback + 1);
  assert.equal(stats.nativeCoverageBatches, beforeNative);
  const response = JSON.parse(nativeCoverage(JSON.stringify({ version: 1, testIds: tests.map((test) => test.id), coverage: {
    static: Object.entries(raw.static), perTest: Object.entries(raw.perTest).map(([id, entries]) => [id, Object.entries(entries)]),
  } })));
  assert.equal(response.supported, true);
  assert.deepEqual(response.result.unknownTestIds, ['unknown', 'emptyUnknown']);
  assert.deepEqual(response.result.hitsByMutantId, [...expected.hitsByMutantId]);
  assert.deepEqual(response.result.testsById.map(([id, index]) => [id, tests[index]]), [...expected.testsById]);
  assert.deepEqual(response.result.testsByMutantId.map(([id, indexes]) => [id, new Set(indexes.map((index) => tests[index]))]), [...expected.testsByMutantId]);
});

test('coverage warning callbacks mutate live indexing once and keep warning order', () => {
  function run(factory) {
    const raw = { static: { m: 1 }, perTest: { unknown: {}, another: {} } };
    const warnings = [];
    const indexed = factory({ tests: [], mutantCoverage: raw }, { warn(message) {
      warnings.push(message);
      raw.static.m = 7;
      if (warnings.length === 1) raw.perTest.another.m = 3;
    } });
    return { indexed, warnings };
  }
  const before = stats.javascriptCoverageFallbacks;
  const actual = run(TestCoverage.from);
  const expected = run(originalFrom);
  assert.deepEqual(actual.warnings, expected.warnings);
  assert.equal(actual.warnings.length, 2);
  assert.deepEqual(actual.indexed.hitsByMutantId, expected.indexed.hitsByMutantId);
  assert.equal(actual.indexed.hitsByMutantId.get('m'), 10);
  assert.equal(stats.javascriptCoverageFallbacks, before + 1);
  const single = { static: { m: 1 }, perTest: { unknown: {} } };
  let calls = 0;
  const indexed = TestCoverage.from({ tests: [], mutantCoverage: single }, { warn() { calls++; single.static.m = 7; } });
  assert.equal(indexed.hitsByMutantId.get('m'), 7);
  assert.equal(calls, 1);
});

test('absent versus collected empty coverage and upstream unit coverage cases', async () => {
  const tests = [testResult('spec1'), testResult('spec2'), testResult('spec3')];
  for (const raw of [undefined, { static: {}, perTest: {} }, { static: { 1: 0, 2: 1 }, perTest: {
    spec1: { 1: 2, 2: 100 }, spec2: { 2: 100 }, spec3: { 1: 3, 2: 0 },
  } }]) {
    const expected = originalFrom({ tests, mutantCoverage: raw }, logger());
    const actual = await prohibitOriginals(() => coverage(tests, raw));
    compareCoverage(actual, expected, tests);
    for (const id of ['1', '2', 'missing']) assert.equal(actual.hasStaticCoverage(id), expected.hasStaticCoverage(id));
  }
});

function assertPlanReferences(plans, originals, globalFilter) {
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const original = originals[i];
    assert.equal(plan.mutant.location, original.location);
    assert.equal(plan.mutant.extension, original.extension);
    assert.ok(Object.hasOwn(plan.mutant, 'static'));
    assert.ok(Object.hasOwn(plan.mutant, 'coveredBy'));
    if (plan.plan === 'EarlyResult') {
      assert.ok(Object.hasOwn(plan.mutant, 'killedBy'));
      assert.ok(Object.hasOwn(plan.mutant, 'statusReason'));
      if (original.status) {
        assert.equal(plan.mutant.coveredBy, original.coveredBy);
        assert.equal(plan.mutant.killedBy, original.killedBy);
      }
    } else {
      assert.deepEqual(Object.keys(plan), ['plan', 'netTime', 'mutant', 'runOptions']);
      assert.deepEqual(Object.keys(plan.runOptions), ['activeMutant', 'mutantActivation', 'timeout', 'testFilter', 'sandboxFileName', 'hitLimit', 'disableBail', 'reloadEnvironment']);
      assert.deepEqual(Object.keys(plan.runOptions.activeMutant), ['id', 'fileName', 'location', 'mutatorName', 'replacement']);
      assert.equal(plan.runOptions.activeMutant.location, original.location);
      assert.ok(Object.hasOwn(plan.runOptions, 'hitLimit'));
      assert.ok(Object.hasOwn(plan.runOptions, 'testFilter'));
      if (plan.runOptions.testFilter !== globalFilter) assert.equal(plan.runOptions.testFilter, plan.mutant.coveredBy);
    }
  }
}

test('native planning matches upstream status, off, empty, static, runtime, hybrid and selected-file branches', async () => {
  const tests = [testResult('a', 20), testResult('b', 22), testResult('negative', -2)];
  const symbol = Symbol('extension');
  const mutants = [mutant('static'), mutant('runtime'), mutant('hybrid'), mutant('uncovered'), mutant('existing', {
    status: 'Killed', statusReason: undefined, coveredBy: ['a'], killedBy: ['b'], extension: { callback() {} }, [symbol]: { kept: true },
  })];
  for (const raw of [undefined, { static: {}, perTest: {} }, { static: { static: 1, hybrid: 2, existing: 1, uncovered: -1 },
    perTest: { a: { runtime: 1, hybrid: 1 }, b: { runtime: 1 }, negative: { runtime: 1 } } }]) {
    for (const ignoreStatic of [false, true]) {
      for (const selected of [[], ['selected.spec.js']]) {
        const native = planner(coverage(tests, raw), { ignoreStatic });
        const upstream = planner(originalFrom({ tests, mutantCoverage: raw }, logger()), { ignoreStatic });
        // Constructor test-file selection is cached; preserve that array identity.
        if (selected.length) {
          native.result.globalTestFilter = ['sandbox/selected.spec.js'];
          upstream.result.globalTestFilter = ['sandbox/selected.spec.js'];
        }
        const expected = await originalMakePlan.call(upstream.result, mutants);
        const before = stats.nativePlanningBatches;
        const actual = await prohibitOriginals(() => native.result.makePlan(mutants), expected.filter((plan) => plan.plan === 'Run').length);
        assert.equal(stats.nativePlanningBatches, before + 1);
        assert.deepEqual(actual, expected);
        actual.forEach((plan, i) => assert.deepEqual(Object.keys(plan.mutant), Object.keys(expected[i].mutant)));
        assertPlanReferences(actual, mutants, native.result.globalTestFilter);
        assert.equal(actual.at(-1).mutant[symbol], mutants.at(-1)[symbol]);
        assert.equal(native.effects.diff, 1);
        assert.equal(native.effects.reports.length, 1);
        assert.equal(native.effects.reports[0].mutantPlans, actual);
        assert.deepEqual(native.effects.warnings, upstream.effects.warnings);
        assert.deepEqual(actual.filter((plan) => plan.plan === 'Run').map((plan) => plan.runOptions.sandboxFileName),
          expected.filter((plan) => plan.plan === 'Run').map((plan) => plan.runOptions.sandboxFileName));
      }
    }
  }
});

test('planner uses constructor snapshots and post-diff actual Set objects, including duplicate IDs', async () => {
  async function run(native) {
    const old = testResult('same', 20);
    const raw = { static: { static: 1 }, perTest: { same: { runtime: 1 } } };
    const cov = native ? coverage([old], raw) : originalFrom({ tests: [old], mutantCoverage: raw }, logger());
    const project = { testFiles: ['before.spec.js'], files: new Map(), incrementalReport: { files: {} } };
    let calls = 0;
    const replacement = testResult('same', 70);
    const differ = { diff(mutants) {
      calls++;
      cov.addTest(replacement);
      cov.addCoverage('runtime', ['same']);
      cov.addTest(testResult('new', 100));
      project.testFiles.push('after.spec.js');
      return [mutants[0], { ...mutants[1], fromDiff: true }];
    } };
    const p = planner(cov, {}, { project, differ });
    const filter = p.result.globalTestFilter;
    const mutants = [mutant('runtime'), mutant('static')];
    const plans = native ? await prohibitOriginals(() => p.result.makePlan(mutants)) : await originalMakePlan.call(p.result, mutants);
    assert.equal(calls, 1);
    assert.equal(plans[0].netTime, 90);
    assert.deepEqual(plans[0].mutant.coveredBy, ['same', 'same']);
    assert.equal(plans[0].mutant.coveredBy, plans[0].runOptions.testFilter);
    assert.equal(plans[1].netTime, 20);
    assert.equal(plans[1].runOptions.testFilter, filter);
    assert.deepEqual(filter, ['sandbox/before.spec.js']);
    assert.equal(plans[1].mutant.fromDiff, true);
    return plans;
  }
  assert.deepEqual(await run(true), await run(false));
});

test('empty cached global filters remain present and empty covered filters remain Run', async () => {
  for (const raw of [undefined, { static: { static: 1 }, perTest: {} }]) {
    const p = planner(coverage([], raw));
    const filter = [];
    p.result.globalTestFilter = filter;
    const plans = await prohibitOriginals(() => p.result.makePlan([mutant('static'), mutant('missing')]));
    for (const plan of plans) {
      assert.equal(plan.plan, 'Run');
      assert.equal(plan.runOptions.mutantActivation, 'runtime');
      assert.equal(plan.runOptions.reloadEnvironment, plan.mutant.static !== false);
    }
    assert.equal(plans[0].runOptions.testFilter, filter);
  }
});

test('finite zero, negative hits and ordered floating point arithmetic preserve exact results', async () => {
  const times = [1e16, -1e16, 0.1, 0.2, -0.3, 1234.56789];
  const tests = times.map((time, index) => testResult(`t${index}`, time));
  const raw = { static: { zero: 0, negative: -4 }, perTest: Object.fromEntries(tests.map((test) => [test.id, { floating: 1 }])) };
  const mutants = ['zero', 'negative', 'floating'].map((id) => mutant(id));
  const actual = await prohibitOriginals(() => planner(coverage(tests, raw), { timeoutMS: -1, timeoutFactor: 0.7 }).result.makePlan(mutants));
  const expected = await originalMakePlan.call(planner(originalFrom({ tests, mutantCoverage: raw }, logger()), { timeoutMS: -1, timeoutFactor: 0.7 }).result, mutants);
  assert.deepEqual(actual, expected);
  assert.equal(actual[0].runOptions.hitLimit, 0);
  assert.equal(actual[1].runOptions.hitLimit, -400);
  const negativeTime = planner(coverage([testResult('negative', -1)]), { timeoutMS: 0, timeoutFactor: 0 });
  const [zeroPlan] = await prohibitOriginals(() => negativeTime.result.makePlan([mutant('m')]));
  assert.equal(zeroPlan.runOptions.timeout, 501, 'an unobservable intermediate negative zero is supported');
});

test('JSON batches preserve difficult binary64 values exactly', async () => {
  const values = [136306105880066.75, 4.1429910180158916e43, -3.730820098426193e-11,
    9.301421581767499e-30, -2.583796856924892e41, Number.MIN_VALUE, Number.MAX_VALUE];
  const raw = { static: Object.fromEntries(values.map((value, index) => [String(index), value])), perTest: {} };
  const cov = await prohibitOriginals(() => coverage([], raw));
  assert.deepEqual([...cov.hitsByMutantId.values()], values);
  const tests = [testResult('precise', 136306105880066.75)];
  const mutants = [mutant('m')];
  const native = planner(coverage(tests), { timeoutMS: 9.301421581767499e-30, timeoutFactor: 0.8455124082255701 });
  const upstream = planner(originalFrom({ tests }, logger()), { timeoutMS: 9.301421581767499e-30, timeoutFactor: 0.8455124082255701 });
  assert.deepEqual(await prohibitOriginals(() => native.result.makePlan(mutants)), await originalMakePlan.call(upstream.result, mutants));
});

test('malformed native coverage falls back atomically after a warning-free native invocation', () => {
  const tests = [testResult('known')];
  const dry = { tests, mutantCoverage: { static: {}, perTest: { known: { a: 1 } } } };
  for (const corrupt of [
    (result) => { result.testsById[0][1] = 999; },
    (result) => { result.testsByMutantId = [['a', [0]], ['b', [999]]]; },
    (result) => { result.hitsByMutantId.push(['a', null]); },
    (result) => { result.unknownTestIds.push('bogus'); },
  ]) {
    const before = stats.javascriptCoverageFallbacks;
    let nativeCalls = 0;
    binding.coverageBatch = (input) => {
      nativeCalls++;
      const output = JSON.parse(nativeCoverage(input));
      corrupt(output.result);
      return JSON.stringify(output);
    };
    try {
      const log = logger();
      const result = TestCoverage.from(dry, log);
      assert.equal(log.warnings.length, 0);
      assert.equal(nativeCalls, 1);
      assert.equal(result.hitsByMutantId.get('a'), 1);
      assert.equal(stats.javascriptCoverageFallbacks, before + 1);
    } finally { binding.coverageBatch = nativeCoverage; }
  }
});

test('malformed planning falls back after exactly one diff, before sandbox/report effects', async () => {
  for (const corrupt of [
    (result) => { result.pop(); },
    (result) => { result[1].timeout = null; },
    (result) => { delete result[1].reloadEnvironment; },
    (result) => { result[1].kind = 'NoCoverage'; },
    (result) => { result[1].selection = 'global'; },
    (result) => { result[1].mutantActivation = 'static'; },
    (result) => { result[1].reloadEnvironment = true; },
  ]) {
    const p = planner(coverage([testResult('a')], { static: {}, perTest: {} }));
    const mutants = [mutant('1'), mutant('2')];
    const before = stats.javascriptPlanningFallbacks;
    try {
      const { value: plans, calls } = await observeSandbox(async (calls) => {
        binding.planningBatch = (input) => {
          assert.equal(calls[0], 0);
          assert.equal(p.effects.reports.length, 0);
          const output = JSON.parse(nativePlanning(input));
          corrupt(output.result);
          return JSON.stringify(output);
        };
        return p.result.makePlan(mutants);
      });
      assert.equal(plans.length, 2);
      assert.equal(p.effects.diff, 1);
      assert.equal(p.effects.reports.length, 1);
      assert.equal(calls, 2);
      assert.deepEqual(plans.map((plan) => plan.runOptions.sandboxFileName), ['sandbox/1.js', 'sandbox/2.js']);
      assert.equal(stats.javascriptPlanningFallbacks, before + 1);
    } finally { binding.planningBatch = nativePlanning; }
  }
});

test('nonfinite, negative zero, overflow and unsupported shapes use upstream without JSON corruption', async () => {
  for (const count of [NaN, Infinity, -Infinity, -0, 1e308]) {
    const raw = { static: { m: count }, perTest: { missing: { m: count } } };
    const before = stats.javascriptCoverageFallbacks;
    const actual = coverage([], raw);
    const expected = originalFrom({ tests: [], mutantCoverage: raw }, logger());
    assert.deepEqual(actual.hitsByMutantId, expected.hitsByMutantId);
    assert.equal(stats.javascriptCoverageFallbacks, before + 1);
  }
  for (const [key, value] of [['timeoutMS', NaN], ['timeoutMS', -0], ['timeoutFactor', Infinity], ['timeoutFactor', 1e308]]) {
    const p = planner(coverage([testResult('t', 10)]), { [key]: value });
    const before = stats.javascriptPlanningFallbacks;
    const actual = await p.result.makePlan([mutant('m')]);
    const expected = await originalMakePlan.call(planner(originalFrom({ tests: [testResult('t', 10)] }, logger()), { [key]: value }).result, [mutant('m')]);
    assert.deepEqual(actual, expected);
    assert.equal(p.effects.diff, 1);
    assert.equal(stats.javascriptPlanningFallbacks, before + 1);
  }
});

test('coverage getters/proxies are bypassed before executable reads and never evaluated twice', () => {
  for (const useProxy of [false, true]) {
    let reads = 0;
    const test = { timeSpentMs: 1, get id() { reads++; return 'a'; } };
    const tests = useProxy ? [new Proxy(test, {})] : [test];
    const actual = coverage(tests, { static: {}, perTest: {} });
    assert.equal(actual.testsById.get('a'), tests[0]);
    assert.equal(reads, 1);
  }
});

test('mutant accessors are not read during native preparation before upstream fallback', async () => {
  let reads = 0;
  const original = mutant('m');
  Object.defineProperty(original, 'extension', { enumerable: true, get() { reads++; return 'value'; } });
  const p = planner(coverage());
  await p.result.makePlan([original]);
  assert.equal(reads, 1, 'only the original spread should evaluate the accessor');
  assert.equal(p.effects.diff, 1);
  let staticReads = 0;
  const raw = { static: {}, perTest: {} };
  const p2 = planner(coverage([], raw), {}, { differ: { diff(mutants) {
    Object.defineProperty(raw.static, 'm', { enumerable: true, get() { staticReads++; return 1; } });
    return mutants;
  } } });
  const [plan] = await p2.result.makePlan([mutant('m')]);
  assert.equal(plan.mutant.static, true);
  assert.equal(staticReads, 1, 'post-diff static accessors are evaluated only by the original planner');
});

test('custom planner helpers, subclasses and custom coverage retain the original path', async () => {
  const p = planner(coverage());
  let calls = 0;
  p.result.planMutant = (value) => { calls++; return { plan: 'custom', mutant: value }; };
  const plans = await p.result.makePlan([mutant('m')]);
  assert.equal(plans[0].plan, 'custom');
  assert.equal(calls, 1);
  assert.equal(p.effects.diff, 1);
  class CustomPlanner extends MutantTestPlanner {}
  Object.setPrototypeOf(p.result, CustomPlanner.prototype);
  await p.result.makePlan([mutant('m')]);
  assert.equal(calls, 2);
  const p2 = planner(coverage());
  p2.result.testCoverage.hasStaticCoverage = () => true;
  const [customCoveragePlan] = await p2.result.makePlan([mutant('m', { status: 'Ignored' })]);
  assert.equal(customCoveragePlan.mutant.static, true);
});

test('post-diff fallback dispatches live own and prototype planMutant overrides per row', async () => {
  for (const target of ['own', 'prototype']) {
    const descriptor = Object.getOwnPropertyDescriptor(MutantTestPlanner.prototype, 'planMutant');
    const calls = [];
    let p;
    const receiver = () => target === 'own' ? p.result : MutantTestPlanner.prototype;
    const second = function (value) { calls.push(['second', value.id]); return { plan: 'custom-second', mutant: value }; };
    const first = function (value) {
      calls.push(['first', value.id]);
      receiver().planMutant = second;
      return { plan: 'custom-first', mutant: value };
    };
    p = planner(coverage(), {}, { differ: { diff(mutants) { p.effects.diff++; receiver().planMutant = first; return mutants; } } });
    const originals = [mutant('1'), mutant('2')];
    const before = stats.javascriptPlanningFallbacks;
    try {
      const plans = await p.result.makePlan(originals);
      assert.deepEqual(calls, [['first', '1'], ['second', '2']], target);
      assert.deepEqual(plans.map((plan) => plan.plan), ['custom-first', 'custom-second']);
      assert.equal(plans[0].mutant, originals[0]);
      assert.equal(plans[1].mutant, originals[1]);
      assert.equal(p.effects.diff, 1);
      assert.equal(p.effects.reports.length, 1);
      assert.equal(p.effects.reports[0].mutantPlans, plans);
      assert.equal(stats.javascriptPlanningFallbacks, before + 1);
    } finally { Object.defineProperty(MutantTestPlanner.prototype, 'planMutant', descriptor); }
  }
});

test('post-diff live planMutant mutation and errors escape without replay', async () => {
  const boom = new Error('live row failed');
  const calls = [];
  let p;
  const originals = [mutant('1'), mutant('2')];
  p = planner(coverage(), {}, { differ: { diff(mutants) {
    p.effects.diff++;
    p.result.planMutant = (value) => {
      calls.push(value.id);
      if (value.id === '1') { mutants[1].status = 'Killed'; return { plan: 'custom', mutant: value }; }
      assert.equal(value.status, 'Killed');
      throw boom;
    };
    return mutants;
  } } });
  await assert.rejects(p.result.makePlan(originals), (error) => error === boom);
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(p.effects.diff, 1);
  assert.equal(p.effects.reports.length, 0);
});

test('custom sandbox callbacks retain per-row option, coverage and mutant mutation semantics', async () => {
  for (const change of ['options', 'coverage', 'mutants']) {
    async function run(native) {
      const tests = [testResult('t', 10), testResult('extra', 20)];
      const raw = change === 'options' ? undefined : { static: {}, perTest: { t: { a: 1, b: 1 } } };
      const cov = native ? coverage(change === 'options' ? [tests[0]] : tests, raw)
        : originalFrom({ tests: change === 'options' ? [tests[0]] : tests, mutantCoverage: raw }, logger());
      const mutants = [mutant('a'), mutant('b')];
      const calls = [];
      let p;
      const sandbox = { sandboxFileFor(file) {
        calls.push(file);
        if (file === 'a.js') {
          if (change === 'options') p.result.options.timeoutMS = 17;
          if (change === 'coverage') cov.addCoverage('b', ['extra']);
          if (change === 'mutants') mutants[1].status = 'Killed';
        }
        return `sandbox/${file}`;
      } };
      p = planner(cov, {}, { sandbox });
      const plans = native ? await p.result.makePlan(mutants) : await originalMakePlan.call(p.result, mutants);
      assert.equal(p.effects.diff, 1);
      assert.equal(p.effects.reports.length, 1);
      return { plans, calls };
    }
    const beforeFallback = stats.javascriptPlanningFallbacks;
    const beforeNative = stats.nativePlanningBatches;
    const actual = await run(true);
    const expected = await run(false);
    assert.deepEqual(actual, expected, change);
    assert.deepEqual(actual.calls, change === 'mutants' ? ['a.js'] : ['a.js', 'b.js']);
    if (change === 'options') assert.deepEqual(actual.plans.map((plan) => plan.runOptions.timeout), [5516, 533]);
    if (change === 'coverage') assert.deepEqual(actual.plans.map((plan) => plan.netTime), [10, 30]);
    if (change === 'mutants') assert.equal(actual.plans[1].plan, 'EarlyResult');
    assert.equal(stats.javascriptPlanningFallbacks, beforeFallback + 1);
    assert.equal(stats.nativePlanningBatches, beforeNative);
  }
});

test('overridden sandbox Map reads fall back before effects, and pinned missing-file errors do not replay', async () => {
  const p = planner(coverage([testResult('t', 10)]), {}, { sandboxFiles: ['a.js', 'b.js'] });
  const calls = [];
  const map = p.result.sandbox.fileMap;
  map.get = (file) => { calls.push(file); if (file === 'a.js') p.result.options.timeoutMS = 17; return Map.prototype.get.call(map, file); };
  const before = stats.javascriptPlanningFallbacks;
  const plans = await p.result.makePlan([mutant('a'), mutant('b')]);
  assert.deepEqual(calls, ['a.js', 'b.js']);
  assert.deepEqual(plans.map((plan) => plan.runOptions.timeout), [5516, 533]);
  assert.equal(p.effects.diff, 1);
  assert.equal(stats.javascriptPlanningFallbacks, before + 1);
  const missing = planner(coverage());
  const nativeBefore = stats.nativePlanningBatches;
  const fallbackBefore = stats.javascriptPlanningFallbacks;
  await observeSandbox(async (calls) => {
    await assert.rejects(missing.result.makePlan([mutant('unmapped')]), /Cannot find sandbox file for unmapped.js/);
    assert.equal(calls[0], 1);
  });
  assert.equal(missing.effects.diff, 1);
  assert.equal(missing.effects.reports.length, 0);
  assert.equal(stats.nativePlanningBatches, nativeBefore + 1);
  assert.equal(stats.javascriptPlanningFallbacks, fallbackBefore);
});

test('logger, diff, sandbox, reporter and slow-warning errors escape without replay', async () => {
  let warnings = 0;
  const boom = new Error('effect failed');
  const before = stats.javascriptCoverageFallbacks;
  assert.throws(() => TestCoverage.from({ tests: [], mutantCoverage: { static: {}, perTest: { missing: {} } } }, { warn() { warnings++; throw boom; } }), (error) => error === boom);
  assert.equal(warnings, 1);
  assert.equal(stats.javascriptCoverageFallbacks, before + 1);
  for (const effect of ['diff', 'sandbox', 'reporter', 'slow']) {
    let calls = 0;
    const throws = () => { calls++; throw boom; };
    const overrides = effect === 'diff' ? { differ: { diff: throws } }
      : effect === 'sandbox' ? { sandbox: { sandboxFileFor: throws } }
        : effect === 'reporter' ? { reporter: { onMutationTestingPlanReady: throws } } : { logger: { warn: throws } };
    const p = planner(coverage([testResult('t', 1)], { static: { m: 1 }, perTest: {} }), {}, overrides);
    const before = stats.javascriptPlanningFallbacks;
    await assert.rejects(p.result.makePlan([mutant('m')]), (error) => error === boom);
    assert.equal(calls, 1, effect);
    assert.equal(stats.javascriptPlanningFallbacks, before + (effect === 'sandbox' ? 1 : 0), effect);
  }
});

test('raw native ABIs reject malformed or unsupported batches atomically', () => {
  for (const method of [nativeCoverage, nativePlanning]) {
    for (const input of ['{}', 'null', '{', '{"version":2}', '{"version":1,"testIds":[0],"coverage":null}']) {
      const result = JSON.parse(method(input));
      assert.equal(result.supported, false);
      assert.equal(Object.hasOwn(result, 'result'), false);
    }
  }
  for (const input of [
    '{"version":1,"testIds":[]}',
    '{"version":1,"testIds":[],"coverage":null,"extra":true}',
    '{"version":1,"testIds":[],"coverage":{"static":[["m",-0.0]],"perTest":[]}}',
    '{"version":1,"testIds":[],"coverage":{"static":[["m",1e308]],"perTest":[["unknown",[["m",1e308]]]]}}',
  ]) {
    const result = JSON.parse(nativeCoverage(input));
    assert.equal(result.supported, false);
    assert.equal(Object.hasOwn(result, 'result'), false);
  }
  const validPlanning = { version: 1, hasCoverage: true, ignoreStatic: false, timeSpentAllTests: 1,
    globalFilterPresent: false, timeoutMS: 1, timeoutFactor: 1, timeOverheadMS: 1,
    rows: [{ hasStatus: true, isStatic: false, coveredTimesMs: [], hitCount: null },
      { hasStatus: false, isStatic: false, coveredTimesMs: [], hitCount: 1e308 }] };
  const overflow = JSON.parse(nativePlanning(JSON.stringify(validPlanning)));
  assert.equal(overflow.supported, false);
  assert.equal(Object.hasOwn(overflow, 'result'), false);
  delete validPlanning.rows[1].hitCount;
  assert.equal(JSON.parse(nativePlanning(JSON.stringify(validPlanning))).supported, false);
});

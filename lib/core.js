// Deliberately private, exact-version seams: this is not a core plugin API.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { loadNative } from './native.js';
import { coreFingerprint, qualifyCoreRuntime } from './core-runtime.js';

const INSTALLATION = Symbol.for('stryker-mutator-rust.core.v1');
const own = Object.getOwnPropertyDescriptor;
const source = (fn) => Function.prototype.toString.call(fn);
const mapGet = Map.prototype.get;
// Published StrykerJS 10.0.0 prototype slots, hashed independently of class text.
const COVERAGE_METHODS = {
  testsByMutantId: ['get', '7994dffd8c5ae701f0371f18c7a7ae82df171032b7f3cb6b59d79b4b152a6464'],
  testsById: ['get', '2586a9f838f5e6a2bda9face3fdecba50400ddba55ab04dfeed06e2c57d6e033'],
  hitsByMutantId: ['get', '3dedc27a710d46c49b39611085b643684cf7c8651526ab3218001bd3a98f8cf9'],
  hasCoverage: ['get', 'faece2f8a59456b34925388430b0087cc06f36db9ccf576d07de429c4e1d378a'],
  hasStaticCoverage: ['value', 'ffd8b5e9e4a37796cba7c9db1c9d23090585550424193b6d77cfd070da3e4a6c'],
  addTest: ['value', '2be186c37980d6b13b360d98797d55ab4c1283264bde5c72c9ea2200c104a325'],
  addCoverage: ['value', '18fba3927cdeacc877b37d1020fe73117055eaa18b463ad429ed7b5fd0400ba0'],
  forMutant: ['value', '37e46094977647abb406c9cb4ddc09608df5f6a4a7eaa93e19d7b2124b34b7cf'],
};
const PLANNER_METHODS = {
  makePlan: ['value', '15baf343a4b28dfb84a63367cf47e43154c259075ff354c9c1527f9fffcff38f'],
  planMutant: ['value', '854632bc2e0d156c34e4d4e2914c903f10bdd2adebd3bd2cf21c7bb6faa08ca1'],
  createMutantEarlyResultPlan: ['value', '5e638acac1ec56fba10ddc45c25ad463b4fbd063671bb116926b44036525c31b'],
  createMutantRunPlan: ['value', '162041f22afee483047233ee9758b6aa9ce2575e015ea17f724ae891880ca28c'],
  warnAboutSlow: ['value', 'd404022d6c1afbf411366305346377de1a09f79705e520d951c4e0592745893e'],
  incrementalDiff: ['value', '74f3b7397bb61843e72dfa283dec19f730992ad27611bbb75d518682ebc4fe5d'],
  readAllOriginalFiles: ['value', '71244b129c91736bf983888b534a1c8adfd16a0721149e36f416360ad5a5f588'],
};
let seam;
let seamError;
try {
  const require = createRequire(import.meta.url);
  const url = pathToFileURL(require.resolve('@stryker-mutator/core/package.json'));
  if (require('@stryker-mutator/core/package.json').version !== '10.0.0') throw new Error('Core requires exactly StrykerJS 10.0.0');
  qualifyCoreRuntime(url);
  const { TestCoverage } = await import(new URL('./dist/src/mutants/test-coverage.js', url));
  const { MutantTestPlanner } = await import(new URL('./dist/src/mutants/mutant-test-planner.js', url));
  const { Sandbox } = await import(new URL('./dist/src/sandbox/sandbox.js', url));
  seam = { TestCoverage, MutantTestPlanner, Sandbox };
} catch (error) {
  seamError = error;
}

function expect(condition, reason = 'Invalid native core response') {
  if (!condition) throw new TypeError(reason);
}
function number(value) {
  expect(typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0), 'Unsupported core number');
  return value;
}
function data(object, prototype) {
  expect(object !== null && typeof object === 'object' && !types.isProxy(object), 'Unsupported core object');
  const actual = Object.getPrototypeOf(object);
  expect(prototype ? actual === prototype : actual === Object.prototype || actual === null, 'Unsupported core prototype');
  const descriptors = Object.getOwnPropertyDescriptors(object);
  expect(Reflect.ownKeys(descriptors).every((key) => 'value' in descriptors[key]), 'Unsupported core accessor');
  return object;
}
function field(object, key) {
  const descriptor = own(object, key);
  expect(descriptor || !(key in object), 'Unsupported inherited core field');
  return descriptor?.value;
}
function array(value) {
  data(value, Array.prototype);
  expect(Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1, 'Unsupported core array');
  for (let i = 0; i < value.length; i++) expect(own(value, i)?.enumerable, 'Unsupported core array element');
  return value;
}
function collection(value, prototype) {
  data(value, prototype);
  expect(Reflect.ownKeys(value).length === 0, 'Unsupported core collection');
  return value;
}
function counts(object) {
  data(object);
  return Object.entries(object).map(([id, count]) => [id, number(count)]);
}
function keys(value, expected) {
  expect(value && typeof value === 'object' && !Array.isArray(value));
  expect(Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)));
}
function uniquePairs(value, visit) {
  expect(Array.isArray(value));
  const ids = new Set();
  for (const pair of value) {
    expect(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && !ids.has(pair[0]));
    ids.add(pair[0]);
    visit(pair[1], pair[0]);
  }
  return ids;
}
function invoke(method, input) {
  const binding = loadNative();
  expect(typeof binding[method] === 'function', 'Native core API unavailable');
  const response = JSON.parse(binding[method](JSON.stringify(input)));
  expect(response && response.supported === true, `Native core unsupported: ${response?.reason ?? 'invalid response'}`);
  keys(response, ['supported', 'result']);
  return response.result;
}
function sameDescriptor(a, b) {
  return a && b && ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((key) => a[key] === b[key]);
}
function unchanged(prototype, saved, replacement) {
  return Object.getPrototypeOf(prototype) === Object.prototype && Reflect.ownKeys(prototype).length === Reflect.ownKeys(saved).length
    && Reflect.ownKeys(saved).every((key) => sameDescriptor(own(prototype, key), replacement && Object.hasOwn(replacement, key) ? replacement[key] : saved[key]));
}
function pinnedDescriptor(descriptor, part, fingerprint) {
  return descriptor?.configurable === true && descriptor.enumerable === false
    && (part === 'value' ? descriptor.writable === true && !('get' in descriptor) && !('set' in descriptor)
      : !('value' in descriptor) && !('writable' in descriptor) && descriptor.set === undefined)
    && typeof descriptor[part] === 'function' && coreFingerprint(descriptor[part], fingerprint);
}
function initialPrototype(Class, methods) {
  expect(Object.getPrototypeOf(Class) === Function.prototype && Object.getPrototypeOf(Class.prototype) === Object.prototype, 'Replaced core prototype');
  const descriptors = Object.getOwnPropertyDescriptors(Class.prototype);
  const constructor = descriptors.constructor;
  expect(constructor?.value === Class && constructor.writable === true && constructor.enumerable === false && constructor.configurable === true
    && !('get' in constructor) && !('set' in constructor), 'Replaced core constructor');
  expect(Reflect.ownKeys(descriptors).length === Object.keys(methods).length + 1
    && Reflect.ownKeys(descriptors).every((key) => key === 'constructor'
      || (Object.hasOwn(methods, key) && pinnedDescriptor(descriptors[key], ...methods[key]))), 'Replaced core helper');
  return descriptors;
}

function sandboxEligible(sandbox) {
  const { Sandbox } = seam;
  data(sandbox, Sandbox.prototype);
  expect(!Object.hasOwn(sandbox, 'sandboxFileFor')
    && Object.getPrototypeOf(Sandbox.prototype) === Object.prototype
    && pinnedDescriptor(own(Sandbox.prototype, 'sandboxFileFor'), 'value', '1eeb68dab75e25926bb3c65b70363fb6e411d50879e3eea6eb4dd52d21fc5717'), 'Custom sandbox mapper');
  collection(field(sandbox, 'fileMap'), Map.prototype);
  expect(own(Map.prototype, 'get')?.value === mapGet && source(mapGet) === 'function get() { [native code] }', 'Custom sandbox Map getter');
}

export function resolveCoreEngine(options = {}) {
  const engine = options.coreEngine ?? process.env.STRYKER_RUST_CORE_ENGINE ?? 'auto';
  if (!['auto', 'upstream', 'native'].includes(engine)) throw new TypeError('coreEngine must be auto, upstream or native');
  return engine;
}

/** Called once by installAcceleration; the instrumenter-only API never calls it. */
export function installCoreAcceleration(options = {}) {
  const engine = resolveCoreEngine(options);
  const stats = { engine, nativeCoreStages: [], nativeCoverageBatches: 0, nativePlanningBatches: 0,
    nativePlannedMutants: 0, javascriptCoverageFallbacks: 0, javascriptPlanningFallbacks: 0, nativeErrors: 0 };
  if (engine === 'upstream') return stats;
  try {
    if (seamError) throw seamError;
    const { TestCoverage, MutantTestPlanner } = seam;
    const registered = own(TestCoverage, INSTALLATION)?.value;
    if (registered) {
      expect(own(MutantTestPlanner, INSTALLATION)?.value === registered && own(TestCoverage, 'from')?.value === registered.coverageHook
        && own(MutantTestPlanner.prototype, 'makePlan')?.value === registered.planningHook, 'Core installation was replaced');
      return registered.stats;
    }
    expect(!own(TestCoverage, INSTALLATION) && !own(MutantTestPlanner, INSTALLATION), 'Conflicting core installation');
    const coverageDescriptor = own(TestCoverage, 'from');
    expect(coverageDescriptor && typeof coverageDescriptor.value === 'function', 'Replaced coverage factory');
    // Fingerprints of the published 10.0.0 classes/factory, plus live descriptor
    // checks, prevent treating an unrelated replacement as the pinned seam.
    expect(coreFingerprint(TestCoverage, '2657066820dc4890140032871cc202a362110761a443bbcf807be714405e8c03')
      && coreFingerprint(coverageDescriptor.value, 'f4a222cf55367feae1cb3ce3328c45ebb8952e8934de35894cf083db089508b5')
      && coreFingerprint(MutantTestPlanner, '57d2054ef4e95539d7df17bfc6e0ed649ab5b667ea17fe56cf0f31f8f42ddcf3'), 'Replaced or incompatible pinned core');
    const coveragePrototype = initialPrototype(TestCoverage, COVERAGE_METHODS);
    const plannerPrototype = initialPrototype(MutantTestPlanner, PLANNER_METHODS);
    const injection = own(coverageDescriptor.value, 'inject')?.value;
    expect(coverageDescriptor.writable && coverageDescriptor.configurable && coverageDescriptor.enumerable
      && array(injection).length === 2 && injection[0] === 'dryRunResult' && injection[1] === 'logger', 'Incompatible coverage factory descriptor');
    const originalFrom = coverageDescriptor.value;
    const originalMakePlan = plannerPrototype.makePlan.value;
    const originalPlanMutant = plannerPrototype.planMutant.value;
    const coverageReferences = new WeakMap();
    const stage = (name) => { if (!stats.nativeCoreStages.includes(name)) stats.nativeCoreStages.push(name); };
    const failed = (error, kind) => {
      stats.nativeErrors++;
      if (engine === 'native') throw error;
      stats.lastFallbackReason = error.message;
      stats[kind === 'coverage' ? 'javascriptCoverageFallbacks' : 'javascriptPlanningFallbacks']++;
    };
    let installedPlannerDescriptor;
    function coverageEligible(coverage) {
      data(coverage, TestCoverage.prototype);
      expect(unchanged(TestCoverage.prototype, coveragePrototype) && Reflect.ownKeys(coverage).length === 0
        && coverageReferences.has(coverage), 'Custom or untracked core coverage');
      const reference = coverageReferences.get(coverage);
      if (reference !== undefined) counts(reference);
      return reference;
    }
    function plannerEligible(planner) {
      data(planner, MutantTestPlanner.prototype);
      expect(unchanged(MutantTestPlanner.prototype, plannerPrototype, { makePlan: installedPlannerDescriptor }), 'Replaced planner helper');
      for (const key of Reflect.ownKeys(plannerPrototype)) expect(!Object.hasOwn(planner, key), 'Custom planner helper');
      for (const key of ['testCoverage', 'incrementalDiffer', 'reporter', 'sandbox', 'project', 'timeOverheadMS', 'options', 'logger', 'timeSpentAllTests', 'globalTestFilter']) {
        expect(Object.hasOwn(planner, key), 'Missing planner field');
      }
      coverageEligible(planner.testCoverage);
      sandboxEligible(planner.sandbox);
    }
    function coverageHook(dryRun, logger) {
      let prepared;
      let result;
      try {
        expect(this === undefined || this === TestCoverage, 'Custom coverage factory receiver');
        expect(unchanged(TestCoverage.prototype, coveragePrototype), 'Replaced coverage helper');
        data(dryRun);
        const tests = array(field(dryRun, 'tests'));
        const testIds = tests.map((test) => { data(test); const id = field(test, 'id'); expect(typeof id === 'string', 'Unsupported test id'); return id; });
        let coverage = null;
        let staticReference;
        const mutantCoverage = field(dryRun, 'mutantCoverage');
        if (mutantCoverage !== undefined && mutantCoverage !== null) {
          const raw = data(mutantCoverage);
          staticReference = field(raw, 'static');
          const perTest = Object.entries(data(field(raw, 'perTest')));
          const knownTestIds = new Set(testIds);
          // Upstream warns before finishing association/hit indexing. The logger
          // may mutate these objects, so a warning-bearing batch cannot snapshot.
          expect(perTest.every(([id]) => knownTestIds.has(id)), 'Coverage warning callbacks require upstream indexing');
          coverage = { static: counts(staticReference), perTest: perTest.map(([id, entry]) => [id, counts(entry)]) };
        }
        prepared = { tests, testIds, staticReference, coverage };
        result = invoke('coverageBatch', { version: 1, testIds, coverage });
        validateCoverage(result, prepared);
      } catch (error) {
        failed(error, 'coverage');
        return originalFrom.call(this, dryRun, logger);
      }
      // No effects are inside the fallback catch: logger errors must never replay.
      const indexed = new TestCoverage(
        new Map(result.testsByMutantId.map(([id, indexes]) => [id, new Set(indexes.map((index) => prepared.tests[index]))])),
        new Map(result.testsById.map(([id, index]) => [id, prepared.tests[index]])),
        prepared.staticReference, new Map(result.hitsByMutantId));
      coverageReferences.set(indexed, prepared.staticReference);
      stats.nativeCoverageBatches++;
      stage('coverage');
      for (const testId of result.unknownTestIds) logger.warn(`Found test with id "${testId}" in coverage data, but not in the test results of the dry run. Not taking coverage data for this test into account.`);
      return indexed;
    }
    Object.defineProperty(coverageHook, 'inject', own(originalFrom, 'inject'));
    async function planningHook(mutants) {
      try {
        plannerEligible(this);
      } catch (error) {
        failed(error, 'planning');
        return originalMakePlan.call(this, mutants);
      }
      const diffed = await this.incrementalDiff(mutants);
      let snapshot;
      let decisions;
      try {
        plannerEligible(this);
        snapshot = preparePlanning(this, array(diffed), coverageReferences.get(this.testCoverage));
        decisions = invoke('planningBatch', snapshot.input);
        validatePlanning(decisions, snapshot.input);
      } catch (error) {
        failed(error, 'planning');
        // Already diffed: original makePlan would repeat incremental mutations/effects.
        const mutantPlans = diffed.map((mutant) => this.planMutant(mutant));
        this.reporter.onMutationTestingPlanReady({ mutantPlans });
        this.warnAboutSlow(mutantPlans);
        return mutantPlans;
      }
      stats.nativePlanningBatches++;
      stats.nativePlannedMutants += diffed.length;
      stage('planning');
      const mutantPlans = decisions.map((decision, index) => rehydrate(this, diffed[index], decision, snapshot.coveredIds[index], snapshot.input.rows[index].isStatic, snapshot));
      this.reporter.onMutationTestingPlanReady({ mutantPlans });
      this.warnAboutSlow(mutantPlans);
      return mutantPlans;
    }
    installedPlannerDescriptor = { ...plannerPrototype.makePlan, value: planningHook };
    // Check both targets before making either change.
    expect(plannerPrototype.makePlan.writable && plannerPrototype.makePlan.configurable
      && Object.isExtensible(TestCoverage) && Object.isExtensible(MutantTestPlanner), 'Core hooks are not installable');
    const registration = { stats, originalFrom, originalMakePlan, originalPlanMutant, coverageDescriptor,
      plannerDescriptor: plannerPrototype.makePlan, coverageHook, planningHook };
    Object.defineProperty(TestCoverage, 'from', { ...coverageDescriptor, value: coverageHook });
    Object.defineProperty(MutantTestPlanner.prototype, 'makePlan', installedPlannerDescriptor);
    Object.defineProperty(TestCoverage, INSTALLATION, { value: registration });
    Object.defineProperty(MutantTestPlanner, INSTALLATION, { value: registration });
    return stats;
  } catch (error) {
    if (engine === 'native') throw error;
    stats.lastFallbackReason = error.message;
    return stats;
  }
}

function validateCoverage(result, { tests, testIds, coverage }) {
  keys(result, ['testsById', 'testsByMutantId', 'hitsByMutantId', 'unknownTestIds']);
  const validIndex = (index) => expect(Number.isSafeInteger(index) && index >= 0 && index < tests.length);
  const ids = uniquePairs(result.testsById, (index, id) => { validIndex(index); expect(testIds[index] === id); });
  const expectedIds = [...new Set(testIds)];
  expect(result.testsById.length === expectedIds.length && result.testsById.every(([id], index) => id === expectedIds[index]));
  const winners = new Map(result.testsById);
  testIds.forEach((id, index) => expect(winners.get(id) >= index));
  const winningIndexes = new Set(winners.values());
  const hitIds = new Set((coverage ? [coverage.static, ...coverage.perTest.map(([, entries]) => entries)] : [])
    .flatMap((entries) => entries.map(([id]) => id)));
  uniquePairs(result.testsByMutantId, (indexes, id) => {
    expect(hitIds.has(id));
    expect(Array.isArray(indexes) && indexes.length > 0 && new Set(indexes).size === indexes.length);
    indexes.forEach((index) => { validIndex(index); expect(winningIndexes.has(index)); });
  });
  uniquePairs(result.hitsByMutantId, number);
  const expectedHits = [...hitIds];
  expect(result.hitsByMutantId.length === expectedHits.length && result.hitsByMutantId.every(([id], index) => id === expectedHits[index]));
  const unknown = (coverage?.perTest ?? []).map(([id]) => id).filter((id) => !ids.has(id));
  expect(Array.isArray(result.unknownTestIds) && result.unknownTestIds.length === unknown.length
    && result.unknownTestIds.every((id, index) => id === unknown[index]));
}

function preparePlanning(planner, mutants, staticReference) {
  const options = data(planner.options);
  const ignoreStatic = field(options, 'ignoreStatic');
  expect(typeof ignoreStatic === 'boolean', 'Unsupported ignoreStatic');
  const globalFilter = planner.globalTestFilter;
  if (globalFilter !== undefined) expect(array(globalFilter).every((id) => typeof id === 'string'), 'Unsupported global test filter');
  const coverage = planner.testCoverage;
  const byMutant = collection(coverage.testsByMutantId, Map.prototype);
  const hits = collection(coverage.hitsByMutantId, Map.prototype);
  const coveredIds = [];
  const rows = mutants.map((mutant) => {
    data(mutant);
    for (const key of ['id', 'status', 'statusReason', 'coveredBy', 'killedBy', 'fileName', 'location', 'mutatorName', 'replacement']) field(mutant, key);
    expect(typeof mutant.id === 'string', 'Unsupported mutant id');
    expect(typeof mutant.fileName === 'string', 'Unsupported mutant file name');
    // An inherited static entry could invoke a user accessor/coercion upstream.
    expect(!staticReference || Object.hasOwn(staticReference, mutant.id) || !(mutant.id in staticReference), 'Inherited static coverage');
    const staticCount = staticReference && own(staticReference, mutant.id)?.value;
    if (staticCount !== undefined) number(staticCount);
    const tests = Map.prototype.get.call(byMutant, mutant.id);
    const ids = [];
    const times = [];
    if (tests !== undefined) {
      collection(tests, Set.prototype);
      for (const test of Set.prototype.values.call(tests)) {
        data(test);
        const id = field(test, 'id');
        expect(typeof id === 'string', 'Unsupported covered test id');
        ids.push(id);
        times.push(number(field(test, 'timeSpentMs')));
      }
    }
    coveredIds.push(ids);
    const hitCount = Map.prototype.get.call(hits, mutant.id);
    return { hasStatus: Boolean(mutant.status), isStatic: staticCount > 0, coveredTimesMs: times,
      hitCount: hitCount === undefined ? null : number(hitCount) };
  });
  return { coveredIds, globalFilter, disableBail: field(options, 'disableBail'),
    input: { version: 1, hasCoverage: staticReference !== undefined, ignoreStatic,
      timeSpentAllTests: number(planner.timeSpentAllTests), globalFilterPresent: globalFilter !== undefined,
      timeoutMS: number(field(options, 'timeoutMS')), timeoutFactor: number(field(options, 'timeoutFactor')), timeOverheadMS: number(planner.timeOverheadMS), rows } };
}

function validatePlanning(decisions, input) {
  expect(Array.isArray(decisions) && decisions.length === input.rows.length);
  decisions.forEach((decision, index) => {
    const row = input.rows[index];
    if (decision?.kind === 'existing') {
      keys(decision, ['kind']);
      expect(row.hasStatus);
    } else if (decision?.kind === 'ignore-static') {
      keys(decision, ['kind']);
      expect(!row.hasStatus && input.hasCoverage && input.ignoreStatic && row.isStatic && row.coveredTimesMs.length === 0);
    } else {
      keys(decision, ['kind', 'selection', 'static', 'netTime', 'timeout', 'hitLimit', 'mutantActivation', 'reloadEnvironment']);
      expect(decision.kind === 'run' && !row.hasStatus && ['covered', 'global'].includes(decision.selection));
      const covered = input.hasCoverage && (!row.isStatic || (input.ignoreStatic && row.coveredTimesMs.length > 0));
      expect(!(input.hasCoverage && input.ignoreStatic && row.isStatic && !covered));
      expect(decision.selection === (covered ? 'covered' : 'global'));
      expect(decision.static === (input.hasCoverage ? row.isStatic : null));
      number(decision.netTime);
      number(decision.timeout);
      expect((row.hitCount === null) === (decision.hitLimit === null));
      if (decision.hitLimit !== null) number(decision.hitLimit);
      const filterPresent = covered || input.globalFilterPresent;
      expect(decision.mutantActivation === (filterPresent ? 'runtime' : 'static'));
      expect(decision.reloadEnvironment === !(filterPresent && decision.static === false));
    }
  });
}

function rehydrate(planner, mutant, decision, coveredBy, originalIsStatic, snapshot) {
  if (decision.kind === 'existing' || decision.kind === 'ignore-static') {
    const existing = decision.kind === 'existing';
    return { plan: 'EarlyResult', mutant: { ...mutant,
      status: existing ? mutant.status : 'Ignored', static: originalIsStatic,
      statusReason: existing ? mutant.statusReason : 'Static mutant (and "ignoreStatic" was enabled)',
      coveredBy: existing ? mutant.coveredBy : coveredBy, killedBy: existing ? mutant.killedBy : undefined } };
  }
  const isStatic = decision.static === null ? undefined : decision.static;
  const ids = snapshot.input.hasCoverage ? coveredBy : undefined;
  const testFilter = decision.selection === 'covered' ? coveredBy : snapshot.globalFilter;
  return { plan: 'Run', netTime: decision.netTime, mutant: { ...mutant, coveredBy: ids, static: isStatic }, runOptions: {
    activeMutant: { id: mutant.id, fileName: mutant.fileName, location: mutant.location, mutatorName: mutant.mutatorName, replacement: mutant.replacement },
    mutantActivation: decision.mutantActivation, timeout: decision.timeout, testFilter,
    sandboxFileName: planner.sandbox.sandboxFileFor(mutant.fileName), hitLimit: decision.hitLimit === null ? undefined : decision.hitLimit,
    disableBail: snapshot.disableBail, reloadEnvironment: decision.reloadEnvironment,
  } };
}

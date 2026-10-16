import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function child(body, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { installAcceleration, createInstrumenter } from './lib/index.js';
    import { loadNative } from './lib/native.js';
    import { TestCoverage, MutantTestPlanner, originalFrom, originalMakePlan, planner, logger, testResult, mutant, prohibitOriginals, observeSandbox } from './test/native-core-helpers.js';
    ${body}
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('upstream mode installs no core hooks and createInstrumenter stays isolated', () => {
  child(`
    createInstrumenter(undefined, { coreEngine: 'native' });
    assert.equal(TestCoverage.from, originalFrom);
    assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
    const cache = installAcceleration({ coreEngine: 'upstream' });
    assert.equal(TestCoverage.from, originalFrom);
    assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
    assert.deepEqual(cache.coreStats.nativeCoreStages, []);
  `);
});

test('forced native core rejects unsupported shapes/numbers/responses without JavaScript proof or effects', () => {
  child(`
    const cache = installAcceleration({ coreEngine: 'native', engine: 'upstream' });
    for (const count of [NaN, Infinity, -Infinity, -0]) {
      assert.throws(() => TestCoverage.from({ tests: [], mutantCoverage: { static: { m: count }, perTest: {} } }, logger()));
    }
    const binding = loadNative();
    const original = binding.planningBatch;
    for (const response of ['{}', '{"supported":false,"reason":"no"}', '{"supported":true,"result":[]}']) {
      const p = planner(TestCoverage.from({ tests: [testResult('t')] }, logger()));
      binding.planningBatch = () => response;
      const observed = await observeSandbox(() => assert.rejects(p.result.makePlan([mutant('m')])));
      assert.equal(p.effects.diff, 1);
      assert.equal(observed.calls, 0);
      assert.equal(p.effects.reports.length, 0);
    }
    binding.planningBatch = original;
    const p = planner(TestCoverage.from({ tests: [] }, logger()));
    p.result.planMutant = () => { throw new Error('custom helper must not run'); };
    await assert.rejects(p.result.makePlan([mutant('m')]), /Custom planner helper/);
    assert.equal(p.effects.diff, 0);
    assert.equal(cache.coreStats.javascriptPlanningFallbacks, 0);
    assert.equal(cache.coreStats.javascriptCoverageFallbacks, 0);
  `);
});

test('default auto and environment override are independent from instrumentation mode', () => {
  child(`
    const cache = installAcceleration({ engine: 'upstream' });
    assert.equal(cache.coreStats.engine, 'native');
    const coverage = await prohibitOriginals(() => TestCoverage.from({ tests: [testResult('t')], mutantCoverage: { static: {}, perTest: { t: { m: 1 } } } }, logger()));
    await prohibitOriginals(() => planner(coverage).result.makePlan([mutant('m')]));
    assert.deepEqual(cache.coreStats.nativeCoreStages, ['coverage', 'planning']);
    assert.equal(cache.coreStats.nativeCoverageBatches, 1);
    assert.equal(cache.coreStats.nativePlanningBatches, 1);
    assert.equal(cache.coreStats.javascriptPlanningFallbacks, 0);
  `, { STRYKER_RUST_CORE_ENGINE: 'native' });
  child(`assert.equal(installAcceleration({ coreEngine: 'auto' }).coreStats.engine, 'auto');`, { STRYKER_RUST_CORE_ENGINE: 'native' });
});

test('unrelated factory/helper replacements before installation are guarded atomically', () => {
  for (const mode of ['native', 'auto']) {
    for (const replacement of [
      'TestCoverage.from = function replacement() {};',
      'MutantTestPlanner.prototype.createMutantRunPlan = function replacement() {};',
      'MutantTestPlanner.prototype.planMutant = MutantTestPlanner.prototype.createMutantRunPlan;',
      'Object.defineProperty(TestCoverage.prototype, "testsById", Object.getOwnPropertyDescriptor(TestCoverage.prototype, "testsByMutantId"));',
      'Object.defineProperty(MutantTestPlanner.prototype, "planMutant", { writable: false });',
      'Object.defineProperty(MutantTestPlanner.prototype, "constructor", { value: function Other() {} });',
      'MutantTestPlanner.prototype.extra = MutantTestPlanner.prototype.planMutant;',
    ]) {
      child(`
        ${replacement}
        const beforeCoverage = TestCoverage.from;
        const beforePlanner = MutantTestPlanner.prototype.makePlan;
        ${mode === 'native' ? `assert.throws(() => installAcceleration({ coreEngine: 'native' }), /Replaced/);`
          : `assert.match(installAcceleration({ coreEngine: 'auto' }).coreStats.lastFallbackReason, /Replaced/);`}
        assert.equal(TestCoverage.from, beforeCoverage);
        assert.equal(MutantTestPlanner.prototype.makePlan, beforePlanner);
        assert.equal(Object.hasOwn(TestCoverage, Symbol.for('stryker-mutator-rust.core.v1')), false);
        assert.equal(Object.hasOwn(MutantTestPlanner, Symbol.for('stryker-mutator-rust.core.v1')), false);
      `);
    }
  }
});

test('failed instrumenter preflight leaves all hooks and installation markers unchanged', () => {
  for (const mode of ['auto', 'native']) {
    for (const sabotage of [
      `Object.defineProperty(Instrumenter.prototype, 'instrument', { writable: false });`,
      'Object.preventExtensions(Instrumenter.prototype);',
    ]) {
      child(`
        import { Instrumenter } from '@stryker-mutator/instrumenter';
        ${sabotage}
        const before = [Object.getOwnPropertyDescriptors(TestCoverage), Object.getOwnPropertyDescriptors(MutantTestPlanner),
          Object.getOwnPropertyDescriptors(MutantTestPlanner.prototype), Object.getOwnPropertyDescriptors(Instrumenter.prototype)];
        assert.throws(() => installAcceleration({ coreEngine: '${mode}' }), /Instrumenter hook/);
        const after = [Object.getOwnPropertyDescriptors(TestCoverage), Object.getOwnPropertyDescriptors(MutantTestPlanner),
          Object.getOwnPropertyDescriptors(MutantTestPlanner.prototype), Object.getOwnPropertyDescriptors(Instrumenter.prototype)];
        assert.deepEqual(after, before);
        assert.equal(TestCoverage.from, originalFrom);
        assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
        for (const target of [TestCoverage, MutantTestPlanner, Instrumenter.prototype]) {
          assert.equal(Object.hasOwn(target, Symbol.for('stryker-mutator-rust.core.v1')), false);
          assert.equal(Object.hasOwn(target, Symbol.for('stryker-mutator-rust.instrumenter.v1')), false);
        }
      `);
    }
  }
  child(`
    const first = installAcceleration({ coreEngine: 'native', engine: 'upstream' });
    const coverageHook = TestCoverage.from;
    const planningHook = MutantTestPlanner.prototype.makePlan;
    assert.equal(installAcceleration({ coreEngine: 'upstream', engine: 'native' }), first);
    assert.equal(first.coreStats.engine, 'native');
    assert.equal(TestCoverage.from, coverageHook);
    assert.equal(MutantTestPlanner.prototype.makePlan, planningHook);
  `);
});

test('configuration accessors run once before the final installation preflight', () => {
  for (const mode of ['auto', 'native']) {
    for (const sabotage of [
      'Object.preventExtensions(Instrumenter.prototype);',
      `Object.defineProperty(Instrumenter.prototype, 'instrument', { writable: false });`,
    ]) {
      child(`
        import { Instrumenter } from '@stryker-mutator/instrumenter';
        const beforeInstrument = Instrumenter.prototype.instrument;
        let reads = 0;
        assert.throws(() => installAcceleration({ get coreEngine() {
          reads++;
          ${sabotage}
          return '${mode}';
        } }), /Instrumenter hook/);
        assert.equal(reads, 1);
        assert.equal(Instrumenter.prototype.instrument, beforeInstrument);
        assert.equal(TestCoverage.from, originalFrom);
        assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
        assert.equal(Object.hasOwn(Instrumenter.prototype, Symbol.for('stryker-mutator-rust.instrumenter.v1')), false);
        assert.equal(Object.hasOwn(TestCoverage, Symbol.for('stryker-mutator-rust.core.v1')), false);
        assert.equal(Object.hasOwn(MutantTestPlanner, Symbol.for('stryker-mutator-rust.core.v1')), false);
      `);
    }
  }
});

test('independent package copies share the first process-wide installation', () => {
  child(`
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const directory = pathToFileURL(process.cwd() + '/lib/');
    const dataURL = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
    const rewrite = (text, cacheURL) => text.replace(/from ['"]([^'"]+)['"]/g, (match, specifier) => {
      const url = specifier === './cache.js' && cacheURL ? cacheURL
        : specifier.startsWith('.') ? new URL(specifier, directory).href : import.meta.resolve(specifier);
      return 'from ' + JSON.stringify(url);
    });
    const cacheURL = dataURL(rewrite(await readFile(new URL('cache.js', directory), 'utf8')));
    const copy = await import(dataURL(rewrite(await readFile(new URL('index.js', directory), 'utf8'), cacheURL)));
    const { InstrumentationCache } = await import('./lib/index.js');
    assert.notEqual(copy.InstrumentationCache, InstrumentationCache);
    const first = installAcceleration({ coreEngine: 'native', engine: 'upstream', cache: false });
    const coverageHook = TestCoverage.from;
    const planningHook = MutantTestPlanner.prototype.makePlan;
    const second = copy.installAcceleration({ coreEngine: 'upstream', engine: 'native' });
    assert.equal(second, first);
    assert.equal(second.coreStats.engine, 'native');
    assert.equal(TestCoverage.from, coverageHook);
    assert.equal(MutantTestPlanner.prototype.makePlan, planningHook);
  `);
});

test('forced native rejects coverage warnings and custom sandbox callbacks before effects', () => {
  child(`
    const cache = installAcceleration({ coreEngine: 'native', engine: 'upstream' });
    let warnings = 0;
    assert.throws(() => TestCoverage.from({ tests: [], mutantCoverage: { static: { m: 1 }, perTest: { unknown: {} } } },
      { warn() { warnings++; throw new Error('must not execute'); } }), /Coverage warning callbacks/);
    assert.equal(warnings, 0);
    assert.equal(cache.coreStats.nativeCoverageBatches, 0);
    let calls = 0;
    const p = planner(TestCoverage.from({ tests: [] }, logger()), {}, { sandbox: { sandboxFileFor() { calls++; throw new Error('must not execute'); } } });
    await assert.rejects(p.result.makePlan([mutant('m')]), /Unsupported core prototype|Custom sandbox/);
    assert.equal(calls, 0);
    assert.equal(p.effects.diff, 0);
    assert.equal(p.effects.reports.length, 0);
    assert.equal(cache.coreStats.javascriptCoverageFallbacks, 0);
    assert.equal(cache.coreStats.javascriptPlanningFallbacks, 0);
  `);
});

test('invalid coreEngine fails before process-wide hooks are installed', () => {
  child(`
    assert.throws(() => installAcceleration({ coreEngine: 'other' }), /coreEngine/);
    assert.equal(TestCoverage.from, originalFrom);
    assert.equal(MutantTestPlanner.prototype.makePlan, originalMakePlan);
    assert.equal(installAcceleration({ coreEngine: 'native' }).coreStats.engine, 'native');
  `);
});

test('the internal core seam rejects any version other than exactly 10.0.0', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    require('@stryker-mutator/core/package.json').version = '10.0.1';
    const { installAcceleration } = await import('./lib/index.js');
    assert.throws(() => installAcceleration({ coreEngine: 'native' }), /exactly StrykerJS 10.0.0/);
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

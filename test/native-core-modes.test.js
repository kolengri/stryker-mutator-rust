import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function child(body, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { installAcceleration, createInstrumenter } from './lib/index.js';
    import { loadNative } from './lib/native.js';
    import { TestCoverage, MutantTestPlanner, originalFrom, originalMakePlan, planner, logger, testResult, mutant, prohibitOriginals } from './test/native-core-helpers.js';
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
      await assert.rejects(p.result.makePlan([mutant('m')]));
      assert.equal(p.effects.diff, 1);
      assert.equal(p.effects.sandbox.length, 0);
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
    for (const replacement of ['TestCoverage.from = function replacement() {};', 'MutantTestPlanner.prototype.createMutantRunPlan = function replacement() {};']) {
      child(`
        ${replacement}
        const beforeCoverage = TestCoverage.from;
        const beforePlanner = MutantTestPlanner.prototype.makePlan;
        ${mode === 'native' ? `assert.throws(() => installAcceleration({ coreEngine: 'native' }), /Replaced/);`
          : `assert.match(installAcceleration({ coreEngine: 'auto' }).coreStats.lastFallbackReason, /Replaced/);`}
        assert.equal(TestCoverage.from, beforeCoverage);
        assert.equal(MutantTestPlanner.prototype.makePlan, beforePlanner);
      `);
    }
  }
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('artifacts/bun-execution-acceleration', { recursive: true });
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim() === '1.4.3';

function probe(runtime, body) {
  const result = spawnSync(runtime, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { installCoreAcceleration } from './lib/core.js';
    import { installAcceleration } from 'stryker-mutator-rust';
    import { TestCoverage, MutantTestPlanner, originalFrom, originalMakePlan, planner, logger, testResult, mutant } from './test/native-core-helpers.js';
    ${body}
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('Node and qualified Bun enter actual native Core stages and preserve pinned planning results', () => {
  const receipts = [];
  for (const runtime of [process.execPath, ...(bunAvailable ? ['bun'] : [])]) {
    const output = probe(runtime, `
      const dry = { tests: [testResult('t')], mutantCoverage: { static: {}, perTest: { t: { m: 1 } } } };
      const original = originalFrom(dry, logger());
      const expected = await originalMakePlan.call(planner(original).result, [mutant('m')]);
      const stats = installAcceleration({ coreEngine: 'native', engine: 'upstream' }).coreStats;
      const actual = TestCoverage.from(dry, logger());
      assert.deepEqual([...actual.testsByMutantId], [...original.testsByMutantId]);
      assert.deepEqual(await planner(actual).result.makePlan([mutant('m')]), expected);
      assert.equal(stats.nativeCoverageBatches, 1);
      assert.equal(stats.nativePlanningBatches, 1);
      assert.deepEqual(stats.nativeCoreStages, ['coverage', 'planning']);
      console.log(JSON.stringify({ node: process.version, bun: process.versions.bun, stats }));
    `);
    receipts.push(JSON.parse(output));
  }
  writeFileSync('artifacts/bun-execution-acceleration/core-fast-path.json', JSON.stringify(receipts, null, 2));
});

test('Bun runtime pins retain atomic factory/helper/descriptor and source-file tamper guards', { skip: !bunAvailable && 'Bun 1.4.3 required' }, () => {
  for (const replacement of [
    'TestCoverage.from = function replacement() {};',
    'MutantTestPlanner.prototype.planMutant = function replacement() {};',
    'Object.defineProperty(MutantTestPlanner.prototype, "planMutant", { writable: false });',
    'Object.defineProperty(TestCoverage.prototype, "testsById", Object.getOwnPropertyDescriptor(TestCoverage.prototype,"testsByMutantId"));',
    'MutantTestPlanner.prototype.extra = ()=>{};',
  ]) probe('bun', `
    ${replacement}
    const before = [TestCoverage.from, MutantTestPlanner.prototype.makePlan];
    assert.throws(()=>installCoreAcceleration({coreEngine:'native'}), /Replaced/);
    assert.equal(TestCoverage.from,before[0]); assert.equal(MutantTestPlanner.prototype.makePlan,before[1]);
    assert.equal(Object.hasOwn(TestCoverage,Symbol.for('stryker-mutator-rust.core.v1')),false);
  `);
  probe('bun', `
    import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, rmSync } from 'node:fs';
    import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
    import { join, dirname } from 'node:path'; import { qualifyCoreRuntime } from './lib/core-runtime.js';
    const base = dirname(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
    const directory = mkdtempSync(join(process.cwd(),'artifacts/bun-execution-acceleration/core-source-'));
    try {
      for (const path of ['mutants/test-coverage.js','mutants/mutant-test-planner.js','sandbox/sandbox.js']) {
        mkdirSync(dirname(join(directory,'dist/src',path)),{recursive:true});
        copyFileSync(join(base,'dist/src',path),join(directory,'dist/src',path));
      }
      const url = pathToFileURL(join(directory,'package.json'));
      qualifyCoreRuntime(url);
      appendFileSync(join(directory,'dist/src/mutants/test-coverage.js'),'\\n// replaced');
      assert.throws(()=>qualifyCoreRuntime(url),/Replaced/);
      const descriptor=Object.getOwnPropertyDescriptor(process.versions,'bun');
      Object.defineProperty(process.versions,'bun',{value:'0.0.0',configurable:true});
      assert.throws(()=>qualifyCoreRuntime(url),/Unqualified/);
      Object.defineProperty(process.versions,'bun',descriptor);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  `);
});

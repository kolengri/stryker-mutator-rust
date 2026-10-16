import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';

const url = pathToFileURL(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
export const { TestCoverage } = await import(new URL('./dist/src/mutants/test-coverage.js', url));
export const { MutantTestPlanner } = await import(new URL('./dist/src/mutants/mutant-test-planner.js', url));
export const originalFrom = TestCoverage.from;
export const originalMakePlan = MutantTestPlanner.prototype.makePlan;
export const originalPlanMutant = MutantTestPlanner.prototype.planMutant;
export const logger = () => ({ warnings: [], warn(message) { this.warnings.push(message); } });
export const testResult = (id, timeSpentMs = 10) => ({ id, timeSpentMs, fileName: 'test.js', name: id, status: 'Success' });
export const mutant = (id, extra = {}) => ({ id, fileName: `${id}.js`, location: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }, mutatorName: 'BooleanLiteral', replacement: 'false', ...extra });
export function planner(coverage, options = {}, overrides = {}) {
  const effects = { diff: 0, sandbox: [], reports: [], warnings: [] };
  const project = { testFiles: [], incrementalReport: { files: {} }, files: new Map() };
  const differ = { diff(mutants) { effects.diff++; return mutants; } };
  const reporter = { onMutationTestingPlanReady(event) { effects.reports.push(event); } };
  const sandbox = { sandboxFileFor(file) { effects.sandbox.push(file); return `sandbox/${file}`; } };
  const log = { warn(message) { effects.warnings.push(message); } };
  const result = new MutantTestPlanner(coverage, overrides.differ ?? differ, overrides.reporter ?? reporter,
    overrides.sandbox ?? sandbox, overrides.project ?? project, 501,
    { ignoreStatic: false, disableBail: false, timeoutMS: 5000, timeoutFactor: 1.5, warnings: true, ...options }, overrides.logger ?? log);
  return { result, effects };
}
// Inspector function breakpoints observe the captured originals without replacing
// methods (which would correctly make the native path ineligible).
export async function prohibitOriginals(action) {
  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  let calls = 0;
  session.on('Debugger.paused', () => { calls++; session.post('Debugger.resume'); });
  globalThis.__nativeCoreOriginals = [originalFrom, originalPlanMutant];
  try {
    await post('Debugger.enable');
    for (let index = 0; index < 2; index++) {
      const { result } = await post('Runtime.evaluate', { expression: `globalThis.__nativeCoreOriginals[${index}]` });
      await post('Debugger.setBreakpointOnFunctionCall', { objectId: result.objectId });
    }
    const result = await action();
    assert.equal(calls, 0, 'accepted native paths must not call original coverage indexing or planMutant');
    return result;
  } finally {
    delete globalThis.__nativeCoreOriginals;
    session.disconnect();
  }
}

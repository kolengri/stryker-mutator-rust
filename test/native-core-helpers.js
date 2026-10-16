import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';

const url = pathToFileURL(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
export const { TestCoverage } = await import(new URL('./dist/src/mutants/test-coverage.js', url));
export const { MutantTestPlanner } = await import(new URL('./dist/src/mutants/mutant-test-planner.js', url));
export const { Sandbox } = await import(new URL('./dist/src/sandbox/sandbox.js', url));
export const originalFrom = TestCoverage.from;
export const originalMakePlan = MutantTestPlanner.prototype.makePlan;
export const originalPlanMutant = MutantTestPlanner.prototype.planMutant;
export const originalSandboxFileFor = Sandbox.prototype.sandboxFileFor;
export const logger = () => ({ warnings: [], warn(message) { this.warnings.push(message); } });
export const testResult = (id, timeSpentMs = 10) => ({ id, timeSpentMs, fileName: 'test.js', name: id, status: 'Success' });
export const mutant = (id, extra = {}) => ({ id, fileName: `${id}.js`, location: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }, mutatorName: 'BooleanLiteral', replacement: 'false', ...extra });
const fixtureFiles = ['m.js', 'static.js', 'runtime.js', 'hybrid.js', 'uncovered.js', 'existing.js', 'missing.js',
  'zero.js', 'negative.js', 'floating.js', '1.js', '2.js'];
export function preparedSandbox(files = fixtureFiles) {
  const sandbox = new Sandbox({ inPlace: false }, { debug() {} }, { path: 'sandbox' }, {}, undefined, {});
  sandbox.fileMap = new Map(files.map((file) => [file, `sandbox/${file}`]));
  return sandbox;
}
export function planner(coverage, options = {}, overrides = {}) {
  const effects = { diff: 0, sandbox: [], reports: [], warnings: [] };
  const project = { testFiles: [], incrementalReport: { files: {} }, files: new Map() };
  const differ = { diff(mutants) { effects.diff++; return mutants; } };
  const reporter = { onMutationTestingPlanReady(event) { effects.reports.push(event); } };
  const sandbox = preparedSandbox([...fixtureFiles, ...(overrides.project ?? project).testFiles, ...(overrides.sandboxFiles ?? [])]);
  const log = { warn(message) { effects.warnings.push(message); } };
  const result = new MutantTestPlanner(coverage, overrides.differ ?? differ, overrides.reporter ?? reporter,
    overrides.sandbox ?? sandbox, overrides.project ?? project, 501,
    { ignoreStatic: false, disableBail: false, timeoutMS: 5000, timeoutFactor: 1.5, warnings: true, ...options }, overrides.logger ?? log);
  return { result, effects };
}
// Inspector function breakpoints observe the captured originals without replacing
// methods (which would correctly make the native path ineligible).
async function observeFunctions(functions, action) {
  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  const calls = functions.map(() => 0);
  const breakpoints = new Map();
  session.on('Debugger.paused', ({ params }) => {
    for (const breakpoint of params.hitBreakpoints) {
      const index = breakpoints.get(breakpoint);
      if (index !== undefined) calls[index]++;
    }
    session.post('Debugger.resume');
  });
  globalThis.__nativeCoreOriginals = functions;
  try {
    await post('Debugger.enable');
    for (let index = 0; index < functions.length; index++) {
      const { result } = await post('Runtime.evaluate', { expression: `globalThis.__nativeCoreOriginals[${index}]` });
      const { breakpointId } = await post('Debugger.setBreakpointOnFunctionCall', { objectId: result.objectId });
      breakpoints.set(breakpointId, index);
    }
    return { value: await action(calls), calls };
  } finally {
    delete globalThis.__nativeCoreOriginals;
    session.disconnect();
  }
}
export async function prohibitOriginals(action, expectedSandboxCalls) {
  const functions = [originalFrom, originalPlanMutant];
  if (expectedSandboxCalls !== undefined) functions.push(originalSandboxFileFor);
  const { value, calls } = await observeFunctions(functions, action);
  assert.deepEqual(calls.slice(0, 2), [0, 0], 'accepted native paths must not call original coverage indexing or planMutant');
  if (expectedSandboxCalls !== undefined) assert.equal(calls[2], expectedSandboxCalls, 'observe the actual pinned sandbox mapper');
  return value;
}
export async function observeSandbox(action) {
  const { value, calls } = await observeFunctions([originalSandboxFileFor], action);
  return { value, calls: calls[0] };
}

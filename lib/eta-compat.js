// Optional instrumentation of exact pinned coordinator methods. No execution decisions.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

let installed;
let subscriber;
const fingerprint = (fn) => createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');

export async function loadEtaCompatibility() {
  if (installed) return installed;
  const require = createRequire(import.meta.url);
  if (require('@stryker-mutator/core/package.json').version !== '10.0.0') throw new Error('ETA lifecycle integration requires exactly StrykerJS 10.0.0');
  const base = pathToFileURL(require.resolve('@stryker-mutator/core/package.json'));
  const { RetryRejectedDecorator: Retry } = await import(new URL('./dist/src/test-runner/retry-rejected-decorator.js', base));
  const { ResourceDecorator: Resource } = await import(new URL('./dist/src/concurrent/resource-decorator.js', base));
  const { ConcurrencyTokenProvider: Capacity } = await import(new URL('./dist/src/concurrent/concurrency-token-provider.js', base));
  const checks = [
    // V8 and JavaScriptCore preserve different method spelling/indentation.
    [Retry.prototype, 'mutantRun', 'bedaf97a9b5296fe14a0a8a82ae7beb9aa79c12daa0e043a672b2d1b28f907ea', '48d36b1dfdfb1c1919da759d9b4116e02a3bbb84c66a5031b3163177b5ddda62'],
    [Retry.prototype, 'run', '35a71d22fdb0e792c5cd1078de1fa31bbd6184752d67f2b42c483ff64dd23b62', '41109e8a44baeb9ae66ccc64bd7486dd2dc86d8f065e512aa4b33e25a0f90db9'],
    [Resource.prototype, 'init', '8392d336f696c4043fbff04716f1ab7ee54401637cd30237cdcb9e30592ea305', '05b96c3db1ddc0d514982f6a2958d9ad7530933ceeb9189d288bdf07f13113ac'],
    [Resource.prototype, 'recover', '33c021e6a8d2ffa4445eaac9721596e2b1ee9f0cbf4a24d1bd93abec88b25178', '1fe45d38562bb85011a1428c669ce38b8c6d4f3fbd47727750510966d00f81aa'],
    [Capacity.prototype, 'freeCheckers', '95a0e1d332816dd2920232a26abbf7353b2b6b73767a1c156583eadfcce7a728', '6a4988a6d918a8856f7bedddbe5d186797204a84bbc8a99d21be9e5d9f62699e'],
  ];
  for (const [prototype, key, nodeHash, bunHash] of checks) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (!descriptor?.writable || !descriptor.configurable || fingerprint(descriptor.value) !== (process.versions.bun ? bunHash : nodeHash)) throw new Error(`Unsupported ETA lifecycle seam: ${key}`);
  }
  if (!Object.isExtensible(Retry.prototype) || Object.hasOwn(Retry.prototype, 'init') || Object.hasOwn(Retry.prototype, 'recover')) throw new Error('Conflicting ETA lifecycle integration');
  const originalRun = Retry.prototype.mutantRun;
  const originalRetries = Retry.prototype.run;
  const originalInit = Resource.prototype.init;
  const originalFree = Capacity.prototype.freeCheckers;
  const active = new WeakMap();
  // Observer failures are quarantined, never replaying or changing a test call.
  const notify = (observer, method, ...args) => {
    if (!observer) return;
    try { observer[method]?.(...args); } catch (error) { try { observer.failure(error); } catch { /* Advisory callback only. */ } }
  };
  Object.defineProperty(Retry.prototype, 'mutantRun', { ...Object.getOwnPropertyDescriptor(Retry.prototype, 'mutantRun'), value: async function (options) {
    const observer = subscriber;
    if (!observer) return originalRun.call(this, options);
    const id = options.activeMutant.id;
    const record = { attempts: 0, counted: new WeakSet() };
    active.set(this, record);
    notify(observer, 'start', id);
    try {
      const result = await originalRun.call(this, options);
      notify(observer, 'finish', id, record.attempts, result.status === 'timeout');
      return result;
    } finally { active.delete(this); }
  } });
  Object.defineProperty(Retry.prototype, 'init', { configurable: true, writable: true, value: async function () {
    const result = await originalInit.call(this);
    notify(subscriber, 'ready', this);
    return result;
  } });
  Object.defineProperty(Retry.prototype, 'run', { ...Object.getOwnPropertyDescriptor(Retry.prototype, 'run'), value: function (actRun, attemptsLeft, lastError) {
    const record = active.get(this);
    if (record && !record.counted.has(actRun)) {
      const execute = actRun;
      actRun = () => { record.attempts++; return execute(); };
      record.counted.add(actRun);
    }
    return originalRetries.call(this, actRun, attemptsLeft, lastError);
  } });
  Object.defineProperty(Capacity.prototype, 'freeCheckers', { ...Object.getOwnPropertyDescriptor(Capacity.prototype, 'freeCheckers'), value: function () {
    const result = originalFree.call(this);
    notify(subscriber, 'capacity', this.concurrencyTestRunners + this.concurrencyCheckers);
    return result;
  } });
  installed = { subscribe(observer) {
    if (subscriber) throw new Error('Only one compatible ETA reporter can be active per process');
    subscriber = observer;
    return () => { if (subscriber === observer) subscriber = undefined; };
  } };
  return installed;
}

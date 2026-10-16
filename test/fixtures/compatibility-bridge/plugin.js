import { appendFileSync, writeSync } from 'node:fs';
import assert from 'node:assert/strict';
import { InjectorDisposedError } from 'typed-inject';
import { setTimeout } from 'node:timers/promises';
import { commonTokens, declareClassPlugin, declareFactoryPlugin, declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

function record(options, event) {
  if (options.cleanupFile) appendFileSync(options.cleanupFile, `${event}\n`);
}

class ExampleRunner {
  static inject = [commonTokens.options, commonTokens.fileDescriptions, commonTokens.logger, commonTokens.getLogger, commonTokens.injector, commonTokens.target];

  constructor(options, files, logger, getLogger, injector, target) {
    this.options = options;
    this.files = files;
    this.trace = [];
    this.logger = logger;
    this.context = {
      optionsFrozen: Object.isFrozen(options) && Object.isFrozen(options.nested),
      filesFrozen: Object.isFrozen(files) && Object.values(files).every(Object.isFrozen),
      hasInjector: typeof injector.provideClass === 'function',
      target: target?.name ?? null,
      controlEnvAbsent: process.env.STRYKER_RUST_BRIDGE_TOKEN === undefined && process.env.STRYKER_RUST_BRIDGE_ADDRESS === undefined,
    };
    console.log('plugin stdout: not JSON');
    writeSync(1, '{direct stdout without a newline}');
    console.error('plugin stderr');
    logger.info('constructed %s', 'runner');
    getLogger('CustomCategory').debug('custom', { key: 42 });
  }

  async init() {
    record(this.options, 'init');
    if (this.options.failInit) throw new Error('init failed deliberately');
  }

  capabilities() {
    return { reloadEnvironment: true, ...this.context };
  }

  async dryRun(params) {
    this.trace.push(`start:${params.label}`);
    record(this.options, `start:${params.label}`);
    if (params.delay) await setTimeout(params.delay);
    if (params.error === 'primitive') throw 'primitive plugin failure';
    if (params.error === 'error') throw new TypeError('plugin failure');
    if (params.error === 'serialization') return { value: 1n };
    if (params.error === 'function') return () => {};
    if (params.error === 'symbol') return Symbol('unserializable');
    this.trace.push(`end:${params.label}`);
    record(this.options, `end:${params.label}`);
    return { status: 'complete', params, trace: [...this.trace], options: this.options, files: this.files };
  }

  mutantRun(params) {
    return { status: 'survived', nrOfTests: 1, params };
  }

  async dispose() {
    record(this.options, 'plugin disposed');
  }
}

class Dependency {
  static inject = [commonTokens.options];
  constructor(options) { this.options = options; }
  dispose() { record(this.options, 'dependency disposed'); }
}

function factory(injector, options) {
  const context = injector.provideClass('dependency', Dependency);
  context.resolve('dependency');
  if (options.failConstruction) throw new Error('construction failed deliberately');
  return context.injectClass(ExampleRunner);
}
factory.inject = [commonTokens.injector, commonTokens.options];

function aliasedFactory(injector, options) {
  if (options.failDependencyDisposal) {
    injector.provideFactory('failingDependency', () => ({
      dispose() { record(options, 'failing dependency disposed'); throw new Error('dependency disposal failed deliberately'); },
    })).resolve('failingDependency');
    injector.provideFactory('healthyDependency', () => ({
      dispose() { record(options, 'healthy dependency disposed'); },
    })).resolve('healthyDependency');
  }
  let aliasesSame = false;
  const runner = Object.freeze({
    capabilities() { return { frozen: Object.isFrozen(this), aliasesSame }; },
    async dryRun() { return { status: 'complete', tests: [] }; },
    async mutantRun() { return { status: 'survived', nrOfTests: 0 }; },
    dispose() { record(options, 'aliased runner disposed'); },
  });
  const context = injector
    .provideFactory('firstAlias', () => runner)
    .provideFactory('secondAlias', () => runner)
    .provideFactory('thirdAlias', () => runner);
  aliasesSame = ['firstAlias', 'secondAlias', 'thirdAlias'].every((token) => context.resolve(token) === runner);
  return context.resolve('thirdAlias');
}
aliasedFactory.inject = [commonTokens.injector, commonTokens.options];

function failingCleanupFactory(injector, options) {
  let context;
  const runner = Object.freeze({
    capabilities() { return { frozen: Object.isFrozen(this) }; },
    async dryRun() { return { status: 'complete', tests: [] }; },
    async mutantRun() { return { status: 'survived', nrOfTests: 0 }; },
    dispose() {
      for (const scope of [injector, context]) {
        assert.throws(() => scope.resolve('unknown'), InjectorDisposedError);
        assert.throws(() => scope.provideValue('new', true), InjectorDisposedError);
      }
      record(options, 'ancestor plugin disposed');
    },
  });
  const alias = injector.provideFactory('ancestorRunner', () => runner);
  context = alias.provideFactory('runnerAlias', () => runner);
  context.resolve('ancestorRunner');
  context.resolve('runnerAlias');
  context.provideFactory('syncFailure', () => ({ dispose() {
    record(options, 'sync dependency disposed');
    throw new TypeError('sync cleanup failure');
  } })).resolve('syncFailure');
  context.provideFactory('asyncFailure', () => ({ async dispose() {
    await Promise.resolve();
    record(options, 'async dependency disposed');
    throw new RangeError('async cleanup failure');
  } })).resolve('asyncFailure');
  return runner;
}
failingCleanupFactory.inject = [commonTokens.injector, commonTokens.options];

const resultCompatibility = {
  capabilities() { return {}; },
  dryRun(params) {
    if (params.returnError) return { status: 'error', errorMessage: new TypeError('dry run result error') };
    globalThis.__mutantCoverage__ = { static: { one: 1 }, perTest: {} };
    return { status: 'complete', tests: [], ...(params.ownCoverage ? { mutantCoverage: { static: { own: 2 } } } : {}) };
  },
  mutantRun() { return { status: 'error', errorMessage: new Error('mutant result error') }; },
};

function callableRunnerFactory(options) {
  function runner() { throw new Error('The callable plugin itself must not be invoked.'); }
  runner.capabilities = () => ({ callable: true });
  runner.dryRun = async (params) => { options = { ...options, ...params }; return { status: 'complete', tests: [] }; };
  runner.mutantRun = async () => ({ status: 'survived', nrOfTests: 0 });
  runner.dispose = () => record(options, 'callable disposed');
  return runner;
}
callableRunnerFactory.inject = [commonTokens.options];

function CallableDeclaration() { throw new Error('A plugin declaration must not be invoked.'); }
CallableDeclaration.kind = PluginKind.TestRunner;
CallableDeclaration.value = callableRunnerFactory({});

const value = {
  capabilities() { return { reloadEnvironment: false }; },
  dryRun(params) { this.options = params; return { status: 'complete', tests: [] }; },
  mutantRun() { return { status: 'survived', nrOfTests: 0 }; },
  dispose() { record(this.options ?? {}, 'value disposed'); },
};

class Checker {
  static inject = [commonTokens.options];
  constructor(options) { this.options = options; }
  async init() {}
  async group(mutants) { return [mutants.map(({ id }) => id)]; }
  async check(mutants) { return Object.fromEntries(mutants.map(({ id }) => [id, { status: 'Passed' }])); }
  dispose() { record(this.options, 'checker disposed'); }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'class', ExampleRunner),
  declareFactoryPlugin(PluginKind.TestRunner, 'factory', factory),
  declareFactoryPlugin(PluginKind.TestRunner, 'aliased', aliasedFactory),
  declareFactoryPlugin(PluginKind.TestRunner, 'cleanup-errors', failingCleanupFactory),
  declareValuePlugin(PluginKind.TestRunner, 'result-compatibility', resultCompatibility),
  declareFactoryPlugin(PluginKind.TestRunner, 'callable-factory', callableRunnerFactory),
  declareValuePlugin(PluginKind.TestRunner, 'callable-value', callableRunnerFactory({})),
  Object.create({ kind: PluginKind.TestRunner, name: 'inherited-factory', factory: callableRunnerFactory }),
  { kind: PluginKind.TestRunner, name: 'inactive-factory', factory: undefined, injectableClass: undefined, value: callableRunnerFactory({}) },
  CallableDeclaration,
  declareValuePlugin(PluginKind.TestRunner, 'value', value),
  declareValuePlugin(PluginKind.TestRunner, 'false', false),
  declareValuePlugin(PluginKind.TestRunner, 'zero', 0),
  declareValuePlugin(PluginKind.TestRunner, 'null', null),
  declareValuePlugin(PluginKind.TestRunner, 'undefined', undefined),
  declareValuePlugin(PluginKind.TestRunner, 'missing', { capabilities() { return {}; } }),
  declareValuePlugin(PluginKind.TestRunner, 'bad-dispose', {
    ...value,
    dispose() { record(this.options, 'bad dispose'); throw new Error('dispose failed deliberately'); },
  }),
  declareClassPlugin(PluginKind.Checker, 'checker', Checker),
  declareValuePlugin(PluginKind.Checker, 'singular', { async init() {}, async check() { return {}; } }),
];
export const strykerValidationSchema = { properties: { bridgeFixture: { type: 'boolean' } } };

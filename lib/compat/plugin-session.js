import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { importPlugin } from './module-loader.js';
import { disposeInjector } from './injector-disposal.js';
import { errorDetails } from './errors.js';

export class BridgeError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function assert(condition, name, message) {
  if (!condition) throw new BridgeError(name, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReference(value) {
  return value !== null && ['object', 'function'].includes(typeof value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function logArgument(value) {
  try {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'function' || typeof item === 'symbol') return inspect(item);
      if (item instanceof Error) return errorDetails(item);
      if (item !== null && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) ?? 'null');
  } catch {
    return inspect(value, { depth: 2, customInspect: false, getters: false });
  }
}

const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function validateModules(params) {
  assert(isRecord(params), 'InvalidParamsError', 'Plugin module params must be an object.');
  assert(typeof params.cwd === 'string' && path.isAbsolute(params.cwd), 'InvalidParamsError', 'cwd must be an absolute directory path.');
  assert(Array.isArray(params.modules) && params.modules.length <= 128 && params.modules.every((module) => typeof module === 'string' && module.length > 0), 'InvalidParamsError', 'modules must contain at most 128 nonempty module specifiers.');
}

async function loadModules({ cwd, modules }) {
  const loadedModules = [];
  const schemaContributions = [];
  const plugins = [];
  for (const specifier of modules) {
    const { moduleName, namespace } = await importPlugin(specifier, cwd);
    const declarations = namespace.strykerPlugins ?? [];
    assert(Array.isArray(declarations), 'InvalidPluginError', `${specifier} exports an invalid strykerPlugins value.`);
    for (const declaration of declarations) {
      assert((isRecord(declaration) || typeof declaration === 'function') && typeof declaration.kind === 'string' && typeof declaration.name === 'string', 'InvalidPluginError', `${specifier} contains an invalid plugin declaration.`);
      plugins.push(declaration);
    }
    loadedModules.push({ moduleName, plugins: declarations.map(({ kind, name }) => ({ kind, name })) });
    if (namespace.strykerValidationSchema !== undefined) {
      assert(isRecord(namespace.strykerValidationSchema), 'InvalidPluginError', `${specifier} exports an invalid strykerValidationSchema value.`);
      schemaContributions.push(namespace.strykerValidationSchema);
    }
  }
  return { cwd, modules: [...modules], loadedModules, schemaContributions, plugins };
}

/** One live SDK plugin. Scheduling, deadlines, and cancellation belong to Rust. */
export class PluginSession {
  state = 'new';
  injector;
  plugin;
  kind;
  initialized = false;
  disposePromise;
  prepared;
  runnerSdk;

  constructor(sendLog) {
    this.sendLog = sendLog;
  }

  async prepare(params) {
    assert(this.state === 'new', 'StateError', 'Plugin metadata can only be prepared before initialization.');
    validateModules(params);
    this.state = 'preparing';
    try {
      process.chdir(params.cwd);
      this.prepared = await loadModules(params);
      const { strykerCoreSchema } = await import('@stryker-mutator/api/core');
      const apiPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.resolve('@stryker-mutator/api/core')), 'utf8'));
      this.state = 'prepared';
      return {
        loadedModules: this.prepared.loadedModules,
        schemaContributions: this.prepared.schemaContributions,
        coreSchema: strykerCoreSchema,
        sdkVersion: apiPackage.version,
      };
    } catch (error) {
      await this.cleanupAfterFailure();
      throw error;
    }
  }

  async initialize(params) {
    assert(['new', 'prepared'].includes(this.state), 'StateError', 'The worker can only be initialized once.');
    validateModules(params);
    assert(isRecord(params.options) && isRecord(params.fileDescriptions), 'InvalidParamsError', 'options and fileDescriptions must be objects.');
    assert(isRecord(params.plugin) && typeof params.plugin.name === 'string' && params.plugin.name.length > 0, 'InvalidParamsError', 'plugin must specify kind and name.');
    assert(['TestRunner', 'Checker'].includes(params.plugin.kind), 'UnsupportedPluginError', `Unsupported plugin kind: ${String(params.plugin.kind)}.`);
    if (this.prepared) {
      const resolved = this.prepared.loadedModules.map(({ moduleName }) => moduleName);
      assert(params.cwd === this.prepared.cwd && [this.prepared.modules, resolved].some((modules) => JSON.stringify(modules) === JSON.stringify(params.modules)), 'StateError', 'Prepared initialization must use the same cwd and module selection.');
    }
    this.state = 'initializing';
    try {
      process.chdir(params.cwd);
      const [{ commonTokens }, { createInjector, Scope }, { default: injectionPackage }] = await Promise.all([
        import('@stryker-mutator/api/plugin'),
        import('typed-inject'),
        import('typed-inject/package.json', { with: { type: 'json' } }),
      ]);
      assert(injectionPackage.version === '5.0.0', 'InjectorCompatibilityError', 'This adapter requires typed-inject 5.0.0.');
      const options = deepFreeze(params.options);
      const fileDescriptions = deepFreeze(params.fileDescriptions);
      const threshold = options.logLevel === 'off' ? Infinity : Math.max(0, levels.indexOf(options.logLevel ?? 'info'));
      const getLogger = (category = 'UNKNOWN') => {
        const logger = {};
        for (const [index, level] of levels.entries()) {
          logger[`is${level[0].toUpperCase()}${level.slice(1)}Enabled`] = () => index >= threshold;
          logger[level] = (message, ...args) => {
            if (index >= threshold) this.sendLog({ level, category, message: String(message), args: args.map(logArgument) });
          };
        }
        return logger;
      };
      const loggerFactory = (factory, target) => factory(target?.name);
      loggerFactory.inject = [commonTokens.getLogger, commonTokens.target];
      // Retain the root so failed construction also disposes dependencies that a
      // plugin factory provided on child injectors before throwing.
      this.injector = createInjector();
      let context = this.injector
        .provideValue(commonTokens.options, options)
        .provideValue(commonTokens.fileDescriptions, fileDescriptions)
        .provideValue(commonTokens.getLogger, getLogger)
        .provideFactory(commonTokens.logger, loggerFactory, Scope.Transient);

      const { loadedModules, schemaContributions, plugins } = this.prepared ?? await loadModules(params);
      const selected = plugins.find(({ kind, name }) => kind === params.plugin.kind && name.toLowerCase() === params.plugin.name.toLowerCase());
      assert(selected, 'PluginNotFoundError', `Cannot find ${params.plugin.kind} plugin "${params.plugin.name}".`);
      // Providers register the returned instance for disposal. injectClass and
      // injectFunction alone do not; provideValue does not register disposal.
      const token = 'strykerRustSelectedPlugin';
      if (selected.factory) {
        assert(typeof selected.factory === 'function', 'InvalidPluginError', 'Plugin factory must be a function.');
        context = context.provideFactory(token, selected.factory);
      } else if (selected.injectableClass) {
        assert(typeof selected.injectableClass === 'function', 'InvalidPluginError', 'Plugin injectableClass must be a constructor.');
        context = context.provideClass(token, selected.injectableClass);
      } else if ('value' in selected) {
        context = context.provideFactory(token, () => selected.value);
      } else {
        throw new BridgeError('InvalidPluginError', 'Plugin declaration is missing factory, injectableClass, or value.');
      }
      this.plugin = context.resolve(token);
      assert(isReference(this.plugin), 'InvalidPluginError', `Plugin "${selected.name}" must produce an object or function.`);
      this.kind = selected.kind;
      if (this.kind === 'TestRunner') {
        const [{ errorToString }, { DryRunStatus, MutantRunStatus }] = await Promise.all([
          import('@stryker-mutator/util'), import('@stryker-mutator/api/test-runner'),
        ]);
        this.runnerSdk = { errorToString, DryRunStatus, MutantRunStatus };
      }
      this.state = 'ready';
      return { plugin: { kind: selected.kind, name: selected.name }, loadedModules, schemaContributions };
    } catch (error) {
      await this.cleanupAfterFailure();
      throw error;
    }
  }

  async invoke(method, params) {
    if (method === 'dispose') return this.dispose();
    if (method === 'prepare') return this.prepare(params);
    if (method === 'initialize') return this.initialize(params);
    assert(this.state === 'ready', 'StateError', `Cannot call ${method} while worker state is ${this.state}.`);
    const prefix = this.kind === 'TestRunner' ? 'runner' : 'checker';
    assert(method.startsWith(`${prefix}.`), 'UnsupportedMethodError', `${method} is not supported by ${this.kind}.`);
    const operation = method.slice(prefix.length + 1);
    const allowed = prefix === 'runner' ? ['init', 'capabilities', 'dryRun', 'mutantRun'] : ['init', 'group', 'check'];
    assert(allowed.includes(operation), 'UnsupportedMethodError', `Unknown method: ${method}.`);
    if (operation === 'init') {
      assert(!this.initialized, 'StateError', 'The plugin has already been initialized.');
      try {
        if (this.plugin.init !== undefined) {
          assert(typeof this.plugin.init === 'function', 'InvalidPluginError', 'Plugin init must be a function.');
          await this.plugin.init();
        } else {
          assert(prefix === 'runner', 'UnsupportedMethodError', 'Checker does not implement init.');
        }
        this.initialized = true;
        return null;
      } catch (error) {
        await this.cleanupAfterFailure();
        throw error;
      }
    }
    if (operation !== 'capabilities') {
      assert(this.initialized || (prefix === 'runner' && this.plugin.init === undefined), 'StateError', 'Call plugin init before running it.');
    }
    if (prefix === 'checker' && operation === 'group' && this.plugin.group === undefined) {
      assert(Array.isArray(params), 'InvalidParamsError', 'checker.group params must be a mutant array.');
      return params.map((mutant) => [mutant.id]);
    }
    assert(typeof this.plugin[operation] === 'function', 'UnsupportedMethodError', `Plugin does not implement ${method}.`);
    if (operation === 'capabilities') return this.plugin[operation]();
    const result = await this.plugin[operation](params);
    if (prefix === 'runner') {
      const { errorToString, DryRunStatus, MutantRunStatus } = this.runnerSdk;
      // Match pinned ChildProcessTestRunnerWorker postprocessing without
      // importing its core dependency graph or adopting its scheduling.
      if (operation === 'dryRun' && result.status === DryRunStatus.Complete && !result.mutantCoverage && params.coverageAnalysis !== 'off') {
        result.mutantCoverage = globalThis.__mutantCoverage__;
      }
      if (result.status === (operation === 'dryRun' ? DryRunStatus.Error : MutantRunStatus.Error)) {
        result.errorMessage = errorToString(result.errorMessage);
      }
    }
    return result;
  }

  async cleanupAfterFailure() {
    try {
      await this.dispose();
    } catch (error) {
      this.sendLog({ level: 'error', category: 'CompatibilityWorker', message: 'Plugin cleanup failed.', args: [logArgument(error)] });
    }
    this.state = 'failed';
  }

  dispose() {
    if (!this.disposePromise) {
      this.state = 'disposed';
      this.disposePromise = Promise.resolve().then(async () => {
        if (this.injector) {
          await disposeInjector(this.injector);
        }
      });
    }
    return this.disposePromise;
  }
}

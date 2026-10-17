import { declareFactoryPlugin, PluginKind } from '@stryker-mutator/api/plugin';
import { createEtaReporter } from '../../lib/eta-reporter.js';

function reporter(options) {
  return createEtaReporter({ ...globalThis.etaFixture, concurrency: options.concurrency, checkers: options.checkers });
}
reporter.inject = ['options'];
export const strykerPlugins = [declareFactoryPlugin(PluginKind.Reporter, 'eta-fixture', reporter)];

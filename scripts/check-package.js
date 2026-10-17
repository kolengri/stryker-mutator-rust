import { readFile, access } from 'node:fs/promises';
import { platformTarget } from '../lib/native.js';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const path of ['LICENSE', 'NOTICE', 'README.md', 'lib/index.js', 'lib/index.d.ts', 'lib/runtime.js', 'lib/runtime.d.ts',
  'lib/eta.js', 'lib/eta.d.ts', 'lib/eta-compat.js', 'lib/eta-reporter.js', 'lib/eta-reporter.d.ts', 'docs/eta.md',
  'lib/compat/worker.js', 'bin/stryker-rust.js']) {
  await access(new URL(`../${path}`, import.meta.url));
}
if (!pkg.optionalDependencies) {
  await access(new URL(`../native/stryker-rust.${platformTarget()}.node`, import.meta.url));
}
for (const name of ['api', 'core', 'instrumenter', 'util']) {
  if (pkg.dependencies[`@stryker-mutator/${name}`] !== '10.0.0') {
    throw new Error('The compatibility adapters are verified against StrykerJS 10.0.0 only');
  }
}
if (pkg.dependencies['typed-inject'] !== '5.0.0') throw new Error('The compatibility disposal adapter requires typed-inject 5.0.0');

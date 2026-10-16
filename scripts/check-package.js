import { readFile, access } from 'node:fs/promises';
import { platformTarget } from '../lib/native.js';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const path of ['LICENSE', 'NOTICE', 'README.md', 'lib/index.js', 'lib/index.d.ts', 'bin/stryker-rust.js']) {
  await access(new URL(`../${path}`, import.meta.url));
}
if (!pkg.optionalDependencies) {
  await access(new URL(`../native/stryker-rust.${platformTarget()}.node`, import.meta.url));
}
if (pkg.dependencies['@stryker-mutator/core'] !== '10.0.0' || pkg.dependencies['@stryker-mutator/instrumenter'] !== '10.0.0') {
  throw new Error('The compatibility hook is verified against StrykerJS 10.0.0 only');
}

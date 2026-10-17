import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Stryker } from '../../lib/index.js';

const cwd = resolve(`artifacts/eta-release/repairs-r1/owner-${process.versions.bun ? 'bun' : 'node'}`);
const originalCwd = process.cwd();
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
const active = new Set();
let created = 0;
globalThis.setInterval = function (...args) {
  const handle = originalInterval(...args);
  if (new Error().stack.includes('lib/eta-reporter.js')) { active.add(handle); created++; }
  return handle;
};
globalThis.clearInterval = function (handle) { active.delete(handle); return originalClear(handle); };
try {
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'add.js'), 'export function add(a,b){return a+b;}');
  const options = {
    testRunner: 'command', plugins: [pathToFileURL(resolve('lib/eta-reporter.js')).href], appendPlugins: [], checkers: [],
    mutate: ['add.js'], concurrency: 1, coverageAnalysis: 'off', cleanTempDir: 'always',
    commandRunner: { command: `"${process.execPath}" test.mjs` },
    reporters: ['json', 'rust-eta'], jsonReporter: { fileName: 'mutation.json' }, logLevel: 'off', timeoutMS: 2000,
  };
  await writeFile(join(cwd, 'stryker.config.json'), JSON.stringify(options));
  process.chdir(cwd);
  await writeFile('test.mjs', "throw new Error('intentional failed baseline');");
  await assert.rejects(new Stryker({ configFile: 'stryker.config.json' }).runMutationTest(), /initial test run|dry run|initial run/i);
  assert.equal(active.size, 0, 'failed baseline must dispose the built-in ETA heartbeat');
  await writeFile('test.mjs', "import assert from 'node:assert/strict';import {add} from './add.js';assert.equal(add(2,3),5);");
  assert.deepEqual(await new Stryker({ configFile: 'stryker.config.json', dryRunOnly: true }).runMutationTest(), []);
  assert.equal(active.size, 0, 'early successful return must dispose the built-in ETA heartbeat');
  const mutants = await new Stryker({ configFile: 'stryker.config.json' }).runMutationTest();
  assert.equal(mutants.length, 2);
  assert.ok(mutants.every((mutant) => mutant.status === 'Killed'));
  assert.equal(active.size, 0, 'successful wrapUp and injector disposal are idempotent');
  assert.equal(created, 3, 'all three actual Stryker instances must create their built-in reporter');
  const report = JSON.parse(await readFile('mutation.json', 'utf8'));
  assert.equal(Object.values(report.files).flatMap((file) => file.mutants).length, 2);
  console.log(`ETA_OWNER:${JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', failedBaseline: true, dryRunOnly: true, healthyMutants: mutants.length, createdTimers: created, remainingTimers: active.size })}`);
} finally {
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
  for (const handle of active) originalClear(handle);
  process.chdir(originalCwd);
  await rm(cwd, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CampaignEta } from '../../lib/eta.js';
import { createHash } from 'node:crypto';
import { runNativeMutationTest } from '../../lib/runtime.js';
import { Stryker, installAcceleration } from '../../lib/index.js';

const [mode, enabled] = process.argv.slice(2);
const cwd = resolve(`artifacts/eta-release/fixture-${mode}-${process.versions.bun ? 'bun' : 'node'}-${enabled}`);
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
await writeFile(join(cwd, 'add.js'), 'export function add(a, b) { return a + b; }\n');
await writeFile(join(cwd, 'test.mjs'), "import assert from 'node:assert/strict'; import {add} from './add.js'; assert.equal(add(3,2),5);\n");
await writeFile(join(cwd, 'sdk.test.mjs'), "import assert from 'node:assert/strict'; import {add} from './add.js'; describe('add',()=>it('adds',()=>assert.equal(add(3,2),5)));\n");
const etaEnabled = enabled === 'on';
const estimates = [];
const campaign = new CampaignEta({ scopes: [{ id: 'fixture' }] });
if (etaEnabled) campaign.record({ type: 'begin', scopeId: 'fixture' });
globalThis.etaFixture = { campaign, scopeId: 'fixture', beginScope: false, intervalMs: 0, onEstimate: (e) => estimates.push(e) };
const sdk = mode === 'sdk';
const config = {
  testRunner: sdk ? 'mocha' : 'command',
  plugins: sdk ? ['@stryker-mutator/mocha-runner'] : mode === 'compat' && etaEnabled ? [pathToFileURL(resolve('test/fixtures/eta-plugin.js')).href] : [],
  appendPlugins: [], checkers: [], coverageAnalysis: 'off', concurrency: 1,
  mutate: ['add.js'], ignorePatterns: ['sdk.test.mjs'], cleanTempDir: 'always',
  commandRunner: { command: `"${process.execPath}" test.mjs` },
  ...(sdk ? { mochaOptions: { spec: ['sdk.test.mjs'] } } : {}),
  reporters: mode === 'compat' && etaEnabled ? ['json', 'eta-fixture'] : ['json'],
  jsonReporter: { fileName: 'mutation.json' }, logLevel: 'off', timeoutMS: 2000,
};
await writeFile(join(cwd, 'stryker.config.json'), JSON.stringify(config));
let mutants;
let coreStats;
if (mode === 'compat') {
  process.chdir(cwd);
  mutants = await new Stryker({ configFile: 'stryker.config.json' }).runMutationTest();
  coreStats = installAcceleration().coreStats;
} else {
  // The SDK fixture uses the installed plugin from this checkout, not a global package.
  if (sdk) config.ignorePatterns = [];
  const result = await runNativeMutationTest({ cwd, overrides: config }, etaEnabled ? { eta: { campaign, scopeId: 'fixture', beginScope: false, intervalMs: 10, onEstimate: (e) => estimates.push(e) } } : {});
  assert.equal(result.supported, true, result.reason);
  assert.equal(result.exitCode, 0);
  mutants = result.mutants;
  if (etaEnabled) assert.equal(result.eta.state, 'complete');
}
assert.ok(mutants.length >= 2 && mutants.length <= 5, `unexpected fixture plan: ${mutants.length}`);
const report = JSON.parse(await readFile(join(cwd, 'mutation.json'), 'utf8'));
const reportMutants = Object.values(report.files).flatMap((file) => file.mutants);
assert.equal(reportMutants.length, mutants.length);
const identities = mutants.map(({ id, location, mutatorName, replacement, status }) => ({ id, location, mutatorName, replacement, status })).sort((a,b) => a.id.localeCompare(b.id));
if (etaEnabled) {
  assert.equal(estimates[0].state, 'unknown');
  assert.equal(estimates.at(-1).state, 'complete');
  assert.ok(estimates.some((e) => e.scopes[0].plannedJobs === mutants.length && e.scopes[0].completedJobs === 0), 'a real initial runnable plan was emitted');
  assert.ok(estimates.some((e) => e.scopes[0].runningJobs > 0), 'actual runner occupancy was visible');
  assert.ok(campaign.history().scopes.length === 0, 'identity-free runs must not produce reusable history');
}
const inputs = {};
for (const file of ['add.js', 'test.mjs', 'sdk.test.mjs', 'stryker.config.json']) inputs[file] = createHash('sha256').update(await readFile(join(cwd,file))).digest('hex');
console.log(`ETA_FIXTURE:${JSON.stringify({ mode, enabled, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`, inputs, coreStats, identities, estimates })}`);

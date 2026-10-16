import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from '../test/helpers.js';

const output = resolve('artifacts/native-parallelism/benchmark');
const script = resolve('scripts/benchmark-parallelism.js');
const command = process.argv[2];
if (command === '--help') {
  console.log('Usage: node scripts/benchmark-parallelism.js [--e2e | --child serial|parallel FILES FUNCTIONS balanced|skewed]\nDefault: instrumentation matrix. STRYKER_RUST_BENCH_SAMPLES defaults to 7.');
  process.exit(0);
}
assert.ok(command === undefined || command === '--child' || command === '--e2e', 'Unknown benchmark option');
assert.ok(command === '--child' ? process.argv.length === 7 : process.argv.length <= 3, 'Invalid benchmark arguments');
const requestedThreads = Math.min(4, os.availableParallelism());
const sampleCount = Number(process.env.STRYKER_RUST_BENCH_SAMPLES ?? 7);
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount > 0, 'Invalid sample count');

function filesFor(count, functions, shape) {
  const sizes = Array(count).fill(0);
  if (shape === 'skewed') {
    sizes[0] = functions - count + 1;
    sizes.fill(1, 1);
  } else {
    for (let i = 0; i < functions; i++) sizes[i % count]++;
  }
  return sizes.map((size, file) => ({
    name: resolve(`parallel-${file}.js`), mutate: true,
    content: Array.from({ length: size }, (_, i) =>
      `function f${i}(a,b) { if (a > b) { return a + b; } return a - b; }`).join('\n'),
  }));
}

function summary(samples, modes, field = 'durationMs') {
  return Object.fromEntries(modes.map((mode) => {
    const values = samples.filter((sample) => sample.mode === mode)
      .flatMap((sample) => sample[field]).sort((a, b) => a - b);
    return [mode, {
      medianMs: values[Math.floor(values.length / 2)],
      minMs: values[0], maxMs: values.at(-1), samples: values.length,
    }];
  }));
}

async function fingerprint() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const names = (await readdir('native')).filter((name) => name.endsWith('.node'));
  const addons = Object.fromEntries(await Promise.all(names.map(async (name) => [name,
    createHash('sha256').update(await readFile(join('native', name))).digest('hex'),
  ])));
  const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const paths = new Set([...tracked.stdout.split('\0').filter((name) =>
    /^(src\/|lib\/|bin\/|Cargo\.|package(?:-lock)?\.json$)/.test(name)),
  'scripts/benchmark-parallelism.js', 'test/helpers.js', 'fixtures/native/stryker.config.json']);
  const files = Object.fromEntries(await Promise.all([...paths].sort().map(async (name) => [name,
    createHash('sha256').update(await readFile(name)).digest('hex'),
  ])));
  return { commit: git.stdout.trim(), addons, files };
}

function runChild(args, cwd = process.cwd(), extraEnv = {}) {
  const started = performance.now();
  const run = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env, STRYKER_RUST_CACHE: '0', STRYKER_RUST_ENGINE: 'native',
      STRYKER_RUST_CORE_ENGINE: 'native', STRYKER_RUST_DIAGNOSTICS: '1', ...extraEnv,
    },
  });
  const durationMs = performance.now() - started;
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return { run, durationMs };
}

if (process.argv[2] === '--child') {
  const [mode, count, functions, shape] = process.argv.slice(3);
  assert.ok(mode === 'serial' || mode === 'parallel', 'Invalid benchmark mode');
  assert.ok(shape === 'balanced' || shape === 'skewed', 'Invalid workload shape');
  assert.ok(Number.isSafeInteger(Number(count)) && Number(count) > 0, 'Invalid file count');
  assert.ok(Number.isSafeInteger(Number(functions)) && Number(functions) >= Number(count), 'Invalid function count');
  const files = filesFor(Number(count), Number(functions), shape);
  const threads = mode === 'serial' ? 1 : requestedThreads;
  const candidate = createInstrumenter(logger, {
    cache: false, engine: 'native', instrumentationThreads: threads,
  });
  const started = performance.now();
  const result = await candidate.instrument(files, options);
  const durationMs = performance.now() - started;
  const execution = { ...candidate.instrumentationStats };
  assert.equal(candidate.stats.nativeBatches, 1);
  assert.equal(candidate.stats.fallbackBatches, 0);
  assert.equal(candidate.stats.nativeErrors, 0);
  assert.ok(execution.lastThreadsUsed >= 1, 'Native execution diagnostics are required');
  if (mode === 'serial') assert.equal(execution.lastThreadsUsed, 1);
  const repeatedDurationsMs = [];
  const repeatedExecutions = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const repeatedStarted = performance.now();
    const repeated = await candidate.instrument(files, options);
    repeatedDurationsMs.push(performance.now() - repeatedStarted);
    repeatedExecutions.push({ ...candidate.instrumentationStats });
    assert.deepEqual(repeated, result);
  }
  assert.equal(candidate.stats.nativeBatches, 4, 'Repeated batches must bypass cache');
  // Run both references after timing. Byte equality includes global IDs and headers.
  const reference = createInstrumenter(logger, {
    cache: false, engine: 'native', instrumentationThreads: 1,
  });
  assert.deepEqual(result, await reference.instrument(files, options));
  assert.deepEqual(result.mutants, (await new Instrumenter(logger).instrument(files, options)).mutants);
  console.log(JSON.stringify({
    mode, count: files.length, functions: Number(functions), shape, durationMs, repeatedDurationsMs, repeatedExecutions,
    sourceBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    mutants: result.mutants.length, execution,
  }));
} else if (process.argv[2] === '--e2e') {
  const directory = join(output, 'e2e');
  const project = join(directory, 'project');
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const config = JSON.parse(await readFile('fixtures/native/stryker.config.json', 'utf8'));
  await writeFile(join(project, 'stryker.config.json'), JSON.stringify(config));
  const sources = filesFor(8, 96, 'balanced');
  const imports = [];
  const cases = [];
  for (let index = 0; index < sources.length; index++) {
    const content = 'export const startup = true;\n' + sources[index].content.replaceAll('function ', 'export function ');
    sources[index] = { name: `module-${index}.js`, content };
    await writeFile(join(project, 'src', sources[index].name), content);
    imports.push(`import * as m${index} from '../src/${sources[index].name}';`);
    cases.push(`it('module ${index} initialization', () => assert.equal(m${index}.startup, true));`);
    for (let fn = 0; fn < 12; fn++) cases.push(`it('module ${index} function ${fn}', () => {
      assert.equal(m${index}.f${fn}(4, 2), 6);
      assert.equal(m${index}.f${fn}(1, 3), -2);
    });`);
  }
  await writeFile(join(project, 'test/modules.test.js'), [
    "import assert from 'node:assert/strict';", ...imports,
    "describe('all generated modules', () => {", ...cases, '});',
  ].join('\n'));
  const require = createRequire(import.meta.url);
  const entries = {
    upstream: resolve(require.resolve('@stryker-mutator/core/package.json'), '../bin/stryker.js'),
    serial: resolve('bin/stryker-rust.js'), parallel: resolve('bin/stryker-rust.js'),
  };
  const modes = Object.keys(entries);
  const samples = [];
  let expected;
  for (let round = 0; round < sampleCount; round++) {
    for (let step = 0; step < modes.length; step++) {
      const mode = modes[(round + step) % modes.length];
      const { run, durationMs } = runChild([entries[mode], 'run'], project, {
        STRYKER_RUST_THREADS: String(mode === 'parallel' ? requestedThreads : 1),
      });
      const log = run.stdout + run.stderr;
      await writeFile(join(directory, `${round}-${mode}.log`), log);
      const report = JSON.parse(await readFile(join(project, 'reports/mutation.json'), 'utf8'));
      const canonical = { ...report, files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [
        name, { ...file, mutants: [...file.mutants].sort((a, b) => Number(a.id) - Number(b.id)) },
      ])) };
      if (expected) assert.deepEqual(canonical, expected);
      else expected = canonical;
      assert.equal(Object.keys(report.files).length, 8);
      for (const file of sources) assert.equal(await readFile(join(project, 'src', file.name), 'utf8'), file.content);
      let diagnostic;
      if (mode !== 'upstream') {
        const match = log.match(/\[stryker-rust\] (\{[^\n]+\})/);
        assert.ok(match, 'Missing native diagnostics');
        diagnostic = JSON.parse(match[1]);
        assert.equal(diagnostic.nativeBatches, 1);
        assert.equal(diagnostic.fallbackBatches, 0);
        assert.equal(diagnostic.nativeErrors, 0);
        assert.deepEqual(diagnostic.core.nativeCoreStages, ['coverage', 'planning']);
        assert.equal(diagnostic.core.javascriptCoverageFallbacks, 0);
        assert.equal(diagnostic.core.javascriptPlanningFallbacks, 0);
        if (mode === 'parallel' && requestedThreads > 1) {
          assert.ok(diagnostic.instrumentation.lastThreadsUsed > 1);
          assert.equal(diagnostic.instrumentation.lastParallelFiles, 8);
        }
      }
      await writeFile(join(directory, `${round}-${mode}.json`), JSON.stringify(report));
      samples.push({ round, mode, durationMs, diagnostic,
        mutants: Object.values(report.files).reduce((sum, file) => sum + file.mutants.length, 0) });
    }
  }
  const report = { scope: 'Complete fresh CLI processes; 8 imported/tested modules, 96 functions; cache disabled; full report parity with pinned upstream; concurrency=2 Node test workers',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, requestedThreads },
    source: await fingerprint(), memory: 'not measured', summary: summary(samples, modes), samples };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
} else {
  await mkdir(output, { recursive: true });
  const samples = [];
  const cases = [32, 512, 4096].flatMap((functions) => [2, 8, 32].flatMap((count) =>
    ['balanced', 'skewed'].map((shape) => ({ count, functions, shape }))));
  for (const workload of cases) {
    for (let round = 0; round < sampleCount; round++) {
      for (const mode of round % 2 ? ['parallel', 'serial'] : ['serial', 'parallel']) {
        const { run } = runChild([script, '--child', mode, String(workload.count), String(workload.functions), workload.shape]);
        samples.push({ round, ...JSON.parse(run.stdout.trim()) });
      }
    }
  }
  const summaries = cases.map((workload) => {
    const selected = samples.filter((sample) => sample.count === workload.count && sample.functions === workload.functions && sample.shape === workload.shape);
    return { ...workload,
      summary: summary(selected, ['serial', 'parallel']),
      repeatedSummary: summary(selected, ['serial', 'parallel'], 'repeatedDurationsMs'),
    };
  });
  const report = {
    scope: 'Instrumentation through public JS bridge; fresh processes, cache disabled, imports excluded; JSON, native parse/emission, ID relocation, assembly and response decoding included; serial byte parity and pinned upstream ordered records checked after timing',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, requestedThreads },
    source: await fingerprint(), memory: 'not measured', summaries, samples,
  };
  await writeFile(join(output, 'instrumentation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summaries, null, 2));
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, truncateSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BunFileCoverageSession, bunCoveragePreload } from 'stryker-mutator-rust/bun-execution';
import { loadNative } from '../lib/native.js';
import { assertProcessStopped } from './helpers.js';

const qualification = 'independent-files-bun-sync-v1';
const artifactRoot = resolve(process.env.STRYKER_RUST_ACCELERATION_ARTIFACT_DIR ?? 'artifacts/bun-execution-acceleration');
mkdirSync(artifactRoot, { recursive: true });
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim() === '1.4.3';
const completionHost = process.platform === 'darwin' && process.arch === 'arm64'
  && (process.versions.bun ? process.versions.bun === '1.4.3' : process.version === 'v26.10.0');
const bunTest = (name, fn) => test(name, { skip: (!bunAvailable || !completionHost) && 'Qualified completion host and Bun 1.4.3 required' }, fn);

test('oversized journals fail closed before native decoding, including the aggregate budget', { skip: !bunAvailable || !completionHost }, async () => {
  const directory = mkdtempSync(join(artifactRoot, 'size-'));
  const files = [0, 1, 2].map((i) => join(directory, `${i}.test.js`));
  for (const file of files) writeFileSync(file, "import {test} from 'bun:test';test('metadata',()=>{});");
  try {
    for (const [bytes, selectedFiles, reason] of [
      [4 * 1024 * 1024 + 1, files.slice(0, 1), 'Coverage receipt exceeds 4 MiB'],
      [3 * 1024 * 1024, files, 'Coverage evidence exceeds 8 MiB'],
    ]) {
      const session = new BunFileCoverageSession({ files: selectedFiles, identityFiles: files, qualification, completion: { bunPath: 'bun' } });
      // This unit callback supplies malformed sparse evidence, not execution proof.
      await session.collect(async (files) => {
        await run(files, session.env);
        const { directory } = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
        const journal = join(directory, 'root.ndjson');
        writeFileSync(journal, ''); truncateSync(journal, bytes);
        return { status: 'survived' };
      }, { status: 'survived' });
      assert.equal(session.select('0').files, undefined);
      assert.equal(session.reason, reason);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function run(files, env, { bail = false, timeout = 2500, signal } = {}) {
  return new Promise((settle) => {
    const childEnv = { ...process.env, ...env };
    if (!env.__STRYKER_ACTIVE_MUTANT__) delete childEnv.__STRYKER_ACTIVE_MUTANT__;
    const child = spawn('bun', ['--no-env-file', 'test', '--max-concurrency=1', '--timeout=100',
      '--preload', bunCoveragePreload, ...(bail ? ['--bail'] : []), ...files], {
      env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const abort = () => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle({ status: spawnError ? 'error' : timedOut ? 'timeout' : code === 0 ? 'survived' : 'killed', stdout, stderr, pid: child.pid });
    });
  });
}

function fixture() {
  const directory = mkdtempSync(join(artifactRoot, 'case-'));
  const names = ['a.js', 'b.js', 'child.js', 'uncovered.js'];
  const contents = [
    'export function a(n) { return n + 1; } export const initial = true;',
    'export function b(n) { return n - 1; }',
    'export function child() { return "child"; }',
    'export function untouched() { return true; }',
  ];
  const response = JSON.parse(loadNative().instrumentBatch(JSON.stringify({
    files: names.map((name, i) => ({ name: join(directory, name), content: contents[i], mutate: true })),
    options: { ignorers: [], excludedMutations: [], plugins: null },
  })));
  assert.equal(response.supported, true, response.reason);
  for (const file of response.result.files) writeFileSync(file.name, file.content);
  const childEntry = join(directory, 'child-entry.js');
  const childEval = `import { child } from ${JSON.stringify(join(directory, 'child.js'))}; process.stdout.write(child())`;
  writeFileSync(childEntry, `const r = Bun.spawnSync([process.execPath,'--no-env-file','-e',${JSON.stringify(childEval)}],{env:{...process.env}});
    process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.exitCode;`);
  const files = ['a.test.js', 'b.test.js'].map((name) => join(directory, name));
  writeFileSync(files[0], `import { test, expect, afterAll } from 'bun:test';
    import { a, initial } from './a.js';
    test('a dynamic', () => { expect(a(1)).toBe(2); expect(initial).toBe(true); });
    test('fresh process', () => { expect(globalThis.__fixtureRuns).toBeUndefined(); globalThis.__fixtureRuns=1; });
    test('child', () => { const result = Bun.spawnSync({cmd:[process.execPath,'--no-env-file','-e',
      'import { child } from '+JSON.stringify(${JSON.stringify(join(directory, 'child.js'))})+'; process.stdout.write(child())'],env:{...process.env}});
      expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe('child'); expect(result.stderr.toString()).toBe(''); });
    test('nested child file', () => { const result = Bun.spawnSync([process.execPath,'--no-env-file',${JSON.stringify(childEntry)}],{env:{...process.env}});
      expect(result.exitCode).toBe(0);expect(result.stdout.toString()).toBe('child');expect(result.stderr.toString()).toBe(''); });
    afterAll(() => { if (process.env.FIXTURE_CLEANUP) require('node:fs').writeFileSync(process.env.FIXTURE_CLEANUP, 'clean'); });
  `);
  writeFileSync(files[1], "import { test, expect } from 'bun:test'; import { b } from './b.js'; test('b dynamic', () => expect(b(3)).toBeGreaterThan(0));");
  return { directory, files, sources: names.map((n) => join(directory, n)), mutants: response.result.mutants, instrumented: response.result,
    session: () => new BunFileCoverageSession({ files, identityFiles: [...names.map((n) => join(directory, n)), childEntry], qualification, completion: { bunPath: 'bun' } }) };
}

function sameFileChildFixture(f, { coverage = false, childSetup = '', childAfter = '', command, options } = {}) {
  writeFileSync(f.files[0], `import {test,expect,afterAll} from 'bun:test';
    import {a,initial} from './a.js'; import {child} from './child.js';
    if(process.env.SAME_FILE_CHILD==='1') {
      ${childSetup}
      test('child dynamic',()=>{
        expect(Bun.main).toBe(import.meta.path);
        expect(child()).toBe('child');
        process.stdout.write('OWNED_CHILD_FILE '+JSON.stringify({file:Bun.main,testFile:import.meta.path})+'\\n');
      });
      ${childAfter}
    } else {
      test('root dynamic',()=>{ expect(a(1)).toBe(2); expect(initial).toBe(true); });
      test('same-file child',()=>{
        const result=Bun.spawnSync(${command ?? `[process.execPath,'--no-env-file','test',${coverage ? "'--coverage'," : ''}import.meta.path]`},
          ${options ?? "{env:{...process.env,SAME_FILE_CHILD:'1'},timeout:2000}"});
        ${command || options || childAfter ? '// Negative fixtures intentionally retain a successful root even when its child fails.' : `
          expect(result.exitCode,result.stderr.toString()).toBe(0);
          expect(Buffer.isBuffer(result.stdout)).toBe(true);expect(Buffer.isBuffer(result.stderr)).toBe(true);
          const identity=result.stdout.toString().split('\\n').find(line=>line.startsWith('OWNED_CHILD_FILE '));
          expect(JSON.parse(identity.slice('OWNED_CHILD_FILE '.length))).toEqual({file:import.meta.path,testFile:import.meta.path});
          process.stdout.write(result.stdout);
        `}
      });
    }
  `);
}

bunTest('same-file Bun test children bind dynamic hooks while imports and child top-level hits stay static', async () => {
  const f = fixture();
  const witnesses = [];
  try {
    for (const coverage of [false, true]) {
      sameFileChildFixture(f, { coverage });
      const baseline = await run(f.files, {});
      assert.equal(baseline.status, 'survived', baseline.stderr);
      const session = f.session();
      const receipts = [];
      const results = [];
      await session.collect(async (files) => {
        const result = await run(files, session.env);
        results.push(result);
        const { directory } = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
        receipts.push(...readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8').trim().split('\n').map(JSON.parse)));
        return result;
      }, baseline);
      witnesses.push({ coverage, receipts, results, stats: session.stats, reason: session.reason });
      writeFileSync(join(artifactRoot, 'same-file-child-witnesses.json'), JSON.stringify(witnesses, null, 2));
      assert.equal(session.reason, 'Complete owned receipts');
      assert.equal(session.stats.participants, 3);
      const childIds = f.mutants.filter((mutant) => mutant.fileName === f.sources[2]).map((mutant) => mutant.id);
      assert.ok(childIds.length > 0);
      const childReceipt = receipts.find((events) => events[0].parent === 'root');
      assert.equal(childReceipt?.[0].file, f.files[0]);
      assert.ok(childReceipt.some((event) => event.type === 'hit' && event.phase === 'test' && childIds.includes(event.mutant)));
      assert.ok(receipts.some((events) => events[0].parent === null && events.some((event) => event.type === 'hit' && event.phase === 'test')));
      for (const id of childIds) assert.deepEqual(session.select(id).files, [f.files[0]]);
      assert.ok(f.mutants.some((mutant) => session.select(mutant.id).reason === 'Static mutation'));
      assert.equal(session.select('unknown').files, undefined);
      assert.equal(session.select(childIds[0], { staticMutation: true }).files, undefined);
    }
    sameFileChildFixture(f, { coverage: true, childSetup: 'child();' });
    const staticChild = f.session();
    await staticChild.collect((files) => run(files, staticChild.env), { status: 'survived' });
    assert.equal(staticChild.reason, 'Complete owned receipts');
    for (const mutant of f.mutants.filter((mutant) => mutant.fileName === f.sources[2])) {
      assert.equal(staticChild.select(mutant.id).reason, 'Static mutation');
      assert.equal(staticChild.select(mutant.id).files, undefined);
    }
    writeFileSync(join(artifactRoot, 'same-file-child-witnesses.json'), JSON.stringify(witnesses, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('positive root hits cannot hide unsupported same-file child forms, unfinished work or late child errors', async () => {
  const f = fixture();
  const witnesses = [];
  try {
    const scenarios = [
      { name: 'other file', command: `[process.execPath,'--no-env-file','test',${JSON.stringify(f.files[1])}]` },
      { name: 'additional test flag', command: "[process.execPath,'--no-env-file','test','--coverage','--timeout=100',import.meta.path]" },
      { name: 'missing no-env-file', command: "[process.execPath,'test',import.meta.path]" },
      { name: 'object form', command: "{cmd:[process.execPath,'--no-env-file','test',import.meta.path],env:{...process.env,SAME_FILE_CHILD:'1'}}" },
      { name: 'changed cwd', options: "{env:{...process.env,SAME_FILE_CHILD:'1'},cwd:process.cwd()}" },
      { name: 'redirected pipe', options: "{env:{...process.env,SAME_FILE_CHILD:'1'},stdout:'ignore'}" },
      { name: 'unknown session', options: "{env:{...process.env,SAME_FILE_CHILD:'1',STRYKER_RUST_FILE_COVERAGE:''}}" },
      { name: 'changed Bun options', options: "{env:{...process.env,SAME_FILE_CHILD:'1',BUN_OPTIONS:'--smol'}}" },
      { name: 'unknown option', options: "{env:{...process.env,SAME_FILE_CHILD:'1'},lazy:true}" },
      { name: 'inherited option', options: "Object.assign(Object.create({stdout:'ignore'}),{env:{...process.env,SAME_FILE_CHILD:'1'}})" },
      { name: 'pending timer', childAfter: 'afterAll(()=>{setTimeout(()=>{},1000)});' },
      { name: 'async timer callback', childAfter: 'afterAll(async()=>{await new Promise(done=>setTimeout(async()=>{child();done()},1))});' },
      { name: 'late child error', childAfter: "afterAll(()=>{queueMicrotask(()=>{throw Error('late child error')})});" },
      { name: 'caught child test failure', childAfter: "test('child failure',()=>{throw Error('caught by root')});" },
    ];
    for (const scenario of scenarios) {
      sameFileChildFixture(f, scenario);
      const session = f.session();
      const receipts = [];
      let result;
      await session.collect(async (files) => {
        result = await run(files, session.env);
        const { directory } = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
        receipts.push(...readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8').trim().split('\n').map(JSON.parse)));
        return result;
      }, { status: 'survived' });
      witnesses.push({ scenario, reason: session.reason, result, receipts });
      writeFileSync(join(artifactRoot, 'same-file-child-fallbacks.json'), JSON.stringify(witnesses, null, 2));
      assert.equal(result.status, 'survived', `${scenario.name}\n${result.stderr}`);
      assert.ok(receipts.some((events) => events[0].parent === null && events.some((event) => event.type === 'hit' && event.phase === 'test')));
      assert.equal(session.index, undefined, scenario.name);
      assert.equal(session.select('0').files, undefined, scenario.name);
      assert.notEqual(session.reason, 'Complete owned receipts', scenario.name);
    }
    writeFileSync(join(artifactRoot, 'same-file-child-fallbacks.json'), JSON.stringify(witnesses, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('caught in-scope launch rejections still invalidate an otherwise valid collection', async () => {
  const f = fixture();
  const rows = [];
  try {
    const baseline = await run(f.files, {});
    assert.equal(baseline.status, 'survived');
    for (const kind of ['missing-token', 'duplicate', 'launch-mode']) {
      const session = f.session();
      const row = { kind };
      await session.collect(async (files) => {
        if (kind !== 'launch-mode') row.rootResult = await run(files, session.env);
        try {
          if (kind === 'missing-token') spawn('ps', ['-o', 'rss=', '-p', String(row.rootResult.pid)]);
          else spawn('bun', ['--no-env-file', 'test', ...files], {
            detached: kind !== 'launch-mode', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...session.env },
          });
          assert.fail('The unsupported launch must throw before spawning');
        } catch (error) { row.caught = error.message; }
        // A catch cannot restore authority. With the old code all three cases
        // could proceed to an ordinary successful root and complete index.
        return row.rootResult ?? await run(files, session.env);
      }, baseline);
      assert.equal(session.index, undefined);
      assert.equal(session.select('0').files, undefined);
      const reason = kind === 'missing-token' ? 'Unowned process launch inside coverage collection'
        : kind === 'duplicate' ? 'Duplicate or late owned producer' : 'Unsupported owned Bun launch mode';
      assert.equal(row.caught, reason);
      assert.equal(session.reason, reason);
      if (row.rootResult) {
        assert.equal(row.rootResult.status, 'survived');
        assertProcessStopped(row.rootResult.pid);
      }
      rows.push({ ...row, reason: session.reason });
    }
    const clean = f.session();
    await clean.collect((files) => run(files, clean.env), baseline);
    assert.equal(clean.reason, 'Complete owned receipts');
    assert.deepEqual(clean.select('0').files, [f.files[0]]);
    writeFileSync(join(artifactRoot, 'caught-launch-rejections.json'), JSON.stringify(rows, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('public file session selects actual fresh Bun tests, includes settled children, and preserves ordered mutant outcomes', async () => {
  const f = fixture();
  try {
    const session = f.session();
    const baseline = await run(f.files, session.env);
    assert.equal(baseline.status, 'survived', baseline.stderr);
    const collected = [];
    await session.collect(async (files) => {
      const result = await run(files, session.env);
      const context = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
      collected.push({ result, journals: readdirSync(context.directory).map((name) => readFileSync(join(context.directory, name), 'utf8')) });
      writeFileSync(join(artifactRoot, 'collection-witness.json'), JSON.stringify(collected, null, 2));
      return result;
    }, baseline);
    assert.equal(session.reason, 'Complete owned receipts');
    assert.equal(session.stats.participants, 5);
    assert.equal(session.stats.ownedRoots, 2);
    const witness = [];
    for (const mutant of f.mutants) {
      const selection = session.select(mutant.id);
      const full = await run(f.files, { __STRYKER_ACTIVE_MUTANT__: mutant.id });
      const candidate = await run(selection.files ?? f.files, { __STRYKER_ACTIVE_MUTANT__: mutant.id });
      assert.equal(candidate.status, full.status, `${mutant.id}: ${mutant.replacement}\n${candidate.stderr}`);
      witness.push({ mutant, selection, full, candidate });
    }
    assert.ok(session.stats.selectedPlans > 0);
    assert.ok(witness.some(({ selection, candidate }) => selection.files && candidate.status === 'survived'));
    assert.ok(session.stats.fullSuiteFallbacks > 0);
    assert.equal(session.select('unknown').files, undefined);
    assert.equal(session.select(f.mutants[0].id, { staticMutation: true }).files, undefined);
    writeFileSync(join(artifactRoot, 'functional-parity.json'), JSON.stringify({ baseline, stats: session.stats, witness,
      fixture: { instrumented: f.instrumented, tests: f.files.map((name) => ({ name, content: readFileSync(name, 'utf8') })) } }, null, 2));
    writeFileSync(f.files[0], readFileSync(f.files[0], 'utf8') + '\n// changed identity');
    assert.equal(session.select(f.mutants[0].id).reason, 'Frozen source/test/cwd identity changed');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('unknown boundaries, process exit, baseline failures, crashes and cancellation fail closed', async () => {
  const f = fixture();
  try {
    const unqualified = new BunFileCoverageSession({ files: f.files, identityFiles: f.sources });
    let calls = 0;
    await unqualified.collect(async () => { calls++; }, { status: 'survived' });
    assert.equal(calls, 0);
    assert.equal(unqualified.select('0').files, undefined);
    const failed = f.session();
    await failed.collect(async () => { calls++; }, { status: 'killed' });
    assert.equal(calls, 0);
    assert.equal(failed.select('0').reason, 'Exhaustive inactive baseline failed');
    const budget = new BunFileCoverageSession({ files: f.files, identityFiles: f.sources, qualification, collectionBudgetMs: 10, completion: { bunPath: 'bun' } });
    let budgetCalls = 0;
    await budget.collect(async (_files, remainingMs) => {
      budgetCalls++; assert.ok(remainingMs <= 10);
      await new Promise((done) => setTimeout(done, 20)); return { status: 'survived' };
    }, { status: 'survived' });
    assert.ok(budgetCalls <= 1);
    assert.equal(budget.select('0').reason, 'Coverage collection budget exhausted');
    const scenarios = [
      `Bun.spawn([process.execPath,'-e',''],{stdout:'ignore',stderr:'ignore'});`,
      `const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath,['-e','']);`,
      `const w = new Worker(new URL('./worker.js',import.meta.url).href); await new Promise(r=>w.addEventListener('close',r));`,
      `const {Worker} = await import('node:worker_threads'); const w=new Worker(new URL('./node-worker.js',import.meta.url),{execArgv:[],env:{...process.env,STRYKER_RUST_FILE_COVERAGE:''}});await new Promise(r=>w.on('exit',r));`,
      `const {Worker}=require('worker_threads');const w=new Worker(new URL('./node-worker.js',import.meta.url),{execArgv:[],env:{...process.env,STRYKER_RUST_FILE_COVERAGE:''}});await new Promise(r=>w.on('exit',r));`,
      `const {ChildProcess}=await import('node:child_process');new ChildProcess();`,
      `const {setTimeout}=await import('node:timers/promises');await setTimeout(1);`,
      `await Bun.sleep(1);`,
      `Bun.spawnSync([process.execPath,'-e','throw new Error("child crash")']);`,
      `process.exit(0);`,
      `throw new Error('baseline crash');`,
      `await new Promise(()=>{});`,
    ];
    writeFileSync(join(f.directory, 'worker.js'), 'close();');
    writeFileSync(join(f.directory, 'node-worker.js'), 'export {};');
    const witnesses = [];
    for (const scenario of scenarios) {
      writeFileSync(f.files[0], `import { test } from 'bun:test'; import {a} from './a.js'; test('boundary',async()=>{a(1);${scenario}});`);
      const session = f.session();
      const results = [];
      const rootHits = [];
      await session.collect(async (files) => {
        const result = await run(files, session.env, { timeout: 700 });
        results.push(result);
        const { directory } = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
        const events = readFileSync(join(directory, 'root.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        rootHits.push(events.filter((event) => event.type === 'hit'));
        return result;
      }, { status: 'survived' });
      assert.ok(rootHits[0].length > 0, `The unsupported boundary must be exercised after positive root coverage: ${scenario}`);
      assert.equal(session.select('0').files, undefined, scenario);
      assert.notEqual(session.reason, 'Complete owned receipts', scenario);
      if (!scenario.includes('throw new Error') && !scenario.includes('process.exit') && !scenario.includes('await new Promise(()=>{})')) {
        assert.equal(results[0].status, 'survived', `${scenario}\n${results[0].stderr}`);
      }
      witnesses.push({ scenario, reason: session.reason, results, rootHits });
    }
    writeFileSync(f.files[0], "import { test } from 'bun:test'; test('cancel',async()=>{await new Promise(()=>{})},10000);");
    const session = f.session();
    const controller = new AbortController();
    let pid;
    const timer = setTimeout(() => controller.abort(), 100);
    await session.collect(async (files) => { const result = await run(files, session.env, { signal: controller.signal }); pid = result.pid; return result; }, { status: 'survived' });
    clearTimeout(timer);
    assert.equal(session.select('0').files, undefined);
    assertProcessStopped(pid);
    writeFileSync(join(artifactRoot, 'fallback-witnesses.json'), JSON.stringify(witnesses, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('first failure bail skips a later hang and afterAll: cleanup-dependent suites are unqualified', async () => {
  const f = fixture();
  const cleanup = join(f.directory, 'cleanup');
  try {
    writeFileSync(f.files[0], `import { test, expect, afterAll } from 'bun:test';
      test('first',()=>expect(Boolean(process.env.__STRYKER_ACTIVE_MUTANT__)).toBe(false));
      test('later hang', async()=>{if(process.env.__STRYKER_ACTIVE_MUTANT__) await new Promise(()=>{});});
      afterAll(()=>require('node:fs').writeFileSync(${JSON.stringify(cleanup)},'clean'));
    `);
    const baseline = await run([f.files[0]], {});
    assert.equal(baseline.status, 'survived', baseline.stderr);
    assert.equal(readFileSync(cleanup, 'utf8'), 'clean');
    rmSync(cleanup);
    const exhaustive = await run([f.files[0]], { __STRYKER_ACTIVE_MUTANT__: 'witness' });
    assert.equal(readFileSync(cleanup, 'utf8'), 'clean');
    rmSync(cleanup);
    const bailed = await run([f.files[0]], { __STRYKER_ACTIVE_MUTANT__: 'witness' }, { bail: true });
    assert.match(exhaustive.stderr, /timed out/);
    assert.doesNotMatch(bailed.stderr, /timed out/);
    assert.equal(existsSync(cleanup), false, 'Bun bail skips the file afterAll in this witness');
    writeFileSync(join(artifactRoot, 'bail-witness.json'), JSON.stringify({ baseline, exhaustive, bailed }, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

bunTest('late timer hits remain visible through EOF, and missing/corrupt/unowned journals invalidate the whole index', async () => {
  const f = fixture();
  try {
    writeFileSync(f.files[0], `import { test, expect, afterAll } from 'bun:test'; import {a} from './a.js';
      test('a',()=>expect(a(1)).toBe(2)); afterAll(async()=>{await new Promise(r=>setTimeout(()=>{a(2);r()},10))});`);
    const late = f.session();
    await late.collect((files) => run(files, late.env), { status: 'survived' });
    assert.equal(late.reason, 'Complete owned receipts');
    for (const mutant of f.mutants.filter((m) => m.fileName === f.sources[0])) {
      assert.equal(late.select(mutant.id).files, undefined, 'late hits outside tests retain full suite');
    }
    writeFileSync(f.files[0], `import {test,afterAll} from 'bun:test'; test('timer',()=>{}); afterAll(()=>{setTimeout(()=>{},1000)});`);
    const pending = f.session();
    await pending.collect((files) => run(files, pending.env), { status: 'survived' });
    assert.equal(pending.select('0').files, undefined);
    assert.match(pending.reason, /Unsettled asynchronous/);
    writeFileSync(f.files[0], `import {test,expect} from 'bun:test';import {a} from './a.js';test('a',()=>expect(a(1)).toBe(2));`);
    const journalFallbacks = [];
    for (const mode of ['missing', 'corrupt', 'late', 'unsettled']) {
      const session = f.session();
      let original, injected;
      await session.collect(async (files) => {
        const result = await run(files, session.env);
        const { directory, session: token, file } = JSON.parse(session.env.STRYKER_RUST_FILE_COVERAGE);
        const root = join(directory, 'root.ndjson');
        original = readFileSync(root, 'utf8');
        if (mode === 'missing') rmSync(root);
        else if (mode === 'corrupt') writeFileSync(root, '{');
        else if (mode === 'unsettled') writeFileSync(join(directory, 'root.tmp'), 'pending');
        else {
          injected = { type: 'start', version: 2, session: token, file, id: 'late', parent: 'root', pid: result.pid };
          writeFileSync(join(directory, '00000000-0000-0000-0000-000000000000.ndjson'), JSON.stringify(injected) + '\n');
        }
        return result;
      }, { status: 'survived' });
      assert.equal(session.select('0').files, undefined, mode);
      if (mode === 'late') {
        assert.equal(session.reason, 'Unowned or late participant');
        const events = original.trim().split('\n').map(JSON.parse);
        assert.equal(events[0].version, 2);
        assert.ok(events[0].pid > 0 && events.some((event) => event.type === 'hit'));
      }
      else assert.notEqual(session.reason, 'Complete owned receipts', mode);
      journalFallbacks.push({ mode, reason: session.reason, original, injected });
    }
    writeFileSync(join(artifactRoot, 'journal-fallbacks.json'), JSON.stringify(journalFallbacks, null, 2));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

// Full-report evidence against the exact installed core, without coordinator
// imports on native paths. No corpus or benchmark is run by these examples.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const core = join(dirname(require.resolve('@stryker-mutator/core/package.json')), 'bin/stryker.js');
const artifacts = join(root, 'artifacts/caller-config-handshake');
const canonical = (report) => ({ ...report, files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, { ...file, mutants: [...file.mutants].sort((a, b) => a.id.localeCompare(b.id)) }])) });

for (const [runner, fixture] of [['command', 'native-command'], ['mocha', 'native']]) {
  test(`executable ${runner} CLI matches actual upstream full report and inherits caller env effects`, { timeout: 60000 }, async (t) => {
    await mkdir(artifacts, { recursive: true });
    const cwd = await mkdtemp(join(artifacts, `${runner}-execution-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await cp(join(root, 'fixtures', fixture), cwd, { recursive: true });
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const options = JSON.parse(await readFile(join(cwd, 'stryker.config.json'), 'utf8'));
    const testFile = join(cwd, 'test/calculator.test.js');
    await writeFile(testFile, `if (process.env.CALLER_CONFIG_PROOF !== 'main-effect') throw new Error('caller env effect lost');\n${await readFile(testFile, 'utf8')}`);
    await rm(join(cwd, 'stryker.config.json'));
    await writeFile(join(cwd, 'stryker.config.mjs'), `await new Promise(r=>setTimeout(r,5)); process.env.CALLER_CONFIG_PROOF='main-effect'; export default ${JSON.stringify(options)};`);
    const guard = join(cwd, 'forbid-core.mjs');
    await writeFile(guard, `import {registerHooks} from 'node:module'; registerHooks({ resolve(specifier,context,next){ if(specifier === '@stryker-mutator/core' || specifier.startsWith('@stryker-mutator/core/')) throw new Error('Forbidden core coordinator import: '+specifier); const result=next(specifier,context); if(/\\/@stryker-mutator\\/core\\/dist\\//.test(result.url)) throw new Error('Forbidden core coordinator URL: '+result.url); return result; } });`);
    const reports = [];
    for (const native of [false, true]) {
      await rm(join(cwd, 'reports'), { recursive: true, force: true });
      const child = spawn(process.execPath, [native ? join(root, 'bin/stryker-rust.js') : core, 'run', 'stryker.config.mjs'], {
        cwd, env: { ...process.env, STRYKER_RUST_COORDINATOR_ENGINE: native ? 'native' : 'upstream', STRYKER_RUST_DIAGNOSTICS: '1', NODE_OPTIONS: native ? `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(guard).href}`.trim() : process.env.NODE_OPTIONS }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => output += data);
      child.stderr.on('data', data => output += data);
      const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
      await writeFile(join(artifacts, `${runner}-${native ? 'native' : 'upstream'}.log`), output);
      assert.deepEqual(exit, { code: 0, signal: null }, output);
      const report = JSON.parse(await readFile(join(cwd, 'reports/mutation.json'), 'utf8'));
      await writeFile(join(artifacts, `${runner}-${native ? 'native' : 'upstream'}.json`), JSON.stringify(report, null, 2));
      reports.push(canonical(report));
      if (native) assert.match(output, /"coordinator":"rust"/);
    }
    assert.deepEqual(reports[1], reports[0]);
    assert.ok(Object.values(reports[1].files).flatMap(file => file.mutants).some(mutant => mutant.status === 'Killed'));
  });
}

for (const [runner, fixture] of [['command', 'native-command'], ['mocha', 'native']]) {
  test(`worker caller ${runner} env set/delete and metadata effects reach descendants without changing main env`, { timeout: 60000 }, async (t) => {
    const evidence = join(artifacts, 'windows-followup');
    await mkdir(evidence, { recursive: true });
    const cwd = await mkdtemp(join(evidence, `${runner}-worker-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await cp(join(root, 'fixtures', fixture), cwd, { recursive: true });
    await symlink(join(root, 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const options = JSON.parse(await readFile(join(cwd, 'stryker.config.json'), 'utf8'));
    const testFile = join(cwd, 'test/calculator.test.js');
    const required = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
    const requiredProbe = `JSON.stringify(Object.entries(process.env).filter(([key])=>${JSON.stringify(required)}.includes(key.toUpperCase())))`;
    const check = `if(process.env.CCE_VALUE !== process.env.CCE_RUN || 'CCE_DELETE' in process.env ${runner === 'mocha' ? "|| process.env.CCE_META !== process.env.CCE_RUN" : ''}) throw new Error('caller worker env was lost');
if(process.platform==='win32' && ${requiredProbe} !== process.env.CCE_REQUIRED_EXPECTED) throw new Error('libuv required env differs from actual caller child_process oracle');`;
    await writeFile(testFile, `import {spawnSync} from 'node:child_process';
${check}
const envChild = spawnSync(process.execPath, ['-e', ${JSON.stringify(check)}], {encoding:'utf8'});
if (envChild.status !== 0) throw new Error(envChild.stderr || 'grandchild failed');
${await readFile(testFile, 'utf8')}`);
    await writeFile(join(cwd, 'caller.mjs'), `process.env.CCE_VALUE=process.env.CCE_RUN; delete process.env.CCE_DELETE; export default ${JSON.stringify(options)};`);
    await writeFile(join(cwd, 'worker.mjs'), `
import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
if(process.platform==='win32') {
  const required=${JSON.stringify(required)};
  for(const key of Object.keys(process.env)) if(required.includes(key.toUpperCase())) delete process.env[key];
  process.env.UserDomain='';
  process.env.LogonServer='caller-server';
  if(process.env.CCE_RUN==='worker-b') process.env.sYsTeMrOoT=workerData.systemRoot;
  // The real Node spawn is the oracle, including empty/absent native OS values.
  const probe=spawnSync(process.execPath,['-e',${JSON.stringify(`console.log(${requiredProbe});`)}],{encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  process.env.CCE_REQUIRED_EXPECTED=probe.stdout.trim();
  const observed=JSON.parse(probe.stdout);
  const named=(name)=>observed.filter(([key])=>key.toUpperCase()===name);
  assert.deepEqual(named('USERDOMAIN'),[['UserDomain','']]);
  assert.deepEqual(named('LOGONSERVER'),[['LogonServer','caller-server']]);
  assert.deepEqual(named('HOMEDRIVE'),[]);
  assert.equal(named('USERPROFILE').length,1);
  if(process.env.CCE_RUN==='worker-b') assert.deepEqual(named('SYSTEMROOT'),[['sYsTeMrOoT',workerData.systemRoot]]);
}
registerHooks({resolve(specifier,context,next){
  if(workerData.native && (specifier==='@stryker-mutator/core'||specifier.startsWith('@stryker-mutator/core/'))) throw new Error('Forbidden native upstream import');
  return next(specifier,context);
},load(url,context,next){const result=next(url,context); if(url.endsWith('/@stryker-mutator/mocha-runner/dist/src/index.js')) return {...result,source:'process.env.CCE_META=process.env.CCE_RUN;'+result.source}; return result;}});
try {
  const reports=[];
  for(let i=0;i<2;i++) {
    if(workerData.native) {
      const {runNativeMutationTest}=await import(${JSON.stringify(new URL('../lib/runtime.js', import.meta.url).href)});
      const result=await runNativeMutationTest({args:['caller.mjs']});
      if(!result.supported||result.exitCode!==0) throw new Error(JSON.stringify(result));
    } else {
      const {Stryker}=await import('@stryker-mutator/core');
      await new Stryker({configFile:'caller.mjs'}).runMutationTest();
    }
    reports.push(JSON.parse(await readFile('reports/mutation.json','utf8')));
  }
  parentPort.postMessage({reports,env:{value:process.env.CCE_VALUE,deleted:'CCE_DELETE' in process.env,meta:process.env.CCE_META}});
} catch(error) {parentPort.postMessage({error:error.stack});}
`);
    await writeFile(join(cwd, 'launch.mjs'), `
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
process.env.CCE_VALUE='main-value'; process.env.CCE_DELETE='main-delete'; delete process.env.CCE_META;
if(process.platform==='win32') {
  // Isolated launch-process fixture only. Worker/native runs must not change it.
  delete process.env.HOMEDRIVE; process.env.HOMEPATH=''; process.env.USERDOMAIN='native-domain';
}
const mainBefore=JSON.stringify(Object.entries(process.env));
const receipts=[];
for(const id of ['worker-a','worker-b']) {
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{native:process.argv[2]==='native',systemRoot:process.env.SystemRoot},env:{...process.env,CCE_RUN:id}});
  const [message]=await once(worker,'message');
  await once(worker,'exit');
  if(message.error) throw new Error(message.error);
  assert.equal(message.env.value,id); assert.equal(message.env.deleted,false);
  ${runner === 'mocha' ? 'assert.equal(message.env.meta,id);' : ''}
  assert.equal(process.env.CCE_VALUE,'main-value'); assert.equal(process.env.CCE_DELETE,'main-delete'); assert.equal(process.env.CCE_META,undefined);
  assert.equal(JSON.stringify(Object.entries(process.env)),mainBefore,'caller worker/native changed main env');
  receipts.push(message);
}
console.log('CALLER_ENV_RECEIPTS '+JSON.stringify(receipts));
`);
    const reports = [];
    for (const mode of ['upstream', 'native']) {
      const child = spawn(process.execPath, ['launch.mjs', mode], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STRYKER_RUST_COORDINATOR_ENGINE: 'native' } });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
      const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
      await writeFile(join(evidence, `${runner}-worker-${mode}.log`), output);
      assert.deepEqual(exit, { code: 0, signal: null }, output);
      const line = output.split('\n').find(line => line.startsWith('CALLER_ENV_RECEIPTS '));
      assert.ok(line, output);
      const receipts = JSON.parse(line.slice('CALLER_ENV_RECEIPTS '.length));
      await writeFile(join(evidence, `${runner}-worker-${mode}.json`), JSON.stringify(receipts, null, 2));
      reports.push(receipts.map(receipt => ({ ...receipt, reports: receipt.reports.map(canonical) })));
    }
    assert.deepEqual(reports[1], reports[0]);
    assert.ok(Object.values(reports[1][0].reports[0].files).flatMap(file => file.mutants).some(mutant => mutant.status === 'Killed'));
  });
}

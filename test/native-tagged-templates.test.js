import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const ts = createRequire(import.meta.resolve('@stryker-mutator/util'))('typescript');
const file = (content, name = 'tagged.ts', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'strict ABI ordered full records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public native ordered full records');
  assert.deepEqual(plain(actual), direct.result, 'public native returns direct ABI bytes');
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

function compile(files, legacy = false) {
  return files.map(({ content, name }) => {
    const result = ts.transpileModule(content, { fileName: name, reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: legacy, useDefineForClassFields: true,
    } });
    assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), [], 'same completed-output TypeScript transform must succeed');
    return new vm.Script(result.outputText, { filename: name });
  });
}

function execute(scripts, setup, observation, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, exports: {} });
  new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
  const errorOf = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', `VM timeout is failed proof: mutant=${id}, settings=${JSON.stringify(settings)}`);
    return { name: error.name, message: error.message };
  };
  let loadError, error, value;
  for (const script of scripts) {
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (caught) { loadError = [...(loadError ?? []), errorOf(caught)]; }
  }
  ns.currentTestId = settings.currentTestId ?? 'tagged-test';
  if (settings.afterLoad) ns.activeMutant = id;
  try { value = new vm.Script(observation).runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = errorOf(caught); }
  return structuredClone({ value, loadError, error, events: new vm.Script('events').runInContext(context), ns });
}

function runtime(pair, files, setup, observation = '[calc(),calc()]', { legacy = false, throws = false } = {}) {
  const native = compile(pair.actual.files, legacy);
  const upstream = compile(pair.expected.files, legacy);
  const original = execute(compile(files, legacy), setup, observation);
  const baseline = execute(native, setup, observation);
  assert.equal(original.loadError, undefined, 'original fixture must load');
  assert.equal(baseline.loadError, undefined, 'native fixture must load');
  assert.equal(Boolean(original.error), throws, 'original observation must execute or throw as specified');
  assert.deepEqual(baseline.value, original.value);
  assert.deepEqual(baseline.error, original.error);
  assert.deepEqual(baseline.events, original.events, 'baseline tag and substitution evaluation matches original');
  let changed = false, limited = false;
  for (const id of [undefined, ...pair.expected.mutants.map(mutant => mutant.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(native, setup, observation, id, settings);
      assert.deepEqual(actual, execute(upstream, setup, observation, id, settings),
        `mutant=${id}, settings=${JSON.stringify(settings)}, legacy=${legacy}`);
      if (id !== undefined && !settings.afterLoad && settings.hitLimit === undefined
        && JSON.stringify({ value: actual.value, error: actual.error, events: actual.events })
          !== JSON.stringify({ value: baseline.value, error: baseline.error, events: baseline.events })) changed = true;
      if (actual.loadError?.some(error => /Hit count limit reached/.test(error.message))
        || /Hit count limit reached/.test(actual.error?.message ?? '')) limited = true;
    }
  }
  assert.ok(changed, 'an active mutant must change observable execution');
  assert.ok(limited, 'an active mutant must reach a hit limit');
  return baseline;
}

const tagSetup = `
const templates=new WeakMap();let nextTemplate=0;
function tag(strings){
  'use strict';const values=Array.prototype.slice.call(arguments,1);
  let identity=templates.get(strings);
  if(identity===undefined){identity=++nextTemplate;templates.set(strings,identity);}
  const result={identity,cooked:Array.from(strings,value=>value===undefined?null:value),raw:Array.from(strings.raw),values};
  events.push({tag:result,receiver:this===undefined?'undefined':'other',frozen:Object.isFrozen(strings)&&Object.isFrozen(strings.raw)});
  return result;
}
const html=tag,svg=tag;
function mark(label,value){events.push(label);return value;}
`;

// Keep the exact former negatives here: expanding grammar must prove their old bytes.
const formerNegatives = [
  ['literal negative', 'const a = tag`x`;', 'a'],
  ['call negative', 'const x=tag`x`;', 'x'],
  ['spread call negative', 'foo(...args);', 'events'],
  ['rest forwarding negative', 'function f(...rest){return g(...rest);}', '[f(1,2),f()]'],
  ['printed-arrow spread negative', 'values.map(value=>invoke(...value)).filter(Boolean);', 'events'],
  ['decorator negative', '@dec class C{x=html`unsupported`;}', '[new C().x,new C().x]'],
];
for (const [name, source, observation] of formerNegatives) {
  test(`exact former ${name} has positive ABI API and runtime proof`, async () => {
    const files = [file(source)];
    const pair = await compare(files);
    for (const legacy of name === 'decorator negative' ? [false, true] : [false]) {
      runtime(pair, files, tagSetup + 'const args=[1,2],values=[[1],[2]];function g(){"use strict";events.push({receiver:this===undefined,values:Array.from(arguments)});return Array.from(arguments);}function invoke(...values){events.push(values);return values[0];}function foo(...values){events.push(values);}function dec(value){events.push("decorate");return value;}', observation, { legacy });
    }
  });
}

const cases = [
  ['arbitrary identifier tags and empty sentinel', 'const loaded=arbitrary``;function calc(){return arbitrary`x`;}', tagSetup + 'const arbitrary=tag;'],
  ['static SVG and multiline raw markup', 'const loaded=svg`<svg/>`;function calc(){return html`<p>\n  raw "quotes" and \'apostrophes\'\n</p>`;}', tagSetup],
  ['raw cooked escapes and Unicode', "const loaded=tag`raw`;function calc(){return tag`a\\n\\t\\x61\\u0061\\u{1f600}\\\\\\`\\${literal}`;}", tagSetup],
  ['invalid cooked escapes admitted by tagged syntax', "const loaded=tag`raw`;function calc(){return tag`\\unicode \\xZ \\8`;}", tagSetup],
  ['CRLF raw and cooked normalization', "const loaded=tag`load`;function calc(){return tag`a\r\nb`;}", tagSetup],
  ['nested conditional tagged substitutions', 'const loaded=tag`load`;function calc(flag=true){return html`outer ${mark("first",1+2)} ${flag ? svg`inner ${mark("nested","v")}` : html`other`} ${mark("last",false)}`;}', tagSetup],
  ['substitution side effects and repeated template identity', 'const loaded=tag`load`;function calc(){return tag`v:${mark("left",counter++)}:${mark("right",++counter)}`;}', tagSetup + 'let counter=0;'],
  ['identifier lookup precedes substitution and tag call', 'const loaded=resolved`load`;function calc(){return resolved`v:${mark("sub",1+2)}`;}', tagSetup + 'Object.defineProperty(globalThis,"resolved",{get(){events.push("lookup");return tag;}});'],
  ['cloned logical and method ancestors preserve tag bytes', 'const loaded=tag`load`;function calc(){return consume(html`a${"x"}` && tag`b${false}`).slice(0);}', tagSetup + 'function consume(value){events.push("consume");return [value];}'],
];
for (const [name, source, setup] of cases) {
  test(`tagged template records and every-mutant runtime: ${name}`, async () => {
    const files = [file(source)];
    const baseline = runtime(await compare(files), files, setup);
    assert.ok(Object.keys(baseline.ns.mutantCoverage.static).length, 'load records static coverage');
    assert.ok(Object.keys(baseline.ns.mutantCoverage.perTest['tagged-test']).length, 'calls record per-test coverage');
    assert.ok(baseline.events.some(event => event?.frozen === true), 'actual frozen template objects reach the tag');
  });
}

test('ordinary identifier spread calls preserve iteration order and nested tag placement', async () => {
  const source = 'const loaded=tag`load`;function calc(){return join(...values,tag`last${true}`);}';
  const files = [file(source)];
  const setup = tagSetup + `
    const values={ [Symbol.iterator](){let index=0;events.push('iterator');return {next(){events.push('next:'+index);if(index>3)throw new RangeError('iteration budget');return index<2?{value:++index,done:false}:{done:true};}};}};
    function join(...values){events.push('join');return values;}
  `;
  runtime(await compare(files), files, setup);
  const statement = [file('function calc(){join(...values,tag`last`);}const loaded=tag`load`;')];
  runtime(await compare(statement), statement, setup);
});

for (const failure of [undefined, 'iterator-getter', 'iterator-call', 'next-getter', 'next-call', 'done-getter', 'value-getter', 'noniterable', 'later-argument']) {
  test(`ordinary spread evaluation and actual errors: ${failure ?? 'success'}`, async () => {
    const source = 'const loaded=tag`load`;function calc(){return join(mark("leading",1),...values,later(tag`trailing${true}`));}';
    const files = [file(source)];
    const setup = tagSetup + `
      const failure=${JSON.stringify(failure ?? null)};
      function step(name){events.push(name);if(failure===name)throw new RangeError(name);}
      const values=failure==='noniterable'?17:{get [Symbol.iterator](){step('iterator-getter');return function(){
        step('iterator-call');let index=0;
        return {get next(){step('next-getter');return function(){
          step('next-call');if(index>3)throw new RangeError('iteration budget');const current=index++;
          return {get done(){step('done-getter');return current>=2;},get value(){step('value-getter');return current;}};
        };},return(){events.push('iterator-return');return {done:true};}};
      };}};
      Object.defineProperty(globalThis,'join',{get(){events.push('callee-getter');return function(){
        'use strict';events.push({calleeReceiver:this===undefined});return Array.from(arguments);
      };}});
      function later(value){step('later-argument');return value;}
    `;
    const baseline = runtime(await compare(files), files, setup, '[calc(),calc()]', { throws: failure !== undefined });
    assert.ok(baseline.events.includes('callee-getter'), 'identifier callee is actually resolved');
    if (failure === undefined) {
      assert.equal(baseline.events.filter(event => event === 'callee-getter').length, 2, 'one callee resolution per call');
      assert.equal(baseline.events.filter(event => event?.calleeReceiver === true).length, 2, 'ordinary identifier calls have no receiver');
      const relevant = baseline.events.filter(event => typeof event === 'string');
      assert.ok(relevant.indexOf('callee-getter') < relevant.indexOf('leading'));
      assert.ok(relevant.indexOf('leading') < relevant.indexOf('iterator-getter'));
      assert.ok(relevant.indexOf('value-getter') < relevant.indexOf('later-argument'));
    }
  });
}

test('throwing nested substitutions preserve call order and actual errors for every mutant', async () => {
  const source = 'const loaded=tag`load`;function calc(){return html`before ${mark("first",tag`inner`)} ${fail()} ${mark("unreached",true)}`;}';
  const files = [file(source)];
  const baseline = runtime(await compare(files), files, tagSetup + 'function fail(){events.push("throw");throw new RangeError("substitution failed");}', 'calc()', { throws: true });
  assert.deepEqual(baseline.error, { name: 'RangeError', message: 'substitution failed' });
  assert.equal(baseline.events.includes('unreached'), false);
});

test('tag template objects retain identity across repeated calls and activation changes', async () => {
  const files = [file('const loaded=tag`load`;function calc(){return tag`same${true}`;}')];
  const pair = await compare(files);
  runtime(pair, files, tagSetup);
  const quasi = pair.expected.mutants.find(mutant => mutant.mutatorName === 'StringLiteral' && mutant.location.start.column > files[0].content.indexOf('function'));
  assert.ok(quasi);
  const observer = `[calc(),calc(),(__stryker__.activeMutant=${JSON.stringify(quasi.id)},calc()),calc(),(__stryker__.activeMutant=undefined,calc()),calc()]`;
  const actual = execute(compile(pair.actual.files), tagSetup, observer);
  assert.deepEqual(actual, execute(compile(pair.expected.files), tagSetup, observer));
  assert.equal(actual.error, undefined);
  const identities = actual.value.map(value => value.identity);
  assert.equal(identities[0], identities[1], 'original template object is cached');
  assert.equal(identities[2], identities[3], 'active replacement template object is cached');
  assert.notEqual(identities[0], identities[2], 'replacement and original have distinct sites');
  assert.equal(identities[0], identities[4], 'deactivation restores original site identity');
  assert.equal(identities[4], identities[5]);
});

test('tag directives ranges exclusions and global IDs keep complete records and original file metadata', async () => {
  const source = '// Stryker disable StringLiteral: keep tagged text\nconst first=tag`😀${true}`;\n// Stryker restore StringLiteral\nfunction calc(){return tag`live${false}`;}';
  const ranges = [{ start: { line: 3, column: 0 }, end: { line: 3, column: 48 } }];
  for (const mutate of [true, false, [], ranges]) {
    for (const excludedMutations of [[], ['StringLiteral'], ['BooleanLiteral'], ['all']]) {
      const files = [file('const before=true;', 'first.ts'), file(source, 'tags.ts', mutate), file('const after=false;', 'last.ts')];
      const pair = await compare(files, { ...options, excludedMutations });
      assert.deepEqual(raw(files, 4, { ...options, excludedMutations }).result, plain(pair.actual));
      if (mutate === false) assert.equal(pair.actual.files[1].content, source, 'mutate false preserves exact original bytes');
    }
  }
});

const litPath = new URL(process.env.STRYKER_TAGGED_LIT_RESOURCE || '../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/lit-html-sample.ts', import.meta.url);
test('unchanged pinned Lit resource has 59 ordered full native records', { skip: !existsSync(litPath) }, async () => {
  const bytes = await readFile(litPath);
  const files = [file(bytes.toString('utf8'), 'lit-html-sample.ts')];
  const pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 59);
  for (const threads of [1, 4, 'auto']) assert.deepEqual(raw(files, threads).result, plain(pair.actual));
  const setup = tagSetup + `
    function require(name){
      if(name==='lit-element')return {LitElement:class{},html,svg,property(){return function(){};},customElement(){return value=>value;}};
      if(name==='../lib/codeHelpers')return {pathJoin(...parts){events.push({pathJoin:parts});return parts.join('/');}};
      if(name==='../lib/htmlHelpers')return {toAbsoluteUrl(path){events.push({absolute:path});return '/'+path;}};
      return {};
    }
  `;
  const observation = `(()=>{
    const Component=exports.MutationTestReportTotalsComponent;
    const component=new Component();
    const initial=component.render();
    let reads=0;
    function model(name,file,childResults=[],mutationScore=60){
      return {name,get file(){if(++reads>100)throw new RangeError('Lit model read budget');return file;},childResults,
        metrics:{mutationScore,killed:1,survived:2,timeout:3,noCoverage:4,ignored:5,runtimeErrors:6,compileErrors:7,totalDetected:8,totalUndetected:9,totalMutants:10}};
    }
    const leaf=model('leaf',{name:'leaf'});
    const directory=model('directory',undefined,[leaf]);
    component.model=model('root',undefined,[directory,leaf]);
    component.thresholds={low:50,high:80};
    component.currentPath=['root'];
    const rendered=[component.render(),component.render()];
    const colors=[component.determineColoringClass(10),component.determineColoringClass(60),component.determineColoringClass(90),component.determineColoringClass(NaN)];
    component.model=model('file',{name:'file'},[],NaN);
    rendered.push(component.render());
    component.thresholds=undefined;
    colors.push(component.determineColoringClass(10));
    return {initial,rendered,colors};
  })()`;
  for (const legacy of [false, true]) runtime(pair, files, setup, observation, { legacy });
  const out = new URL('../artifacts/native-tagged-templates/', import.meta.url);
  await mkdir(out, { recursive: true });
  await writeFile(new URL('lit-receipt.json', out), JSON.stringify({
    source: litPath.pathname, sha256: createHash('sha256').update(bytes).digest('hex'),
    upstream: '10.0.0', records: pair.actual.mutants, nativeBatches: 1, fallbackBatches: 0, nativeErrors: 0,
  }, null, 2));
});

test('tagged batches preserve native bytes through parallel auto recovery and subsequent reuse', async () => {
  const files = [file('const before=true;', 'before.ts'), file('function calc(){return html`😀${true}`;}', 'tag.ts'),
    file('const untouched=tag`text`;', 'off.ts', false), file('', 'empty.ts'), file('const after=false;', 'after.ts')];
  const serial = raw(files);
  assert.equal(serial.supported, true, serial.reason);
  const recovery = [...files, file('type T=typeof stryMutAct_9fa48;const live=true;', 'opaque.ts')];
  for (const threads of [1, 4, 'auto']) {
    assert.deepEqual(raw([], threads).result, raw([]).result);
    assert.deepEqual(raw(files, threads).result, serial.result);
    const recovered = raw(recovery, threads);
    assert.deepEqual(recovered.result, raw(recovery).result);
    if (threads === 4 && availableParallelism() > 1) {
      assert.ok(recovered.execution.spawnedThreads > 0);
      assert.equal(recovered.execution.serialRecoveries, 1);
    }
    assert.deepEqual(raw(files, threads).result, serial.result);
    await compare(files);
  }
});

test('unproven member call optional typed tags and existing printer boundaries reject mixed batches atomically', async () => {
  for (const source of ['const x=obj.tag`x`;', 'obj.foo(...args);', 'const x=Array(...args);', 'const x=join?.(...args);', 'const x=obj["tag"]`x`;', 'const x=factory()`x`;',
    'const x=(flag?tag:html)`x`;', 'const x=tag<string>`x`;', 'const x=obj?.tag`x`;',
    'const x=tag`x${()=>{"use strict";return true;}}`;', 'const x=tag`x${a||{x:true}}`;',
    'const x=tag`x${obj.trim(/* interior */ value)}`;']) {
    const files = [file('const first=true;', 'first.ts'), file('const off=tag`untouched`;', 'off.ts', false),
      file('', 'empty.ts'), file('const excluded=tag`excluded`;', 'excluded.ts', []), file(source)];
    for (const config of [options, { ...options, excludedMutations: ['all'] }]) {
      const rejected = raw(files, 1, config);
      assert.equal(rejected.supported, false, source);
      assert.equal(rejected.result, undefined, source);
      for (const threads of [4, 'auto']) assert.deepEqual(raw(files, threads), rejected);
      const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
      await assert.rejects(strict.instrument(files, config), /unsupported/i);
      const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
      let expected, failure;
      try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
      if (failure) await assert.rejects(auto.instrument(files, config), error => error.name === failure.name && error.message === failure.message);
      else assert.deepEqual(await auto.instrument(files, config), expected);
      assert.equal(auto.stats.nativeBatches, 0);
      assert.equal(auto.stats.fallbackBatches, 1);
      assert.equal(auto.stats.nativeErrors, 0);
      assert.deepEqual(raw([file('const x=tag`recovered`;', 'recovered.ts')]).supported, true);
    }
  }
});

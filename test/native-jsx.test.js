import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parse, RecursiveVisitor, visitAll } from 'angular-html-parser';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

// Reuse Stryker's installed compiler only after instrumentation, identically for
// original, native and fresh upstream. No transform is part of the native ABI.
const ts = createRequire(import.meta.resolve('@stryker-mutator/util'))('typescript');
assert.equal(ts.version, '6.0.3', 'review the test-only transform when updating TypeScript');
const sample = "<template>\n  <div class=\"test\">\n    <h1>Hello</h1>\n  </div>\n</template>\n<script lang=\"tsx\">\nimport { Vue, Component, Prop, Watch, Emit } from 'vue-property-decorator';\n@Component({\n  name: 'example-tsx-component',\n})\nexport default class AuditDrawerInfo extends Vue {\n  public renderFunction = (h, context) => {\n    return <button>button</button>;\n  };\n}\n</script>\n<style lang=\"scss\"></style>\n";
const sampleSha = '28cac85bca322820ec5a82e60c24a66b2be000cfdff55d907abb9ee0a7423a8c';
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const file = (content, name = 'leaf.tsx', mutate = true) => ({ name, content, mutate });
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));
const output = new URL('../artifacts/native-jsx/qualification/', import.meta.url);
async function receipt(name, value) {
  await mkdir(output, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, output), JSON.stringify(value, null, 2));
}

// Pinned Angular oracle extraction, shared library rather than an HTML scanner.
function programs(input) {
  if (!/\.(?:html?|vue)$/i.test(input.name)) return [{ start: 0, end: input.content.length, content: input.content }];
  const tree = parse(input.content, { canSelfClose: true, allowHtmComponentClosingTags: true, isTagNameCaseSensitive: true });
  assert.deepEqual(tree.errors, [], 'successful HTML parsing is part of the runtime proof');
  const result = [];
  visitAll(new class extends RecursiveVisitor {
    visitElement(element, context) {
      const format = (element.attrs.find(attr => attr.name === 'type') ?? element.attrs.find(attr => attr.name === 'lang'))?.value.toLowerCase();
      if (element.name === 'script' && !element.attrs.some(attr => attr.name === 'src') &&
          (format === undefined || ['js', 'text/javascript', 'javascript', 'module', 'ts', 'text/typescript', 'typescript', 'tsx', 'text/tsx'].includes(format))) {
        const start = element.startSourceSpan.end.offset, end = element.endSourceSpan.start.offset;
        result.push({ start, end, content: input.content.slice(start, end) });
      }
      super.visitElement(element, context);
    }
  }, tree.rootNodes);
  return result;
}
function outer(input) {
  let cursor = 0;
  const parts = programs(input).map(({ start, end }) => {
    const prefix = input.content.slice(cursor, start); cursor = end; return prefix;
  });
  return [...parts, input.content.slice(cursor)];
}
async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const abi = raw(files, 1, config);
  assert.equal(abi.supported, true, abi.reason);
  assert.deepEqual(abi.result.mutants, plain(expected.mutants), 'complete fresh oracle ordered ABI records');
  const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await strict.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'complete public ordered records');
  assert.deepEqual(plain(actual), abi.result, 'public and ABI exact bytes/metadata');
  assert.deepEqual([strict.stats.nativeBatches, strict.stats.fallbackBatches, strict.stats.nativeErrors], [1, 0, 0]);
  assert.deepEqual(actual.files.map(({ content, ...metadata }) => metadata), files.map(({ content, ...metadata }) => metadata));
  for (let i = 0; i < files.length; i++) {
    if (/\.(?:html?|vue)$/i.test(files[i].name)) assert.deepEqual(outer(actual.files[i]), outer(files[i]), 'outer source exact bytes');
    for (const jsx of files[i].content.matchAll(/<(?:div|p|button|h1)(?:\s*\/>|>[^<]*<\/(?:div|p|button|h1)>)/g)) {
      assert.ok(actual.files[i].content.includes(jsx[0]), 'original JSX bytes');
    }
  }
  return { actual, expected };
}
const compiled = new Map();
function compile(input, legacy) {
  return programs(input).map(({ content }) => {
    const key = `${legacy}:${content}`;
    if (!compiled.has(key)) {
      const result = ts.transpileModule(content, { fileName: 'embedded.tsx', reportDiagnostics: true, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React, jsxFactory: 'h', experimentalDecorators: legacy, useDefineForClassFields: true,
      } });
      assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), [], 'same pinned transform must compile successfully');
      compiled.set(key, new vm.Script(result.outputText, { filename: 'compiled-jsx.js' }));
    }
    return compiled.get(key);
  });
}
function execute(files, observation, id, settings = {}, legacy = true) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.duringLoadTest ? { currentTestId: 'load' } : {}),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ exports: {}, __stryker__: ns, process: { env: {} } });
  new vm.Script(`
    const events=[];
    function mark(label,value){events.push(label);return value;}
    function dec(value){events.push(['dec',typeof value==='function'?'class':'member']);}
    function h(tag,props,...children){return {tag,props,children};}
    class Vue{constructor(){events.push('base');}}
    function Component(metadata){
      events.push(['factory',metadata.name]);
      return function(klass){events.push(['apply',klass.name,Object.getPrototypeOf(klass)===Vue]);
        return class Replacement extends klass{constructor(...args){super(...args);events.push('replacement');}};
      };
    }
    function require(name){if(name!=='vue-property-decorator')throw new Error('unexpected dependency:'+name);
      return {Vue,Component,Prop(){throw new Error('unused Prop');},Watch(){throw new Error('unused Watch');},Emit(){throw new Error('unused Emit');}};}
  `).runInContext(context, { timeout: 1000 });
  const errorOf = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeouts cannot establish equivalence');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const input of files) for (const script of compile(input, legacy)) {
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(errorOf(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'jsx';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = new vm.Script(observation).runInContext(context, { timeout: 1000 }); } catch (caught) { error = errorOf(caught); }
  return structuredClone({ value, error, loadErrors, events: new vm.Script('events').runInContext(context), ns });
}
function runtime(pair, files, observation, legacy = true) {
  const original = execute(files, observation, undefined, {}, legacy);
  const baseline = execute(pair.actual.files, observation, undefined, {}, legacy);
  assert.deepEqual(original.loadErrors, []); assert.equal(original.error, undefined);
  assert.deepEqual(baseline.loadErrors, []); assert.equal(baseline.error, undefined);
  assert.deepEqual([baseline.value, baseline.events], [original.value, original.events], 'successful original baseline');
  const cases = [];
  for (const id of [undefined, ...pair.expected.mutants.map(mutant => mutant.id)]) {
    for (const settings of [{}, { afterLoad: true }, { duringLoadTest: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(pair.actual.files, observation, id, settings, legacy);
      const expected = execute(pair.expected.files, observation, id, settings, legacy);
      if (settings.hitLimit === undefined) {
        assert.deepEqual(actual.loadErrors, [], 'every mutant must load successfully');
        assert.equal(actual.error, undefined, 'equal runtime errors cannot prove parity');
        assert.deepEqual(expected.loadErrors, [], 'every upstream mutant must load successfully');
        assert.equal(expected.error, undefined, 'upstream execution must succeed');
      }
      assert.deepEqual(actual, expected, `successful differential id=${id} settings=${JSON.stringify(settings)}`);
      cases.push({ id, settings, actual });
    }
  }
  return { original, baseline, cases };
}
const sampleObservation = `(() => {const C=exports.default,a=new C(),b=new C();return {
  identity:C===AuditDrawerInfo,name:C.name,heritage:Object.getPrototypeOf(Object.getPrototypeOf(C))===Vue,
  instances:[a instanceof C,a instanceof Vue,b instanceof C],arrows:a.renderFunction!==b.renderFunction,
  first:a.renderFunction(h,{}),second:b.renderFunction(h,{})};})()`;

test('unchanged pinned Vue TSX is native with its one complete fresh record and successful decorator JSX runtime proof', async () => {
  assert.equal(hash(sample), sampleSha);
  const override = process.env.STRYKER_JSX_RESOURCE;
  try {
    assert.equal(await readFile(new URL(override ?? '../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/vue-tsx-sample.vue', import.meta.url), 'utf8'), sample);
  } catch (error) { if (override || error.code !== 'ENOENT') throw error; }
  const files = [file(sample, 'vue-tsx-sample.vue')], pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 1);
  assert.deepEqual(pair.actual.mutants.map(({ id, mutatorName, replacement }) => ({ id, mutatorName, replacement })), [{ id: '0', mutatorName: 'BlockStatement', replacement: '{}' }]);
  const proofs = [];
  for (const legacy of [true, false]) {
    const proof = runtime(pair, files, sampleObservation, legacy);
    assert.deepEqual(proof.baseline.value, { identity: true, name: 'Replacement', heritage: true, instances: [true, true, true], arrows: true,
      first: { tag: 'button', props: null, children: ['button'] }, second: { tag: 'button', props: null, children: ['button'] } });
    assert.deepEqual(proof.baseline.events, [['factory', 'example-tsx-component'], ['apply', 'AuditDrawerInfo', true], 'base', 'replacement', 'base', 'replacement']);
    const active = proof.cases.find(c => c.id === '0' && Object.keys(c.settings).length === 0).actual;
    assert.equal(active.value.first, undefined); assert.equal(active.value.second, undefined);
    assert.ok(proof.cases.some(c => c.actual.error?.message.includes('Hit count limit')));
    assert.ok(proof.cases.some(c => c.actual.ns.mutantCoverage?.static['0']));
    assert.ok(proof.cases.some(c => c.actual.ns.mutantCoverage?.perTest.jsx?.['0']));
    proofs.push({ legacy, ...proof });
  }
  await receipt('pinned-sample', { sha256: sampleSha, files, ...pair, proofs });
});

// Exact former negative bytes are retained here BEFORE the old boundaries move.
const formerNegatives = [
  ['native-typescript', file('const x=<div/>;', 'unsupported.tsx'), 'x'],
  ['native-html', file('<script type="tsx">const x=<p/>;</script>', 'old.html'), 'x'],
  ['native-html', file('<script lang="tsx">const x=true;</script>', 'old.html'), 'x'],
  ['native-html-recovery', file('<template><script lang="tsx">const bad=true;</script></template>', 'bad.html'), 'bad'],
  ['native-vue', file('<template><script lang="tsx">const value=<p/>;</script></template>', 'old.vue'), 'value'],
  ['native-vue', file('<template><script type="text/tsx">const value=true;</script></template>', 'old.vue'), 'value'],
  ['native-vue', file('<script>export default class C{method(){return true;}}</script>', 'old.vue'), '[exports.default===C,new C().method()]'],
  ['native-decorators', file('export default @dec class C{@dec x:number=1+2;}', 'decorators.ts'), '[exports.default===C,C.name,new C().x]'],
  ['native-vue-recovery', file('<script lang="tsx">const bad=<p/>;</script>', 'bad.vue'), 'bad'],
];
test('every newly admitted exact former negative retains complete ordered records and every-mutant runtime proof', async () => {
  const ledger = [];
  for (const [origin, input, observation] of formerNegatives) {
    const pair = await compare([input]);
    ledger.push({ origin, input, sha256: hash(input.content), ...pair, proof: runtime(pair, [input], observation) });
  }
  await receipt('former-negatives', ledger);
});

test('ordinary leaves named class binding initialization and selector semantics remain bounded', async () => {
  const cases = [
    [file('const value=<div />;'), 'value'],
    [file('function render(){return <h1>hello &amp; 😀\n text</h1>;}'), 'render()'],
    [file('const render=()=>{return <p>text</p>;};'), '[render(),render()]'],
    [file('export default class C{static field=mark("static",1+2);field=mark("field",true);render=()=>{return <p/>;};}'), '(()=>{const a=new C(),b=new C();return [exports.default===C,C.name,C.field,a.field,a.render!==b.render,a.render(),b.render()];})()'],
    [file('<script type="TsX" lang="js">function render(){return <p>text</p>;}</script>', 'selector.vue'), 'render()'],
    [file('<script lang="tsx" type="js">const value=true;</script>', 'precedence.html'), 'value'],
    [file('<script lang=" tsx ">opaque </script><script src lang="tsx">opaque </script><script type="json" lang="tsx">opaque </script>', 'opaque.vue'), '42'],
    [file('<template><script lang="tsx">const first=<p/>;</script><template><script type="text/tsx">function render(){return <button>text</button>;}</script></template></template><script>const last=true;</script>', 'nested.vue'), '[first,render(),last]'],
    [file('import {Vue,Component} from "vue-property-decorator"; @Component({name:"decorated"}) export default class C extends Vue{static field=mark("static",1+2);field=mark("field",true);render=()=>{return <p/>;};}', 'decorated.tsx'), '(()=>{const a=new C(),b=new C();return [exports.default===C,C.name,C.field,a.field,a.render!==b.render,a.render(),b.render()];})()'],
  ];
  const ledger = [];
  for (const [input, observation] of cases) {
    const pair = await compare([input]);
    ledger.push({ input, ...pair, proof: runtime(pair, [input], observation) });
  }
  await receipt('ordinary-leaves', ledger);
});

test('locations Unicode CRLF ranges comments exclusions and no-header preserve oracle records', async () => {
  const ledger = [];
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const content = `<template>😀${newline}<script lang="tsx">// Stryker disable next-line BlockStatement: preserve body${newline}function render(){return <p>😀</p>;}${newline}const value=true;</script></template>`;
    for (const mutate of [true, false, [], [{ start: { line: 1, column: 0 }, end: { line: 4, column: 999 } }]]) {
      for (const excludedMutations of [[], ['BlockStatement', 'BooleanLiteral']]) {
        const files = [file(content, 'ranges.vue', mutate)], pair = await compare(files, { ...options, excludedMutations });
        ledger.push({ files, excludedMutations, ...pair, proof: runtime(pair, files, '[render(),value]') });
      }
    }
  }
  const noHeader = await compare([file('function render(){return <p/>;}')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
  await receipt('locations-filters', ledger);
});

const unsupported = [
  file('const value=<div/>;', 'plain.js'), file('const value=<div/>;', 'plain.ts'),
  ...['<Div/>', '<div a="x"/>', '<div a={true}/>', '<div {...props}/>', '<div><p/></div>', '<div>{value}</div>', '<div>{...value}</div>', '<></>', '<ns:tag/>', '<obj.tag/>', '<div<T>/>', '<div></p>', '<div>', '<div/> + 1', '!<div/>', '(<div/>).slice()', 'true && <div/>'].map(value => file(`const value=${value};`)),
  file('export default class {method(){return true;}}', 'anonymous.tsx'),
  file('export default function C(){return <p/>;}', 'function.tsx'),
  file('const value=<div/>;', 'plain.jsx.flow'),
  ...[
    '<script lang="tsx">const value="</button>";</script>',
    '<script lang="tsx">/* </button> */ const value=<p/>;</script>',
    '<script lang="tsx">const value="</"; const other=<p>text</p>;</script>',
    '<script lang="tsx">const value=<script>text</script>;</script>',
    '<script lang="tsx">const value="<!--";</script>',
    '<script src lang="tsx">const value=<p>text</p>;</script>',
    '<script type="json" lang="tsx">const value=<p>text</p>;</script>',
    '<script type="js" lang="tsx">const value=<p/>;</script>',
    '<script lang="tsx">const value=<p>{true}</p>;</script>',
    '<SCRIPT lang="tsx">const value=<p/>;</SCRIPT>',
    '<template><script lang="tsx">const value=<p/>;</script></template extra>',
  ].map(content => file(content, 'unsupported.vue')),
];
test('unsupported JSX and unproved raw-text or clone contexts reject whole mixed batches atomically', async () => {
  const ledger = [];
  for (const input of unsupported) {
    const files = [file('const before=true;', 'before.js'), file(sample, 'positive.vue'), input];
    const abi = raw(files);
    assert.equal(abi.supported, false, input.content); assert.equal(abi.result, undefined);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i);
    const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    if (failure) await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message === failure.message);
    else assert.deepEqual(await automatic.instrument(files, options), expected);
    assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0]);
    ledger.push({ input, sha256: hash(input.content), reason: abi.reason, upstreamError: failure?.message });
  }
  await receipt('retained-boundaries', ledger);
});

test('serial four auto and recovery retain exact native bytes metadata IDs and mixed-batch rejection', async () => {
  const files = [file('const before=true;', 'before.js'), file(sample, 'vue-tsx-sample.vue'), file('function render(){return <p/>;}', 'leaf.tsx'), file('const after=false;', 'after.js')];
  const pair = await compare(files), baseline = raw(files), modes = [];
  for (const threads of [1, 4, 'auto']) {
    const abi = raw(files, threads); assert.deepEqual(abi.result, baseline.result);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    await assert.rejects(strict.instrument([...files, file('const bad=<p a/>;', 'bad.tsx')], options), /unsupported/i);
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    assert.deepEqual([strict.stats.nativeBatches, strict.stats.fallbackBatches, strict.stats.nativeErrors], [2, 0, 0]);
    if (abi.execution.spawnedThreads) { assert.equal(abi.execution.serialRecoveries, 1); assert.equal(abi.execution.reason, 'unproven-relocation'); }
    modes.push({ threads, execution: abi.execution });
  }
  await receipt('modes', { files, ...pair, modes });
});

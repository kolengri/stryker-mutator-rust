import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { parse, RecursiveVisitor, visitAll } from 'angular-html-parser';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
const file = (content, name = 'container.vue', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const hash = content => createHash('sha256').update(content).digest('hex');
const artifact = new URL('../artifacts/native-vue/', import.meta.url);
const resourceOverride = process.env.STRYKER_VUE_RESOURCE;
const resource = new URL(resourceOverride ?? '../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/vue-sample.vue', import.meta.url);
// Exact pinned upstream bytes, deliberately independent of an ignored checkout.
const vueSample = "<template>\n  <div class=\"hello\">\n    <h1>{{ msg }}</h1>\n    <h2>Essential Links</h2>\n    <ul>\n      <li>\n        <a href=\"https://vuejs.org\" target=\"_blank\"> Core Docs </a>\n      </li>\n      <li>\n        <a href=\"https://forum.vuejs.org\" target=\"_blank\"> Forum </a>\n      </li>\n      <li>\n        <a href=\"https://chat.vuejs.org\" target=\"_blank\"> Community Chat </a>\n      </li>\n      <li>\n        <a href=\"https://twitter.com/vuejs\" target=\"_blank\"> Twitter </a>\n      </li>\n      <br />\n      <li>\n        <a href=\"http://vuejs-templates.github.io/webpack/\" target=\"_blank\">\n          Docs for This Template\n        </a>\n      </li>\n    </ul>\n    <h2>Ecosystem</h2>\n    <ul>\n      <li>\n        <a href=\"http://router.vuejs.org/\" target=\"_blank\"> vue-router </a>\n      </li>\n      <li>\n        <a href=\"http://vuex.vuejs.org/\" target=\"_blank\"> vuex </a>\n      </li>\n      <li>\n        <a href=\"http://vue-loader.vuejs.org/\" target=\"_blank\"> vue-loader </a>\n      </li>\n      <li>\n        <a href=\"https://github.com/vuejs/awesome-vue\" target=\"_blank\">\n          awesome-vue\n        </a>\n      </li>\n    </ul>\n  </div>\n</template>\n\n<script>\nexport default {\n  name: 'HelloWorld',\n  data() {\n    return {\n      msg: 'Welcome to Your Vue.js App',\n    };\n  },\n  watch: {\n    'category.type'(categoryType) {\n      if (this.isNew && this.category) {\n        this.category.permissions =\n          getDefaultDocumentCategoryPermissions(categoryType);\n      }\n    },\n  },\n};\n</script>\n<script>\nconst b = a + c;\n</script>\n\n<!-- Add \"scoped\" attribute to limit CSS to this component only -->\n<style scoped>\nh1,\nh2 {\n  font-weight: normal;\n}\nul {\n  list-style-type: none;\n  padding: 0;\n}\nli {\n  display: inline-block;\n  margin: 0 10px;\n}\na {\n  color: #42b983;\n}\n</style>\n";
const vueSha = "dc8c662823d82b134dde1816d077b66816d525a0d48fdc337dfc679085452c94";
const tsxSample = "<template>\n  <div class=\"test\">\n    <h1>Hello</h1>\n  </div>\n</template>\n<script lang=\"tsx\">\nimport { Vue, Component, Prop, Watch, Emit } from 'vue-property-decorator';\n@Component({\n  name: 'example-tsx-component',\n})\nexport default class AuditDrawerInfo extends Vue {\n  public renderFunction = (h, context) => {\n    return <button>button</button>;\n  };\n}\n</script>\n<style lang=\"scss\"></style>\n";
const tsxSha = '28cac85bca322820ec5a82e60c24a66b2be000cfdff55d907abb9ee0a7423a8c';
const raw = (files, threads = 1, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, execution: threads === 'auto' ? {} : { threads },
})));

// Oracle extraction is TEST ONLY. The native ABI has no JavaScript HTML parser.
function scripts(content) {
  const tree = parse(content, { canSelfClose: true, allowHtmComponentClosingTags: true, isTagNameCaseSensitive: true });
  assert.deepEqual(tree.errors, [], 'emitted HTML must remain accepted by pinned Angular');
  const result = [];
  visitAll(new class extends RecursiveVisitor {
    visitElement(element, context) {
      if (element.name === 'script' && !element.attrs.some(attr => attr.name === 'src')) {
        const format = (element.attrs.find(attr => attr.name === 'type') ?? element.attrs.find(attr => attr.name === 'lang'))?.value.toLowerCase();
        if (format === undefined || ['js', 'text/javascript', 'javascript', 'module', 'ts', 'text/typescript', 'typescript'].includes(format)) {
          const start = element.startSourceSpan.end.offset, end = element.endSourceSpan.start.offset;
          result.push({ start, end, content: content.slice(start, end), typescript: ['ts', 'text/typescript', 'typescript'].includes(format) });
        }
      }
      super.visitElement(element, context);
    }
  }, tree.rootNodes);
  return result;
}

function outer(content) {
  let cursor = 0;
  const result = scripts(content).map(script => {
    const raw = content.slice(cursor, script.start);
    cursor = script.end;
    return raw;
  });
  return [...result, content.slice(cursor)];
}

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'strict ABI full ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'public /instrumenter full ordered records');
  assert.deepEqual(plain(actual), direct.result, 'public output equals strict ABI bytes');
  const metadata = result => result.files.map(({ content, ...metadata }) => metadata);
  assert.deepEqual(metadata(actual), files.map(({ content, ...metadata }) => metadata));
  assert.deepEqual(metadata(actual), metadata(expected));
  assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
  for (let index = 0; index < files.length; index++) {
    if (/\.(?:html?|vue)$/i.test(files[index].name)) assert.deepEqual(outer(actual.files[index].content), outer(files[index].content), 'outer original bytes');
  }
  return { actual, expected };
}

const transpiled = new Map();
function executable(script) {
  const key = `${script.typescript}:${script.content}`;
  if (!transpiled.has(key)) {
    // Apply the SAME module/TS transform only AFTER instrumentation, including
    // the original baseline. Compilation errors fail the proof, not equivalence.
    transpiled.set(key, transformSync(script.content, {
      filename: script.typescript ? 'embedded.ts' : 'embedded.js', configFile: false, babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
      presets: script.typescript ? [[require.resolve('@babel/preset-typescript'), { ignoreExtensions: true }]] : [],
    }).code);
  }
  return transpiled.get(key);
}

function execute(files, observation, id, settings = {}) {
  const ns = { ...(settings.duringLoadTest ? { currentTestId: 'vue-load-test' } : {}), ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const logs = [];
  const context = vm.createContext({ exports: {}, a: 8, c: 3, getDefaultDocumentCategoryPermissions(value) { logs.push(['permissions', value]); return { value }; }, __stryker__: ns, process: { env: {} }, console: { log: (...values) => logs.push(values) } });
  const errorOf = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'timeout invalidates runtime proof');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const input of files) {
    const programs = /\.(?:html?|vue)$/i.test(input.name) ? scripts(input.content) : [{ content: input.content }];
    for (const program of programs) {
      // Compilation failures are test failures, never swallowed as mutant errors.
      const compiled = new vm.Script(executable(program), { filename: input.name });
      try { compiled.runInContext(context, { timeout: 1000 }); }
      catch (caught) { loadErrors.push(errorOf(caught)); }
    }
  }
  ns.currentTestId = settings.currentTestId ?? 'vue-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  const observer = new vm.Script(observation);
  try { value = observer.runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = errorOf(caught); }
  return structuredClone({ value, error, logs, loadErrors, ns });
}

function runtime(pair, files, observation) {
  const original = execute(files, observation);
  const baseline = execute(pair.actual.files, observation);
  assert.deepEqual(original.loadErrors, []);
  assert.equal(original.error, undefined);
  assert.deepEqual(baseline.loadErrors, []);
  assert.equal(baseline.error, undefined);
  assert.deepEqual([baseline.value, baseline.logs], [original.value, original.logs]);
  const cases = [];
  let changed = false, limited = false, staticCovered = false, testCovered = false;
  for (const id of [undefined, ...pair.expected.mutants.map(mutant => mutant.id)]) {
    for (const settings of [{}, { duringLoadTest: true }, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(pair.actual.files, observation, id, settings);
      const expected = execute(pair.expected.files, observation, id, settings);
      assert.deepEqual(actual, expected, `id=${id}; settings=${JSON.stringify(settings)}`);
      if (id !== undefined && settings.hitLimit === undefined && JSON.stringify([actual.value, actual.logs]) !== JSON.stringify([baseline.value, baseline.logs])) changed = true;
      limited ||= [...actual.loadErrors, actual.error].some(error => /Hit count limit reached/.test(error?.message ?? ''));
      staticCovered ||= Object.keys(actual.ns.mutantCoverage?.static ?? {}).length > 0;
      testCovered ||= Object.values(actual.ns.mutantCoverage?.perTest ?? {}).some(coverage => Object.keys(coverage).length > 0);
      cases.push({ id, settings, actual, expected });
    }
  }
  if (pair.expected.mutants.some(mutant => mutant.status !== 'Ignored')) assert.ok(changed, 'active mutations change behavior');
  if (pair.expected.mutants.some(mutant => mutant.status !== 'Ignored')) assert.ok(limited, 'active mutations enforce hit limits');
  if (pair.expected.mutants.some(mutant => mutant.status !== 'Ignored')) assert.ok(staticCovered, 'static coverage executes');
  if (pair.expected.mutants.some(mutant => mutant.status !== 'Ignored')) assert.ok(testCovered, 'per-test coverage executes');
  return { original, baseline, cases };
}


const receipt = async (name, value) => {
  await mkdir(artifact, { recursive: true });
  await writeFile(new URL(`${name}-${process.versions.bun ? 'bun' : 'node'}.json`, artifact), JSON.stringify(value, null, 2));
};

test('unchanged pinned Vue sample has twelve complete ordered native records and every mutant executes', async () => {
  assert.equal(hash(vueSample), vueSha);
  let comparedResource = null;
  try {
    assert.equal(await readFile(resource, 'utf8'), vueSample, 'pinned resource bytes');
    comparedResource = fileURLToPath(resource);
  } catch (error) {
    if (resourceOverride !== undefined || error.code !== 'ENOENT') throw error;
  }
  const files = [file(vueSample, 'vue-sample.vue')];
  const pair = await compare(files);
  assert.equal(pair.actual.mutants.length, 12);
  const execution = runtime(pair, files, `(() => {
    const app=exports.default, first=app.data();
    const receiver={isNew:true,category:{permissions:null}};
    app.watch['category.type'].call(receiver,'docs');
    receiver.isNew=false;app.watch['category.type'].call(receiver,'other');
    return [app.name,first,receiver,b];
  })()`);
  await receipt('fixture', { source: 'embedded unchanged pinned vue-sample.vue', sha256: vueSha, comparedResource, files, ...pair, execution });
});

// Exact formerly negative source bytes, each with full ABI/public/runtime proof.
const formerNegatives = [
  { owner: 'src/instrument.rs rejects_batches_atomically_and_rejects_options', content: 'const o = {method(){ return 1; }};', name: 'former-rust-method.js', observation: 'o.method()' },
  { owner: 'src/instrument/html.rs explicit_boundaries_reject_normalized_implicit_and_reparented_structures', content: '<template><script>const hidden=true;</script></template>', name: 'former-rust-template.html', observation: 'hidden' },
  { owner: 'test/native-html.test.js unsupported', content: '<template><script>const x=true;</script></template>', name: 'former-template.html', observation: 'x' },
  { owner: 'test/native-html.test.js unsupported', content: '<script>const f=()=>({method(){return true;}});</script>', name: 'former-method.html', observation: 'f().method()' },
  { owner: 'test/native-literals.test.js unsupported', content: 'const a = { method() { return "x"; } };', name: 'former-method.js', observation: 'a.method()' },
  { owner: 'test/native-html.test.js recovery', content: '<template><script>const bad=true;</script></template>', name: 'former-recovery.html', observation: 'bad' },
];
test('every broadened former HTML and JS negative retains exact source with full records and runtime proof', async () => {
  const ledger = [];
  for (const { observation, ...entry } of formerNegatives) {
    const files = [file(entry.content, entry.name)];
    const pair = await compare(files);
    const execution = runtime(pair, files, observation);
    ledger.push({ ...entry, sha256: hash(entry.content), files, ...pair, execution });
  }
  await receipt('negative-boundary-ledger', ledger);
});

test('ordinary object methods preserve receivers quoted keys argument effects return values and exceptions', async () => {
  for (const extension of ['vue', 'html', 'js', 'ts']) {
    const program = `export default {
      count:1,
      'quoted-key'(n=1+2){console.log('receiver',this.count,n);this.count+=n;if(n<0){throw new Error('negative');}return this.count;},
      7(){return true;},
      data(){return {msg:'😀'};},
      empty(){}
    };`;
    const content = ['vue', 'html'].includes(extension) ? `<template><ul><li>{{ msg }}</li></ul></template><script>${program}</script><style scoped>.x{color:red}</style>` : program;
    const files = [file(content, `methods.${extension}`)];
    const pair = await compare(files);
    const execution = runtime(pair, files, `(() => {
      const app=exports.default, values=[];
      for(const n of [2,-1]){try{values.push(app['quoted-key']((console.log('argument',n),n)));}catch(error){values.push([error.name,error.message]);}}
      return [values,app.count,app[7](),app.data(),app.empty(),app['quoted-key'].length];
    })()`);
    await receipt(`methods-${extension}`, { files, ...pair, execution });
  }
});

test('template fragments recurse in source order through nested scripts with shared global IDs and headers', async () => {
  const content = `<template><ul><li>{{ msg }}</li><li>plain</li></ul>
<script setup context="module">const first=true;function one(){return first?1+2:0;}</script>
<template><div>{{ other }} {{msg}}</div><script lang="TS">const second:number=3+4;function two(){return second;}</script></template>
</template><script type="module">const third=false;function three(){return third?5:6;}</script><style scoped>.x{color:red}</style>`;
  const files = [file('const before=true;', 'before.js'), file(content), file('const after=false;', 'after.js')];
  const pair = await compare(files);
  assert.equal(scripts(pair.actual.files[1].content).length, 3);
  assert.equal((pair.actual.files[1].content.match(/function stryNS_/g) ?? []).length, 3);
  assert.deepEqual(pair.actual.mutants.map(mutant => mutant.id), pair.actual.mutants.map((_, index) => String(index)));
  const execution = runtime(pair, files, '[before,one(),two(),three(),after]');
  await receipt('nested', { files, ...pair, execution });
});

test('selectors use type before lang without trimming and setup context src remain ordinary attributes', async () => {
  for (const attr of ['', 'setup', 'setup context="module"', 'lang="JS"', 'lang="Ts"', 'type="text/javascript" lang="tsx"', 'lang="tsx" type="js"', 'type="TEXT/TYPESCRIPT" lang="jsx"']) {
    const typed = /Ts|TYPESCRIPT/.test(attr);
    const files = [file(`<template><script ${attr}>const value${typed ? ':number' : ''}=1+2;function calc(){return value;}</script></template>`)];
    const pair = await compare(files);
    runtime(pair, files, 'calc()');
  }
  for (const attr of ['src', 'src=""', 'src="missing.js" lang="tsx"', 'type="" lang="js"', 'type=" js"', 'type="js "', 'lang="json"', 'type="application/json" lang="js"']) {
    const files = [file(`<template><script ${attr}>this is not executable JavaScript!</script></template>`)];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants.length, 0);
    assert.equal(pair.actual.files[0].content, files[0].content);
  }
});

test('Unicode CRLF and script-relative ranges directives exclusions preserve pinned locations', async () => {
  for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const prefix = `<template><div>😀 {{ msg }}</div>${newline}<script>`;
    const files = [file(`${prefix}const first=true;${newline}function calc(){return first?"😀":"x";}</script></template>`)];
    const pair = await compare(files);
    assert.equal(pair.actual.mutants[0].location.start.column, prefix.length + 'const first='.length);
    runtime(pair, files, 'calc()');
  }
  const content = `<template><script>// Stryker disable next-line StringLiteral: method property
export default { method(){return '😀';} };
</script></template><script>const after=true;</script>`;
  for (const mutate of [true, false, [], [{ start: { line: 1, column: 0 }, end: { line: 1, column: 99 } }], [{ start: { line: 2, column: 0 }, end: { line: 3, column: 99 } }]]) {
    for (const excludedMutations of [[], ['ObjectLiteral', 'StringLiteral']]) {
      const files = [file(content, 'ranges.vue', mutate)];
      const pair = await compare(files, { ...options, excludedMutations });
      runtime(pair, files, '[exports.default.method(),after]');
    }
  }
  const typedFiles = [file('<script lang="ts">export default { method(n:number=1+2):number{return n;} };</script>')];
  const typedPair = await compare(typedFiles);
  runtime(typedPair, typedFiles, 'exports.default.method()');
  const noHeader = await compare([file('<script>export default {method(){return true;}};</script>')], { ...options, noHeader: true });
  assert.doesNotMatch(noHeader.actual.files[0].content, /function stryNS_/);
});

const unsupported = [
  tsxSample,
  `<script>export default {\n// Stryker disable next-line BlockStatement: method body\n'quoted'(){return true;}\n};</script>`,
  '<template><script lang="tsx">const value=<p/>;</script></template>',
  '<template><script type="text/tsx">const value=true;</script></template>',
  '<template><script>const value=<p/>;</script></template>',
  '<TEMPLATE><script>const value=true;</script></TEMPLATE>',
  '<template><SCRIPT>const value=true;</SCRIPT></template>',
  '<template><script TYPE="js">const value=true;</script></template>',
  '<template><script SRC="x">const value=true;</script></template>',
  '<template><script type="js" type="ts">const value=true;</script></template>',
  '<template><div>&unknown;</div></template><script>const value=true;</script>',
  '<template><div>{{ foo() }}</div></template>',
  '<template><div>{{ msg }</div></template>',
  '<template><div>{msg}</div></template>',
  '<template><div>{{ msg }} }</div></template>',
  '<template><div :class="active">text</div></template>',
  '<template><ul><li>implicit<li>close</li></ul></template>',
  '<template><div><span></div></span></template>',
  '<template/><script>const value=true;</script>',
  '<template><svg><script>const value=true;</script></svg></template>',
  '<template><table><script>const value=true;</script></table></template>',
  '<template><script>const value="<!--<script></script>";</script></template>',
  '<template><textarea><script>opaque</script></textarea></template>',
  '<template><script>const value=true;</script></template extra>',
  '<script>export default {get value(){return true;}};</script>',
  '<script>export default {[key](){return true;}};</script>',
  '<script>export default {*method(){yield true;}};</script>',
  '<script>export default {async method(){return true;}};</script>',
  '<script>export default class C{method(){return true;}}</script>',
  '<script>export default function calc(){return true;}</script>',
  '<script>export default {method(){"use strict";return true;}};</script>',
  '<script>const value=true;</script><script>export default {method(){return receiver.tag`x`;}};</script>',
];
test('unproven Vue markup embedded grammar and TSX reject the entire mixed batch with exact fallback or errors', async () => {
  assert.equal(hash(tsxSample), tsxSha, 'pinned unsupported TSX bytes');
  try {
    const resource = new URL('../artifacts/upstream/stryker-js/packages/instrumenter/testResources/instrumenter/vue-tsx-sample.vue', import.meta.url);
    assert.equal(await readFile(resource, 'utf8'), tsxSample);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ledger = [];
  for (const content of unsupported) {
    const files = [file('const before=true;', 'before.js'), file(vueSample, 'positive.vue'), file(content, 'unsupported.vue')];
    assert.equal(raw(files).supported, false, content);
    assert.equal(raw(files).result, undefined, content);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(strict.instrument(files, options), /unsupported/i, content);
    const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    if (failure) await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message === failure.message, content);
    else assert.deepEqual(await automatic.instrument(files, options), expected, content);
    assert.deepEqual([automatic.stats.nativeBatches, automatic.stats.fallbackBatches, automatic.stats.nativeErrors], [0, 1, 0]);
    ledger.push({ content, sha256: hash(content), reason: raw(files).reason, upstreamError: failure?.message });
  }
  await receipt('retained-boundaries', ledger);
});

test('serial four auto recovery retain exact output bytes metadata and global IDs across Vue and unsupported batches', async () => {
  const files = [file('const before=true;', 'before.js'), file(vueSample, 'vue-sample.vue'), file('<template><script lang="ts">const value:number=1+2;</script></template>', 'typed.vue'), file('const after=false;', 'after.js')];
  const baseline = raw(files);
  assert.equal(baseline.supported, true, baseline.reason);
  const modes = [];
  for (const threads of [1, 4, 'auto']) {
    const direct = raw(files, threads);
    assert.deepEqual(direct.result, baseline.result);
    const strict = createInstrumenter(logger, { cache: false, engine: 'native', instrumentationThreads: threads === 'auto' ? undefined : threads });
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    await assert.rejects(strict.instrument([...files, file('<script lang="tsx">const bad=<p/>;</script>', 'bad.vue')], options), /unsupported/i);
    assert.deepEqual(plain(await strict.instrument(files, options)), baseline.result);
    assert.deepEqual([strict.stats.nativeBatches, strict.stats.fallbackBatches, strict.stats.nativeErrors], [2, 0, 0]);
    if (direct.execution.spawnedThreads) {
      assert.equal(direct.execution.serialRecoveries, 1);
      assert.equal(direct.execution.reason, 'unproven-relocation');
    }
    modes.push({ threads, execution: direct.execution });
  }
  await receipt('modes', { files, result: baseline.result, modes });
});

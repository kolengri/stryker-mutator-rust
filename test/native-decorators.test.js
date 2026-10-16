import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

// Reuse Stryker util's installed TypeScript dependency, including nested installs.
const ts = createRequire(import.meta.resolve('@stryker-mutator/util'))('typescript');
const file = (content, name = 'decorators.ts', mutate = true) => ({ name, content, mutate });

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, true, raw.reason);
  assert.deepEqual(raw.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'direct ABI ordered full records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.deepEqual(actual.mutants, expected.mutants, 'forced native ordered full records');
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

function opaque(pair, fragments) {
  for (const fragment of fragments) {
    assert.ok(pair.actual.files[0].content.includes(fragment), `preserved decorator bytes: ${fragment}`);
    const source = pair.source;
    const start = source.indexOf(fragment);
    assert.notEqual(start, -1);
    const offset = ({ line, column }) => source.split('\n').slice(0, line).reduce((size, text) => size + text.length + 1, 0) + column;
    assert.equal(pair.actual.mutants.some(mutant => offset(mutant.location.start) >= start
      && offset(mutant.location.end) <= start + fragment.length), false, 'decorator subtree has no mutants');
  }
}

function compile(files, legacy) {
  return files.map(({ content, name }) => {
    const result = ts.transpileModule(content, { fileName: name, reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: legacy, useDefineForClassFields: true,
    } });
    assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), [], 'decorator transform must succeed');
    assert.match(result.outputText, legacy ? /__decorate/ : /__esDecorate/, 'TypeScript must lower actual decorators');
    return new vm.Script(result.outputText, { filename: name });
  });
}

function execute(scripts, setup, observation, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} }, exports: {} });
  new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
  const caughtError = caught => {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: caught.name, message: caught.message };
  };
  let loadError, error, value;
  for (const script of scripts) {
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (caught) { loadError = [...(loadError ?? []), caughtError(caught)]; }
  }
  ns.currentTestId = settings.currentTestId ?? 'decorators-test';
  if (settings.afterLoad) ns.activeMutant = id;
  try { value = new vm.Script(observation).runInContext(context, { timeout: 1000 }); }
  catch (caught) { error = caughtError(caught); }
  return structuredClone({ value, loadError, error, events: new vm.Script('events').runInContext(context), ns });
}

function runtime(pair, source, setup, observation, legacy) {
  const native = compile(pair.actual.files, legacy);
  const upstream = compile(pair.expected.files, legacy);
  const original = execute(compile([file(source)], legacy), setup, observation);
  const baseline = execute(native, setup, observation);
  assert.equal(original.loadError, undefined, 'original decorators must actually execute');
  assert.equal(original.error, undefined, 'original observation must succeed');
  assert.equal(baseline.loadError, undefined, 'native decorators must actually execute');
  assert.equal(baseline.error, undefined, 'native observation must succeed');
  assert.deepEqual(baseline.value, original.value);
  assert.deepEqual(baseline.events, original.events, 'factory, decorator and initializer order matches original');
  let changed = false, limited = false;
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      const actual = execute(native, setup, observation, id, settings);
      assert.deepEqual(actual, execute(upstream, setup, observation, id, settings),
        `legacy=${legacy}, mutant=${id}, settings=${JSON.stringify(settings)}`);
      if (id !== undefined && !settings.afterLoad && settings.hitLimit === undefined
        && JSON.stringify(actual.value) !== JSON.stringify(baseline.value)) changed = true;
      if (actual.loadError?.some(error => /Hit count limit reached/.test(error.message))
        || /Hit count limit reached/.test(actual.error?.message ?? '')) limited = true;
    }
  }
  assert.ok(changed, 'activation must change an executed result');
  assert.ok(limited, 'hit limits must interrupt executed decorators or class bodies');
  assert.ok(Object.keys(baseline.ns.mutantCoverage.static).length, 'class evaluation records static coverage');
  assert.ok(Object.keys(baseline.ns.mutantCoverage.perTest['decorators-test']).length, 'class use records per-test coverage');
  return baseline;
}

const setup = `
function mark(label,value){events.push(label);return value;}
class Base{constructor(){events.push('base');}}
function factory(label,metadata){
  events.push('factory:'+label);
  return function(value,key,descriptor){
    const modern=key&&typeof key==='object';
    const kind=modern?key.kind:(typeof value==='function'&&key===undefined?'class':descriptor?'method':'field');
    events.push('apply:'+label);
    if(modern)key.addInitializer(function(){events.push('extra:'+label);});
    if(kind==='class')return class extends value{constructor(...args){super(...args);events.push('replacement:'+label);}};
    if(kind==='field'){
      if(modern)return function(initial){events.push('initialize:'+label);return initial;};
      return;
    }
    if(modern)return function(...args){events.push('call:'+label);return value.apply(this,args);};
    const method=descriptor.value;
    descriptor.value=function(...args){events.push('call:'+label);return method.apply(this,args);};
    return descriptor;
  };
}
`;

test('class, field and method factories execute with legacy and standard decorator ordering', async () => {
  const fragments = ['@factory("class", {flag:true,text:"metadata"})', '@factory("outer", [true,"outer"])',
    '@factory("field", {flag:false})', '@factory("static", "static metadata")', '@factory("method", [1+2,true])'];
  const source = `${fragments[0]}\n${fragments[1]}\nclass C<T> extends Base<T> implements I<T>{
    ${fragments[2]} public readonly field:number=mark("field-init",1+2);
    ${fragments[3]} static flag:boolean=mark("static-init",true);
    constructor(public offset:number=1+2){super();events.push("constructor");}
    ${fragments[4]} method(n:number=1+2):number{events.push("body");return this.field+n+this.offset;}
  }`;
  const pair = { ...await compare([file(source)]), source };
  opaque(pair, fragments);
  for (const legacy of [true, false]) {
    const baseline = runtime(pair, source, setup, '(() => {const a=new C(2);const b=new C(3);return [C.flag,a.field,a.method(),b.method(4)];})()', legacy);
    assert.deepEqual(baseline.value, [true, 3, 8, 10]);
    assert.deepEqual(baseline.events.filter(event => event.startsWith('factory:')),
      legacy ? ['factory:field','factory:method','factory:static','factory:class','factory:outer']
        : ['factory:class','factory:outer','factory:field','factory:static','factory:method']);
    assert.equal(baseline.events.filter(event => event === 'field-init').length, 2);
    assert.equal(baseline.events.filter(event => event === 'replacement:class').length, 2);
    assert.equal(baseline.events.filter(event => event === 'call:method').length, 2);
  }
});

test('decorated accessors and private fields preserve standard decorator initialization', async () => {
  const source = `@factory("class",true) class C{
    @factory("private",false) #value:number=mark("private-init",1+2);
    @factory("get",true) get value():number{return this.#value;}
    @factory("set",false) set value(v:number){this.#value=v+1;}
    static flag=mark("static-init",true);
  }`;
  const pair = await compare([file(source)]);
  const baseline = runtime(pair, source, setup, '(() => {const c=new C();const first=c.value;c.value=4;return [first,c.value,C.flag];})()', false);
  assert.deepEqual(baseline.value, [3,5,true]);
  assert.ok(baseline.events.includes('initialize:private'));
  assert.ok(baseline.events.includes('call:get'));
  assert.ok(baseline.events.includes('call:set'));
});

test('direct class, field and method decorators execute in both TypeScript decorator modes', async () => {
  const source = '@decorate class C{@decorate x:boolean=true;static flag=true;@decorate method(){return this.x;}}';
  const pair = { ...await compare([file(source)]), source };
  opaque(pair, ['@decorate']);
  for (const legacy of [true, false]) {
    const baseline = runtime(pair, source, `${setup}\nfunction decorate(...args){return factory('direct',true)(...args);}`,
      '(() => {const c=new C();return [c.x,c.method(),C.flag];})()', legacy);
    assert.deepEqual(baseline.value, [true,true,true]);
    assert.equal(baseline.events.filter(event => event === 'apply:direct').length, 3);
    assert.ok(baseline.events.includes('replacement:direct'));
    assert.ok(baseline.events.includes('call:direct'));
  }
});

test('decorator subtrees stay opaque even with unsupported expressions, TS and directives', async () => {
  const fragment = '@factory({flag:true, text:"😀", pattern:/ab/g, tag:html`tag`, callback:function*(){yield true;}, typed:(x:true):true=>true, /* Stryker disable all: hidden */ list:[false]})';
  const source = `${fragment}\r\nclass C{\r\nx=true;\r\nmethod(){return "body";}\r\n}\r\nconst after=false;`;
  const pair = { ...await compare([file(source)]), source };
  opaque(pair, [fragment]);
  assert.ok(pair.actual.mutants.length);
  assert.equal(pair.actual.mutants.some(m => m.status === 'Ignored'), false, 'decorator directives do not leak');
});

test('decorators retain class-expression filter state and supported TypeScript interactions', async () => {
  const sources = [
    'use(@dec class C{x=1+2;});',
    'use(class C{@dec x=1+2;});',
    'use(class C{@dec method(){return true;}});',
    'const C=@dec class<T>{x?:number=1+2;method<U>(x:number=1+2):number{return x+1;}};',
    '@dec export class C<T> extends Base<T> implements I<T>{public readonly x!:number;@dec static x=1+2;}',
    '@dec class C{constructor(public x:number=1+2){}@dec method(...args:number[]){return args.length+1;}}',
    '@dec class C{@dec "field"="value";@dec 12=true;}',
  ];
  for (const source of sources) await compare([file(source)]);
  for (const source of ['@dec class C{x=true;}', 'class C{@dec x=true;}', 'class C{@dec method(){return true;}}']) {
    await compare([file(source, 'decorators.js')]);
  }
  // A skipped Decorator leaves the same filter-stack state as upstream's skip().
  assert.deepEqual((await compare([file(sources[0])])).actual.mutants.map(m => m.id), ['0','1']);
});

test('decorator ranges, ignores, cross-file IDs and pruned directives match upstream', async () => {
  const source = '@dec({value:true})\nclass C{\n// Stryker disable next-line StringLiteral: field\n@dec("metadata") x="body";\n@dec method(){return true;}\n}\nconst after=false;';
  for (const config of [options, { ...options, excludedMutations: ['BlockStatement','StringLiteral'] }, { ...options, noHeader: true }]) {
    await compare([file('const first=true;', 'first.ts'), file(source), file('const last=false;', 'last.ts')], config);
  }
  for (const mutate of [false, [{ start: { line: 0, column: 0 }, end: { line: 0, column: 18 } }],
    [{ start: { line: 4, column: 0 }, end: { line: 4, column: 35 } }],
    [{ start: { line: 6, column: 0 }, end: { line: 6, column: 18 } }]]) {
    await compare([file(source, 'decorators.ts', mutate)]);
  }
  await compare([file('@dec({/* Stryker disable all: hidden */ value:true})\nclass C{x=true;}\nconst after=false;')]);
});

test('unproven decorated forms retain atomic fallback for the whole mixed batch', async () => {
  for (const source of ['@dec abstract class C{x=true;}', '@dec declare class C{x:true;}',
    'class C{@dec declare x:true;}', 'class C{@dec abstract x:true;}', 'class C{@dec accessor x=true;}',
    'class C{@dec [key]=true;}', 'class C{@dec [key](){return true;}}', 'class C{@dec "method"(){return true;}}',
    'class C{@dec #method(){return true;}}', 'class C{@dec *method(){return true;}}',
    'class C{constructor(@dec x:number){}}', 'class C{method(@dec x:number){return true;}}',
    '@dec class C{x=html`unsupported`;}', 'export default @dec class C{@dec x:number=1+2;}']) {
    const files = [file('const first=true;', 'first.ts'), file(source)];
    const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
    assert.equal(raw.supported, false, source);
    assert.equal(raw.result, undefined, source);
    await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, options), /unsupported/i);
    const sut = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    if (failure) await assert.rejects(sut.instrument(files, options), error => error.name === failure.name
      && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
    else assert.deepEqual(await sut.instrument(files, options), expected);
    assert.equal(sut.stats.nativeBatches, 0);
    assert.equal(sut.stats.fallbackBatches, 1);
    assert.equal(sut.stats.nativeErrors, 0);
  }
});

// Exact Stryker 10 resources from c931a93237816901f1e9f48da411170beeb3dfca.
const angularResources = {
  "app.component.ts": "import {\n  input,\n  model,\n  output,\n  Component,\n  contentChild,\n  contentChildren,\n  viewChild,\n  viewChildren,\n  TemplateRef,\n  Directive,\n} from '@angular/core';\n\n@Directive({ selector: '[stepDetail]' })\nclass StepDetailDirective {}\n\n@Component({\n  selector: 'app-root',\n  templateUrl: './app.component.html',\n  styleUrls: ['./app.component.scss'],\n})\nexport class AppComponent {\n  normalInput = input('', { alias: 'normal-input' });\n  requiredInput = input.required<string>({ alias: 'required-input' });\n\n  normalModel = model('', { alias: 'normal-model' });\n  requiredModel = model.required<string>({ alias: 'required-model' });\n\n  normalOutput = output<string>({ alias: 'normal-output' });\n\n  inputFalseAlias = input({ alias: 'this-is-actually-the-default-value' });\n  modelFalseAlias = model({ alias: 'this-is-actually-the-default-value' });\n\n  readonly contentChildField = contentChild(StepDetailDirective, {\n    read: TemplateRef,\n  });\n  readonly contentChildrenField = contentChildren(StepDetailDirective, {\n    read: TemplateRef,\n    descendants: true,\n  });\n  readonly viewChildField = viewChild('tpl', { read: TemplateRef });\n  readonly viewChildrenField = viewChildren('tpl', { read: TemplateRef });\n\n  readonly contentChildRequiredField = contentChild.required(\n    StepDetailDirective,\n    { read: TemplateRef },\n  );\n  readonly viewChildRequiredField = viewChild.required('tpl', {\n    read: TemplateRef,\n  });\n\n  readonly contentChildNoOptionsField = contentChild(StepDetailDirective);\n\n  title = 'angular-app';\n}\n",
  "app.directive.ts": "import {\n  input,\n  model,\n  output,\n  Directive,\n  contentChild,\n  contentChildren,\n  viewChild,\n  viewChildren,\n  TemplateRef,\n} from '@angular/core';\n\n@Directive({ selector: '[stepDetail]' })\nclass StepDetailDirective {}\n\n@Directive({ selector: '[appDirective]' })\nexport class AppDirective {\n  normalInput = input('', { alias: 'normal-input' });\n  requiredInput = input.required<string>({ alias: 'required-input' });\n\n  normalModel = model('', { alias: 'normal-model' });\n  requiredModel = model.required<string>({ alias: 'required-model' });\n\n  normalOutput = output<string>({ alias: 'normal-output' });\n\n  inputFalseAlias = input({ alias: 'this-is-actually-the-default-value' });\n  modelFalseAlias = model({ alias: 'this-is-actually-the-default-value' });\n\n  readonly contentChildField = contentChild(StepDetailDirective, {\n    read: TemplateRef,\n  });\n  readonly contentChildrenField = contentChildren(StepDetailDirective, {\n    read: TemplateRef,\n    descendants: true,\n  });\n  readonly viewChildField = viewChild('tpl', { read: TemplateRef });\n  readonly viewChildrenField = viewChildren('tpl', { read: TemplateRef });\n\n  readonly contentChildRequiredField = contentChild.required(\n    StepDetailDirective,\n    { read: TemplateRef },\n  );\n  readonly viewChildRequiredField = viewChild.required('tpl', {\n    read: TemplateRef,\n  });\n\n  readonly contentChildNoOptionsField = contentChild(StepDetailDirective);\n}\n"
};

test('upstream Angular resources produce all 27 and 26 ordered mutant records through forced native', async () => {
  const root = process.env.STRYKER_UPSTREAM ?? resolve('artifacts/upstream/stryker-js');
  for (const [name, content] of Object.entries(angularResources)) {
    const path = join(root, 'packages/instrumenter/testResources/instrumenter', name);
    if (existsSync(path)) assert.equal(await readFile(path, 'utf8'), content, `original ${name} bytes`);
    const pair = { ...await compare([file(content, name)]), source: content };
    assert.equal(pair.actual.mutants.length, name === 'app.component.ts' ? 27 : 26);
    opaque(pair, [...content.matchAll(/@(?:Directive|Component)\([\s\S]*?\)\n/g)].map(match => match[0]));
  }
});

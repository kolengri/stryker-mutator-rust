import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'non-null-delete.ts', mutate = true) => ({ name, content, mutate });
const completedOutputs = new Map();
async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, true, `${files.map(f => f.content).join('\n')}: ${raw.reason}`);
  assert.deepEqual(raw.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'direct ABI full ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'forced-native public full ordered records');
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

function completedJavaScript(content) {
  // Strip only completed instrumentation, identically for both engines. The
  // original TypeScript bytes always reach both production instrumenters.
  if (!completedOutputs.has(content)) completedOutputs.set(content, stripTypeScriptTypes(content));
  return completedOutputs.get(content);
}

function execute(result, setup, observation, state, id, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.initialTestId === undefined ? {} : { currentTestId: settings.initialTestId }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  new vm.Script(`const events=[];
    function capture(fn){try{const value=fn();return {value:value!==null&&(typeof value==='object'||typeof value==='function')?typeof value:value};}
      catch(error){return {error:{name:error.name,message:error.message}};}}
    ${setup}`).runInContext(context, { timeout: 1000 });
  const caughtError = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const { content } of result.files) {
    const script = new vm.Script(completedJavaScript(content));
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(caughtError(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'non-null-delete-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = new vm.Script(observation).runInContext(context, { timeout: 1000 }); } catch (caught) { error = caughtError(caught); }
  return structuredClone({ value, error, loadErrors, ns,
    state: new vm.Script(state).runInContext(context, { timeout: 1000 }),
    events: new vm.Script('events').runInContext(context, { timeout: 1000 }) });
}

function runtime(pair, setup, observation = '[capture(()=>calc()),capture(()=>calc())]', state = 'null') {
  const baseline = execute(pair.actual, setup, observation, state);
  assert.deepEqual(baseline.loadErrors, [], 'baseline must reach the observer');
  assert.equal(baseline.error, undefined, 'baseline observer must execute');
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { initialTestId: 'load-test' }, { currentTestId: '' },
      { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(pair.actual, setup, observation, state, id, settings),
        execute(pair.expected, setup, observation, state, id, settings), `id=${id}, settings=${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}

// Apache-2.0 StrykerJS resource, copyright Stryker Mutator contributors; see NOTICE.
// Original bytes from c931a93237816901f1e9f48da411170beeb3dfca, instrumenter 10.0.0.
const optionalChains = `const baz = foo?.bar?.()?.[1] ?? 'qux';

qux()?.map();

const directiveRanges = comments?.map(tryParseTSDirective);

const qux = quux(corge?.cov());

input?.id!.toString();

bar?.baz[0];

state.stats[organization?.organization_id] = action.payload.stats;

// https://github.com/stryker-mutator/stryker-js/issues/4741
delete myVariable?.[indexer];
void foo?.();
`;

test('original optional-chains.ts dispatches natively with all 13 exact ordered records', async () => {
  if (process.env.STRYKER_UPSTREAM) assert.equal(await readFile(`${process.env.STRYKER_UPSTREAM}/packages/instrumenter/testResources/instrumenter/optional-chains.ts`, 'utf8'), optionalChains);
  const pair = await compare([file(optionalChains, 'optional-chains.ts')]);
  const records = [
    ['LogicalOperator', 0, 12, 38, "foo?.bar?.()?.[1] && 'qux'"],
    ['OptionalChaining', 0, 12, 29, 'foo?.bar?.()[1]'],
    ['OptionalChaining', 0, 12, 24, 'foo?.bar()'],
    ['OptionalChaining', 0, 12, 20, 'foo.bar'],
    ['StringLiteral', 0, 33, 38, '""'],
    ['OptionalChaining', 2, 0, 10, 'qux().map'],
    ['OptionalChaining', 4, 24, 37, 'comments.map'],
    ['OptionalChaining', 6, 17, 27, 'corge.cov'],
    ['OptionalChaining', 8, 0, 9, 'input.id'],
    ['OptionalChaining', 10, 0, 8, 'bar.baz'],
    ['OptionalChaining', 12, 12, 41, 'organization.organization_id'],
    ['OptionalChaining', 15, 7, 28, 'myVariable[indexer]'],
    ['OptionalChaining', 16, 5, 12, 'foo()'],
  ].map(([mutatorName, line, start, end, replacement], index) => ({ fileName: 'optional-chains.ts', id: String(index),
    mutatorName, location: { start: { line, column: start }, end: { line, column: end } }, replacement,
    status: undefined, statusReason: undefined }));
  assert.deepEqual(pair.actual.mutants, records);
});

test('every original expression executes independently for its baseline and every active mutant', async () => {
  const cases = [
    ["const baz = foo?.bar?.()?.[1] ?? 'qux';", 'const foo=null;', 'baz'],
    ["const baz = foo?.bar?.()?.[1] ?? 'qux';", 'const foo={bar(){events.push(this===foo);return [0,"value"];}};', 'baz'],
    ['qux()?.map();', 'const receiver={map(){events.push(["map",this===receiver]);}};function qux(){events.push("qux");return receiver;}', 'events'],
    ['const directiveRanges = comments?.map(tryParseTSDirective);', 'const comments=[1,2];function tryParseTSDirective(x){events.push(x);return x+1;}', 'directiveRanges'],
    ['const qux = quux(corge?.cov());', 'const corge={cov(){events.push(["cov",this===corge]);return 3;}};function quux(x){events.push(["quux",x]);return x;}', 'qux'],
    ['input?.id!.toString();', 'const id={toString(){events.push(["toString",this===id]);return "id";}};const input={get id(){events.push("get:id");return id;}};', 'events'],
    ['input?.id!.toString();', 'const input=null;', 'events'],
    ['bar?.baz[0];', 'const bar={get baz(){events.push("get:baz");return [3];}};', 'events'],
    ['state.stats[organization?.organization_id] = action.payload.stats;', 'const state={stats:{}},action={payload:{stats:7}},organization={get organization_id(){events.push("id");return "key";}};', 'state.stats'],
    ['delete myVariable?.[indexer];', 'const myVariable={x:3},indexer={toString(){events.push("key");return "x";}};', 'Object.hasOwn(myVariable,"x")'],
    ['void foo?.();', 'function foo(){events.push("foo");return 4;}', 'events'],
  ];
  for (const [source, setup, observation] of cases) {
    assert.ok(optionalChains.includes(source), 'exercise exact original expression bytes');
    runtime(await compare([file(source)]), setup, observation);
  }
  const nullableCases = [
    ["const baz = foo?.bar?.()?.[1] ?? 'qux';", [
      'const foo=undefined;', 'const foo={bar:null};', 'const foo={bar:undefined};',
      'const foo={bar(){events.push(["bar",this===foo]);return null;}};',
      'const foo={bar(){events.push(["bar",this===foo]);return undefined;}};',
      'const foo={get bar(){events.push("bar");throw new Error("getter");}};',
    ], 'baz'],
    ['qux()?.map();', ['function qux(){events.push("qux");return null;}',
      'function qux(){events.push("qux");return undefined;}'], 'events'],
    ['const directiveRanges = comments?.map(tryParseTSDirective);',
      ['const comments=null;function tryParseTSDirective(){}','const comments=undefined;function tryParseTSDirective(){}'], 'directiveRanges'],
    ['const qux = quux(corge?.cov());', ['const corge=null;function quux(x){events.push(x);return x;}',
      'const corge=undefined;function quux(x){events.push(x);return x;}'], 'qux'],
    ['input?.id!.toString();', ['const input=undefined;'], 'events'],
    ['bar?.baz[0];', ['const bar=null;','const bar=undefined;'], 'events'],
    ['state.stats[organization?.organization_id] = action.payload.stats;',
      ['const organization=null,state={stats:{}},action={payload:{stats:7}};',
        'const organization=undefined,state={stats:{}},action={payload:{stats:7}};'], 'state.stats'],
    ['delete myVariable?.[indexer];', ['const myVariable=null,indexer="x";',
      'const myVariable=undefined,indexer="x";'], 'events'],
    ['void foo?.();', ['const foo=null;','const foo=undefined;'], 'events'],
  ];
  for (const [source, setups, observation] of nullableCases) {
    const pair = await compare([file(source)]);
    for (const setup of setups) {
      // A throwing getter is intentional program behavior, not runtime proof
      // from the unrelated whole-file lexical-qux failure.
      if (setup.includes('throw new Error')) {
        for (const id of [undefined,...pair.expected.mutants.map(m=>m.id)]) {
          assert.deepEqual(execute(pair.actual,setup,'events','null',id),execute(pair.expected,setup,'events','null',id));
        }
      } else runtime(pair, setup, observation);
    }
  }
  const input = await compare([file('function calc(){return input?.id!.toString();}')]);
  for (const id of ['null', 'undefined']) runtime(input, `const input={get id(){events.push("id");return ${id};}};`);
});

const receiverSetup = `const receiver={get trim(){events.push('get:trim');return function(x){events.push(['trim',this===receiver,x]);return ' result ';};},
  get id(){events.push('get:id');return receiver;},toString(){events.push(['toString',this===receiver]);return 'id';}};
  const obj=receiver,foo=receiver,a=4,b=2;
  function arg(){events.push('arg');return 2;} function factory(){events.push('base');return receiver;}`;

test('non-null spines preserve receivers, getter/key/argument counts and local arithmetic placement', async () => {
  for (const expression of ['foo.trim()!', 'foo!.trim()', 'foo!.trim()!', '(a+b)!', 'input?.id!.toString()',
    'obj?.trim!()', 'obj?.id!.trim()', 'obj?.trim!?.()', 'factory()?.id!!?.trim!(arg())',
    'obj!?.trim()', 'obj?.id!!.trim()', 'obj?.trim!(obj?.id!.toString())',
    'obj?.[key.trim()!]!.trim(arg())', 'obj?.trim!(arg()+1)!.length']) {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    const observation = '[capture(()=>calc()),capture(()=>calc()),capture(()=>calc()===receiver)]';
    runtime(pair, receiverSetup + 'const input=obj,key="id";', observation);
    if (expression.includes('obj?') || expression.includes('input?')) for (const absent of ['null', 'undefined']) {
      runtime(pair, receiverSetup.replace('const obj=receiver', `const obj=${absent}`) + 'const input=obj,key="id";', observation);
    }
  }
  const pair = await compare([file('const value=(a+b)!;')]);
  assert.match(pair.actual.files[0].content, /stryCov_9fa48\("0"\)[\s\S]*!;/);
  assert.doesNotMatch(pair.actual.files[0].content, /\? \(a - b!\)/);
});

test('placement transparency retains direct syntactic predicates and filtered call ID gaps', async () => {
  for (const [source, expected] of [
    ['obj?.trim!();', [['0','OptionalChaining','obj.trim']]],
    ['obj?.id!.trim();', [['0','MethodExpression','obj?.id!'],['1','OptionalChaining','obj.id']]],
    ['Array!();', [['0','CallExpression',';']]],
    ['require!("x");', [['1','StringLiteral','""']]],
    ['Symbol!("x");', [['1','StringLiteral','""']]],
    ['obj?.trim!?.();', [['0','OptionalChaining','obj?.trim!()'],['1','OptionalChaining','obj.trim']]],
  ]) {
    const pair = await compare([file(source)]);
    assert.deepEqual(pair.actual.mutants.map(m => [m.id,m.mutatorName,m.replacement]), expected);
    runtime(pair, receiverSetup + 'function Array(){events.push("Array");}function require(x){events.push(["require",x]);}function Symbol(x){events.push(["Symbol",x]);}', 'events');
  }
});

test('non-null contextual roots own conditional mutants once with normal scopes and loop context', async () => {
  const root = await compare([file('if(obj?.x!) ;')]);
  assert.deepEqual(root.actual.mutants.map(m => [m.id,m.mutatorName,m.location.start.column,m.location.end.column]),
    [['0','ConditionalExpression',3,10],['1','ConditionalExpression',3,10],['2','OptionalChaining',3,9]]);
  for (const source of ['function calc(){if(obj?.x!) return 1;return 2;}',
    'function calc(){while(obj?.x!) break;return 2;}',
    'function calc(){do {record();} while(obj?.x!);return 2;}',
    'function calc(){for(;obj?.x!;) break;return 2;}',
    'function calc(){if((a+b)!) return 1;return 2;}']) {
    const pair = await compare([file(source)]);
    for (const obj of ['null','undefined','{get x(){events.push("x");return false;}}']) {
      runtime(pair, `const obj=${obj},a=1,b=2;function record(){events.push("record");}`);
    }
  }
});

test('delete switches surround references and leave key mutations local with bypassed nested coverage', async () => {
  const direct = await compare([file('delete obj?.[obj.trim()];')]);
  assert.deepEqual(direct.actual.mutants.map(m => [m.id,m.mutatorName,m.replacement]),
    [['0','OptionalChaining','obj[obj.trim()]'],['1','MethodExpression','obj']]);
  const pair = await compare([file('function calc(){return delete obj?.[obj.trim()];}')]);
  assert.deepEqual(pair.actual.mutants.map(m => [m.id,m.mutatorName,m.replacement]),
    [['0','BlockStatement','{}'],['1','OptionalChaining','obj[obj.trim()]'],['2','MethodExpression','obj']]);
  const setup = `const obj={x:3,trim(){events.push(['trim',this===obj]);return 'x';},toString(){events.push('key');return 'x';}};`;
  const baseline = runtime(pair, setup, '[calc(),calc()]', 'Object.hasOwn(obj,"x")');
  assert.equal(baseline.state, false);
  assert.deepEqual(baseline.value, [true,true]);
  const active = execute(pair.actual, setup, '[calc(),calc()]', 'Object.hasOwn(obj,"x")', '1');
  assert.equal(active.state, false);
  assert.equal(active.ns.mutantCoverage?.perTest?.['non-null-delete-test']?.['2'], undefined);
  assert.match(pair.actual.files[0].content, /\? \(delete obj\[obj\.trim\(\)\]\)/);
});

test('delete preserves actual deletion, nullish short-circuit, key coercion and proxy deleteProperty traps', async () => {
  for (const expression of ['delete obj.x', 'delete obj?.x', 'delete obj!.x', 'delete obj?.x!',
    'delete obj?.[key()]', 'delete obj?.[key()]!', 'delete base()?.[key()]',
    'delete base()!?.[key()]', 'delete obj.trim()!.x', 'delete obj?.trim!(arg()).x',
    'delete obj?.trim!(arg()+1).x']) {
    const pair = await compare([file(`function calc(){return ${expression};}`)]);
    for (const base of ['target','null','undefined']) for (const configurable of [true,false]) {
      const setup = `const target={trim(x){events.push(['trim',this===obj,x]);return target;}};
        Object.defineProperty(target,'x',{get(){events.push('getter');return 3;},configurable:${configurable}});
        const obj=${base};function base(){events.push('base');return obj;}
        function key(){events.push('key');return {toString(){events.push('coerce');return 'x';}};}
        function arg(){events.push('arg');return 2;}`;
      const baseline = runtime(pair, setup, '[capture(()=>calc()),capture(()=>calc())]', 'Object.hasOwn(target,"x")');
      assert.ok(!baseline.events.includes('getter'), 'delete must never read the property value');
      if (base === 'target') assert.equal(baseline.state, !configurable);
      if (base !== 'target' && expression.includes('?.') && !expression.includes('trim')) assert.deepEqual(baseline.events.filter(e => e !== 'base'), []);
    }
  }
  const nullBase = await compare([file('function calc(){return delete base()?.[key()];}')]);
  const nullSetup = 'function base(){events.push("base");return null;}function key(){events.push("key");return "x";}';
  const active = execute(nullBase.actual,nullSetup,'capture(()=>calc())','null','1');
  assert.deepEqual(active.events,['base','key']);
  assert.equal(active.value.error.name,'TypeError');
  for (const returns of ['true','false','throw new Error("trap");']) {
    const pair = await compare([file('function calc(){return delete base()?.[key()]!;}')]);
    const setup = `const target={x:3};const obj=new Proxy(target,{get(){events.push('getter');return 3;},
      deleteProperty(target,key){events.push(['delete',key]);${returns.startsWith('throw') ? returns : `if(${returns})delete target[key];return ${returns};`}}});
      function base(){events.push('base');return obj;}function key(){events.push('key');return {toString(){events.push('coerce');return 'x';}};}`;
    const baseline = runtime(pair, setup, '[capture(()=>calc()),capture(()=>calc())]', 'Object.hasOwn(target,"x")');
    assert.ok(!baseline.events.includes('getter'));
    assert.deepEqual(baseline.events.slice(0,4), ['base','key','coerce',['delete','x']]);
  }
});

test('strict delete preserves non-configurable and false proxy-trap exceptions', async () => {
  // Class methods are inherently strict without broadening directive support.
  const pair = await compare([file('class C{static calc(){return delete obj?.x!;}} function calc(){return C.calc();}')]);
  for (const setup of ['const obj={};Object.defineProperty(obj,"x",{value:3,configurable:false});',
    'const obj=new Proxy({x:3},{deleteProperty(target,key){events.push(["delete",key]);return false;}});']) {
    const baseline = runtime(pair,setup,'[capture(()=>calc()),capture(()=>calc())]','Object.hasOwn(obj,"x")');
    assert.equal(baseline.value[0].error.name,'TypeError');
    assert.equal(baseline.state,true);
  }
});

test('logical clones preserve raw quotes and generated string mutants use double quotes', async () => {
  for (const quote of ["'", '"']) for (const operator of ['??','||','&&']) {
    const pair = await compare([file(`function calc(){return obj?.x ${operator} ${quote}qux${quote};}`)]);
    assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'LogicalOperator' && m.replacement.endsWith(`${quote}qux${quote}`)));
    assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'StringLiteral' && m.replacement === '""'));
    for (const obj of ['null','undefined','{x:0}','{x:"value"}']) runtime(pair, `const obj=${obj};`);
  }
  for (const raw of ['', ' ', '!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~']) {
    const pair = await compare([file(`const value=flag??'${raw}';`)]);
    runtime(pair,'const flag=null;','value');
  }
});

test('non-null/delete ranges UTF16 CRLF directives exclusions and cross-file gaps retain full records and runtime', async () => {
  const cases = ['if(obj?.x!) record();','delete obj?.[key.trim()!];','require!("x");',
    '// Stryker disable next-line all: reason\r\nif(obj?.x!) record();',
    '// Stryker disable next-line all:   \r\ndelete obj?.x!;',
    '// Stryker disable next-line OptionalChaining: reason\nif(obj?.x!) record();',
    '// Stryker disable next-line ConditionalExpression:   \nif(obj?.x!) record();',
    'const astral="😀";delete obj?.[key.trim()!]!;\r\nif(obj?.x!) record();'];
  const setup = 'const obj={x:3},key="x";function record(){events.push("record");}function require(x){events.push(x);}';
  for (const source of cases) for (const excludedMutations of [[],['OptionalChaining'],['MethodExpression'],['ConditionalExpression'],['StringLiteral'],['OptionalChaining','ConditionalExpression','MethodExpression','StringLiteral']]) {
    const pair = await compare([file(source)], { ...options, excludedMutations });
    runtime(pair, setup, 'events', 'Object.hasOwn(obj,"x")');
    if (pair.actual.mutants.every(m => m.status === 'Ignored')) assert.doesNotMatch(pair.actual.files[0].content, /function stryNS_/);
  }
  const source = 'if(obj?.x!) record();';
  for (const mutate of [false, [], ...Array.from({length:source.length+1}, (_, end) => [{ start:{line:0,column:0},end:{line:0,column:end} }])]) {
    runtime(await compare([file(source,'selected.ts',mutate)]), setup, 'events');
  }
  const pair = await compare([file('require!("x");','first.ts'),file('if(obj?.x!) record();','off.ts',false),
    file('delete obj?.[key.trim()!];','last.ts')]);
  runtime(pair, setup, 'events', 'Object.hasOwn(obj,"x")');
  assert.deepEqual(pair.actual.mutants.map(m=>m.id), ['1','2','3']);
});

async function fallback(content) {
  const files = [file('const accepted=true;','first.ts'),file(content,'unsupported.ts')];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
  assert.equal(raw.supported, false, content);
  assert.equal(raw.result, undefined, content);
  await assert.rejects(createInstrumenter(logger,{cache:false,engine:'native'}).instrument(files,options), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files,options); } catch(error) { failure = error; }
  const sut = createInstrumenter(logger,{cache:false,engine:'auto'});
  if (failure) await assert.rejects(sut.instrument(files,options), error => error.name === failure.name &&
    error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await sut.instrument(files,options),expected);
  assert.equal(sut.stats.nativeBatches,0);
  assert.equal(sut.stats.fallbackBatches,1);
  assert.equal(sut.stats.nativeErrors,0);
  return failure;
}

test('typed lvalues private/super and parenthesized optional spines remain atomic fallback', async () => {
  for (const source of ['obj!.x! = value;','for(obj!.x! of values) ;','delete value;',
    'delete factory();','delete (obj?.x)!.y;','(obj?.x)!.trim();','(obj?.trim!)();',
    'class C{#x;f(){return this?.#x!;}}','class C{#x;f(){return this.#x!;}}',
    'class C{#x;f(){return this!.#x;}}','class C{#x;f(){return this!.#x();}}',
    'class C extends B{f(){return super.x!.trim();}}']) await fallback(source);
});

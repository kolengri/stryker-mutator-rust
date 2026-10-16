import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { availableParallelism } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'arrows.js', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === undefined ? {} : { execution: { threads } }),
})));

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'direct ABI ordered records');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants, 'public full ordered records');
  assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  return { actual, expected };
}

const completedOutputs = new Map();
function executable({ name, content }) {
  if (!name.endsWith('.ts')) return content;
  if (!completedOutputs.has(content)) completedOutputs.set(content, stripTypeScriptTypes(content));
  return completedOutputs.get(content);
}

function execute(result, setup, observation, state, activeMutant, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  evaluate(`const events=[];
    function capture(fn){try{return fn();}catch(e){return {name:e.name,message:e.message};}}
    ${setup}`);
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const output of result.files) {
    // Compile outside the catch: instrumentation must produce executable syntax.
    const script = new vm.Script(`${settings.strict ? '"use strict";\n' : ''}${executable(output)}`);
    try { script.runInContext(context, { timeout: 1000 }); }
    catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'printed-arrows';
  if (settings.afterLoad) ns.activeMutant = activeMutant;
  let value, error;
  try { value = evaluate(observation); }
  catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, ns, state: evaluate(state), events: evaluate('events') });
}

function runtime(pair, setup = '', observation = '[calc(),calc()]', state = 'null') {
  const baseline = execute(pair.actual, setup, observation, state);
  assert.deepEqual(baseline.loadErrors, [], 'baseline must load');
  assert.equal(baseline.error, undefined, 'baseline must reach its observer');
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const strict of [false, true]) for (const settings of [
      {}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 },
    ]) {
      assert.deepEqual(execute(pair.actual, setup, observation, state, id, { strict, ...settings }),
        execute(pair.expected, setup, observation, state, id, { strict, ...settings }),
        `mutant=${id}, strict=${strict}, settings=${JSON.stringify(settings)}`);
    }
  }
  return baseline;
}

test('concise callback chains have pinned ordered records and executable replacements', async () => {
  const source = "function normalize(input){return input.split(',').map((value)=>value.trim().toLowerCase()).filter(Boolean);}";
  const pair = await compare([file(source)]);
  assert.deepEqual(pair.actual.mutants.map(({ id, mutatorName, replacement }) => [id, mutatorName, replacement]), [
    ['0', 'BlockStatement', '{}'],
    ['1', 'MethodExpression', "input.split(',').map(value => value.trim().toLowerCase())"],
    ['2', 'StringLiteral', '""'],
    ['3', 'ArrowFunction', '() => undefined'],
    ['4', 'MethodExpression', 'value.trim().toUpperCase()'],
    ['5', 'MethodExpression', 'value'],
  ]);
  runtime(pair, '', '[normalize(" A , ,B "),normalize(" c,D ")]');
});

for (const [name, params, body] of [
  ['zero identifiers', '()', 'true'],
  ['bare identifier', 'value', 'value'],
  ['parenthesized identifier', '(value)', 'value'],
  ['multiple identifiers and trailing comma', '(value,index,)', 'value+index'],
  ['unicode identifier', '(é)', 'é+1'],
  ['escaped identifier', '(\\u0076alue)', '\\u0076alue+1'],
  ['nested concise arrows', '(value)', 'invoke(other=>value+other)'],
  ['sequence and conditional precedence', '(value)', '(mark(value),value?left(value):right(value))'],
]) {
  test(`printed callbacks preserve ${name}`, async () => {
    const pair = await compare([file(`function calc(){return values.map(${params}=>${body}).filter(Boolean);}`)]);
    runtime(pair, `const values=[0,2];function invoke(fn){events.push([fn.name,fn.length]);return fn(3);}
      function mark(x){events.push(["mark",x]);return x;}
      function left(x){events.push("left");return x+1;}function right(x){events.push("right");return x-1;}`);
  });
}

test('arrow callee, conditionals, arguments, and nested mapped methods preserve precedence', async () => {
  for (const source of [
    'function calc(){return invoke(flag?value=>left(value):value=>right(value)).filter(Boolean);}',
    'function calc(){return invoke((value=>other=>value+other)(2)).filter(Boolean);}',
    'function calc(){return values.map(value=>receive(value,other=>other.trim().toLowerCase())).filter(Boolean).map(value=>value).filter(Boolean);}',
    'function calc(){return values.map((value,index)=>receive(value,index,()=>true)).filter(Boolean).join(",").toLowerCase();}',
  ]) {
    const pair = await compare([file(source)]);
    runtime(pair, `const flag=true,values=[" A ","B"];
      function invoke(fn){events.push([fn.name,fn.length]);return [fn(1),fn(2)];}
      function left(x){events.push("left");return x+1;}function right(x){events.push("right");return x-1;}
      function receive(value,other,zero){events.push([value,typeof other,zero&&zero()]);return typeof other==="function"?other(value):value;}`);
  }
});

test('callbacks retain lexical this and arguments over repeated invocations', async () => {
  const pair = await compare([file('function calc(values){return values.map(value=>(record(this,arguments,value),this.factor*value+arguments[1])).filter(Boolean);}')]);
  const baseline = runtime(pair,
    'const receiver={factor:3};function record(self,args,value){events.push([self===receiver,args.length,args[1],value]);}',
    '[calc.call(receiver,[1,2],4),calc.call(receiver,[3,0],5)]');
  assert.deepEqual(baseline.value, [[7, 10], [14, 5]]);
  assert.equal(baseline.events.length, 4);
});

test('inferred names stay local to their original binding or assignment context', async () => {
  for (const source of [
    'function calc(){const callback=value=>value+1;return callback;}',
    'function calc(){let callback;return callback=value=>value+1;}',
    'function calc(){return save(callback=value=>value+1).filter(Boolean);}',
    'function calc(){return (callback=value=>value+1)&&callback;}',
  ]) {
    const pair = await compare([file(source)]);
    runtime(pair, 'let callback;function save(fn){events.push([fn.name,fn.length,fn(2)]);return [fn.name];}',
      '[capture(()=>{const f=calc();return typeof f==="function"?[f.name,f.length,f(2)]:f;}),capture(()=>{const f=calc();return typeof f==="function"?[f.name,f.length,f(3)]:f;})]');
  }
});

test('computed keys and assignment ancestors preserve reference evaluation and callback order', async () => {
  for (const source of [
    'function calc(){return target[makeKey(value=>key(value))]+=rhs();}',
    'function calc(){return factory().filter(value=>keep(value)).field=value=>value+1;}',
    'function calc(){return target[makeKey(value=>key(value))]++;}',
  ]) {
    const pair = await compare([file(source)]);
    runtime(pair, `const target={field:4};const values=[1,2];
      function makeKey(fn){events.push(["makeKey",fn.name,fn.length]);return fn("field");}
      function key(value){events.push(["key",value]);return value;}
      function rhs(){events.push("rhs");return 2;}
      function factory(){events.push("factory");return values;}
      function keep(value){events.push(["keep",value]);return value;}`,
    '[capture(()=>{const f=calc();return typeof f==="function"?[f.name,f.length,f(2)]:f;}),capture(()=>{const f=calc();return typeof f==="function"?[f.name,f.length,f(3)]:f;})]',
    '[target.field,target.undefined,values.field&&values.field.name]');
  }
});

test('optional chains preserve argument and callback short circuiting', async () => {
  for (const values of ['null', '[0,2]']) {
    const pair = await compare([file('function calc(){return values?.map(value=>mark(value)+1).filter(Boolean);}')]);
    runtime(pair, `const values=${values};function mark(value){events.push(value);return value;}`);
  }
});

test('raw spelling, marker lookalikes, templates, and UTF8 parameter spans remain distinct', async () => {
  const source = String.raw`function calc(){return values.map(é=>receive('é',"\x61",'__stryker_raw_string_0__',` + '`😀 (value) => __stryker_raw_string_1__`' + ',é)).filter(Boolean);}';
  const pair = await compare([file(source)]);
  runtime(pair, 'const values=[1,2];function receive(...args){events.push(args);return args[4];}');
  assert.ok(pair.actual.mutants.some(m => m.replacement.includes(String.raw`receive('é', "\x61", '__stryker_raw_string_0__'`)));
});

test('TS non-null wrappers and simple call type arguments preserve callback records and type skips', async () => {
  for (const source of [
    'function calc(values:number[]){return values!.map(value=>value!+1).filter(Boolean);}',
    'function calc(values:number[]){return values.map<number>(value=>value+1).filter(Boolean);}',
    'function calc(values:number[]){return values.map(value=>invoke<number>(value)).filter(Boolean);}',
  ]) runtime(await compare([file(source, 'arrows.ts')]), 'function invoke(x){events.push(x);return x;}', '[calc([0,2]),calc([3,4])]');
});

test('directives, exclusions, selection gaps and unchanged files retain IDs and statuses', async () => {
  const source = "// Stryker disable next-line ArrowFunction: preserve callback\r\nconst astral='😀';const chosen=values.map(é=>é+1).filter(Boolean);\r\nconst tail=false;";
  const files = [file('consume(true);', 'filtered.js'), file(source, 'selected.js', [{
    start: { line: 1, column: 0 }, end: { line: 1, column: source.split('\r\n')[1].length },
  }]), file('const untouched=values.map(value=>value).filter(Boolean);', 'off.js', false)];
  for (const config of [options, { ...options, excludedMutations: ['MethodExpression', 'ArithmeticOperator'] }, { ...options, noHeader: true }]) {
    const pair = await compare(files, config);
    assert.ok(Number(pair.actual.mutants[0].id) > 0, 'filtered statement consumes IDs');
    assert.ok(pair.actual.mutants.some(m => m.status === 'Ignored'));
    if (!config.noHeader) runtime(pair, 'const values=[0,2];function consume(x){events.push(x);}', '[astral,chosen,tail,untouched]');
  }
});

test('excluded arrow switches retain inner instrumentation and inferred names', async () => {
  const files = [file('function calc(){const callback=value=>value+1;return [callback.name,values.map(value=>callback(value)).filter(Boolean)];}')];
  for (const excludedMutations of [['ArrowFunction'], ['MethodExpression'], ['ArrowFunction', 'MethodExpression']]) {
    const pair = await compare(files, { ...options, excludedMutations });
    assert.ok(pair.actual.mutants.some(m => m.status === 'Ignored'));
    assert.ok(pair.actual.mutants.every(m => !excludedMutations.includes(m.mutatorName) || m.status === 'Ignored'));
    runtime(pair, 'const values=[0,2];');
  }
});

test('whole-for replacement formatting reuses the arrow and raw-literal proofs', async () => {
  const pair = await compare([file("function calc(){for(;;tick()){values.map(value=>mark('é',value)).filter(Boolean);break;}return events.length;}")]);
  runtime(pair, 'const values=[0,2];let ticks=0;function tick(){if(++ticks>4)throw new RangeError("budget");}function mark(label,value){events.push([label,value]);return value;}');
});

test('serial, four workers and auto return exact native bytes across repeated batches', async () => {
  const files = [
    file("function calc(values){return values.map(value=>value.trim()).filter(Boolean);}", 'first.js'),
    file('const numeric=values.map((value,index)=>value+index).filter(Boolean);', 'numeric.js'),
    file(String.raw`const raw=values.map(é=>receive('é',"\x61",é)).filter(Boolean);`, 'raw.js'),
    file('const zero=values.map(()=>true).filter(Boolean);', 'zero.js'),
  ];
  const pair = await compare(files);
  const serial = raw(files, 1);
  assert.deepEqual(serial.result.mutants, plain(pair.expected.mutants));
  for (let repeat = 0; repeat < 3; repeat++) for (const threads of [1, 4, undefined]) {
    const response = raw(files, threads);
    assert.equal(response.supported, true, response.reason);
    assert.equal(JSON.stringify(response.result), JSON.stringify(serial.result));
    if (threads === undefined) assert.equal(response.execution.reason, 'auto-serial-unproven-speedup');
  }
});

test('arrow replacements survive whole-batch serial recovery and a fresh parallel call', async () => {
  const files = [file('const first=values.map(value=>value+1).filter(Boolean);', 'first.js'),
    file('const hidden=stryMutAct_9fa48("0") as unknown;', 'opaque.ts'),
    file("const last=values.map(value=>value.trim()).filter(Boolean);", 'last.js')];
  const pair = await compare(files);
  const serial = raw(files, 1);
  for (let repeat = 0; repeat < 3; repeat++) {
    const recovered = raw(files, 4);
    assert.equal(recovered.supported, true, recovered.reason);
    assert.equal(JSON.stringify(recovered.result), JSON.stringify(serial.result));
    assert.deepEqual(recovered.result.mutants, plain(pair.expected.mutants));
    if (availableParallelism() > 1) {
      assert.equal(recovered.execution.reason, 'unproven-relocation');
      assert.equal(recovered.execution.serialRecoveries, 1);
    }
    const fresh = raw([files[0], files[2]], 4);
    assert.equal(fresh.supported, true, fresh.reason);
    assert.equal(fresh.execution.serialRecoveries, 0);
    assert.deepEqual(fresh.result, raw([files[0], files[2]], 1).result);
  }
});

async function fallback(content, name = 'unsupported.js', config = options) {
  const files = [file('const first=values.map(value=>value+1).filter(Boolean);', 'first.js'), file(content, name)];
  const serial = raw(files, 1, config);
  assert.equal(serial.supported, false, content);
  assert.equal(serial.result, undefined, content);
  assert.deepEqual(raw(files, 4, config), serial);
  await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, config), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files, config); } catch (error) { failure = error; }
  const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
  if (failure) await assert.rejects(auto.instrument(files, config), error =>
    error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
  else assert.deepEqual(await auto.instrument(files, config), expected);
  assert.equal(auto.stats.nativeBatches, 0);
  assert.equal(auto.stats.fallbackBatches, 1);
  assert.equal(auto.stats.nativeErrors, 0);
  assert.equal(raw([files[0]], 4).supported, true, 'failed batches leave no partial state');
  return { serial, failure };
}

test('unproven arrow forms and prior printer boundaries fail closed for the whole batch', async () => {
  for (const [content, name = 'unsupported.js'] of [
    ['values.map((value=1)=>{return value;}).filter(Boolean);'],
    ['values.map((value=1)=>value).filter(Boolean);'],
    ['values.map((...value)=>value).filter(Boolean);'],
    ['values.map(({value})=>value).filter(Boolean);'],
    ['values.map(([value])=>value).filter(Boolean);'],
    ['values.map((value:number)=>value).filter(Boolean);', 'typed.ts'],
    ['values.map(<T>(value:T)=>value).filter(Boolean);', 'generic.ts'],
    ['values.map((value):number=>value).filter(Boolean);', 'return.ts'],
    ['values.map((value?)=>value).filter(Boolean);', 'optional.ts'],
    ['values.map(value=>function(){return value;}).filter(Boolean);'],
    ['values.map(value=>function*(){yield value;}).filter(Boolean);'],
    ['values.map(value=>class {}).filter(Boolean);'],
    ['values.map(value=>new C(value)).filter(Boolean);'],
    ['values.map(value=>({value})).filter(Boolean);'],
    ['values.map(value=>[1,2,3]).filter(Boolean);'],
    ['values.map(value=>0x10n).filter(Boolean);'],
    ['values.map(value=>value as number).filter(Boolean);', 'opaque.ts'],
    ['values.map(value=>value/* (value) => */).filter(Boolean);'],
    ['values.map(value=>receiver.invoke(...value)).filter(Boolean);'],
    ['const broken=values.map((value)=>;'],
  ]) await fallback(content, name);
  // Excluding emitted mutants does not prove an unsupported printer grammar.
  await fallback('values.map((value=1)=>value).filter(Boolean);', 'excluded.js',
    { ...options, excludedMutations: ['MethodExpression', 'ArrowFunction'] });
});

test('update object-spine placement errors remain upstream errors with callback descendants', async () => {
  const { failure } = await fallback('values.map(value=>value).filter(Boolean).field++;');
  assert.equal(failure.name, 'SyntaxError');
});

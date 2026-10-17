import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { availableParallelism } from 'node:os';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/instrumenter.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'receiver.js', mutate = true) => ({ name, content, mutate });
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (files, threads, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === undefined ? {} : { execution: { threads } }),
})));
const callback = 'value => { if (value) { return true; } return false; }';

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const direct = raw(files, 1, config);
  assert.equal(direct.supported, true, direct.reason);
  assert.deepEqual(direct.result.mutants, plain(expected.mutants), 'complete ABI records');
  for (const engine of ['native', 'auto']) {
    const sut = createInstrumenter(logger, { cache: false, engine, instrumentationThreads: 1 });
    const actual = await sut.instrument(files, config);
    assert.deepEqual(actual.mutants, expected.mutants, 'complete public records');
    assert.deepEqual(actual.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
    assert.equal(sut.stats.nativeBatches, 1);
    assert.equal(sut.stats.fallbackBatches, 0);
    assert.equal(sut.stats.nativeErrors, 0);
  }
  return { actual: direct.result, expected, original: { files } };
}

function execute(result, setup, observation, id, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const run = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  run(`const events=[];function capture(fn){try{return fn();}catch(e){return {name:e.name,message:e.message};}}${setup}`);
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    return { name: error.name, message: error.message };
  };
  const loadErrors = [];
  for (const { content } of result.files) {
    const script = new vm.Script(content); // Parse errors must never be treated as user failures.
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'receiver-arguments';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = run(observation); } catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, events: run('events'), ns });
}

function runtime(pair, setup, observation) {
  const { ns: nativeNs, ...inactive } = execute(pair.actual, setup, observation);
  const { ns: originalNs, ...original } = execute(pair.original, setup, observation);
  assert.deepEqual(inactive, original, 'unchanged inactive original behavior');
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(pair.actual, setup, observation, id, settings),
        execute(pair.expected, setup, observation, id, settings), `id=${id}, ${JSON.stringify(settings)}`);
    }
  }
}

test('receiver-only removal keeps callback control flow, effects, failures, activation and coverage', async () => {
  const source = "function calc(items){return items.filter((value,index)=>{events.push([value,index]);if(value<0){throw new RangeError('negative');}return value>0;},mark());}";
  const pair = await compare([file(source)]);
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'MethodExpression' && m.replacement === 'items'));
  runtime(pair, "function mark(){events.push('argument');return null;}", '[capture(()=>calc([0,2,3])),capture(()=>calc([-1,2]))]');
  const getter = await compare([file(`function calc(){return receiver.filter(${callback},mark());}`)]);
  for (const failure of ['none', 'getter', 'argument']) {
    const setup = `const receiver={get filter(){events.push('getter');${failure === 'getter' ? 'throw new RangeError("getter");' : ''}
      return function(fn,arg){events.push(['receiver',this===receiver,arg]);return [0,1].filter(fn);};}};
      function mark(){events.push('argument');${failure === 'argument' ? 'throw new RangeError("argument");' : ''}return 7;}`;
    runtime(getter, setup, 'capture(()=>{const value=calc();return value===receiver?"receiver":value;})');
  }
});

test('former negative inputs retain their exact source as positive public and runtime proofs', async () => {
  const sources = [
    'const x=obj.trim((x=1) => { return 1; });',
    "obj.trim('x',(...args)=>{return 1;});",
    "obj.trim('x',{value:'x'});",
  ];
  const setup = `const obj={trim(...args){events.push(args.map(value=>typeof value==='function'?[value(),value(3),value.name]:value));return 7;}};`;
  for (const source of sources) runtime(await compare([file(source)]), setup, 'events');
  const defaults = await compare([file('function calc(items){return items.filter((value=2)=>{if(value){return true;}return false;});}')]);
  runtime(defaults, '', 'capture(()=>calc([undefined,0,1]))');
});

test('dropped async callbacks retain awaited effects and failures without a printer relaxation', async () => {
  const pair = await compare([file('function calc(){return values.filter(async value=>{if(value){await mark(value);}return true;});}')]);
  async function observe(result, id, settings = {}) {
    const ns = {
      ...(settings.afterLoad ? {} : { activeMutant: id }),
      ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
    };
    const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
    const run = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
    run(`const events=[];
      const values={filter(fn){events.push('filter');return Promise.all([0,1].map(fn));}};
      function mark(value){events.push(['mark',value]);return Promise.resolve(value);}`);
    for (const { content } of result.files) run(content);
    ns.currentTestId = 'async-callback';
    if (settings.afterLoad) ns.activeMutant = id;
    const value = await run(`(async()=>{try{const value=await calc();return value===values?'receiver':value;}
      catch(error){return {name:error.name,message:error.message};}})()`);
    return structuredClone({ value, events: run('events'), ns });
  }
  const { ns: nativeNs, ...inactive } = await observe(pair.actual);
  const { ns: originalNs, ...original } = await observe(pair.original);
  assert.deepEqual(inactive, original);
  for (const id of [undefined, ...pair.expected.mutants.map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(await observe(pair.actual, id, settings), await observe(pair.expected, id, settings));
    }
  }
});

test('inherited, receiver, optional, chained and argument-retaining printer boundaries still reject atomically', async () => {
  const boundaries = [
    `values.some(${callback});`, `values?.filter(${callback});`, `values.filter?.(${callback});`,
    `values.filter(${callback}).length;`, `values.filter(${callback}).trim();`,
    `values.map(${callback}).filter(Boolean);`, `values.filter(${callback}) + 1;`,
    `values.some(values.filter(${callback}));`,
  ].map(content => [content, /Only concise or simple block arrows/]);
  boundaries.push(
    ["obj.endsWith('x',(...args)=>{return 1;});", /Only concise or simple block arrows/],
    ["obj.endsWith('x',{value:'x'});", /Objects inside printed/],
  );
  for (const [content, reason] of boundaries) {
    const files = [file(`function keep(values){return values.filter(${callback});}`, 'first.js'), file(content, 'unsupported.js')];
    const rejected = raw(files, 1);
    assert.equal(rejected.supported, false, content);
    assert.equal(rejected.result, undefined, content);
    assert.match(rejected.reason, reason);
    assert.deepEqual(raw(files, 4), rejected);
    const sut = createInstrumenter(logger, { cache: false, engine: 'auto' });
    assert.deepEqual(await sut.instrument(files, options), await new Instrumenter(logger).instrument(files, options));
    assert.equal(sut.stats.nativeBatches, 0);
    assert.equal(sut.stats.fallbackBatches, 1);
    assert.equal(sut.stats.nativeErrors, 0);
    assert.equal(raw([files[0]], 1).supported, true, 'failed batch must leave no partial state');
  }
});

test('serial, explicit parallel, automatic, exclusions, directives, selections and recovery retain ordered bytes and IDs', async () => {
  const sources = [
    file('consume(true);', 'gap.js'),
    file(`// Stryker disable next-line MethodExpression: keep call\nfunction keep(values){return values.filter(${callback});}`, 'keep.js'),
    file('const tail=false;', 'tail.js'),
  ];
  for (const config of [options, { ...options, excludedMutations: ['BlockStatement', 'BooleanLiteral'] }]) {
    const pair = await compare(sources, config);
    const serial = raw(sources, 1, config);
    for (const threads of [undefined, 4]) {
      const actual = raw(sources, threads, config);
      assert.equal(actual.supported, true, actual.reason);
      assert.equal(JSON.stringify(actual.result), JSON.stringify(serial.result));
    }
    assert.deepEqual(serial.result.mutants, plain(pair.expected.mutants));
  }
  const selected = sources.map((source, index) => index === 1 ? { ...source, mutate: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 1000 } }] } : source);
  await compare(selected);
  const recovery = [sources[1], file('const hidden=stryMutAct_9fa48("0") as unknown;', 'opaque.ts'), sources[2]];
  const serial = raw(recovery, 1);
  assert.equal(serial.supported, true, serial.reason);
  const recovered = raw(recovery, 4);
  assert.equal(recovered.supported, true, recovered.reason);
  assert.equal(JSON.stringify(recovered.result), JSON.stringify(serial.result));
  if (availableParallelism() > 1) {
    assert.equal(recovered.execution.reason, 'unproven-relocation');
    assert.equal(recovered.execution.serialRecoveries, 1);
  }
  assert.equal(raw(sources, 4).execution.serialRecoveries, 0, 'fresh call after recovery');
});

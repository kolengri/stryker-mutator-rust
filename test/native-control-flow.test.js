import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { analyze, loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'control-flow.js', mutate = true) => ({ name, content, mutate });

async function compare(files, config = options) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.equal(sut.stats.nativeErrors, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  return { actual, expected };
}

// The external budget makes infinite-loop mutations deterministic without
// instrumenting the escape hatch. VM timeouts also bound accidental hangs.
const budget = `let ticks=0; function tick(value=true){
  if(++ticks>8) throw new RangeError("loop budget"); return value;
}`;

function execute(result, setup, observation, state, activeMutant, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(`const events=[]; ${budget} ${setup}`).runInContext(context, { timeout: 1000 });
    for (const { content } of result.files) new vm.Script(content).runInContext(context, { timeout: 1000 });
    ns.currentTestId = settings.currentTestId ?? 'control-test';
    if (settings.afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'use a deterministic budget for every possibly nonterminating mutant');
  }
  const final = new vm.Script(state).runInContext(context, { timeout: 1000 });
  const events = new vm.Script('events').runInContext(context, { timeout: 1000 });
  return structuredClone({ value, error, final, events, ns });
}

function runtime(pair, setup = '', observation = 'calc()', state = 'null') {
  const ids = [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)];
  for (const id of ids) for (const settings of [
    {}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 },
  ]) {
    assert.deepEqual(
      execute(pair.actual, setup, observation, state, id, settings),
      execute(pair.expected, setup, observation, state, id, settings),
      `mutant ${id}, settings=${JSON.stringify(settings)}`,
    );
  }
  return execute(pair.actual, setup, observation, state);
}

for (const [name, body] of [
  ['while', 'let i=0; while(tick(i<3)) {events.push(i);i++;} return i;'],
  ['do-while', 'let i=0; do {events.push(i);i++;} while(tick(i<3)); return i;'],
  ['unbraced while', 'let i=0; while(tick(i<3)) if(i<1) i++; else i+=2; return i;'],
  ['unbraced do-while', 'let i=0; do if(i<1) i++; else i+=2; while(tick(i<3)); return i;'],
  ['ordinary for', 'for(let i=0;tick(i<3);i++) events.push(i); return ticks;'],
  ['expression init and sequence update', 'let i; for(i=0;tick(i<3);i++,note(i)) events.push(i); return i;'],
  ['absent init and update', 'let i=0;for(;tick(i<3);) i++; return i;'],
  ['nested loops, break and continue', 'let sum=0;for(let i=0;tick(i<3);i++){let j=0;while(tick(j<3)){j++;if(j===1)continue;if(i===1)break;sum+=j;}}return sum;'],
  ['chained labels', 'let i=0;outer: again: while(tick(i<3)){i++;for(let j=0;tick(j<2);j++){if(j===0)continue outer;break again;}}return i;'],
  ['labelled switch and block', 'done:{pick:switch(choice){case 1:events.push(1);break pick;default:break done;}events.push(2);}return ticks;'],
  ['dangling else around generated statement', 'let i=0;if(choice) for(;tick(i<2);i++) if(i) note(i); else note(0); else note(9);return i;'],
]) {
  test(`control-flow exact records and runtime: ${name}`, async () => {
    const pair = await compare([file(`function calc(){${body}}`)]);
    runtime(pair, 'const choice=1;function note(x){events.push(x);}', 'calc()', 'ticks');
  });
}

test('loop tests generate false only before ordinary boolean-expression logic', async () => {
  for (const source of ['while(a)break;', 'do break;while(a);', 'for(;a;)break;', 'while(!a)break;', 'while(a&&b)break;', 'while(a??b)break;']) {
    const pair = await compare([file(source)]);
    const conditionals = pair.actual.mutants.filter(m => m.mutatorName === 'ConditionalExpression');
    assert.deepEqual(conditionals.map(m => m.replacement), ['false'], source);
  }
});

test('omitted-for-test mutants clone the entire original statement before descendants', async () => {
  for (const source of [
    'for(;;)break;',
    'for(let i=note(1);;)break;',
    'for(let i=0;;i++,tick()) {if(i>2)break;events.push(i);}',
    'for(let i=0;;tick()) if(i++>1) break; else note(i);',
    'for(; ; tick()) {for(let j=0;tick(j<2);j++)note(j);break;}',
    'outer:for(; ; tick()) {note(1);break outer;}',
    'if(choice) for(; ; tick()) {note(1);break;} else note(2);',
    'for(; ; tick()) {switch(choice){case 1:note(1);break;default:note(2);}break;}',
    'for(let i=0,j=(note(1),2); ; tick(),i++) {let a=1,b=(note(i),j);note(b);if(i>1)break;}',
    'for(; ; tick()) for(target[ choice + 1 ] of (note(1),list)) break;',
    'for(; ; tick()) if(choice) for(;tick(false);) if(choice) note(1);else note(2);else note(3);',
    'for(; ; tick()) {switch(choice){case (note(1),1):note(2);break;default:;}break;}',
    'for(; ; tick());',
    'for(; ; tick()) {while(tick(false));for(let x of list);for(let x in target);break;}',
    'for(; ; tick()) var a=note(1),b=note(2);',
    'for(; ; tick()) {var a,b;for(let x of list)var c=1,d=2;break;}',
  ]) {
    const pair = await compare([file(`function calc(){${source}return ticks;}`)]);
    const own = pair.actual.mutants.find(m => m.replacement.startsWith('for ('));
    assert.ok(own, source);
    assert.match(own.replacement, /; false;/);
    runtime(pair, 'const choice=1,target={},list=[1,2];function note(x){events.push(x);return x;}', 'calc()', 'ticks');
  }
});

test('for-in and synchronous for-of retain declaration/reference targets and key evaluation', async () => {
  for (const source of [
    'for(const key in data) events.push(key);',
    'for(let key in data) {if(key===skip)continue;events.push(key);}',
    'let key;for(key in data) events.push(key);',
    'for(const value of list) events.push(value);',
    'let value;for(value of list) {events.push(value);if(value===2)break;}',
    'for(target.x of list) events.push(target.x);',
    'for(target[index++] of list) events.push(index);',
    'for(target[(note(index),index++)] of list) events.push(index);',
    'for(target[key?.name] in data) events.push(target.x);',
    'for(target[getKey().trim()] of list) events.push(target.x);',
    'for((note(1),factory().trim()).x of list) events.push(target.x);',
  ]) {
    const pair = await compare([file(`function calc(){${source}return index;}`)]);
    runtime(pair, 'const data={a:1,b:2},list=[1,2],target={},key={name:"x"},skip="b";let index=0;function note(x){events.push(x);}function getKey(){events.push("key");return " x ";}function factory(){return {trim(){events.push("trim");return target;}};}', 'calc()', '[target,index]');
  }
});

test('switch default, fallthrough, nonempty cases and case-test order match upstream', async () => {
  const content = `function calc(){switch(note(choice)){
    case (note(1),1): note(11);
    case 2:
    case (note(3),3): note(33);break;
    default: note(9);
    case 4: {note(44);break;}
  }return choice;}`;
  const pair = await compare([file(content)]);
  assert.equal(pair.actual.mutants.filter(m => m.replacement === 'case 2:').length, 0);
  assert.equal(pair.actual.mutants.filter(m => m.replacement === 'default:').length, 1);
  for (const choice of [1,2,3,4,9]) runtime(pair, `const choice=${choice};function note(x){events.push(x);return x;}`);
  const lexical = await compare([file('function calc(){switch(choice){case 1:let x=1;note(x);case 2:note(typeof x);break;default:;}}')]);
  for (const choice of [1,2,9]) runtime(lexical, `const choice=${choice};function note(x){events.push(x);}`);
});

test('sequence expressions keep independent placements and unbound callees/indirect eval', async () => {
  const setup = `let a=4,b=2,index=0;const obj={x:3,trim(){events.push(this===obj?"bound":"unbound");return this===obj?this.x:7;}};
    const key={name:"x"},rhs={value:2};function note(x){events.push(x);return x;}function observe(x){return x===obj?"object":typeof x==="function"?"function":x;}`;
  for (const expression of [
    '(a++,b++)', '(note(a),a+=b,b)', '(note(1),(note(2),obj.trim()))',
    '(note(1),obj.trim)()', '(note(1),obj.trim)?.()',
    '(obj.trim(),obj.trim)()',
    '(note(1),obj).trim()', 'obj[(note(1),key?.name)] += (note(2),rhs?.value)',
    '(note(1),obj)?.[(note(2),key.name)]', 'note((a++,b++))',
    '(note(1),obj.trim()).x++',
    '(0,eval)("typeof local")', '(obj.trim(),eval)("typeof local")', 'eval((note(1),"typeof local"))',
  ]) {
    const pair = await compare([file(`function calc(){const local=1;return ${expression};}`)]);
    runtime(pair, setup, '[observe(calc()),observe(calc())]', '[a,b,index,obj.x]');
  }
  const indirect = await compare([file('function calc(){const local=1;return (0,eval)("typeof local");}')]);
  assert.equal(runtime(indirect).value, 'undefined');
});

test('assignments, updates and optional chains inside loop tests and updates stay native', async () => {
  for (const body of [
    'let i=0;while(tick((i++,i<3))){target[key?.name]+=rhs?.value;}return i;',
    'let i=0;for(;tick(i<3);i++,target[key?.name]++) note(target.x);return i;',
    'let i=0;while(tick(i<3)&&obj?.trim?.().length){i++;note(i);}return i;',
    'let i=0;do note(i);while(tick((i+=1,i<3)));return i;',
  ]) {
    const pair = await compare([file(`function calc(){${body}}`)]);
    for (const obj of ['null', '{trim(){events.push("trim");return " x ";}}']) {
      runtime(pair, `const obj=${obj},target={x:1},key={name:"x"},rhs={value:2};function note(x){events.push(x);}`, 'calc()', '[ticks,target]');
    }
  }
});

test('control-flow exclusions, empty ignore reason, directives, ranges and batch IDs', async () => {
  const content = '// Stryker disable next-line ConditionalExpression:   \r\nfunction calc(){const text="😀";for(let i=0;tick(i<2);i++){switch(i){case 0:note(text);break;default:note(i);}}return text;}';
  for (const excludedMutations of [[], ['ConditionalExpression'], ['BlockStatement','UpdateOperator'], ['StringLiteral','CallExpression']]) {
    const pair = await compare([
      file('foo(a+b);', 'first.js'), file('for(;;)break;', 'off.js', false), file(content, 'utf16.js'), file('bar();', 'last.js'),
    ], { ...options, excludedMutations });
    assert.equal(pair.actual.mutants[0].id, excludedMutations.includes('CallExpression') ? '0' : '1', 'filtered CallExpression keeps the global ID gap; ignored candidates remain');
    assert.equal(pair.actual.mutants.some(m => m.statusReason === '' && m.status === undefined), true);
    runtime(pair, 'const a=2,b=3;function foo(x){events.push(x);}function bar(){events.push("bar");}function note(x){events.push(x);}');
  }
  for (const source of [
    '// Stryker disable ConditionalExpression: reason\nwhile(tick(false));\n// Stryker restore ConditionalExpression\nwhile(tick(false));',
    '// Stryker disable next-line ConditionalExpression:   \nwhile(tick(false));',
  ]) runtime(await compare([file(source)]), '', 'ticks', 'ticks');

  const source = 'function calc(){let i=0;while(tick(i<2))i++;return i;}';
  for (const [start,end] of [[0,source.length],[23,44],[34,37],[0,0],[38,38]]) {
    const ranges = [{ start:{line:0,column:start}, end:{line:0,column:end} }];
    runtime(await compare([file(source,'range.js',ranges)]), '', 'calc()', 'ticks');
  }
  assert.equal(analyze('for(;;)break;').supported, false);
});

test('noHeader control-flow placements use the existing externally supplied ABI', async () => {
  const seed = await compare([file('const seed=true;')]);
  const header = seed.actual.files[0].content.slice(0,seed.actual.files[0].content.indexOf('const seed'));
  const pair = await compare([file('function calc(){for(; ; tick()){switch(choice){case 1:note(1);break;default:note(2);}break;}return ticks;}')], { ...options, noHeader:true });
  assert.doesNotMatch(pair.actual.files[0].content, /function stry/);
  runtime(pair, `${header} const choice=1;function note(x){events.push(x);}`, 'calc()', 'ticks');
});

// Exact bytes from upstream c931a93237816901f1e9f48da411170beeb3dfca.
const switchResource = "switch (foo) {\n  case 'bar':\n    console.log('bar');\n    break;\n  case 'baz':\n    console.log('baz');\n    break;\n}\n";
test('pinned upstream switch-case.js resource works in forced-native mode', async () => {
  if (process.env.STRYKER_UPSTREAM) {
    assert.equal(await readFile(`${process.env.STRYKER_UPSTREAM}/packages/instrumenter/testResources/instrumenter/switch-case.js`, 'utf8'), switchResource);
  }
  const pair = await compare([file(switchResource,'switch-case.js')]);
  for (const foo of ['bar','baz','other']) runtime(pair, `const foo=${JSON.stringify(foo)};const console={log(x){events.push(x);}};`, 'events');
});

async function fallback(content, config = options, extension = 'js') {
  const files = [file('const first=true;', 'first.js'),file(content,`unsupported.${extension}`)];
  const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options: config })));
  assert.equal(raw.supported, false, content);
  assert.equal(raw.result, undefined, content);
  await assert.rejects(createInstrumenter(logger, { cache:false, engine:'native' }).instrument(files,config), /unsupported/i);
  let expected, failure;
  try { expected = await new Instrumenter(logger).instrument(files,config); } catch(error) { failure = error; }
  const auto = createInstrumenter(logger, { cache:false, engine:'auto' });
  if (failure) await assert.rejects(auto.instrument(files,config), error => {
    assert.equal(error.name,failure.name);
    assert.equal(error.message.split('\n')[0],failure.message.split('\n')[0]);
    return true;
  });
  else assert.deepEqual(await auto.instrument(files,config),expected,content);
  assert.equal(auto.stats.nativeBatches,0);
  assert.equal(auto.stats.fallbackBatches,1);
  return { expected, failure, reason: raw.reason };
}

test('iteration target object-spine placement errors fall back atomically', async () => {
  for (const operator of ['in','of']) for (const target of ['factory().trim().field','factory()?.field']) {
    // Optional iteration targets are syntax errors; method mutations on public
    // targets hit upstream's erroneous ConditionalExpression placement.
    const { failure } = await fallback(`for(${target} ${operator} list) foo();`);
    assert.equal(failure.name, 'SyntaxError');
    if (target.includes('trim')) assert.match(failure.message, /ConditionalExpression/);
  }
  for (const operator of ['in','of']) {
    const pair = await compare([file(`function calc(){for(factory().trim().field ${operator} list) note(1);}`)], { ...options, excludedMutations:['MethodExpression'] });
    runtime(pair, 'const list=[1,2],target={};function factory(){return {trim(){events.push("trim");return target;}};}function note(x){events.push(x);}', 'calc()', 'target');
  }
});

test('labelled continue across an active whole-for wrapper preserves upstream invalid output via fallback', async () => {
  for (const content of ['outer:for(; ; tick()){continue outer;}', 'outer:inner:for(; ; tick()){continue outer;}']) {
    const { expected, reason } = await fallback(content);
    assert.match(reason, /Labelled continue/);
    assert.throws(() => new vm.Script(expected.files[1].content), /Illegal continue statement/);
    const pair = await compare([file(content)], { ...options, excludedMutations:['ConditionalExpression'] });
    runtime(pair, '', 'ticks', 'ticks');
  }
});

test('unsupported bindings, async iteration, expression targets and formatter boundaries remain atomic', async () => {
  for (const [content, extension='js'] of [
    ['for(let [x] of list)foo();'], ['for({x} of list)foo();'], ['for([x] in list)foo();'],
    ['for await(const x of list)foo();'], ['for(let i:number=0;i<2;i++)foo(i!);','ts'],
    ['for(;tick(true);)new Thing();'], ['while(tick(true)) /x/.test(value);'],
    ['for(;;){ /* ordinary comment */ break;}'], ['for(;;){note({x:1});break;}'],
    ['// Stryker disable ConditionalExpression: reason\nfor(;;)break;'],
    ['for(;;)break;\n// trailing clone comment'],
    ['for(;;){note(0x10);break;}'], ['for(;;){note(()=>1);break;}'],
    ['for(;;){const x=`first\nsecond`;break;}'],
    ['for((a,b)=value;;)break;'],
  ]) await fallback(content, options, extension);
});

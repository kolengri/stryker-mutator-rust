import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { availableParallelism } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { analyze, loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const file = (content, name = 'strings.js', mutate = true) => ({ name, content, mutate });
const raw = (files, threads, config = options) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === undefined ? {} : { execution: { threads } }),
})));
const plain = value => JSON.parse(JSON.stringify(value));

// Same full ordered-record oracle as the other native compatibility groups.
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

function execute(result, setup, observation, activeMutant, settings = {}) {
  const ns = {
    ...(settings.afterLoad ? {} : { activeMutant }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }),
  };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(`const events=[]; ${setup}`).runInContext(context, { timeout: 1000 });
    for (const { name, content } of result.files) {
      const code = name.endsWith('.ts') ? stripTypeScriptTypes(content) : content;
      new vm.Script(code).runInContext(context, { timeout: 1000 });
    }
    ns.currentTestId = settings.currentTestId ?? 'string-spelling';
    if (settings.afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    assert.notEqual(caught.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, ns, events: new vm.Script('events').runInContext(context) });
}

function runtime(pair, setup, observation = '[calc(),calc()]') {
  const baseline = execute(pair.actual, setup, observation);
  assert.equal(baseline.error, undefined, 'baseline and observer must execute successfully');
  assert.deepEqual(baseline, execute(pair.expected, setup, observation));
  for (const id of [undefined, ...pair.expected.mutants.filter(m => m.status !== 'Ignored').map(m => m.id)]) {
    for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
      assert.deepEqual(execute(pair.actual, setup, observation, id, settings),
        execute(pair.expected, setup, observation, id, settings), `mutant ${id}: ${JSON.stringify(settings)}`);
    }
  }
}

const receive = 'function receive(...args){events.push(args);return args[0];}';
const cases = [
  ['canonical double quotes, backslashes and escaped lone surrogates', String.raw`function calc(){return receive("x", "a\\b", "say \"yes\"", "\ud800", "\udfff", "\\ud800", "�", "😀é").startsWith("x");}`, receive],
  ['mixed repeated values and escapes', String.raw`function calc(){return receive(' a ', "a", '\x61', "\u0061", '\u{61}', 'it\'s', "say \"yes\"", '\\', '\0', '\t', '\uD800', '\udfff', '�', '😀é').trim('single quoted').startsWith('\x61');}`, receive],
  ['operators and nested logical clones', String.raw`function calc(){return (receive('x', "\x78") === '\u0078') && (receive(false) || 'fallback');}`, receive],
  ['assignments and updates through computed method spines', String.raw`function calc(){obj[choose(' key ', "\x6bey").trim('unused')].value += receive('2', "\u0032"); return obj[choose("key", '\u006bey')].value++;}`, receive + 'const obj={key:{value:3}};function choose(...args){events.push(args);return args[0];}'],
  ['direct computed update key', String.raw`function calc(){return ++obj['\x78'];}`, 'const obj={x:4};'],
  ['assignment lifted from a method receiver', String.raw`function calc(){return factory('x').trim().field = 'raw';}`, 'const obj={field:0,trim(){events.push("trim");return this;}};function factory(x){events.push(x);return obj;}'],
  ['optional and non-null TS wrappers', String.raw`function calc(value:string='a'){return receive(' a ', "\u0061")!.trim('unused')?.startsWith(value || '\x61');}`, receive, 'strings.ts'],
  ['templates alongside cloned strings', 'function calc(){return receive(`raw \' " ${\'\\x61\'}`,\'a\').trim(\'unused\').endsWith(`a${"\\u0061"}`);}', receive],
  ['generated replacements and marker-looking source', String.raw`function calc(){return receive('', '""', '__stryker_raw_string_0__', '/* "a" */', 'stryMutAct_9fa48("0")').startsWith('a') || ('\x61' === "a");}`, receive],
  ['LF and CRLF continuations', "function calc(){return receive('a\\\nb',\"a\\\r\nb\",'ab').startsWith('a');}", receive],
  ['raw Unicode line separators', "function calc(){return receive('😀é\u2028x','\u2029','\\uD800').startsWith('😀');}", receive],
  ['CRLF template beside a raw string', "function calc(){return receive('a',`a\r\nb`).startsWith('a');}", receive],
  ['unary clones', String.raw`function calc(){return !receive('\x61') || ~receive('2');}`, receive],
  ['whole-for clones with string target keys', String.raw`function calc(){for(;;tick()){for(obj['\x78'] of values){receive('a').trim('unused');if(tick())break;}break;}return obj['x'];}`, receive + 'const obj={x:0},values=[1,2];let ticks=0;function tick(){if(++ticks>8)throw new RangeError("budget");return true;}'],
];

for (const [name, content, setup, extension] of cases) {
  test(`raw string replacement records and runtime: ${name}`, async () => {
    runtime(await compare([file(content, extension)]), setup);
  });
}

test('canonical method/operator/logical clones preserve all records and runtime', async () => {
  const content = 'function calc(a="x",b="y"){return a.startsWith("x") && b === "y";}';
  runtime(await compare([file(content)]), '', '[calc(),calc("z","y"),calc("x","z")]');
});

test('canonical, protected and string-free printers coexist across execution modes', async () => {
  const files = [
    file('function canonical(a,b){return a.startsWith("x") && b === "y";}', 'canonical.js'),
    file(String.raw`function protectedRaw(a,b){return a.startsWith('\x78') && b === 'y';}`, 'raw.js'),
    file('function numeric(a,b){return a+b;}', 'numeric.js'),
  ];
  const pair = await compare(files);
  const serial = raw(files, 1);
  assert.equal(serial.supported, true, serial.reason);
  for (let repeat = 0; repeat < 3; repeat++) for (const threads of [1, 4, undefined]) {
    const response = raw(files, threads);
    assert.equal(response.supported, true, response.reason);
    assert.equal(JSON.stringify(response.result), JSON.stringify(serial.result));
  }
  runtime(pair, '', '[canonical("x","y"),protectedRaw("x","y"),numeric(3,2)]');
});

test('raw clones retain their own spelling while generated string mutants use double quotes', async () => {
  const content = String.raw`function calc(){return receive('', "", '\x61', "\u0061", 'a').startsWith('a') || (flag && '');}`;
  const pair = await compare([file(content)]);
  assert.ok(pair.actual.mutants.some(m => m.replacement.includes(String.raw`receive('', "", '\x61', "\u0061", 'a').endsWith('a')`)));
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'StringLiteral' && m.replacement === '"Stryker was here!"'));
  assert.ok(pair.actual.mutants.some(m => m.mutatorName === 'StringLiteral' && m.replacement === '""'));
  runtime(pair, receive + 'const flag=true;');
});

test('formerly rejected raw spelling cases have full upstream ordered records', async () => {
  for (const content of [
    "const x=obj.trim('single quoted');", "obj?.trim('single quoted');", "obj.x += ('single quoted' + a);",
    "const a = value === 'x';", String.raw`const a = value === "\u0078";`, "const a = 'x' + value + 1;",
    "const value=(a||'qux')+b;", String.raw`const value=a||'q\nx';`, "const value=a||'é';",
    "const value=a||'q\"x';", 'const value="left"||\'qux\';', "const value=a||'x'||b;",
    "for(;;){a||'qux';break;}", "obj?.run(a||'qux');", "const value=a||'qux\t';",
  ]) await compare([file(content)]);
});

test('ignored/excluded records, UTF16 selections, filtered gaps and repeated batches preserve exact bytes', async () => {
  const source = "// Stryker disable next-line StringLiteral: keep raw\r\nconst astral='😀';const value=receive('x',\"\\x78\").startsWith('x');\r\nconst last=false;";
  const files = [
    file('consume(true);', 'filtered.js'),
    file(source, 'mixed.js', [{ start: { line: 1, column: 0 }, end: { line: 1, column: 87 } }]),
    file("const untouched=obj.trim('raw');", 'off.js', false),
    file("const tail=flag||'é';", 'last.js'),
  ];
  for (const config of [options, { ...options, excludedMutations: ['StringLiteral', 'MethodExpression'] }, { ...options, noHeader: true }]) {
    const pair = await compare(files, config);
    if (!config.noHeader) runtime(pair, receive + 'const flag=true;const obj="x";function consume(x){events.push(x);}', '[astral,value,last,tail,untouched]');
    const serial = raw(files, 1, config);
    assert.equal(serial.supported, true, serial.reason);
    assert.deepEqual(serial.result.mutants, plain(pair.expected.mutants));
    assert.ok(Number(serial.result.mutants[0].id) > 0, 'filtered expression statements consume IDs');
    assert.ok(serial.result.mutants.some(m => m.status === 'Ignored'));
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const threads of [1, 4, 'auto']) {
        const response = raw(files, threads === 'auto' ? undefined : threads, config);
        assert.equal(response.supported, true, response.reason);
        assert.equal(JSON.stringify(response.result), JSON.stringify(serial.result));
        if (threads === 'auto') assert.equal(response.execution.reason, 'auto-serial-unproven-speedup');
      }
    }
  }
});

test('raw literals survive whole-batch serial recovery and the next parallel call', async () => {
  const files = [file("const first=flag||'\\x61';", 'first.js'),
    file('const hidden=stryMutAct_9fa48("0") as unknown;', 'opaque.ts'),
    file("const last=obj.startsWith('é');", 'last.js')];
  const pair = await compare(files);
  const serial = raw(files);
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

test('remaining printer boundaries and parse errors reject atomically without contaminating later calls', async () => {
  for (const [content, reason] of [
    ["for(;;){receive('a\\\nb').trim();break;}", /Multiline strings in whole-for/],
    ["obj.trim(/* raw 'x' */ 'x');", /Comments/],
    ["obj.trim('x',(...args)=>{return 1;});", /Only concise or simple block arrows/],
    ["obj.trim('x',0x10n);", /Unsupported expression/],
    ["obj.trim('x',{value:'x'});", /Objects inside printed/],
    ["const broken='unterminated;", /Syntax error/],
    ["obj.trim('" + String.fromCharCode(0xd800) + "');", /Invalid instrumentation input/],
  ]) {
    const files = [file("const first=flag||'x';", 'first.js'), file(content, 'unsupported.js')];
    const serial = raw(files);
    assert.equal(serial.supported, false, content);
    assert.equal(serial.result, undefined);
    assert.match(serial.reason, reason);
    assert.deepEqual(raw(files, 4), serial);
    await assert.rejects(createInstrumenter(logger, { cache: false, engine: 'native' }).instrument(files, options), /unsupported/i);
    const automatic = createInstrumenter(logger, { cache: false, engine: 'auto' });
    let expected, failure;
    try { expected = await new Instrumenter(logger).instrument(files, options); } catch (error) { failure = error; }
    if (failure) await assert.rejects(automatic.instrument(files, options), error => error.name === failure.name && error.message.split(/\n\s+at /)[0] === failure.message.split(/\n\s+at /)[0]);
    else assert.deepEqual(await automatic.instrument(files, options), expected);
    assert.equal(automatic.stats.nativeBatches, 0);
    assert.equal(automatic.stats.fallbackBatches, 1);
    assert.equal(automatic.stats.nativeErrors, 0);
    assert.equal(raw([files[0]], 4).supported, true);
  }
  const candidate = analyze("const broken='unterminated;", 'bad.js');
  assert.equal(candidate.supported, false);
  assert.deepEqual(candidate.mutants, []);
  assert.ok(candidate.reason);
  assert.equal(analyze("const value=flag||'x';").supported, false, 'preview API retains its experimental contract');
});

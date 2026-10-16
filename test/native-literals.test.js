import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

// Observe collections and functions outside the mutated source so those
// observers neither add mutants nor broaden the accepted native grammar.
const cases = [
  ['strings', `const empty = ''; const text = 'hello'; function calc() { return [empty, text, ""]; }`, '[calc(), calc()]'],
  ['escaped strings', String.raw`function calc() { return ['a\nb\tc', '\u{1F600}', '\uD800', '\x00', '"', '\\', '\u2028']; }`, 'calc()'],
  ['empty continuation', "function calc() { return ['\\\n', '\\\r\n']; }", 'calc()'],
  ['unicode locations', "const 𐐀 = '😀';\r\nfunction calc() {\u2028return ['é', 𐐀, '\u2029'];\u2029}", 'calc()'],
  ['string statements', `const x = 'x'; 'skip me'; ('skip me too'); function calc() { return x; 'also skip'; }`, 'calc()'],
  ['string conditions', `function calc(a) { if ('yes') return a ? '' : 'no'; else return 'other'; }`, '[calc(true), calc(false)]'],
  ['templates', 'const empty = ``; const text = `hello`; function calc(a) { return [empty, text, `x${a + 1}y`, `${``}`]; }', '[calc(2), calc(0)]'],
  ['multiline templates', 'function calc(a) { return `😀\r\nline\n${a ? "yes" : "no"}\u2028end`; }', '[calc(true), calc(false)]'],
  ['empty template continuation', 'function calc() { return [`\\\n`, `\\\r\n`]; }', 'calc()'],
  ['escaped templates', String.raw`function calc(a) { return [\`\n\u{1F600}\${escaped}\`, \`\${a}\`]; }`.replaceAll('\\`', '`'), '[calc(1), calc(0)]'],
  ['template expressions', '`hello`; ``; const calc = a => `${a ? "yes" : "no"}:${[a, true]}`;', '[calc(1), calc(0), calc.name]'],
  ['arithmetic string exclusions', "function calc(a) { return ['x' + a, a - '2', a * `2`, a / '2', a % '2', a + 'x' + 1, a + 1 + 'x']; }", '[calc(4), calc(0)]'],
  ['printed strings', 'function calc(a) { return [a === "x", "x" != a, a && "x", !"x", ~"2", +"2", `x${a + 1}` === "x2", "x" + a + 1]; }', '[calc(1), calc("x")]'],
  ['printed templates', 'function calc(a) { return [`x\ny` === a, `x${a ? "yes" : "no"}` || a, !`😀${a + 1}`]; }', '[calc(0), calc(1)]'],
  ['arrays', 'const empty = []; const filled = [1, true, null, "x",]; function calc(a) { return [empty, filled, [a + 1, [false, []]]]; }', '[calc(2), calc(0)]'],
  ['printed arrays', 'function calc(a) { return [a || [1, "x"], [2] == a, ![], [a] + 1]; }', '[calc(0), calc(1)]'],
  ['objects', `const x = 'value'; const empty = {}; function calc(a) { return { x, 'key': a + 1, ['skip']: 'text', [2]: [], nested: { flag: true }, empty }; }`, '[calc(2), calc(0)]'],
  ['literal conditions', 'function calc(a) { if ([a, "x"]) return { value: `${a}` } + "x"; else return {}; }', '[calc(1), calc(0)]'],
  ['object keys', String.raw`const calc = { '\u{1F600}': '', ['\x61']: 'value', 1e2: false, [0x10]: \'text\', __proto__: null };`.replaceAll("\\'", "'"), 'Object.entries(calc)'],
  ['object arrows', 'const calc = { plain: a => a + 1, "quoted": () => "x", ["computed"]: () => `y`, block: () => { return []; } };', '[Object.keys(calc), ...Object.values(calc).map(f => [f(2), f.name])]'],
  ['nested arrows', 'const calc = a => ({ value: a + 1, callback: () => "x", array: [() => `y`] });', '[calc(1)?.value, calc.name, calc(1)?.callback?.name, calc(1)?.callback?.(), calc(1)?.array?.[0]?.name, calc(1)?.array?.[0]?.()]'],
  ['ASI literals', 'const a = []\ntrue\nfunction calc(x) { if (x) return { value: "yes" }\nelse return ["no"]\ntrue\n}', '[a, calc(1), calc(0)]'],
  ['ASI expression literals', 'const a = "x"\ntrue\n;["value"]\n;({ value: "text" })\nfunction calc() { return\n`not returned`\n}', '[a, calc()]'],
];

function execute(code, observation, activeMutant, { afterLoad = false, hitLimit } = {}) {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    new vm.Script(code).runInContext(context, { timeout: 1000 });
    ns.currentTestId = 'literal-test';
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, ns });
}

for (const [name, content, observation] of cases) {
  test(`native literal parity: complete records and runtime: ${name}`, async () => {
    const files = [{ name: `/fixture/${name}.js`, content, mutate: true }];
    const expected = await new Instrumenter(logger).instrument(files, options);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
    const actual = await sut.instrument(files, options);
    assert.equal(sut.stats.nativeBatches, 1);
    assert.equal(sut.stats.fallbackBatches, 0);
    assert.deepEqual(actual.mutants, expected.mutants);
    const native = actual.files[0].content;
    const upstream = expected.files[0].content;
    const baseline = execute(native, observation);
    assert.equal(baseline.error, undefined, 'baseline and observer must execute successfully');
    assert.deepEqual(baseline, execute(upstream, observation));
    for (const { id } of expected.mutants) {
      for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
        assert.deepEqual(execute(native, observation, id, settings), execute(upstream, observation, id, settings), `${name}: mutant ${id}: ${JSON.stringify(settings)}`);
      }
    }
  });
}

test('literal exclusions, selected-off files and global IDs preserve complete records', async () => {
  const files = [
    { name: 'one.js', content: "const a = ['x', ``, { 'key': '' }];", mutate: true },
    { name: 'off.js', content: 'const off = { value: ["off"] };', mutate: false },
    { name: 'two.js', content: 'export const x = { value: [] };', mutate: true },
    { name: 'imports.js', content: `import 'side-effect'; import { x as y } from 'module'; export { y }; export { x } from 'module'; export * from 'module';`, mutate: true },
  ];
  for (const excludedMutations of [[], ['StringLiteral'], ['ArrayDeclaration', 'ObjectLiteral'], ['StringLiteral', 'ArrayDeclaration', 'ObjectLiteral']]) {
    const config = { ...options, excludedMutations };
    const expected = await new Instrumenter(logger).instrument(files, config);
    const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
    const actual = await sut.instrument(files, config);
    assert.equal(sut.stats.nativeBatches, 1);
    assert.equal(sut.stats.fallbackBatches, 0);
    assert.deepEqual(actual.mutants, expected.mutants);
    assert.deepEqual(execute(actual.files[0].content, 'a'), execute(expected.files[0].content, 'a'));
    assert.deepEqual(execute(actual.files[1].content, 'off'), execute(expected.files[1].content, 'off'));
    for (const { id } of expected.mutants) {
      for (const settings of [{}, { afterLoad: true }, { hitLimit: 0 }]) {
        assert.deepEqual(execute(actual.files[0].content, 'a', id, settings), execute(expected.files[0].content, 'a', id, settings));
      }
    }
  }
});

test('array printing threshold preserves exact records or rejects the entire batch', async () => {
  const contexts = [
    [(array) => array, false],
    [(array) => `a ? ${array} : false`, false],
    [(array) => `a + ${array}`, true],
    [(array) => `a === ${array}`, true],
    [(array) => `a && ${array}`, true],
    [(array) => `${array} ?? a`, true],
    [(array) => `!${array}`, true],
    [(array) => `a + (a ? ${array} : false)`, true],
  ];
  for (let size = 0; size <= 8; size++) {
    const array = `[${Array.from({ length: size }, (_, index) => index + 1).join(', ')}]`;
    for (const literal of [array, `[${array}]`]) {
      for (const [wrap, printed] of contexts) {
        const content = `function calc(a) { return ${wrap(literal)}; }`;
        const files = [
          { name: 'first.js', content: 'const first = true;', mutate: true },
          { name: 'array.js', content, mutate: true },
        ];
        const response = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
        const supported = !printed || size <= 2;
        assert.equal(response.supported, supported, content);
        const expected = await new Instrumenter(logger).instrument(files, options);
        const actual = createInstrumenter(logger, { cache: false, engine: 'auto' });
        const result = await actual.instrument(files, options);
        assert.deepEqual(result.mutants, expected.mutants, content);
        assert.equal(actual.stats.nativeBatches, Number(supported), content);
        assert.equal(actual.stats.fallbackBatches, Number(!supported), content);
        if (supported) {
          assert.deepEqual(execute(result.files[1].content, 'calc(2)'), execute(expected.files[1].content, 'calc(2)'), content);
        } else {
          assert.equal(response.result, undefined, content);
          assert.deepEqual(result, expected, content);
        }
      }
    }
  }
});

test('unsupported literal contexts reject the complete batch atomically', async () => {
  const sources = [
    'const a = [,];', 'const a = [1,,2];', 'const a = [...[]];',
    'const a = { ...{} };', 'const a = { method() { return "x"; } };',
    'const a = { get value() { return "x"; } };', 'const a = { set value(x) {} };',
    'const a = { ["x" + "y"]: "value" };', 'const a = { [`x`]: "value" };',
    'const [a] = ["x"];', 'const { a } = { a: "x" };',
    'const a = tag`x`;', 'const a = require?.("x");', 'const a = Symbol?.("x");',
    'const a = import("x");', 'const a = Array?.();', 'const a = new Array(1);',
    'const a = [1]?.length;', 'const a = "x"?.length;',
    '"use strict"; const a = "x";', 'function calc() { "use strict"; return []; }',
    `const a = value === 'x';`, 'const a = value === "\\u0078";', `const a = 'x' + value + 1;`,
    'const a = value || { value: "x" };', 'const a = value + (() => "x");',
  ];
  for (const content of sources) {
    const files = [
      { name: 'first.js', content: 'const first = ["x", { value: true }];', mutate: true },
      { name: 'unsupported.js', content, mutate: true },
    ];
    const response = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
    assert.equal(response.supported, false, content);
    assert.equal(response.result, undefined, content);
    const native = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(native.instrument(files, options), /unsupported/i, content);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    const expected = await new Instrumenter(logger).instrument(files, options);
    assert.deepEqual(await auto.instrument(files, options), expected, content);
    assert.equal(auto.stats.nativeBatches, 0, content);
    assert.equal(auto.stats.fallbackBatches, 1, content);
  }
});

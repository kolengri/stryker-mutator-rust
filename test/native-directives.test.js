import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

function position(content, offset) {
  const lines = content.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/u);
  return { line: lines.length - 1, column: lines.at(-1).length };
}

function range(content, text, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = content.indexOf(text, offset + 1);
  assert.notEqual(offset, -1, text);
  return { start: position(content, offset), end: position(content, offset + text.length) };
}

function execute(files, observation, activeMutant, { afterLoad = false, hitLimit, currentTestId = 'directive-test' } = {}, prelude = '') {
  const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  let value, error;
  try {
    if (prelude) new vm.Script(prelude).runInContext(context, { timeout: 1000 });
    for (const { content } of files) new vm.Script(content).runInContext(context, { timeout: 1000 });
    ns.currentTestId = currentTestId;
    if (afterLoad) ns.activeMutant = activeMutant;
    value = new vm.Script(observation).runInContext(context, { timeout: 1000 });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  return structuredClone({ value, error, ns });
}

async function parity(files, config = options, observation, prelude) {
  const warnings = [];
  const oracle = new Instrumenter({ ...logger, warn: (...args) => warnings.push(args) });
  const expected = await oracle.instrument(files, config);
  assert.deepEqual(warnings, [], 'accepted directives must not need warning replay');
  const sut = createInstrumenter(logger, { cache: false, engine: 'native' });
  const actual = await sut.instrument(files, config);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.fallbackBatches, 0);
  assert.deepEqual(actual.mutants, expected.mutants);
  assert.deepEqual(actual.files.map(({ name, mutate }) => ({ name, mutate })), files.map(({ name, mutate }) => ({ name, mutate })));
  if (observation) {
    const baseline = execute(actual.files, observation, undefined, {}, prelude);
    assert.equal(baseline.error, undefined, 'baseline and observer must execute successfully');
    assert.deepEqual(baseline, execute(expected.files, observation, undefined, {}, prelude));
    for (const { id, status } of expected.mutants) {
      if (status === 'Ignored') continue;
      for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
        assert.deepEqual(execute(actual.files, observation, id, settings, prelude), execute(expected.files, observation, id, settings, prelude), `mutant ${id}: ${JSON.stringify(settings)}`);
      }
    }
  }
  return actual;
}

const selectedSource = `const first = [1 + 2, true];
function calc(x) {
  if (x > 0) { return [first, x + 3]; }
  return [false, x - 1];
}`;
const inner = range(selectedSource, 'x + 3');
const full = { start: { line: 0, column: 0 }, end: position(selectedSource, selectedSource.length) };
const selections = [
  ['true', true], ['false', false], ['empty', []], ['whole file', [full]],
  ['exact child with parent outside', [inner]],
  ['exact parent and descendants', [range(selectedSource, '[1 + 2, true]')]],
  ['disjoint', [range(selectedSource, '1 + 2'), range(selectedSource, 'x - 1')]],
  ['multiline', [{ start: { line: 2, column: 0 }, end: { line: 4, column: 0 } }]],
  ['start touch', [{ start: inner.start, end: inner.start }]],
  ['end touch', [{ start: inner.end, end: inner.end }]],
  ['partial overlap', [{ start: inner.start, end: { ...inner.end, column: inner.end.column - 1 } }]],
  ['multiple partial ranges do not jointly contain', [
    { start: inner.start, end: { ...inner.start, column: inner.start.column + 2 } },
    { start: { ...inner.start, column: inner.start.column + 2 }, end: inner.end },
  ]],
  ['overlapping ranges do not duplicate', [full, inner, inner]],
  ['outside file', [{ start: { line: 99, column: 0 }, end: { line: 100, column: 0 } }]],
];
for (const [name, mutate] of selections) {
  test(`native range parity: ${name}`, async () => {
    const actual = await parity([{ name: 'ranges.js', content: selectedSource, mutate }], options, '[calc(2), calc(0)]');
    if (name === 'exact child with parent outside') {
      assert.deepEqual(actual.mutants.map(({ id, mutatorName }) => [id, mutatorName]), [['0', 'ArithmeticOperator']]);
    }
    if (['false', 'empty', 'start touch', 'end touch', 'partial overlap', 'multiple partial ranges do not jointly contain', 'outside file'].includes(name)) {
      assert.deepEqual(actual.mutants, []);
      assert.ok(!actual.files[0].content.includes('function stryNS_9fa48'));
    }
  });
}

const directiveCases = [
  ['ordinary preamble and boundaries', `/* license 😀 */\n// preamble\nconst first = true; // trailing\n/* ordinary */\nfunction calc(x) {\n/* inner */\nif (x) {\n// before return\nreturn first;\n/* closing */\n}\nreturn false; // last\n}\n// EOF`, '[calc(true), calc(false)]'],
  ['blank lines and owner start line', `// Stryker disable next-line all\n\nconst first = [true,\nfalse];\nfunction calc() { return first; }`, 'calc()'],
  ['trailing directive owns next statement', `const first = true; /* Stryker disable next-line all */\n\nconst second = false;\nfunction calc() { return [first, second]; }`, 'calc()'],
  ['persistent across blocks and functions', `function calc(x) {\nif (x) {\n// Stryker disable ArithmeticOperator: nested reason\nreturn x + 1;\n}\nreturn x - 2;\n}\nfunction later() { return 3 * 4; }`, '[calc(1), calc(0), later()]'],
  ['restore tombstones and newest matching rule', `// Stryker disable all: outer\nconst first = true;\n// Stryker restore BooleanLiteral\nconst second = false;\n// Stryker disable BooleanLiteral: newer\nconst third = true;\n// Stryker restore next-line all\nconst fourth = false;\nconst fifth = true;\nfunction calc() { return [first, second, third, fourth, fifth]; }`, 'calc()'],
  ['multiple comments and names', `// Stryker disable all: broad\n/* Stryker restore all */\n// Stryker disable booleanliteral, ARITHMETICOPERATOR: trimmed reason  \nfunction calc(x) { return [true, x + 1, "x"]; }`, 'calc(2)'],
  ['empty whitespace reason stays active', `// Stryker disable all: \t\nfunction calc(x) { return [true, x + 1]; }`, 'calc(2)', ['BooleanLiteral', 'ArithmeticOperator', 'BlockStatement', 'ArrayDeclaration']],
  ['absent reason after colon uses default', `// Stryker disable all:\nfunction calc(x) { return x + 1; }`, 'calc(2)'],
  ['next line targets statement not physical next line', `function calc(x) {\n// Stryker disable next-line all: just if\n\nif (x > 0) {\nreturn true;\n}\nreturn false;\n}`, '[calc(1), calc(0)]'],
  ['next line restore falls back to exclusions', `// Stryker disable all: comment wins\nconst first = true;\n// Stryker restore next-line BooleanLiteral\nconst second = false;\nconst third = true;\nfunction calc() { return [first, second, third]; }`, 'calc()', ['BooleanLiteral']],
  ['closing and EOF directives have no owner', `function calc(x) {\n{\nconst first = true;\n// Stryker disable all\n}\nreturn x + 1;\n}\n// Stryker disable UnknownName`, 'calc(2)'],
  ['empty block comments have no owner', `function calc() { { /* Stryker disable all */ } return true; }`, 'calc()'],
  ['keyword case and regex whitespace', `//  Stryker disable all\nconst first = true;\n// stryker disable all\nconst second = false;\n// Stryker Disable all\nfunction calc() { return [first, second]; }`, 'calc()'],
  ['regex unanchored tail', `// Stryker disable BooleanLiteral123: ignored tail\nfunction calc() { return true; }`, 'calc()'],
  ['multiline comment regex reason stops at newline', `/* Stryker disable BooleanLiteral: first line\nsecond line */\nfunction calc() { return true; }`, 'calc()'],
  ['empty statements are directive owners', `// Stryker disable next-line all\n; const first = true;\nconst second = false;\nfunction calc() { return [first, second]; }`, 'calc()'],
];
for (const [name, content, observation, excludedMutations = []] of directiveCases) {
  test(`native statement-boundary comment parity: ${name}`, async () => {
    const actual = await parity([{ name: 'comments.js', content, mutate: true }], { ...options, excludedMutations }, observation);
    if (name === 'empty whitespace reason stays active') {
      assert.ok(actual.mutants.length > 0);
      assert.ok(actual.mutants.every(({ status, statusReason }) => status === undefined && statusReason === ''));
      assert.ok(actual.files[0].content.includes('function stryNS_9fa48'));
    }
    if (name === 'ordinary preamble and boundaries') assert.ok(actual.files[0].content.startsWith('/* license 😀 */\n// preamble\nfunction stryNS_9fa48'));
    if (name === 'absent reason after colon uses default') {
      assert.ok(actual.mutants.every(({ statusReason }) => statusReason === 'Ignored using a comment'));
      assert.ok(!actual.files[0].content.includes('stryNS_9fa48'));
    }
  });
}

test('directives process before range pruning, but never inside a pruned subtree', async () => {
  const content = `const calc = () => {\n// Stryker disable all: visited\nreturn true;\n};\nconst outside = false;`;
  const outside = range(content, 'false');
  const startOfBody = range(content, '{').start;
  const startOfReturn = range(content, 'return true;').start;
  for (const [mutate, ignored] of [
    [[outside], false],
    [[outside, { start: startOfBody, end: startOfBody }], true],
    [[outside, { start: startOfReturn, end: startOfReturn }], true],
  ]) {
    const actual = await parity([{ name: 'pruned.js', content, mutate }], options, '[outside, calc()]');
    assert.equal(actual.mutants.length, 1);
    assert.equal(actual.mutants[0].status, ignored ? 'Ignored' : undefined);
  }
  const ownerOutside = `// Stryker disable all: owner outside range\nconst first = true;\nconst outside = false;`;
  const actual = await parity([{ name: 'owner.js', content: ownerOutside, mutate: [range(ownerOutside, 'false')] }], options, '[first, outside]');
  assert.equal(actual.mutants[0].status, 'Ignored');
});

test('UTF16 columns, CRLF and U2028 selections preserve locations and comment scopes', async () => {
  const content = `/* 😀 */ const 𐐀 = '😀';\r\n// Stryker disable next-line StringLiteral\r\n\r\nconst text = 'é';\u2028function calc() { return [𐐀, text, true, 1 + 2]; }`;
  const mutate = [range(content, "'😀'"), range(content, "'é'"), range(content, 'true'), range(content, '1 + 2')];
  const actual = await parity([{ name: 'unicode.js', content, mutate }], options, 'calc()');
  assert.equal(actual.mutants.length, 4);
  assert.equal(actual.mutants[0].location.start.column, 20);
  assert.equal(actual.mutants[1].status, 'Ignored');
  assert.equal(actual.mutants[2].location.start.line, 4);
});

test('all 17 upstream mutator names validate, including grammar outside native support', async () => {
  const names = ['ArithmeticOperator', 'ArrayDeclaration', 'ArrowFunction', 'BlockStatement', 'BooleanLiteral', 'ConditionalExpression', 'CallExpression', 'EqualityOperator', 'LogicalOperator', 'MethodExpression', 'ObjectLiteral', 'StringLiteral', 'UnaryOperator', 'UpdateOperator', 'Regex', 'OptionalChaining', 'AssignmentOperator'];
  const content = `// Stryker disable ${names.join(', ')}\nfunction calc() { return [true, 1 + 2, "x"]; }`;
  const actual = await parity([{ name: 'registry.js', content, mutate: true }], options, 'calc()');
  assert.ok(actual.mutants.length > 0);
  assert.ok(actual.mutants.every(({ status }) => status === 'Ignored'));
  assert.ok(!actual.files[0].content.includes('function stryNS_9fa48'));
});

test('mixed files preserve selections, ignored IDs, exclusions, and per-file directive state', async () => {
  const selected = `// Stryker disable BooleanLiteral: selected\nconst selected = [true, 1 + 2];`;
  const files = [
    { name: 'off.js', content: '// Stryker disable all\nconst off = true;', mutate: false },
    { name: 'empty.js', content: 'const empty = false;', mutate: [] },
    { name: 'selected.js', content: selected, mutate: [range(selected, 'true'), range(selected, '1 + 2')] },
    { name: 'on.js', content: 'const on = false; function calc() { return [off, empty, selected, on]; }', mutate: true },
  ];
  const actual = await parity(files, { ...options, excludedMutations: ['ArrayDeclaration'] }, 'calc()');
  assert.deepEqual(actual.mutants.map(({ id }) => id), actual.mutants.map((_, index) => String(index)));
  assert.equal(actual.mutants[0].status, 'Ignored');
  assert.equal(actual.mutants[1].id, '1');
  assert.equal(actual.mutants[2].status, undefined);
});

test('comments on import/export boundaries apply before import skip and preserve native module records', async () => {
  const content = `/* license */\n// Stryker disable StringLiteral: before import\nimport 'side-effect';\n// Stryker disable next-line BooleanLiteral: export\nexport const flag = true;\n// Stryker restore StringLiteral\nexport const text = 'x';\nexport { flag as alias };\n// EOF`;
  const actual = await parity([{ name: 'module.mjs', content, mutate: [range(content, 'true'), range(content, "'x'")] }]);
  assert.equal(actual.mutants[0].status, 'Ignored');
  assert.equal(actual.mutants[1].status, undefined);
  assert.ok(actual.files[0].content.startsWith('/* license */\n// Stryker disable StringLiteral: before import\nfunction stryNS_9fa48'));
  const persistent = `// Stryker disable BooleanLiteral: before import\nimport 'side-effect';\nexport const flag = true;`;
  const ignored = await parity([{ name: 'import.mjs', content: persistent, mutate: true }]);
  assert.equal(ignored.mutants[0].statusReason, 'before import');
  assert.ok(!ignored.files[0].content.includes('stryNS_9fa48'));
});

test('noHeader keeps switches and directives with an externally supplied ABI header', async () => {
  const oracle = await new Instrumenter(logger).instrument([{ name: 'header.js', content: 'true;', mutate: true }], options);
  const printed = oracle.files[0].content;
  const header = printed.slice(0, printed.lastIndexOf('\n'));
  const content = '// preamble\n// Stryker disable next-line BooleanLiteral\nconst first = true;\nfunction calc(x) { return [first, x + 1]; }';
  const actual = await parity([{ name: 'no-header.js', content, mutate: true }], { ...options, noHeader: true }, 'calc(2)', header);
  assert.ok(!actual.files[0].content.includes('function stryNS_9fa48'));
  assert.ok(actual.files[0].content.includes('stryMutAct_9fa48'));
});

test('ambiguous attachments, printed comments, warnings and prior unsupported grammar fall back atomically', async () => {
  const sources = [
    'const a = [1, /* Stryker disable next-line all */ 2 + 3];',
    'const a = 1 /* Stryker disable all */ + 2;',
    'const a = x /* ordinary */ + y;',
    'const a = /* ordinary */ true;',
    'function calc(/* Stryker disable all */ x) { return x + 1; }',
    'const a = { /* ordinary */ key: true };',
    'const a = { key: /* Stryker disable all */ true };',
    'if (true) /* ordinary */ { const a = false; }',
    'function calc() /* ordinary */ { return true; }',
    'export /* ordinary */ const a = true;',
    '// Stryker disable ALL\nconst a = true;',
    '// Stryker restore Unknown\nconst a = true;',
    '// Stryker disable next-line \nconst a = true;',
    '// Stryker disable next-line : reason\nconst a = true;',
    '// Stryker disable BooleanLiteral,\nconst a = true;',
    '// Stryker disable EmptyExpression\nconst a = true;',
    '"use strict";\n// ordinary\nconst a = true;',
    '#!/usr/bin/env node\nconst a = true;',
    'const a = call?.();',
    'const a = x || [1, 2, 3];',
  ];
  for (const content of sources) {
    const files = [
      { name: 'first.js', content: 'const first = true;', mutate: true },
      { name: 'unsupported.js', content, mutate: true },
    ];
    const raw = JSON.parse(loadNative().instrumentBatch(JSON.stringify({ files, options })));
    assert.equal(raw.supported, false, content);
    assert.equal(raw.result, undefined, content);
    const native = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(native.instrument(files, options), /unsupported/i, content);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    const expected = await new Instrumenter(logger).instrument(files, options);
    assert.deepEqual(await auto.instrument(files, options), expected, content);
    assert.equal(auto.stats.nativeBatches, 0, content);
    assert.equal(auto.stats.fallbackBatches, 1, content);
  }
});


test('native module comments and ranges preserve baseline, active IDs, coverage and hit limits', async () => {
  const content = `/* module preamble */
// Stryker disable StringLiteral: import owner
import 'side-effect';
// Stryker disable next-line BooleanLiteral: export owner
export const flag = true;
// Stryker restore StringLiteral
export const text = 'x';
export function calc(x) { return [flag, text, x + 1]; }`;
  const files = [{ name: 'runtime.mjs', content, mutate: [range(content, 'true'), range(content, "'x'"), range(content, '{ return [flag, text, x + 1]; }')] }];
  const actual = await parity(files);
  const expected = await new Instrumenter(logger).instrument(files, options);
  // Node exposes isolated VM modules behind this flag. Run the whole comparison
  // in one child; imports are linked to inert modules without network or files.
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import { readFileSync } from 'node:fs';
    const { actual, expected } = JSON.parse(readFileSync(0, 'utf8'));
    async function execute(result, activeMutant, settings = {}) {
      const { afterLoad = false, hitLimit, currentTestId = 'module-test' } = settings;
      const ns = { ...(afterLoad ? {} : { activeMutant }), ...(hitLimit === undefined ? {} : { hitCount: 0, hitLimit }) };
      const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
      let value, error;
      try {
        const mod = new vm.SourceTextModule(result.files[0].content, { context });
        await mod.link(() => new vm.SourceTextModule('', { context }));
        await mod.evaluate({ timeout: 1000 });
        context.calc = mod.namespace.calc;
        ns.currentTestId = currentTestId;
        if (afterLoad) ns.activeMutant = activeMutant;
        value = new vm.Script('[calc(2), calc(0)]').runInContext(context, { timeout: 1000 });
      } catch (caught) {
        error = { name: caught.name, message: caught.message };
      }
      return structuredClone({ value, error, ns });
    }
    const baseline = await execute(actual);
    assert.equal(baseline.error, undefined);
    assert.deepEqual(baseline, await execute(expected));
    for (const { id, status } of expected.mutants) {
      if (status === 'Ignored') continue;
      for (const settings of [{}, { afterLoad: true }, { currentTestId: '' }, { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }]) {
        assert.deepEqual(await execute(actual, id, settings), await execute(expected, id, settings), id + ': ' + JSON.stringify(settings));
      }
    }
  `;
  const checked = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
    input: JSON.stringify({ actual, expected }), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr);
});

test('comment-only files and cached range results preserve the selection contract', async (t) => {
  await parity([{ name: 'comments-only.js', content: '// Stryker disable UnknownName\n/* ordinary */', mutate: true }], options, '1');
  const content = '// ordinary comment\nconst flag = true; const value = 1 + 2;';
  const selected = [{ name: 'cache.js', content, mutate: [range(content, 'true')] }];
  const cacheDir = await mkdtemp(join(tmpdir(), 'stryker-rust-directives-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const sut = createInstrumenter(logger, { engine: 'native', cacheDir });
  const first = await sut.instrument(selected, options);
  assert.deepEqual(first.mutants, (await new Instrumenter(logger).instrument(selected, options)).mutants);
  assert.deepEqual(await sut.instrument(selected, options), first);
  assert.equal(sut.stats.nativeBatches, 1);
  assert.equal(sut.stats.hits, 1);
  const changed = [{ ...selected[0], mutate: [range(content, '1 + 2')] }];
  const second = await sut.instrument(changed, options);
  assert.deepEqual(second.mutants, (await new Instrumenter(logger).instrument(changed, options)).mutants);
  assert.equal(second.mutants[0].mutatorName, 'ArithmeticOperator');
  assert.equal(sut.stats.nativeBatches, 2);
  assert.equal(sut.stats.fallbackBatches, 0);
});

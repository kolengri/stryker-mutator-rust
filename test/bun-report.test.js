import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { normalizeBunDiagnostic, normalizeBunReport } from '../scripts/bun-report.js';

const projectRoot = resolve('artifacts/bun-report-test/project');
const context = { projectRoot, tempDirName: '.stryker-tmp' };
const stack = (leaf, coordinates = '5:19') => `      at <anonymous> (${join(projectRoot, '.stryker-tmp', leaf, 'test/calculator.test.ts')}:${coordinates})`;
const reason = (leaf, elapsed) => `bun test v1.4.3 (revision)\n\ntest/calculator.test.ts:\n4 | test('adds values', () => {\n5 |   expect(add(2, 3)).toBe(5);\n                         ^\nerror: expect(received).toBe(expected)\n\nExpected: 5\nReceived: -1\n${stack(leaf)}\n(fail) adds values${elapsed}\n(pass) checks positive numbers\nRan 3 tests across 1 file.${elapsed}\n`;

test('Bun normalization retains diagnostics while removing only identified formatting differences', () => {
  const upstream = reason('sandbox-abc123', ' [0.02ms]').replace('error:', '\x1b[31merror:\x1b[0m').replaceAll('\n\n', '\n\n\n');
  const native = reason('sandbox-def456', '');
  const normalized = normalizeBunDiagnostic(upstream, context);
  assert.equal(normalized, normalizeBunDiagnostic(native, context));
  assert.ok(normalized.includes('Expected: 5\nReceived: -1'));
  assert.ok(normalized.includes('5 |   expect(add(2, 3)).toBe(5);'));
  assert.ok(normalized.includes(':5:19)'));
  assert.ok(normalized.includes('(fail) adds values\n(pass) checks positive numbers\n'));
});

test('Bun normalization cannot hide values, test names, frames, coordinates or unrelated paths', () => {
  const original = reason('sandbox-abc123', ' [0.02ms]');
  const normalized = normalizeBunDiagnostic(original, context);
  for (const changed of [
    original.replace('Received: -1', 'Received: 5'),
    original.replace('Expected: 5', 'Expected: 7'),
    original.replace('(fail) adds values', '(fail) wrong test'),
    original.replace('expect(add(2, 3)).toBe(5);', 'expect(add(4, 3)).toBe(5);'),
    original.replace(':5:19)', ':6:20)'),
    original.replace('error: expect', 'TypeError: expect'),
  ]) assert.notEqual(normalizeBunDiagnostic(changed, context), normalized);
  const outside = `      at fn (${join(projectRoot, 'unrelated', 'sandbox-abc123', 'module.ts')}:8:4)`;
  assert.equal(normalizeBunDiagnostic(outside, context), outside);
  const values = `Expected: sandbox-abc123 [1ms]\nReceived: sandbox-def456 [2ms]\nconsole output [3ms]\n(pass) unknown test [4ms]\n`;
  assert.equal(normalizeBunDiagnostic(values, context), values);
});

test('Bun elapsed formatting removes external whitespace and preserves a time-like test title', () => {
  const options = { ...context, testNames: ['literal [1ms]'] };
  assert.equal(normalizeBunDiagnostic('(pass) literal [1ms] [0.02ms]', options), '(pass) literal [1ms]');
  assert.equal(normalizeBunDiagnostic('(pass) literal [1ms]', options), '(pass) literal [1ms]');
  assert.equal(normalizeBunDiagnostic('(fail) adds values\t[0.03s]\nRan 3 tests across 1 file.\t[2.5s]', context), '(fail) adds values\nRan 3 tests across 1 file.');
  assert.equal(normalizeBunDiagnostic('Expected: 5 \nReceived: -1 ', context), 'Expected: 5 \nReceived: -1 ');
});

test('Bun report comparison preserves all known and future fields, arrays and input objects', () => {
  const input = {
    projectRoot,
    config: { tempDirName: '.stryker-tmp', commandRunner: { command: 'bun test' }, extra: 42 },
    framework: { name: 'StrykerJS', version: '10.0.0', dependencies: { arbitrary: '1.0' } },
    testFiles: { test: { source: 'original test source', tests: [{ id: '0', name: 'All tests' }] } },
    files: { source: { language: 'typescript', source: 'original source', futureFileField: true, mutants: [
      { id: '2', status: 'Survived', location: { start: { line: 1, column: 3 } }, coveredBy: ['second', 'first'], futureMutantField: { value: 7 } },
      { id: '1', status: 'Killed', killedBy: ['0'], testsCompleted: 1, statusReason: reason('sandbox-abc123', ' [0.02ms]') },
    ] } },
    futureTopLevelField: { complete: true },
  };
  const snapshot = structuredClone(input);
  const normalized = normalizeBunReport(input);
  assert.deepEqual(input, snapshot);
  const expected = structuredClone(snapshot);
  expected.files.source.mutants.reverse();
  expected.files.source.mutants[0].statusReason = normalizeBunDiagnostic(snapshot.files.source.mutants[1].statusReason, context);
  assert.deepEqual(normalized, expected);
  assert.deepEqual(normalized.files.source.mutants[1].coveredBy, ['second', 'first']);
});

test('Bun diagnostics never normalize a temporary directory outside this owned project', () => {
  assert.throws(() => normalizeBunDiagnostic(reason('sandbox-abc123', ''), { projectRoot, tempDirName: '../outside' }), /inside projectRoot/);
});

import assert from 'node:assert/strict';
import { join, relative, resolve } from 'node:path';
import { EOL } from 'node:os';
import { test } from 'node:test';
import { normalizeBunDiagnostic, normalizeBunReport, reassembleUpstreamBunReport } from '../scripts/bun-report.js';

const projectRoot = resolve('artifacts/bun-report-test/project');
const context = { projectRoot, tempDirName: '.stryker-tmp' };
const stack = (leaf, coordinates = '5:19') => `      at <anonymous> (${join(projectRoot, '.stryker-tmp', leaf, 'test/calculator.test.ts')}:${coordinates})`;
const reason = (leaf, elapsed) => `bun test v1.4.3 (revision)\n\ntest/calculator.test.ts:\n4 | test('adds values', () => {\n5 |   expect(add(2, 3)).toBe(5);\n                         ^\nerror: expect(received).toBe(expected)\n\nExpected: 5\nReceived: -1\n${stack(leaf)}\n(fail) adds values${elapsed}\n(pass) checks positive numbers\nRan 3 tests across 1 file.${elapsed}\n`;
const annotation = (leaf, absolute = false) => {
  const file = join(projectRoot, '.stryker-tmp', leaf, 'test/calculator.test.ts');
  return `::error file=${absolute ? file : relative(process.cwd(), file)},line=5,col=19,title=error: expect(received).toBe(expected)::Expected: 5%0AReceived: -1%0A%0A${stack(leaf)}%0A`;
};

test('Bun normalization retains diagnostics while removing only identified formatting differences', () => {
  const upstream = reason('sandbox-abc123', ' [0.02ms]').replace('error:', '\x1b[31merror:\x1b[0m');
  const native = reason('sandbox-def456', '');
  const normalized = normalizeBunDiagnostic(upstream, context);
  assert.equal(normalized, normalizeBunDiagnostic(native, context));
  assert.ok(normalized.includes('Expected: 5\nReceived: -1'));
  assert.ok(normalized.includes('5 |   expect(add(2, 3)).toBe(5);'));
  assert.ok(normalized.includes(':5:19)'));
  assert.ok(normalized.includes('(fail) adds values\n(pass) checks positive numbers\n'));
  assert.ok(normalized.includes('\n\nExpected: 5'));
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

test('Bun GitHub annotations normalize only the owned leaf in file metadata and encoded stack frames', () => {
  for (const absolute of [false, true]) {
    const upstream = annotation('sandbox-abc123', absolute);
    const normalized = normalizeBunDiagnostic(upstream, context);
    assert.equal(normalized, normalizeBunDiagnostic(annotation('sandbox-def456', absolute), context));
    assert.equal(normalized, upstream.replaceAll('sandbox-abc123', 'sandbox-<owned>'));
    assert.ok(normalized.includes('line=5,col=19,title=error: expect(received).toBe(expected)::Expected: 5%0AReceived: -1%0A%0A'));
    assert.ok(normalized.endsWith(':5:19)%0A'));
  }
});

test('Bun diagnostics never guess whether an annotation newline was inserted by upstream', () => {
  const shortFile = annotation('sandbox-abc123').replace(/file=.*?,line=/, 'file=test/calculator.test.ts,line=');
  for (const different of [
    shortFile.replace('title=error:', 'title=\nerror:'),
    shortFile.replace('title=error:', 'title=custom\nerror:'),
    shortFile.replace('title=error:', 'title=\nTypeError:'),
    shortFile.replace('title=error:', 'title=\n\nerror:'),
    shortFile.replace('Expected: 5%0AReceived:', 'Expected: 5\nReceived:'),
    shortFile.replace('title=error:', 'title=\nerror:').replace('file=test/', 'file=unrelated/'),
  ]) assert.equal(normalizeBunDiagnostic(different, context), different, 'Unproven title/message newlines must remain');
  assert.equal(normalizeBunDiagnostic('Expected: 5\n\nReceived: -1\n\n\n', context), 'Expected: 5\n\nReceived: -1\n\n\n');
});

test('Bun GitHub annotation normalization preserves severity, title, values, coordinates and unrelated paths', () => {
  const original = annotation('sandbox-abc123');
  const normalized = normalizeBunDiagnostic(original, context);
  for (const changed of [
    original.replace('::error ', '::warning '),
    original.replace('title=error:', 'title=TypeError:'),
    original.replace('line=5,col=19', 'line=6,col=20'),
    original.replace(':5:19)', ':6:20)'),
    original.replace('Expected: 5', 'Expected: 7'),
    original.replace('Received: -1', 'Received: 5'),
    original.replace('Received: -1%0A', 'Received: -1%0D%0A'),
  ]) assert.notEqual(normalizeBunDiagnostic(changed, context), normalized);

  const outside = annotation('sandbox-abc123').replaceAll('.stryker-tmp', 'unrelated');
  assert.equal(normalizeBunDiagnostic(outside, context), outside);
  const sibling = annotation('sandbox-abc123').replaceAll('.stryker-tmp', '.stryker-tmp-other');
  assert.equal(normalizeBunDiagnostic(sibling, context), sibling);
  const value = join(projectRoot, '.stryker-tmp', 'sandbox-abc123', 'expected.ts');
  const withValues = original.replace('title=error:', `title=${value} error:`).replace('Expected: 5', `Expected: ${value}%250A`);
  const result = normalizeBunDiagnostic(withValues, context);
  assert.ok(result.includes(`title=${value} error:`));
  assert.ok(result.includes(`Expected: ${value}%250A`));
  const ordinaryOutput = `console output ${original}`;
  assert.equal(normalizeBunDiagnostic(ordinaryOutput, context), ordinaryOutput);
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

const activeMutantVariable = '__STRYKER_ACTIVE_MUTANT__';
function capturedReport() {
  const chunks = [
    { stream: 'stdout', text: 'Original blank lines:\n\nExpected: 5\nReceived: -1\n::error file=test/calculator.test.ts,line=5,col=19,title=err' },
    { stream: 'stderr', text: 'or: expect(received).toBe(expected)::Expected: 5%0' },
    { stream: 'stdout', text: 'AReceived: -1%0A%0Areal message newline:\nretained\n' },
  ];
  const report = {
    projectRoot,
    config: { tempDirName: '.stryker-tmp', commandRunner: { command: 'pinned-bun test' }, extra: true },
    files: { source: { source: 'original', mutants: [
      { id: '0', status: 'Killed', statusReason: chunks.map((chunk) => chunk.text).join(EOL), future: [7, 5] },
      { id: '1', status: 'Survived', statusReason: 'unchanged survivor diagnostic' },
    ] } },
    future: { complete: true },
  };
  const capture = (id, exitCode, data = []) => ({
    version: 1, command: report.config.commandRunner.command,
    cwd: join(projectRoot, '.stryker-tmp', 'sandbox-abc123'),
    activeMutantVariable, activeMutantId: id, chunks: data, exit: { code: exitCode, signal: null },
  });
  return { report, captures: [capture(null, 0), capture('0', 1, chunks), capture('1', 0)], chunks };
}

test('Captured upstream chunk reassembly retains every original character and all other report fields', () => {
  const { report, captures, chunks } = capturedReport();
  const snapshot = structuredClone({ report, captures });
  const corrected = reassembleUpstreamBunReport(report, captures, { activeMutantVariable });
  const expected = structuredClone(report);
  expected.files.source.mutants[0].statusReason = chunks.map((chunk) => chunk.text).join('');
  assert.deepEqual(corrected, expected);
  assert.deepEqual({ report, captures }, snapshot);
  const diagnostic = corrected.files.source.mutants[0].statusReason;
  assert.ok(diagnostic.includes('Original blank lines:\n\nExpected: 5\nReceived: -1'));
  assert.ok(diagnostic.includes('title=error: expect(received).toBe(expected)::Expected: 5%0AReceived: -1%0A%0A'));
  assert.ok(diagnostic.endsWith('real message newline:\nretained\n'));
});

test('Upstream chunk evidence rejects missing, duplicate, unrelated and mismatched captures', () => {
  const original = capturedReport();
  const invalid = [
    ({ captures }) => captures.splice(0, 1),
    ({ captures }) => captures.splice(1, 1),
    ({ captures }) => captures.push(structuredClone(captures[1])),
    ({ captures }) => { captures[1].command = 'another command'; },
    ({ captures }) => { captures[1].cwd = join(projectRoot, 'unrelated', 'sandbox-abc123'); },
    ({ captures }) => { captures[1].activeMutantVariable = 'ANOTHER_VARIABLE'; },
    ({ captures }) => { captures[1].chunks[1].text = 'different assertion'; },
    ({ captures }) => { captures[1].exit.code = 0; },
    ({ captures }) => { captures[2].activeMutantId = 'unreported'; },
    ({ report }) => { report.files.source.mutants[0].statusReason += '\n'; },
    ({ report }) => { delete report.files.source.mutants[0].statusReason; },
  ];
  for (const change of invalid) {
    const candidate = structuredClone(original);
    change(candidate);
    assert.throws(() => reassembleUpstreamBunReport(candidate.report, candidate.captures, { activeMutantVariable }), /upstream Bun|Upstream Bun/);
  }
});

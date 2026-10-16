import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsync } from '@babel/core';
import { analyze, nativeStatus } from '../lib/native.js';
import { loadNative } from '../lib/native.js';

test('release native binding loads on the host platform', () => {
  assert.equal(nativeStatus().available, true, nativeStatus().error);
  assert.equal(loadNative().cacheKey('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  assert.throws(() => loadNative().cacheKey(42));
});

test('preview candidates use JavaScript UTF16 offsets and remain explicit about parity gaps', async () => {
  const source = 'const emoji = "😀"; function calc(a,b) { return (a + b) > 0 && true; }';
  const result = analyze(source, 'sample.js');
  assert.equal(result.supported, false);
  assert.ok(result.reason);
  assert.ok(result.mutants.length > 0);
  const arithmetic = result.mutants.find((m) => m.mutatorName === 'ArithmeticOperator');
  assert.equal(source.slice(arithmetic.start, arithmetic.end), 'a + b');
  for (const mutant of result.mutants) {
    const mutated = source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
    await parseAsync(mutated, { configFile: false, babelrc: false });
  }
});

test('malformed source is rejected without candidates', () => {
  const result = analyze('const = ;', 'broken.js');
  assert.equal(result.supported, false);
  assert.equal(result.mutants.length, 0);
  assert.ok(result.reason);
});

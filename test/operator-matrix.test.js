import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { logger, options } from './helpers.js';

test('all 512 nested operator pairs retain complete upstream mutant records', async () => {
  const operators = ['+', '-', '*', '/', '%', '==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||', '??'];
  const expressions = [];
  for (const inner of operators) for (const outer of operators) {
    expressions.push(`(a ${inner} b) ${outer} c`, `a ${outer} (b ${inner} c)`);
  }
  expressions.push('a ? b+c : b-c', '(a ? b : c)+c', '!(a?b:c)', 'typeof(a+b)', 'void(a+b)');
  const native = createInstrumenter(logger, { cache: false, engine: 'native' });
  const upstream = new Instrumenter(logger);
  for (const expression of expressions) {
    const files = [{ name: 'input.js', mutate: true, content: `function f(a,b,c) { return ${expression}; }` }];
    const expected = await upstream.instrument(files, options);
    const result = await native.instrument(files, options);
    assert.deepEqual(result.mutants, expected.mutants, expression);
  }
  assert.equal(native.stats.nativeBatches, 517);
  assert.equal(native.stats.fallbackBatches, 0);
});

test('known printer incompatibilities must fallback rather than change record text', async () => {
  const upstream = new Instrumenter(logger);
  for (const expression of ['a+(b=>b)', 'a+0x10', 'a+1_000', 'a+1e2']) {
    const files = [{ name: 'input.js', mutate: true, content: `function f(a,b,c) { return ${expression}; }` }];
    const native = createInstrumenter(logger, { cache: false, engine: 'native' });
    await assert.rejects(native.instrument(files, options), /unsupported/i);
    const auto = createInstrumenter(logger, { cache: false, engine: 'auto' });
    assert.deepEqual(await auto.instrument(files, options), await upstream.instrument(files, options));
    assert.equal(auto.stats.fallbackBatches, 1);
  }
});

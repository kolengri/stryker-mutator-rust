import assert from 'node:assert/strict';
import { Calculator, create, startup } from '../src/calculator.ts';

describe('typed class calculator', () => {
  it('constructs a derived instance and adds values', () => {
    const calculator = create(1);
    assert.equal(calculator.value, 1);
    assert.equal(calculator.add(2, 3), 6);
  });

  it('preserves private accessor state', () => {
    const calculator = create(1);
    assert.equal(calculator.offset, 1);
    calculator.offset = 4;
    assert.equal(calculator.offset, 4);
    assert.equal(calculator.add(2, 3), 9);
  });

  it('observes static initialization', () => {
    assert.equal(startup, true);
    assert.equal(Calculator.enabled, true);
  });
});

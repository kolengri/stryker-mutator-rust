import assert from 'node:assert/strict';
import { add, positive, startup, removeOptional, nonNullValue, total, recover } from '../src/calculator.ts';

describe('typed calculator', () => {
  it('adds values', () => assert.equal(add(2, 3), 5));
  it('checks positive numbers', () => {
    assert.equal(positive(1), true);
    assert.equal(positive(-1), false);
  });
  it('observes module initialization', () => assert.equal(startup, true));
  it('deletes optional references and skips absent bases', () => {
    const container = { value: 3 };
    assert.equal(removeOptional(container), true);
    assert.equal(Object.hasOwn(container, 'value'), false);
    assert.equal(removeOptional(undefined), true);
  });
  it('preserves a non-null member receiver and optional short-circuit', () => {
    const value = { toString() { assert.equal(this, value); return 'value'; } };
    assert.equal(nonNullValue({ value }), 'value');
    assert.equal(nonNullValue(undefined), undefined);
  });
  it('evaluates defaults only when needed and collects rest arguments', () => {
    assert.equal(total(), 3);
    assert.equal(total(undefined, 5, 6), 5);
    assert.equal(total(10, 20), 11);
    assert.equal(total(0), 0);
  });
  it('calls a nested declaration before its source position and always finalizes', () => {
    for (const [value, expected] of [[2, 3], [-2, -2]]) {
      const state = { value, finalized: false };
      assert.equal(recover(state), expected);
      assert.equal(state.finalized, true);
    }
  });
});

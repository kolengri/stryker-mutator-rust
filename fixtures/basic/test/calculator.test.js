import assert from 'node:assert/strict';
import { add, positive, startup } from '../src/calculator.js';

describe('calculator', () => {
  it('adds values', () => assert.equal(add(2, 3), 5));
  it('checks positive numbers', () => {
    assert.equal(positive(1), true);
    assert.equal(positive(-1), false);
  });
  it('observes module initialization', () => assert.equal(startup, 'ready'));
});

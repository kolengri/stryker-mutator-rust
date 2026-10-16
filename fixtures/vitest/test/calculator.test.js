import { describe, it, expect } from 'vitest';
import { add, positive, startup } from '../src/calculator.js';

describe('calculator', () => {
  it('adds values', () => expect(add(2, 3)).toBe(5));
  it('checks positive numbers', () => {
    expect(positive(1)).toBe(true);
    expect(positive(-1)).toBe(false);
  });
  it('observes module initialization', () => expect(startup).toBe('ready'));
});

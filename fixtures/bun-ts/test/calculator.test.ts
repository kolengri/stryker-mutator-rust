import { expect, test } from 'bun:test';
import { add, positive, startup } from '../src/calculator.ts';

test('adds values', () => {
  expect(add(2, 3)).toBe(5);
});

test('checks positive numbers', () => {
  expect(positive(1)).toBe(true);
  expect(positive(-1)).toBe(false);
});

test('observes module initialization', () => {
  expect(startup).toBe(true);
});

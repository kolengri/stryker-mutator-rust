import assert from 'node:assert/strict';
import { add, positive, startup } from '../src/calculator.js';

try {
  assert.equal(add(2, 3), 5);
  assert.equal(positive(1), true);
  assert.equal(positive(-1), false);
  assert.equal(startup, true);
} catch (error) {
  // Keep failure output deterministic across independently named sandboxes.
  console.error(error.message);
  process.exitCode = 1;
}

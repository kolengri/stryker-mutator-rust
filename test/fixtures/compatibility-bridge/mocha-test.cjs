const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');

function record(event) {
  appendFileSync(process.env.BRIDGE_TEST_HOOKS, `${event}\n`);
}

describe('bridge fixture', function () {
  before(function () { record('before'); });
  beforeEach(async function () {
    await Promise.resolve();
    record(`beforeEach:${this.currentTest.title}`);
  });
  afterEach(function () { record(`afterEach:${this.currentTest.title}`); });
  after(function () { record('after'); });
  it('async mutation', async function () {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(globalThis.__stryker__.activeMutant === 'kill' ? false : true, true);
  });
  it('callback', function (done) { setImmediate(done); });
  it.skip('pending', function () {});
});

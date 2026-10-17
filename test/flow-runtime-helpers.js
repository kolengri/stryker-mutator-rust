import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from '@babel/core';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { createInstrumenter } from '../lib/index.js';
import { loadNative } from '../lib/native.js';
import { logger, options } from './helpers.js';

const require = createRequire(import.meta.url);
export const flowOptions = { ...options, plugins: ['flow'] };
export const file = (content, name = 'flow.js', mutate = true) => ({ name, content, mutate });
export const raw = (files, config = flowOptions, threads = 1) => JSON.parse(loadNative().instrumentBatch(JSON.stringify({
  files, options: config, ...(threads === 'auto' ? {} : { execution: { threads } }),
})));
export const proofs = [];
export async function compare(files, config = flowOptions, modes = [1]) {
  const expected = await new Instrumenter(logger).instrument(files, config);
  const abi = raw(files, config);
  assert.equal(abi.supported, true, abi.reason);
  // JSON is the frozen ABI: omitted undefined status fields are its contract.
  assert.deepEqual(abi.result.mutants, JSON.parse(JSON.stringify(expected.mutants)), 'raw ABI complete ordered upstream records');
  assert.deepEqual(abi.result.files.map(({ content, ...rest }) => rest), files.map(({ content, ...rest }) => rest));
  for (const threads of modes) {
    assert.deepEqual(raw(files, config, threads).result, abi.result, `complete output bytes/IDs: ${threads}`);
    for (const engine of ['native', 'auto']) {
      const sut = createInstrumenter(logger, { cache: false, engine, ...(threads === 'auto' ? {} : { instrumentationThreads: threads }) });
      const actual = await sut.instrument(files, config);
      assert.deepEqual(actual.mutants, expected.mutants, 'public API includes exact upstream undefined/ignored status fields');
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), abi.result, 'complete public/ABI result');
      assert.deepEqual([sut.stats.nativeBatches, sut.stats.fallbackBatches, sut.stats.nativeErrors], [1, 0, 0]);
    }
  }
  const proof = { files, config, abi, expected, runtimeComparisons: 0 };
  proofs.push(proof);
  return { actual: abi.result, expected, original: { files }, proof };
}
const compiled = new Map();
function executable(content) {
  if (!compiled.has(content)) {
    // Original Flow reaches BOTH instrumenters first. The identical real Flow
    // compiler processes original and completed outputs only, on Node and Bun.
    const output = transformSync(content, { filename: 'completed-flow.js', configFile: false, babelrc: false,
      plugins: [[require.resolve('@babel/plugin-transform-flow-strip-types'), { all: true }]],
    });
    assert.equal(typeof output.code, 'string');
    compiled.set(content, output.code);
  }
  return compiled.get(content);
}
export function execute(result, setup, observation, state, id, settings = {}) {
  const ns = { ...(settings.afterLoad ? {} : { activeMutant: id }),
    ...(settings.initialTestId === undefined ? {} : { currentTestId: settings.initialTestId }),
    ...(settings.hitLimit === undefined ? {} : { hitCount: 0, hitLimit: settings.hitLimit }) };
  const context = vm.createContext({ __stryker__: ns, process: { env: {} } });
  const evaluate = code => new vm.Script(code).runInContext(context, { timeout: 1000 });
  const describe = error => {
    assert.notEqual(error.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 'VM timeout fails the proof');
    return { name: error.name, message: error.message };
  };
  evaluate(`const events=[]; ${setup}`);
  const loadErrors = [];
  for (const output of result.files) {
    const script = new vm.Script(executable(output.content));
    try { script.runInContext(context, { timeout: 1000 }); } catch (error) { loadErrors.push(describe(error)); }
  }
  ns.currentTestId = settings.currentTestId ?? 'flow-test';
  if (settings.afterLoad) ns.activeMutant = id;
  let value, error;
  try { value = evaluate(observation); } catch (caught) { error = describe(caught); }
  return structuredClone({ value, error, loadErrors, state: evaluate(state), events: evaluate('events'), ns });
}
const observable = ({ ns, ...rest }) => rest;
function substitute(source, mutant) {
  const lines = source.split(/\r\n|[\r\n\u2028\u2029]/);
  // Keep original line terminator lengths and UTF-16 source indices.
  const offsets = [0];
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) offsets.push(match.index + match[0].length);
  const at = position => {
    assert.ok(position.column <= lines[position.line].length);
    return offsets[position.line] + position.column;
  };
  return source.slice(0, at(mutant.location.start)) + mutant.replacement + source.slice(at(mutant.location.end));
}
export function runtime(pair, setup, observation, state = 'null', { baselineThrows = false } = {}) {
  const original = observable(execute(pair.original, setup, observation, state));
  if (!baselineThrows) { assert.deepEqual(original.loadErrors, []); assert.equal(original.error, undefined); }
  assert.deepEqual(observable(execute(pair.actual, setup, observation, state)), original, 'inactive native matches original Flow');
  const settings = [{}, { afterLoad: true }, { initialTestId: 'loading' }, { currentTestId: '' },
    { hitLimit: 0 }, { afterLoad: true, hitLimit: 1 }, { afterLoad: true, hitLimit: 2 }];
  for (const id of [undefined, ...pair.actual.mutants.map(mutant => mutant.id)]) {
    for (const setting of settings) {
      assert.deepEqual(execute(pair.actual, setup, observation, state, id, setting),
        execute(pair.expected, setup, observation, state, id, setting), `id=${id} ${JSON.stringify(setting)}`);
      pair.proof.runtimeComparisons++;
    }
  }
  for (const mutant of pair.actual.mutants) {
    if (mutant.status === 'Ignored') {
      assert.deepEqual(observable(execute(pair.actual, setup, observation, state, mutant.id)), original);
    } else {
      const direct = { files: pair.original.files.map(f => ({ ...f, content: f.name === mutant.fileName ? substitute(f.content, mutant) : f.content })) };
      assert.deepEqual(observable(execute(pair.actual, setup, observation, state, mutant.id)),
        observable(execute(direct, setup, observation, state)), `direct original-span mutant ${mutant.id}`);
    }
    pair.proof.runtimeComparisons++;
  }
}

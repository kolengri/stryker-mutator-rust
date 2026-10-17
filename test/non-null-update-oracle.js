import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { logger } from './helpers.js';

// Apache-2.0 StrykerJS resource, copyright Stryker Mutator contributors; see NOTICE.
// Exact c931a93237816901f1e9f48da411170beeb3dfca / instrumenter 10.0.0 bytes.
export const pinnedNonNullSource = `export function count(letters: string): Int8Array {
  const c = new Int8Array(26);
  for (const letter of letters) {
    c[letter.charCodeAt(0) - 65]!++;
  }
  return c;
}
`;
export const sha256 = source => createHash('sha256').update(source).digest('hex');
export const pinnedNonNullHash = 'd5a1bf58560da091a6fe4ec24d8aaf6b0cb36024eee4ec80f54339088a74ac9f';
assert.equal(sha256(pinnedNonNullSource), pinnedNonNullHash);
export const nonNullErrorMessage = 'Property argument of UpdateExpression expected node to be of a type ["Identifier","MemberExpression"] but instead got "TSNonNullExpression"';

// Resolve pinned internals through the public package.json export. These are
// verification-only per-call injections; no package globals or source change.
const require = createRequire(import.meta.url);
const packageFile = require.resolve('@stryker-mutator/instrumenter/package.json');
assert.equal(require(packageFile).version, '10.0.0');
const internal = name => import(pathToFileURL(join(dirname(packageFile), 'dist/src', name)).href);
const [{ transformBabel }, { allMutators }, { deepCloneNode }] = await Promise.all([
  internal('transformers/babel-transformer.js'), internal('mutators/index.js'), internal('util/index.js'),
]);
const update = allMutators.find(mutator => mutator.name === 'UpdateOperator');
assert.ok(update);
export const oracleGlobalState = () => ({ array: allMutators, entries: allMutators.slice(),
  methods: allMutators.map(mutator => mutator.mutate),
  descriptors: allMutators.map(mutator => Object.getOwnPropertyDescriptors(mutator)) });

export function offset(source, position) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) starts.push(match.index + match[0].length);
  assert.ok(position.line < starts.length);
  return starts[position.line] + position.column;
}
export function sourceSpan(source, mutant) {
  return source.slice(offset(source, mutant.location.start), offset(source, mutant.location.end));
}
export function substitute(source, mutant) {
  return source.slice(0, offset(source, mutant.location.start)) + mutant.replacement + source.slice(offset(source, mutant.location.end));
}

export async function nonNullUpdateOracle(files, config) {
  const before = oracleGlobalState();
  let correctedConstructors = 0;
  const localMutators = allMutators.map(mutator => mutator === update ? {
    ...mutator,
    *mutate(path) {
      if (path.isUpdateExpression() && path.node.argument.type === 'TSNonNullExpression') {
        correctedConstructors++;
        // Exact fresh types.updateExpression shape from pinned Babel 8. Only
        // its invalid argument validator is bypassed for this valid TS node.
        // Keep deepCloneNode's argument metadata; do not clone root metadata
        // that the ordinary constructor would discard.
        const { operator, argument, prefix } = path.node;
        assert.ok(operator === '++' || operator === '--');
        yield { type: 'UpdateExpression', operator: operator === '++' ? '--' : '++',
          argument: deepCloneNode(argument), prefix };
      } else yield* mutator.mutate(path);
    },
  } : mutator);
  const transform = (ast, collector, context) => {
    assert.ok(['js', 'ts', 'tsx'].includes(ast.format), 'The corrected constructor oracle is scoped to Babel source files');
    transformBabel(ast, collector, { ...context, transform }, localMutators);
  };
  const expected = await new Instrumenter(logger, undefined, undefined, transform).instrument(files, config);
  assert.deepEqual(oracleGlobalState(), before, 'Pinned mutator array, objects and methods remain unchanged');
  const sources = new Map(files.map(file => [file.name, file.content]));
  return { expected,
    oracle: { strategy: 'Pinned original-AST traversal with a per-call corrected UpdateOperator constructor',
      upstream: '10.0.0', correctedConstructors,
      sources: files.map(file => ({ fileName: file.name, sourceHash: sha256(file.content) })) },
    spans: expected.mutants.map(mutant => ({ ...mutant, original: sourceSpan(sources.get(mutant.fileName), mutant) })) };
}

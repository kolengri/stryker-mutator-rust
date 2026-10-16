import { types } from 'node:util';

const providerKinds = new Set(['ClassProvider', 'FactoryProvider', 'ValueProvider']);

function incompatible() {
  const error = new Error('Unsupported typed-inject disposal layout; this adapter requires typed-inject 5.0.0 injector-owned Sets.');
  error.name = 'InjectorCompatibilityError';
  throw error;
}

function dataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable || !descriptor.configurable || !descriptor.enumerable) incompatible();
  return descriptor.value;
}

function nativeSet(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Set.prototype) incompatible();
  return value;
}

/**
 * typed-inject 5.0.0 (dist/src/InjectorImpl.js) records disposables separately
 * per provider. Aliasing the same object through providers otherwise disposes
 * it repeatedly. Validate the complete injector graph before changing any Set.
 * Plugin identity/methods and the SDK's traversal/context states stay intact.
 */
function validatedGraph(root) {
  const stack = [{ node: root, parent: undefined, depth: 0, visitedChildren: false }];
  const visited = new Set();
  const owners = [];
  while (stack.length) {
    const entry = stack.pop();
    const { node, parent, depth } = entry;
    if (entry.visitedChildren) {
      if (entry.disposables) owners.push({ node, disposables: entry.disposables, depth });
      continue;
    }
    if (!node || typeof node !== 'object' || types.isProxy(node) || visited.has(node)) incompatible();
    visited.add(node);
    const prototype = Object.getPrototypeOf(node);
    if (!prototype) incompatible();
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    const kind = typeof constructor === 'function' ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value : undefined;
    if (parent === undefined ? kind !== 'RootInjector' : !providerKinds.has(kind) && kind !== 'ChildInjector') incompatible();
    if (parent !== undefined && dataProperty(node, 'parent') !== parent) incompatible();
    if (typeof dataProperty(node, 'isDisposed') !== 'boolean') incompatible();
    const children = nativeSet(dataProperty(node, 'childInjectors'));
    const disposables = providerKinds.has(kind) ? nativeSet(dataProperty(node, 'disposables')) : undefined;
    if (disposables) {
      for (const value of Set.prototype.values.call(disposables)) {
        if (value === null || !['object', 'function'].includes(typeof value)) incompatible();
      }
    } else if (Object.hasOwn(node, 'disposables')) incompatible();
    stack.push({ ...entry, visitedChildren: true, disposables });
    for (const child of Set.prototype.values.call(children)) {
      stack.push({ node: child, parent: node, depth: depth + 1, visitedChildren: false });
    }
  }
  // Postorder retains descendants; depth also settles aliases in separate
  // branches without depending on provider insertion order.
  owners.sort((left, right) => right.depth - left.depth);
  return { owners, nodes: [...visited] };
}

function deduplicate(owners) {
  const retained = new Set();
  for (const { disposables } of owners) {
    for (const value of Set.prototype.values.call(disposables)) {
      if (retained.has(value)) Set.prototype.delete.call(disposables, value);
      else retained.add(value);
    }
  }
}

export function deduplicateInjectorDisposables(root) {
  deduplicate(validatedGraph(root).owners);
}

function validateMethod(node, method, expectedOwner) {
  if (Object.hasOwn(node, method)) incompatible();
  let prototype = Object.getPrototypeOf(node);
  while (prototype) {
    if (types.isProxy(prototype)) incompatible();
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (descriptor) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
      const kind = typeof constructor === 'function' ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value : undefined;
      if (kind !== expectedOwner || typeof descriptor.value !== 'function' || !descriptor.writable || !descriptor.configurable || descriptor.enumerable) incompatible();
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  incompatible();
}

/** Attempt every owned disposable while keeping normal SDK traversal/state. */
export async function disposeInjector(root) {
  const { owners, nodes } = validatedGraph(root);
  // Validate every override before ownership mutation or user callbacks.
  const providers = new Set(owners.map(({ node }) => node));
  for (const node of nodes) {
    validateMethod(node, 'dispose', node === root ? 'AbstractInjector' : 'ChildInjector');
    validateMethod(node, 'removeChild', 'AbstractInjector');
    validateMethod(node, 'disposeInjectedValues', providers.has(node) ? 'ChildWithProvidedInjector' : node === root ? 'RootInjector' : 'ChildInjector');
    if (providers.has(node) && !Object.isExtensible(node)) incompatible();
  }
  deduplicate(owners);
  const errors = [];
  const patched = [];
  try {
    for (const { node, disposables } of owners) {
      Object.defineProperty(node, 'disposeInjectedValues', {
        configurable: true,
        writable: true,
        async value() {
          const results = await Promise.allSettled([...Set.prototype.values.call(disposables)]
            .map((disposable) => Promise.resolve().then(() => disposable.dispose())));
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        },
      });
      patched.push(node);
    }
    // The SDK marks contexts disposed before callbacks, awaits children before
    // parents, and starts independent branches in parallel. Swallow only user
    // disposal failures inside dispatch so ancestors still get their callbacks.
    try { await root.dispose(); } catch (error) { errors.push(error); }
  } finally {
    for (const node of patched) delete node.disposeInjectedValues;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} plugin disposals failed.`);
}

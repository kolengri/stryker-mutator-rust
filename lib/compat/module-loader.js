import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let nextImportId = 0;

/** Import with Node's normal conditions and loaders, anchored in the consumer project. */
export async function importPlugin(specifier, cwd) {
  if (path.isAbsolute(specifier)) {
    const moduleName = pathToFileURL(specifier).href;
    return { moduleName, namespace: await import(moduleName) };
  }
  if (specifier.startsWith('.')) {
    const moduleName = pathToFileURL(path.resolve(cwd, specifier)).href;
    return { moduleName, namespace: await import(moduleName) };
  }
  if (URL.canParse(specifier)) {
    return { moduleName: specifier, namespace: await import(specifier) };
  }

  // import.meta.resolve's parent argument still needs a flag on supported Node
  // versions. require.resolve would silently select the wrong export condition.
  // Rebase only this import; all other resolution is passed through unchanged.
  const request = `stryker-rust-plugin:${++nextImportId}`;
  const parentURL = pathToFileURL(path.join(cwd, 'package.json')).href;
  let moduleName;
  if (typeof nodeModule.registerHooks !== 'function') {
    throw new Error('Consumer-relative bare plugin imports require Node module.registerHooks; pass a resolved file URL on this Node version.');
  }
  const hook = nodeModule.registerHooks({
    resolve(candidate, context, nextResolve) {
      if (candidate === request) {
        const resolved = nextResolve(specifier, { ...context, parentURL });
        moduleName = resolved.url;
        return resolved;
      }
      return nextResolve(candidate, context);
    },
  });
  try {
    return { namespace: await import(request), moduleName };
  } finally {
    hook.deregister();
  }
}

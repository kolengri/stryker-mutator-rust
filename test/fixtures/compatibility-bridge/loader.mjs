export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'bridge-loader-dependency') {
    return { url: new URL('./loader-dependency.js', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

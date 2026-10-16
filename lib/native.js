import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let binding;
let failure;

export function platformTarget() {
  const { platform, arch } = process;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return `win32-${arch}-msvc`;
  if (platform === 'linux') {
    const glibc = process.report?.getReport().header.glibcVersionRuntime;
    return `linux-${arch}-${glibc ? 'gnu' : 'musl'}`;
  }
  return `${platform}-${arch}`;
}

export function loadNative() {
  if (binding) return binding;
  if (failure) throw failure;
  const target = platformTarget();
  const errors = [];
  for (const name of [
    `../native/stryker-rust.${target}.node`,
    `stryker-mutator-rust-${target}`,
  ]) {
    try {
      const candidate = require(name);
      if (typeof candidate.cacheKey !== 'function' || typeof candidate.analyze !== 'function') {
        throw new Error('Native binding has an incompatible API');
      }
      binding = candidate;
      return binding;
    } catch (error) {
      errors.push(error);
    }
  }
  failure = new AggregateError(errors,
    `No compatible Rust binding for ${target}. Install stryker-mutator-rust-${target} at the same version, or build this checkout with npm run build.`);
  throw failure;
}

export function nativeStatus() {
  try {
    const binding = loadNative();
    return { available: true, target: platformTarget(), napi: 8, candidateEngine: 'preview', nativeInstrumentation: typeof binding.instrumentBatch === 'function', nativeCoverage: typeof binding.coverageBatch === 'function', nativePlanning: typeof binding.planningBatch === 'function' };
  } catch (error) {
    return { available: false, target: platformTarget(), error: error.message, nativeInstrumentation: false, nativeCoverage: false, nativePlanning: false };
  }
}

export function analyze(source, fileName = 'input.js') {
  if (typeof source !== 'string' || typeof fileName !== 'string') {
    throw new TypeError('source and fileName must be strings');
  }
  return JSON.parse(loadNative().analyze(source, fileName));
}

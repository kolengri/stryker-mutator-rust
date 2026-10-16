import { mkdir, open, readFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { types } from 'node:util';
import { loadNative } from './native.js';
import { createInstrumentationStats, resolveInstrumentationThreads } from './execution.js';

const FORMAT = 5;
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_CACHE = 256 * 1024 * 1024;
const KNOWN_EXTENSIONS = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const NATIVE_EXTENSIONS = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|html?|vue|svelte)$/i;
const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/i;

// Unknown objects, executable options and accessors cannot have a safe content key.
export function serializePlain(value, seen = new Set()) {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (['string', 'boolean'].includes(typeof value)) return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', Object.is(value, -0) ? '-0' : value];
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Uncacheable value');
  if (types.isProxy(value)) throw new TypeError('Uncacheable proxy');
  seen.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) throw new TypeError('Uncacheable prototype');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Uncacheable symbol');
    if (array) {
      const length = descriptors.length.value;
      if (Object.keys(descriptors).length !== length + 1) throw new TypeError('Uncacheable sparse or custom array');
      const elements = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Uncacheable array element');
        elements.push(serializePlain(descriptor.value, seen));
      }
      return ['array', elements];
    }
    return ['object', Object.keys(descriptors).sort().map((key) => {
      if (!('value' in descriptors[key]) || !descriptors[key].enumerable) throw new TypeError('Uncacheable descriptor');
      return [key, serializePlain(descriptors[key].value, seen)];
    })];
  } finally {
    seen.delete(value);
  }
}

export async function cacheEligibility(files, options) {
  return parserEligibility(files, options, KNOWN_EXTENSIONS);
}

// Native HTML/Vue/Svelte has a bounded parser contract, but no result-cache
// identity for compiler configuration. Keep these eligibility decisions separate.
export async function nativeEligibility(files, options) {
  return parserEligibility(files, options, NATIVE_EXTENSIONS);
}

async function parserEligibility(files, options, extensions) {
  if (!Array.isArray(options?.ignorers) || !Array.isArray(options?.excludedMutations)) return false;
  if (options.ignorers?.length) return false;
  // Framework parsers may depend on external compiler versions/configuration.
  if (files.some((file) => !extensions.test(file.name))) return false;
  // TS/TSX parsing explicitly disables ambient Babel configuration upstream.
  // JS does not: dynamic Babel plugins/configuration must run on every invocation.
  const visited = new Set();
  for (const origin of [process.cwd(), ...files.filter((file) => !TYPESCRIPT.test(file.name)).map((file) => dirname(resolve(file.name)))]) {
    for (let directory = origin; !visited.has(directory); directory = dirname(directory)) {
      visited.add(directory);
      // Inspect names only: loading a Babel config here would execute user code twice.
      const names = await readdir(directory).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (names.some((name) => /^(?:\.babelrc(?:\.|$)|\.babelignore$|babel\.config\.)/.test(name))) return false;
      if (names.includes('package.json')) {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (Object.hasOwn(pkg, 'babel')) return false;
      }
      if (dirname(directory) === directory) break;
    }
  }
  return true;
}

function validResult(result, files) {
  return result && Array.isArray(result.files) && Array.isArray(result.mutants)
    && result.files.length === files.length
    && result.files.every((file, i) => file.name === files[i].name && typeof file.content === 'string')
    && result.mutants.every((mutant) => typeof mutant.id === 'string'
      && typeof mutant.fileName === 'string' && typeof mutant.replacement === 'string'
      && typeof mutant.mutatorName === 'string' && mutant.location?.start && mutant.location?.end);
}

export class InstrumentationCache {
  constructor({ cacheDir = process.env.STRYKER_RUST_CACHE_DIR || join(process.cwd(), 'node_modules/.cache/stryker-rust'), cache = true, engine = process.env.STRYKER_RUST_ENGINE ?? 'auto', onEvent = () => {}, instrumentationThreads } = {}) {
    this.instrumentationStats = createInstrumentationStats(resolveInstrumentationThreads(instrumentationThreads));
    this.directory = resolve(cacheDir);
    this.enabled = cache && process.env.STRYKER_RUST_CACHE !== '0';
    this.onEvent = onEvent;
    this.engine = engine;
    this.stats = { hits: 0, misses: 0, bypasses: 0, errors: 0, nativeBatches: 0, fallbackBatches: 0, nativeErrors: 0 };
  }

  event(type, reason) {
    this.stats[type]++;
    // Diagnostic hooks must never change mutation testing behavior.
    try { this.onEvent({ type, reason }); } catch { /* diagnostic observer */ }
  }

  async instrument(instrument, files, options) {
    if (!this.enabled) {
      this.event('bypasses', 'disabled');
      return instrument(files, options);
    }
    let native, key;
    try {
      native = loadNative();
      const serialized = serializePlain({ files, options });
      // Upstream emits directive warnings on every invocation. Conservatively
      // bypass potential directives rather than caching observable logger effects.
      if (files.some((file) => /Stryker (?:disable|restore)/.test(file.content))) {
        this.event('bypasses', 'potential Stryker directive');
        return instrument(files, options);
      }
      if (!await cacheEligibility(files, options)) {
        this.event('bypasses', 'external parser configuration or ignorer');
        return instrument(files, options);
      }
      key = native.cacheKey(JSON.stringify({ format: FORMAT, engine: this.engine, implementation: '0.1.0', upstream: '10.0.0', cwd: process.cwd(), node: process.versions.node, env: { babel: process.env.BABEL_ENV, node: process.env.NODE_ENV }, input: serialized }));
    } catch {
      this.event('bypasses', 'native binding or cache eligibility unavailable');
      return instrument(files, options);
    }
    const path = join(this.directory, `${key}.bin`);
    try {
      if ((await stat(path)).size <= MAX_ENTRY) {
        const record = deserialize(await readFile(path));
        if (record.format === FORMAT && record.key === key && Buffer.isBuffer(record.payload)
          && createHash('sha256').update(record.payload).digest('hex') === record.integrity) {
          const result = deserialize(record.payload);
          if (validResult(result, files)) {
            this.event('hits');
            return result;
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.event('errors', 'cache read failed');
    }
    this.event('misses');
    // Cache only instrumentation, never test outcomes. All tests still execute.
    const result = await instrument(files, options);
    let temporary;
    try {
      // V8 serialization preserves own properties whose value is undefined.
      const payload = serialize(result);
      const record = serialize({ format: FORMAT, key, integrity: createHash('sha256').update(payload).digest('hex'), payload });
      if (Buffer.byteLength(record) > MAX_ENTRY) return result;
      await mkdir(dirname(path), { recursive: true });
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(record); } finally { await file.close(); }
      await rename(temporary, path);
      await this.prune();
    } catch {
      this.event('errors', 'cache write failed');
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
    return result;
  }

  async prune() {
    const entries = await Promise.all((await readdir(this.directory))
      .filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))
      .map(async (name) => {
        const path = join(this.directory, name);
        try { return { path, ...await stat(path) }; } catch { return undefined; }
      }));
    const files = entries.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= MAX_CACHE) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }
}

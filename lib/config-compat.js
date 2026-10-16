// Only executable extraction and descriptor-safe transport live here. File
// selection, merge, defaults, validation and execution belong to Rust.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { strykerCoreSchema } from '@stryker-mutator/api/core';
import { StrykerError } from '@stryker-mutator/util';

const stringify = JSON.stringify;
const descriptors = Object.getOwnPropertyDescriptors;
const prototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isProxy = types.isProxy;
const extensible = Object.isExtensible;

export class UnsupportedConfigCapability extends Error {
  constructor(message) {
    super(`Unsupported executable configuration capability: ${message}`);
    this.name = 'UnsupportedConfigCapability';
  }
}

/** Read descriptors into an ordered JSON representation, never stringify user objects. */
export function configDataJson(value, nullPrototypes = []) {
  const seen = new WeakSet();
  let nodes = 0;
  function encode(value, path, depth, keysPath) {
    if (++nodes > 100000 || depth > 128) throw new UnsupportedConfigCapability(`${path}: graph exceeds the bounded data transport`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return stringify(value);
    if (typeof value !== 'object') throw new UnsupportedConfigCapability(`${path}: ${typeof value} is not represented (including undefined)`);
    if (isProxy(value)) throw new UnsupportedConfigCapability(`${path}: Proxy is not represented`);
    if (seen.has(value)) throw new UnsupportedConfigCapability(`${path}: cycles and shared object references are not represented`);
    seen.add(value);
    const array = Array.isArray(value);
    const proto = prototype(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      throw new UnsupportedConfigCapability(`${path}: custom prototype is not represented`);
    }
    if (!array && proto === null) nullPrototypes.push(keysPath);
    if (!extensible(value)) throw new UnsupportedConfigCapability(`${path}: nonextensible data is not represented`);
    const fields = descriptors(value);
    const keys = ownKeys(fields);
    if (keys.some((key) => typeof key === 'symbol')) throw new UnsupportedConfigCapability(`${path}: symbol keys are not represented`);
    const parts = [];
    for (const key of keys) {
      if (array && key === 'length') {
        if (!fields.length.writable) throw new UnsupportedConfigCapability(`${path}: readonly array length is not represented`);
        continue;
      }
      const field = fields[key];
      if (!('value' in field)) throw new UnsupportedConfigCapability(`${path}.${key}: nested accessor is not represented`);
      if (!field.writable || !field.configurable) throw new UnsupportedConfigCapability(`${path}.${key}: readonly or nonconfigurable data is not represented`);
      if (!field.enumerable) throw new UnsupportedConfigCapability(`${path}.${key}: nested nonenumerable property is not represented`);
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) !== parts.length)) {
        throw new UnsupportedConfigCapability(`${path}: sparse arrays and extra array properties are not represented`);
      }
      const child = encode(field.value, `${path}.${key}`, depth + 1, [...keysPath, key]);
      parts.push(array ? child : `${stringify(key)}:${child}`);
    }
    if (array && parts.length !== fields.length.value) throw new UnsupportedConfigCapability(`${path}: sparse array is not represented`);
    return array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
  }
  return encode(value, 'config', 0, []);
}

class ConfigReaderError extends StrykerError {
  constructor(message, name, cause) {
    super(`Invalid config file "${name}". ${message}`, cause);
    if (cause !== undefined) this.cause = cause;
  }
}

/** One exact file URL import in the original Node environment and module cache. */
export async function loadConfigDefault(path, name) {
  let namespace;
  try {
    namespace = await import(pathToFileURL(resolve(path)).toString());
  } catch (cause) {
    throw new ConfigReaderError('Error during import', name, cause);
  }
  if (!namespace || typeof namespace !== 'object' || !('default' in namespace)) {
    throw new ConfigReaderError('Config file must have a default export!', name);
  }
  const options = namespace.default;
  if (typeof options !== 'object') throw new ConfigReaderError('Default export of config file must be an object!', name);
  // Box the default: an async return must not assimilate exported Promises/thenables.
  return { options };
}

/** Eligibility only: do not execute root getters in the adapter error stage. */
export function rootConfigUnsupportedReason(options) {
  return options !== null && isProxy(options)
    ? 'Unsupported executable configuration capability: root Proxy is not represented'
    : undefined;
}

/** User execution stage. Its exceptions must never be inspected/classified. */
export function spreadConfig(options) { return { ...options }; }

export async function importConfig(path, name) {
  const { options } = await loadConfigDefault(path, name);
  const reason = rootConfigUnsupportedReason(options);
  if (reason) throw new UnsupportedConfigCapability('root Proxy is not represented');
  const extracted = spreadConfig(options);
  return { extracted, json: configDataJson(extracted) };
}

/** Only this descriptor-only stage can classify an adapter-owned rejection. */
export function projectConfigData(value) {
  try {
    const nullPrototypes = [];
    return { json: configDataJson(value, nullPrototypes), nullPrototypes: stringify(nullPrototypes) };
  }
  catch (error) {
    if (error instanceof UnsupportedConfigCapability) return { reason: error.message };
    throw error;
  }
}

export function callerCoreSchemaJson() { return configDataJson(strykerCoreSchema); }

/** Rust chooses these exact pinned modules only after core option validation. */
export async function loadCallerMetadata(modules) {
  const plugins = [];
  for (const specifier of modules) {
    const namespace = await import(specifier);
    plugins.push(namespace.strykerValidationSchema);
  }
  return { core: strykerCoreSchema, plugins };
}

export async function callerMetadataJson(modules) { return configDataJson(await loadCallerMetadata(modules)); }
export function callerCoreSchema() { return strykerCoreSchema; }

// Interpret only native-authored writes/deletes against the retained root. Paths
// follow preceding replacements, so detached export objects stay detached.
const ownDescriptor = Object.getOwnPropertyDescriptor;
const set = Reflect.set;
const remove = Reflect.deleteProperty;
export function applyConfigEffects(root, receipt) {
  const { version, operations } = JSON.parse(receipt);
  if (version !== 1 || !Array.isArray(operations)) throw new Error('Invalid native config effect receipt');
  for (const { kind, path, key, value } of operations) {
    let target = root;
    for (const part of path) {
      const field = ownDescriptor(target, part);
      if (!field || !('value' in field)) throw new Error('Native config effect path is no longer data');
      target = field.value;
    }
    const applied = kind === 'set' ? set(target, key, value) : kind === 'delete' ? remove(target, key) : false;
    if (!applied) throw new Error('Cannot apply native config effect');
  }
}

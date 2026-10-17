import { loadNative } from './native.js';
import { serializePlain } from './cache.js';

const engines = new WeakMap();
function encode(value) {
  serializePlain(value);
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('ETA input must be plain JSON data');
  return json;
}

/** Identity components must cover all actual inputs; no file discovery or telemetry. */
export function createEtaIdentity(components) {
  const binding = loadNative();
  if (typeof binding.etaIdentity !== 'function') throw new Error('Installed Rust addon does not support ETA');
  return binding.etaIdentity(encode(components));
}

/** Scopes execute sequentially. All durations and event times use milliseconds. */
export class CampaignEta {
  constructor(options) {
    const binding = loadNative();
    if (typeof binding.EtaEngine !== 'function') throw new Error('Installed Rust addon does not support ETA');
    engines.set(this, new binding.EtaEngine(encode(options)));
  }
  record(event) { return JSON.parse(engines.get(this).record(encode(event))); }
  snapshot(atMs) { return JSON.parse(engines.get(this).snapshot(atMs)); }
  history(nowUnixMs) { return JSON.parse(engines.get(this).history(nowUnixMs)); }
}

// Internal handshake; ownership remains in Rust through native cleanup.
export function attachNativeEta(preparation, campaign, scopeId) {
  const engine = engines.get(campaign);
  if (!engine || typeof preparation.trackEta !== 'function') throw new TypeError('Native ETA requires a CampaignEta and an ETA-capable addon');
  preparation.trackEta(engine, scopeId);
}

export function formatEta(estimate) {
  const time = (ms) => ms < 1000 ? '<1s' : ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : ms < 3_600_000 ? `${Math.ceil(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
  if (estimate.state === 'complete') return 'ETA complete';
  if (estimate.remainingMs === null) {
    if (estimate.knownRemainingMs === 0) return `ETA ${estimate.state}: total unknown`;
    return `ETA ${estimate.state}: ${time(estimate.knownRemainingMs)} modeled work; total unknown`;
  }
  return `ETA ~${time(estimate.remainingMs)} (${time(estimate.range.lowerMs)}–${time(estimate.range.upperMs)}; heuristic)`;
}

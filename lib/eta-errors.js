// Advisory failures can be arbitrary thrown values, including hostile accessors.
export function etaErrorMessage(error) {
  try {
    const message = error?.message;
    if (typeof message === 'string') return message;
  } catch { /* Fall back without trusting Error-like objects. */ }
  try { return String(error); }
  catch { return 'Unknown ETA observer failure'; }
}

export function invokeEtaCallback(callback, value) {
  const returned = callback?.(value);
  if (returned?.then) {
    // Consume asynchronous rejection even though this API requires sync callbacks.
    Promise.prototype.then.call(Promise.resolve(returned), undefined, () => {});
    throw new TypeError('ETA callbacks must be synchronous');
  }
}

export function resolveInstrumentationThreads(option) {
  let value = option;
  if (value === undefined) {
    const environment = process.env.STRYKER_RUST_THREADS;
    if (environment === undefined || environment === '') return undefined;
    if (!/^[0-9]+$/.test(environment)) throw new TypeError('STRYKER_RUST_THREADS must be a positive decimal safe integer');
    value = Number(environment);
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${option === undefined ? 'STRYKER_RUST_THREADS' : 'instrumentationThreads'} must be a positive safe integer`);
  }
  return value;
}

export function createInstrumentationStats(configuredThreads) {
  return { configuredThreads, parallelBatches: 0, serialBatches: 0, serialRecoveries: 0,
    lastThreadsUsed: 0, lastSpawnedThreads: 0, lastParallelFiles: 0 };
}

function valid(condition) {
  if (!condition) throw new TypeError('Invalid native execution metadata');
}

export function executionMetadata(response, fileCount, configuredThreads) {
  if (!Object.hasOwn(response, 'execution')) {
    return { threadsUsed: fileCount === 0 ? 0 : 1, spawnedThreads: 0, parallelFiles: 0,
      serialRecoveries: 0, reason: 'Native execution information unavailable (legacy addon)' };
  }
  const execution = response.execution;
  const fields = ['threadsUsed', 'spawnedThreads', 'parallelFiles', 'serialRecoveries'];
  valid(execution !== null && typeof execution === 'object' && !Array.isArray(execution));
  valid(Object.keys(execution).every((key) => fields.includes(key) || key === 'reason'));
  for (const field of fields) {
    valid(Object.hasOwn(execution, field) && Number.isSafeInteger(execution[field])
      && execution[field] >= 0 && !Object.is(execution[field], -0));
  }
  valid(!Object.hasOwn(execution, 'reason') || typeof execution.reason === 'string');
  const { threadsUsed, spawnedThreads, parallelFiles, serialRecoveries } = execution;
  const capacity = Math.min(configuredThreads ?? fileCount, fileCount);
  valid(threadsUsed <= capacity && spawnedThreads <= Math.max(0, capacity - 1));
  valid(parallelFiles <= fileCount && serialRecoveries <= 1);
  if (fileCount === 0) {
    valid(threadsUsed === 0 && spawnedThreads === 0 && parallelFiles === 0 && serialRecoveries === 0);
  } else {
    valid(threadsUsed >= 1 && threadsUsed <= spawnedThreads + 1);
    valid(threadsUsed <= 1 || parallelFiles > 0);
    valid(parallelFiles === 0 || (fileCount > 1 && spawnedThreads > 0 && parallelFiles >= threadsUsed));
    valid(serialRecoveries === 0 || (threadsUsed === 1 && parallelFiles === 0));
    if (fileCount === 1) valid(spawnedThreads === 0 && parallelFiles === 0 && serialRecoveries === 0);
  }
  return execution;
}

export function recordExecution(stats, execution) {
  const { threadsUsed, spawnedThreads, parallelFiles, serialRecoveries, reason } = execution;
  stats[threadsUsed > 1 && parallelFiles > 0 ? 'parallelBatches' : 'serialBatches']++;
  stats.serialRecoveries += serialRecoveries;
  stats.lastThreadsUsed = threadsUsed;
  stats.lastSpawnedThreads = spawnedThreads;
  stats.lastParallelFiles = parallelFiles;
  if (reason === undefined) delete stats.lastReason;
  else stats.lastReason = reason;
}

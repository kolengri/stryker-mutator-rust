#!/usr/bin/env node
import { nativeStatus } from '../lib/native.js';

if (process.argv[2] === '--rust-info') {
  console.log(JSON.stringify(nativeStatus(), null, 2));
} else if (process.env.STRYKER_RUST_COORDINATOR_ENGINE === 'native') {
  const { runNativeMutationTest } = await import('../lib/runtime.js');
  const { CampaignEta, formatEta } = await import('../lib/eta.js');
  const args = process.argv.slice(2);
  if (args[0] === 'run') args.shift();
  process.title = 'stryker-rust';
  const controller = new AbortController();
  let interruptedExitCode = 130;
  const interrupt = () => controller.abort();
  const terminate = () => { interruptedExitCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const eta = process.env.STRYKER_RUST_ETA === '1' ? {
      campaign: new CampaignEta({ scopes: [{ id: 'run' }] }), scopeId: 'run', intervalMs: 10_000,
      onEstimate: (estimate) => console.error(`[stryker-rust] ${formatEta(estimate)}`),
    } : undefined;
    const result = await runNativeMutationTest({ args }, { signal: controller.signal, eta });
    if (!result.supported) {
      console.error(`[stryker-rust] Native coordinator does not support this run: ${result.reason}`);
      process.exitCode = 2;
    } else {
      process.exitCode = result.exitCode;
      if (process.env.STRYKER_RUST_DIAGNOSTICS === '1') console.error(`[stryker-rust] ${JSON.stringify(result.stats)}`);
    }
  } catch (error) {
    console.error(`[stryker-rust] ${error.message}`);
    process.exitCode = controller.signal.aborted ? interruptedExitCode : 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} else {
  if (process.env.STRYKER_RUST_COORDINATOR_ENGINE !== undefined && process.env.STRYKER_RUST_COORDINATOR_ENGINE !== 'upstream') {
    throw new Error('STRYKER_RUST_COORDINATOR_ENGINE must be native or upstream');
  }
  const [{ installAcceleration }, { StrykerCli }] = await Promise.all([
    import('../lib/index.js'),
    import('@stryker-mutator/core'),
  ]);
  const argv = process.argv.filter((argument, i) => i < 2 || argument !== '--rust-no-cache');
  const cache = installAcceleration({ cache: !process.argv.includes('--rust-no-cache') });
  if (process.env.STRYKER_RUST_DIAGNOSTICS === '1') {
    process.on('exit', () => console.error(`[stryker-rust] ${JSON.stringify({ ...cache.stats, core: cache.coreStats, instrumentation: cache.instrumentationStats })}`));
  }
  process.title = 'stryker-rust';
  new StrykerCli(argv).run();
}

#!/usr/bin/env node
import { installAcceleration, nativeStatus } from '../lib/index.js';
import { StrykerCli } from '@stryker-mutator/core';

if (process.argv[2] === '--rust-info') {
  console.log(JSON.stringify(nativeStatus(), null, 2));
} else {
  const argv = process.argv.filter((argument, i) => i < 2 || argument !== '--rust-no-cache');
  const cache = installAcceleration({ cache: !process.argv.includes('--rust-no-cache') });
  if (process.env.STRYKER_RUST_DIAGNOSTICS === '1') {
    process.on('exit', () => console.error(`[stryker-rust] ${JSON.stringify({ ...cache.stats, core: cache.coreStats })}`));
  }
  process.title = 'stryker-rust';
  new StrykerCli(argv).run();
}

// Explicit, single local archive smoke. Never installs, publishes or builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('.');
const output = join(root, 'artifacts/package/local');
const artifacts = join(root, 'artifacts/eta-release/repairs-r1');
await mkdir(artifacts, { recursive: true });
// Do not overwrite an unrelated existing package staging directory.
await assert.rejects(access(output), (error) => error.code === 'ENOENT');
const extracted = await mkdtemp(join(artifacts, 'archive-'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
};
try {
  run(process.execPath, ['scripts/package.js', 'local']);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.packages.length, 1);
  const archive = join(output, manifest.packages[0].file);
  const files = run('tar', ['-tzf', archive]).trim().split('\n');
  assert.ok(files.includes('package/docs/eta.md'));
  run('tar', ['-xzf', archive, '-C', extracted]);
  const readme = await readFile(join(extracted, 'package/README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/eta\.md\)/);
  const doc = await readFile(join(extracted, 'package/docs/eta.md'), 'utf8');
  assert.match(doc, /CampaignEta/);
  assert.equal(doc, await readFile('docs/eta.md', 'utf8'), 'the actual archived link target must match the current source');
  const retained = join(artifacts, manifest.packages[0].file);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await rename(archive, retained);
  await writeFile(join(artifacts, 'archive-receipt.json'), JSON.stringify({
    archive: retained, sha256, actualArchiveFiles: files, readmeLink: 'docs/eta.md',
    documentationSha256: createHash('sha256').update(doc).digest('hex'),
    profile: 'existing debug macOS addon; no release/platform claim',
  }, null, 2));
  console.log(JSON.stringify({ archive: retained, sha256, linkedDocumentationPresent: true }));
} finally {
  await rm(extracted, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
}

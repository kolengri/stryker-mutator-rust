import { spawnSync } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, rm, access, readdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { targets } from './targets.js';
import { platformTarget } from '../lib/native.js';

const mode = process.argv[2] || 'local';
if (!['local', 'release'].includes(mode)) throw new Error('Use local or release');
const root = resolve('.');
const output = join(root, 'artifacts/package', mode);
await mkdir(output, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const selected = mode === 'local' ? targets.filter((t) => t.name === platformTarget()) : targets;
if (!selected.length) throw new Error('No native distribution target for this host');
// Refuse incomplete release bundles. Merely declaring optional packages is insufficient.
for (const target of selected) await access(join(root, `native/stryker-rust.${target.name}.node`));
const stage = join(output, 'stage');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const path of ['lib', 'bin', 'LICENSE', 'NOTICE', 'README.md']) await cp(join(root, path), join(stage, path), { recursive: true });
const manifest = { ...pkg };
delete manifest.devDependencies;
delete manifest.napi;
delete manifest.scripts;
const packages = [];
async function distributionModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await distributionModes(path);
    else await chmod(path, entry.name === 'stryker-rust.js' ? 0o755 : 0o644);
  }
}
const pack = async (directory) => {
  await distributionModes(directory);
  // npm pack does not need a compiler and does not run package lifecycle scripts.
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: directory, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  // npm <= 11 emits an array; npm 12 keys pack results by package name.
  const info = Array.isArray(report) ? report[0] : report[pkg.name] ?? Object.values(report)[0];
  if (!info?.filename || !Array.isArray(info.files)) throw new Error('Unexpected npm pack JSON response');
  const archive = join(output, info.filename);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  packages.push({ file: info.filename, sha256, size: info.size, files: info.files.map((f) => f.path) });
};
if (mode === 'local') {
  manifest.os = [selected[0].os];
  manifest.cpu = [selected[0].cpu];
  if (selected[0].libc) manifest.libc = [selected[0].libc];
  await mkdir(join(stage, 'native'), { recursive: true });
  await cp(join(root, `native/stryker-rust.${selected[0].name}.node`), join(stage, `native/stryker-rust.${selected[0].name}.node`));
} else {
  manifest.optionalDependencies = {};
  for (const target of selected) {
    const name = `${pkg.name}-${target.name}`;
    const directory = join(output, target.name);
    await mkdir(directory, { recursive: true });
    await cp(join(root, `native/stryker-rust.${target.name}.node`), join(directory, 'binding.node'));
    await cp(join(root, 'LICENSE'), join(directory, 'LICENSE'));
    await cp(join(root, 'NOTICE'), join(directory, 'NOTICE'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: pkg.version, description: `Native ${target.name} binding for ${pkg.name}`, license: pkg.license, main: 'binding.node', files: ['binding.node', 'LICENSE', 'NOTICE'], os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}), engines: pkg.engines }, null, 2));
    manifest.optionalDependencies[name] = pkg.version;
    await pack(directory);
  }
}
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
await pack(stage);
await writeFile(join(output, 'manifest.json'), JSON.stringify({ version: pkg.version, mode, target: mode === 'local' ? platformTarget() : 'all', packages }, null, 2));
console.log(JSON.stringify({ directory: output, packages: packages.map(({ file, sha256, size }) => ({ file, sha256, size })) }, null, 2));

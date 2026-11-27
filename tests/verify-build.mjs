// Run from an installed checkout with `pnpm verify:build`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { verifyApprovedFeature } from './verify-apply.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(temp, 'Packsmith 构建 '));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
const resources = [
  ['config/fixture-common.json', 'overrides', 'common'],
  ['config/fixture-client.json', 'client-overrides', 'client'],
  ['config/fixture-server.json', 'server-overrides', 'server']
];

async function createTarget(loader, version) {
  const id = `${loader}-fixture`;
  const target = { id, path: `packs/${id}`, artifacts: ['modrinth', 'serverpack'] };
  const dir = path.join(root, target.path);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, 'pakku.json'), { name: id, version: '1.0.0', overrides: ['config'] });
  await writeJson(path.join(dir, 'pakku-lock.json'), {
    target: 'modrinth', mc_versions: ['1.21.1'], loaders: { [loader]: version }, lockfile_version: 2
  });
  for (const [gamePath, folder, side] of resources) {
    const file = side === 'common' ? path.join(dir, gamePath) : path.join(dir, '.pakku', folder, gamePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJson(file, { target: id, side });
  }
  await fs.writeFile(path.join(dir, 'config', `target-probe-${id}.txt`), id);
  return target;
}

function cli(...args) {
  return execFileSync(process.execPath, [path.join(root, 'tools/mp.mjs'), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit']
  });
}

async function snapshot(directory) {
  const hashes = {};
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      hashes[path.relative(directory, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  return hashes;
}

async function verifyArtifacts(target, loader, version) {
  const dir = path.join(root, 'dist', target.id);
  const files = (await fs.readdir(dir, { recursive: true })).filter(name => /\.(mrpack|zip)$/.test(name));
  assert.equal(files.length, 2, `产物数量与预期不符: ${dir}`);
  for (const suffix of ['.mrpack', '.zip']) {
    const file = files.find(name => name.endsWith(suffix));
    assert.ok(file, `缺少 ${target.id} 的 ${suffix} 产物`);
    const entries = unzipSync(await fs.readFile(path.join(dir, file)));
    const mrpack = suffix === '.mrpack';
    if (mrpack) {
      const index = JSON.parse(Buffer.from(entries['modrinth.index.json']).toString('utf8'));
      assert.equal(index.game, 'minecraft');
      assert.equal(index.formatVersion, 1);
      assert.deepEqual(index.dependencies, { minecraft: '1.21.1', [loader]: version });
    }
    for (const [gamePath, folder, side] of resources) {
      const source = side === 'common' ? gamePath : path.join('.pakku', folder, gamePath);
      const expected = await fs.readFile(path.join(root, target.path, source));
      const matching = Object.keys(entries).filter(key => key === gamePath || key.endsWith('/' + gamePath));
      if (!mrpack && side === 'client') {
        assert.deepEqual(matching, [], '服务端 ZIP 混入客户端文件');
      } else {
        const key = mrpack ? `${folder}/${gamePath}` : gamePath;
        assert.deepEqual(matching, [key], `侧别不正确: ${gamePath}`);
        assert.deepEqual(Buffer.from(entries[key]), expected, `覆盖内容不正确: ${key}`);
      }
    }
    const probes = Object.keys(entries).filter(name => path.posix.basename(name).startsWith('target-probe-'));
    const probe = (mrpack ? 'overrides/' : '') + `config/target-probe-${target.id}.txt`;
    assert.deepEqual(probes, [probe], '构建混入了其他 Target 的文件');
  }
}

try {
  for (const name of ['tools', 'package.json', 'toolchain.json']) {
    await fs.cp(path.join(repo, name), path.join(root, name), { recursive: true });
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { pakku } = await readJson(path.join(root, 'toolchain.json'));
  const cached = `.cache/pakku-${pakku.version}.jar`;
  await fs.mkdir(path.join(root, '.cache'));
  try {
    await fs.copyFile(path.join(repo, cached), path.join(root, cached));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  cli('bootstrap');

  const workspaceFile = path.join(root, 'workspace.json');
  const primary = await createTarget('fabric', '0.16.14');
  await writeJson(workspaceFile, { targets: [primary] });
  assert.ok(cli('targets').includes(primary.id));
  const packs = path.join(root, 'packs');
  const singleBefore = await snapshot(packs);
  cli('check');
  cli('build');
  await verifyArtifacts(primary, 'fabric-loader', '0.16.14');
  assert.deepEqual(await snapshot(packs), singleBefore, '单 Target 检查或构建改动了源文件');
  console.log('单 Target 的默认选择、MRPACK 与服务端 ZIP 验证通过。');

  // Keep the first build apart so it cannot satisfy checks on the next one.
  await fs.rename(path.join(root, 'dist'), path.join(root, 'single-target-dist'));
  const other = await createTarget('neoforge', '21.1.172');
  await writeJson(workspaceFile, { targets: [primary, other] });
  const listing = cli('targets');
  assert.ok(listing.includes(primary.id) && listing.includes(other.id));
  const multiBefore = await snapshot(packs);
  for (const target of [primary, other]) {
    cli('check', '--target', target.id);
    cli('build', '--target', target.id);
  }
  await verifyArtifacts(primary, 'fabric-loader', '0.16.14');
  await verifyArtifacts(other, 'neoforge', '21.1.172');
  assert.deepEqual(await snapshot(packs), multiBefore, '双 Target 检查或构建改动了源文件');
  console.log('双 Target 的显式选择、Loader、覆盖文件侧别和产物隔离验证通过。');
  await verifyApprovedFeature(root, primary, other);
} finally {
  assert.equal(path.dirname(root), temp);
  await fs.rm(root, { recursive: true, force: true });
}

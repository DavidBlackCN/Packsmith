import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function put(root, relative, bytes) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

async function fileHashes(root) {
  const result = {};
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, file).split(path.sep).join('/');
    result[relative] = sha256(await fs.readFile(file));
  }
  return result;
}

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temp, 'Packsmith 采集 '));
  t.after(async () => {
    assert.equal(path.dirname(base), temp);
    await fs.rm(base, { recursive: true, force: true });
  });
  const project = path.join(base, '模板');
  const game = path.join(base, '开发实例');
  await fs.cp(path.join(repo, 'tools'), path.join(project, 'tools'), { recursive: true });
  await fs.copyFile(path.join(repo, 'package.json'), path.join(project, 'package.json'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.join(repo, 'node_modules'), path.join(project, 'node_modules'), linkType);
  await fs.mkdir(game);
  const current = path.join(project, '.intake/current');
  const manifest = async () => JSON.parse(await fs.readFile(path.join(current, 'manifest.json'), 'utf8'));
  // 临时模板中没有 workspace.json、Pakku 工具链、JAR 缓存或任何绑定记录。
  const offline = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = () => { throw Error('offline fixture'); }");
  const intake = (source = game, ...args) => exec(process.execPath, ['--import', offline, 'tools/mp.mjs', 'intake', source, ...args], {
    cwd: project, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PACKSMITH_JAVA: path.join(base, 'java-not-installed') },
  });
  return { base, game, current, linkType, manifest, intake };
}

function fabricJar(id, version) {
  const metadata = { schemaVersion: 1, id, name: id, version, depends: { minecraft: '1.21.1' } };
  return zipSync({ 'fabric.mod.json': strToU8(JSON.stringify(metadata)) });
}

test('无基线混合实例离线采集，保留重复和禁用状态，仅保存供审查的小文本', async t => {
  const { base, game, current, linkType, manifest, intake } = await fixture(t);
  const jar = fabricJar('demo_mod', '1.0.0');
  const script = 'kubejs/server_scripts/recipe.js';
  const craftTweaker = 'scripts/recipe.zs';
  const data = 'datapacks/recipes/data/demo/recipe/food.json';
  const config = 'config/demo.toml';
  const resource = 'resourcepacks/素材/assets/demo/textures/large.png';
  const inputs = {
    'mods/renamed.jar': jar,
    'mods/copy.jar': jar,
    'mods/old.jar.disabled': fabricJar('older_mod', '0.1.0'),
    'mods/local.jar': zipSync({ 'example.txt': strToU8('local unknown') }),
    [config]: 'bonus = 3',
    'defaultconfigs/demo-server.toml': 'chance = 1',
    [script]: "throw Error('只供静态审查');",
    [craftTweaker]: '// 自定义合成',
    [data]: '{"type":"minecraft:crafting_shapeless"}',
    [resource]: Buffer.alloc(300 * 1024, 0x83),
    'config/.env': 'AUTH_SECRET=fixture-private-value',
    'saves/world/level.dat': 'world state',
    'logs/latest.log': 'test log',
    'options.txt': 'personal options',
  };
  for (const [name, bytes] of Object.entries(inputs)) await put(game, name, bytes);
  const outside = path.join(base, '外部目录');
  await put(outside, 'hidden.js', 'private external script');
  await fs.symlink(outside, path.join(game, 'kubejs/server_scripts/linked'), linkType);
  const before = await fileHashes(game);
  await intake();
  assert.deepEqual(await fileHashes(game), before);

  const scan = await manifest();
  assert.equal(scan.schema, 1);
  assert.ok(scan.scanId && scan.source && Number.isFinite(Date.parse(scan.scannedAt)));
  assert.ok(Array.isArray(scan.issues));
  const byPath = new Map(scan.items.map(item => [item.path, item]));
  assert.equal(byPath.size, scan.items.length);
  const expected = ['mods/renamed.jar', 'mods/copy.jar', 'mods/old.jar.disabled', 'mods/local.jar',
    config, 'defaultconfigs/demo-server.toml', script, craftTweaker, data, resource];
  assert.deepEqual([...byPath.keys()].sort(), expected.sort());
  for (const item of scan.items) {
    assert.equal(item.sha256, before[item.path], item.path);
    assert.equal(item.size, Buffer.byteLength(inputs[item.path]), item.path);
  }
  const copies = [byPath.get('mods/renamed.jar'), byPath.get('mods/copy.jar')];
  const original = copies.find(item => !item.duplicateOf);
  const duplicate = copies.find(item => item.duplicateOf);
  assert.equal(duplicate.duplicateOf, original.path);
  assert.ok(copies.every(item => item.enabled));
  assert.equal(original.jar.mods[0].id, 'demo_mod');
  assert.equal(original.jar.mods[0].version, '1.0.0');
  const disabled = byPath.get('mods/old.jar.disabled');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.jar.mods[0].id, 'older_mod');
  assert.deepEqual(byPath.get('mods/local.jar').jar.mods, []);

  const snapshots = [script, craftTweaker, data];
  for (const name of snapshots) {
    assert.equal(byPath.get(name).snapshot, 'files/' + name);
    assert.equal(await fs.readFile(path.join(current, 'files', name), 'utf8'), inputs[name]);
  }
  assert.deepEqual(Object.keys(await fileHashes(path.join(current, 'files'))).sort(), snapshots.sort());
  assert.equal(scan.stats.snapshots, snapshots.length);
  assert.equal(scan.stats.duplicates, 1);
  assert.ok(scan.stats.filesHashed >= expected.length);
  assert.ok(scan.stats.bytesRead >= scan.items.reduce((sum, item) => sum + item.size, 0));
  assert.ok(scan.stats.elapsedMs >= 0);
  const report = await fs.readFile(path.join(current, 'report.md'), 'utf8');
  assert.match(report, /JAR|Mod|模组/i);
  assert.ok(!report.includes('fixture-private-value'));
});

test('失败保留整份 current，成功重扫移除上次快照', async t => {
  const { base, game, current, intake, manifest } = await fixture(t);
  await put(game, 'scripts/first.zs', '// first');
  await intake();
  const original = await manifest();
  const before = await fileHashes(current);
  await assert.rejects(intake(path.join(base, '不存在的实例')));
  assert.deepEqual(await fileHashes(current), before);

  await fs.unlink(path.join(game, 'scripts/first.zs'));
  await put(game, 'scripts/second.zs', '// second');
  const result = await intake();
  const next = await manifest();
  assert.notEqual(next.scanId, original.scanId);
  assert.deepEqual(next.items.map(item => item.path), ['scripts/second.zs']);
  assert.deepEqual(await fileHashes(path.join(current, 'files')), { 'scripts/second.zs': sha256('// second') });
  assert.match(result.stdout + result.stderr, /替换|覆盖|replace/i);
});

test('--world 仅读取指定存档的数据包，选错存档时保留上次结果', async t => {
  const { game, current, intake, manifest } = await fixture(t);
  const chosen = 'saves/南方 世界/datapacks/demo/pack.mcmeta';
  await put(game, chosen, '{"pack":{"pack_format":48,"description":"demo"}}');
  await put(game, 'saves/北方/datapacks/test/pack.mcmeta', '{"pack":{"description":"other"}}');
  await put(game, 'saves/南方 世界/region/r.0.0.mca', 'region data');
  await put(game, 'saves/南方 世界/serverconfig/example.toml', 'world_specific = true');
  const before = await fileHashes(game);
  await intake();
  assert.deepEqual((await manifest()).items, []);

  await intake(game, '--world', '南方 世界');
  const scan = await manifest();
  assert.equal(scan.world, '南方 世界');
  assert.deepEqual(scan.items.map(item => item.path), [chosen]);
  assert.equal(scan.items[0].kind, 'datapack');
  assert.equal(scan.items[0].sha256, before[chosen]);
  const saved = await fileHashes(current);
  await assert.rejects(intake(game, '--world', '不存在的世界'));
  assert.deepEqual(await fileHashes(current), saved);
  assert.deepEqual(await fileHashes(game), before);
});

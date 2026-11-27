import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { inspectJar } from '../tools/lib/intake-jar.mjs';
import { scanInstance } from '../tools/lib/intake-scan.mjs';

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 采集 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'instance'), stage = path.join(root, 'stage');
  await fs.mkdir(source);
  await fs.mkdir(stage);
  const put = async (relative, bytes) => {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  return { root, source, stage, put };
}

test('按原路径分类并按哈希关联；重复 JAR 只读取一份元数据', async t => {
  const { source, stage, put } = await fixture(t);
  const jar = zipSync({ 'fabric.mod.json': Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'demo', version: '1.0.0' })) });
  const js = Buffer.from('// 开发记录\n');
  const config = Buffer.from('[config]\n');
  const active = await put('mods/active.jar', jar);
  await fs.link(active, path.join(source, 'mods/renamed.jar.disabled'));
  await put('config/main.toml', config);
  await put('kubejs/server_scripts/first.js', js);
  await put('scripts/later.zs', js);
  await put('mods/unused.txt', 'launcher note');
  await put('kubejs/logs/latest.log', 'log entry');
  await put('saves/another/region/world.mca', 'world');
  const handle = await fs.open(active);
  let jarReads;
  try { jarReads = (await inspectJar(handle, jar.byteLength)).readBytes; }
  finally { await handle.close(); }
  const { items, issues, stats } = await scanInstance(source, stage);
  assert.deepEqual(issues, []);
  assert.deepEqual(items.map(item => item.path), [
    'config/main.toml', 'kubejs/server_scripts/first.js', 'mods/active.jar', 'mods/renamed.jar.disabled', 'scripts/later.zs'
  ]);
  const [cfg, script, enabled, disabled, duplicate] = items;
  assert.equal(cfg.kind, 'config');
  assert.equal(cfg.snapshot, undefined);
  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, false);
  assert.equal(enabled.jar.mods[0].id, 'demo');
  assert.equal(disabled.duplicateOf, enabled.path);
  assert.deepEqual(disabled.jar, enabled.jar);
  assert.equal(enabled.snapshot, undefined);
  assert.equal(duplicate.duplicateOf, script.path);
  assert.equal(duplicate.snapshot, script.snapshot);
  assert.equal(script.snapshot, 'files/kubejs/server_scripts/first.js');
  assert.deepEqual(await fs.readFile(path.join(stage, script.snapshot)), js);
  assert.equal(script.sha256, createHash('sha256').update(js).digest('hex'));
  assert.equal(stats.filesHashed, 5);
  assert.equal(stats.bytesRead, jar.byteLength * 2 + js.length * 2 + config.length + jarReads);
  assert.equal(stats.duplicates, 2);
  assert.equal(stats.snapshots, 1);
});

test('资源目录保留内部路径，归档、大文本和非文本只记元信息，屏蔽私密内容', async t => {
  const { source, stage, put } = await fixture(t);
  const texture = 'resourcepacks/本地包/assets/demo/textures/test.png';
  const lang = 'resourcepacks/本地包/assets/demo/lang/zh_cn.json';
  const localZip = 'shaderpacks/local.zip';
  const longText = 'datapacks/test/data/demo/function/big.mcfunction';
  const brokenText = 'kubejs/client_scripts/bad.js';
  for (const [file, bytes] of [
    [texture, Buffer.from([0, 255])], [lang, '{}'], [localZip, zipSync({})],
    [longText, 'x'.repeat(256 * 1024 + 1)], [brokenText, Buffer.from([255])],
    ['defaultconfigs/x.toml', 'a=1'], ['scripts/.env', 'secret'],
    ['kubejs/config/private.json', '{"accessToken":"test"}'],
    ['config/cache/unused.json', 'cache'], ['assets/indexes/index.json', 'launcher'],
  ]) await put(file, bytes);
  const { items, issues } = await scanInstance(source, stage);
  const files = new Map(items.map(item => [item.path, item]));
  assert.equal(files.get(lang).snapshot, 'files/' + lang);
  for (const item of [texture, localZip, longText, brokenText, 'defaultconfigs/x.toml']) {
    assert.ok(files.has(item), item);
    assert.equal(files.get(item).snapshot, undefined, item);
  }
  for (const item of ['scripts/.env', 'kubejs/config/private.json', 'config/cache/unused.json', 'assets/indexes/index.json']) {
    assert.equal(files.has(item), false, item);
  }
  assert.ok(issues.some(issue => issue.path === 'kubejs/config/private.json'));
});

test('仅采集点名存档的 datapacks，不跟随目录链接', async t => {
  const { source, stage, put } = await fixture(t);
  const pack = 'saves/世界 A/datapacks/example/pack.mcmeta';
  await put(pack, '{"pack":{}}');
  await put('saves/世界 B/datapacks/other/pack.mcmeta', '{"other":true}');
  await put('saves/世界 A/region/r.0.0.mca', 'world data');
  await fs.symlink(path.join(source, 'saves', '世界 B'), path.join(source, 'resourcepacks'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await scanInstance(source, stage)).items.length, 0);
  const { items, issues } = await scanInstance(source, stage, { world: '世界 A' });
  assert.deepEqual(items.map(item => [item.path, item.kind, item.snapshot]), [[pack, 'datapack', 'files/' + pack]]);
  assert.ok(issues.some(issue => issue.path === 'resourcepacks'));
  await assert.rejects(scanInstance(source, stage, { world: '不存在' }), /存档/);
  await assert.rejects(scanInstance(source, stage, { world: '../外部' }), /路径/);
  await fs.mkdir(path.join(source, 'saves', '空世界'));
  const empty = await scanInstance(source, stage, { world: '空世界' });
  assert.ok(empty.issues.some(issue => issue.path === 'saves/空世界/datapacks' && issue.reason.includes('没有')));
});

test('写快照出错时终止本次采集', async t => {
  const { source, stage, put } = await fixture(t);
  await put('scripts/example.zs', '// example');
  await fs.writeFile(path.join(stage, 'files'), 'occupied');
  await assert.rejects(scanInstance(source, stage), error => ['EEXIST', 'ENOTDIR', 'ENOENT'].includes(error.code));
});

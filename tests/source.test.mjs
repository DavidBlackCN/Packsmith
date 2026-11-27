import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectTarget } from '../tools/lib/check.mjs';

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 源文件 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = { id: 'example', path: 'packs/example' };
  const dir = path.join(root, target.path);
  const put = async (name, contents) => {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    return file;
  };
  const config = { name: 'Test', version: '1', overrides: ['config'] };
  await put('pakku.json', JSON.stringify(config));
  await put('pakku-lock.json', JSON.stringify({
    lockfile_version: 2, target: 'modrinth', mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' }
  }));
  await put('config/example.json', '{}');
  return { put, config, inspect: () => inspectTarget(root, target) };
}

test('同路径的公共与侧别配置分别映射到对应归档目录', async t => {
  const { put, inspect } = await fixture(t);
  await put('.pakku/client-overrides/config/example.json', '{"client":true}');
  await put('.pakku/server-overrides/config/example.json', '{"server":true}');
  const { mapping } = await inspect();
  assert.deepEqual(mapping.map(item => item.archivePath).sort(), [
    'client-overrides/config/example.json', 'overrides/config/example.json', 'server-overrides/config/example.json'
  ]);
  await put('.pakku/overrides/config/example.json', '{"duplicate":true}');
  await assert.rejects(inspect, /冲突/);
});

test('明确声明的本地归档和资源包允许进入源，散落归档和玩家数据会被指出', async t => {
  const { put, inspect } = await fixture(t);
  await put('.pakku/overrides/mods/local.jar', Buffer.from('local jar'));
  await put('.pakku/client-overrides/resourcepacks/demo/assets/demo/lang/en_us.json', '{}');
  assert.equal((await inspect()).mapping.length, 3);
  for (const name of ['loose.jar', '.pakku/overrides/saves/world/level.dat', '.pakku/overrides/config/.env']) {
    const file = await put(name, 'private');
    await assert.rejects(inspect, undefined, name);
    await fs.unlink(file);
  }
  await put('config/credentials-example.json', '{"accessToken":"fixture-token"}');
  await assert.rejects(inspect, /凭据/);
});

test('未匹配的覆盖规则和损坏的锁文件会中止源检查', async t => {
  const { put, config, inspect } = await fixture(t);
  await put('pakku.json', JSON.stringify({ ...config, overrides: ['missing.txt'] }));
  await assert.rejects(inspect, /未匹配/);
  await put('pakku.json', JSON.stringify(config));
  await put('pakku-lock.json', '{');
  await assert.rejects(inspect, SyntaxError);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishChanges } from '../tools/lib/apply-publish.mjs';
import { sha256 } from '../tools/lib/pakku.mjs';

const target = { id: 'demo', path: 'packs/demo' };

async function put(dir, name, bytes) {
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 发布 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const dir = path.join(root, target.path);
  const stage = path.join(root, '.intake/stage');
  await put(dir, 'config/a.toml', 'old');
  await put(dir, 'config/remove.toml', 'remove');
  await put(dir, 'config/unrelated.toml', 'keep');
  await put(stage, 'config/a.toml', 'new');
  await put(stage, '.pakku/overrides/scripts/new.zs', 'script');
  const changes = [
    { path: 'config/a.toml', before: sha256('old'), after: sha256('new') },
    { path: 'config/remove.toml', before: sha256('remove'), after: null },
    { path: '.pakku/overrides/scripts/new.zs', before: null, after: sha256('script') },
  ];
  return { root, dir, stage, changes,
    publish: (verify = async () => {}) => publishChanges(root, target, stage, changes, verify),
    read: name => fs.readFile(path.join(dir, name), 'utf8'),
  };
}

test('发布所选增改删，重复执行已应用的清单直接返回', async t => {
  const f = await fixture(t);
  const result = await f.publish(() => put(f.dir, 'config/unrelated.toml', 'edited separately'));
  assert.deepEqual(result, { alreadyApplied: false });
  assert.equal(await f.read('config/a.toml'), 'new');
  await assert.rejects(f.read('config/remove.toml'), { code: 'ENOENT' });
  assert.equal(await f.read(f.changes[2].path), 'script');
  assert.equal(await f.read('config/unrelated.toml'), 'edited separately');
  assert.deepEqual(await f.publish(() => assert.fail('重复执行不应重新发布')), { alreadyApplied: true });
});

test('全体预检拒绝已变动的候选、部分已发布的 Target 和回调期间的并发编辑', async t => {
  const f = await fixture(t);
  await put(f.stage, f.changes[2].path, 'tampered');
  await assert.rejects(f.publish(), /批准哈希/);
  assert.equal(await f.read('config/a.toml'), 'old');
  await put(f.stage, f.changes[2].path, 'script');
  await put(f.dir, 'config/a.toml', 'new');
  await assert.rejects(f.publish(), /重新审查/);
  assert.equal(await f.read('config/remove.toml'), 'remove');
  await put(f.dir, 'config/a.toml', 'old');
  await assert.rejects(f.publish(() => put(f.dir, 'config/remove.toml', 'manual edit')), /正式文件已变化/);
  assert.equal(await f.read('config/a.toml'), 'old');
  assert.equal(await f.read('config/remove.toml'), 'manual edit');
});

test('发布持锁时拒绝第二次发布；审核回调失败不动 Target', async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = f.publish(async () => {
    entered.resolve();
    await release.promise;
    throw new Error('源采集已经变化');
  });
  try {
    await entered.promise;
    await assert.rejects(f.publish(), /PID/);
  } finally {
    release.resolve();
  }
  await assert.rejects(first, /源采集已经变化/);
  assert.equal(await f.read('config/a.toml'), 'old');
  assert.deepEqual(await f.publish(), { alreadyApplied: false });
});

test('写入末项时出现同名文件，会恢复先前的修改和删除，保留用户同时新增的文件', async t => {
  const f = await fixture(t);
  const realLink = fs.link;
  t.mock.method(fs, 'link', async (from, to) => {
    if (path.basename(from) === 'new-2') await fs.writeFile(to, 'user file', { flag: 'wx' });
    return realLink(from, to);
  });
  await assert.rejects(f.publish(), { code: 'EEXIST' });
  assert.equal(await f.read('config/a.toml'), 'old');
  assert.equal(await f.read('config/remove.toml'), 'remove');
  assert.equal(await f.read(f.changes[2].path), 'user file');
});

test('目的卷无法建立硬链接时，在移动任何正式文件前退出并清理探测文件', async t => {
  const f = await fixture(t);
  const realLink = fs.link;
  const displaced = [];
  const realRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to).startsWith('old-')) displaced.push(from);
    return realRename(from, to);
  });
  let code;
  t.mock.method(fs, 'link', async (from, to) => {
    // 整卷禁用硬链接，或第一处父目录允许、另一处属于不同的卷。
    if (code === 'ENOTSUP' || path.dirname(to) === f.dir) throw Object.assign(new Error(code), { code });
    return realLink(from, to);
  });
  for (code of ['ENOTSUP', 'EXDEV']) {
    await assert.rejects(f.publish(), error => error.message.includes('同一支持硬链接的文件系统') && error.message.includes(code));
  }
  assert.deepEqual(displaced, []);
  assert.deepEqual((await fs.readdir(path.join(f.dir, 'config'))).sort(), ['a.toml', 'remove.toml', 'unrelated.toml']);
  assert.equal(await f.read('config/a.toml'), 'old');
  assert.equal(await f.read('config/remove.toml'), 'remove');
  assert.deepEqual(await fs.readdir(path.join(f.root, '.work/publish')), []);
});

test('编辑器在回滚校验后替换文件，保留新内容和原始备份', async t => {
  const f = await fixture(t);
  const realLink = fs.link;
  t.mock.method(fs, 'link', async (from, to) => {
    if (path.basename(from) === 'new-2') throw new Error('末项写入失败');
    return realLink(from, to);
  });
  const realRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === 'undo-0') {
      const temp = path.join(f.dir, 'editor.tmp');
      await fs.writeFile(temp, 'external edit');
      await realRename(temp, from);
    }
    return realRename(from, to);
  });
  await assert.rejects(f.publish(), /人工核对/);
  assert.equal(await f.read('config/a.toml'), 'external edit');
  assert.equal(await f.read('config/remove.toml'), 'remove');
  assert.equal(await fs.readFile(path.join(f.root, '.work/publish/demo.journal/old-0'), 'utf8'), 'old');
});

test('子进程在首项写入后终止，确认旧进程退出并解除锁后可恢复再发布', async t => {
  const f = await fixture(t);
  const childSource = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const [url, input] = process.argv.slice(1);
    const { root, stage, changes, target } = JSON.parse(input);
    const { publishChanges } = await import(url);
    const realLink = fs.link;
    fs.link = async (from, to) => {
      await realLink(from, to);
      if (path.basename(from) === 'new-0') process.exit(47);
    };
    await publishChanges(root, target, stage, changes, async () => {});
  `;
  const moduleUrl = new URL('../tools/lib/apply-publish.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, moduleUrl,
    JSON.stringify({ root: f.root, stage: f.stage, changes: f.changes, target })], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 47, child.stderr);
  assert.equal(await f.read('config/a.toml'), 'new');
  assert.equal(await f.read('config/remove.toml'), 'remove');
  const lock = path.join(f.root, '.work/publish/demo.lock');
  assert.equal(Number(await fs.readFile(lock, 'utf8')), child.pid);
  await fs.unlink(lock);
  const result = await f.publish(async () => {
    assert.equal(await f.read('config/a.toml'), 'old', '先恢复上次中断的发布，再复核本次申请');
  });
  assert.deepEqual(result, { alreadyApplied: false });
  assert.equal(await f.read(f.changes[2].path), 'script');
  assert.deepEqual(await fs.readdir(path.dirname(lock)), []);
});

test('拒绝越界、重复路径及指向外部的目标或候选链接', async t => {
  const f = await fixture(t);
  for (const name of ['../outside', '.git/config']) {
    const rows = [{ ...f.changes[0], path: name }];
    await assert.rejects(publishChanges(f.root, target, f.stage, rows, async () => {}));
  }
  await assert.rejects(publishChanges(f.root, target, f.stage, [f.changes[0], {
    ...f.changes[0], path: 'config/A.toml',
  }], async () => {}), /重复/);
  const outside = path.join(f.root, 'outside');
  await put(outside, 'x.toml', 'outside');
  const linked = path.join(f.stage, 'linked');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const row = [{ path: 'linked/x.toml', before: null, after: sha256('outside') }];
  await fs.symlink(outside, linked, linkType);
  await assert.rejects(publishChanges(f.root, target, f.stage, row, async () => {}), /junction/);
  await fs.symlink(outside, path.join(f.dir, 'linked'), linkType);
  await assert.rejects(publishChanges(f.root, target, f.stage, row, async () => {}), /junction/);
  assert.equal(await fs.readFile(path.join(outside, 'x.toml'), 'utf8'), 'outside');
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../tools/lib/pakku.mjs';
import { readReviewText } from '../tools/lib/review-text.mjs';

async function fixture(t) {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'Packsmith-review-text-'));
  t.after(() => temp.remove());
  const root = await fs.realpath(temp.path);
  const current = path.join(root, '.intake/current');
  const game = path.join(root, 'game');
  const target = { id: 'fabric', path: 'packs/fabric' };
  const item = { path: 'config/tuning.toml', kind: 'config', sha256: sha256('bonus = 3'), size: 9 };
  const manifest = { schema: 1, scanId: 'scan-1', source: game, items: [item] };
  const mapping = {
    source: '.pakku/client-overrides/' + item.path, destination: item.path, side: 'client', sha256: sha256('bonus = 2'),
  };
  mapping.projectPath = target.path + '/' + mapping.source;
  const reviewed = { ...item, comparison: { mappings: [mapping] } };
  const review = { schema: 1, scanId: 'scan-1', target, items: [reviewed] };
  async function put(base, name, value) {
    const file = path.join(base, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  async function save() {
    await put(current, 'manifest.json', JSON.stringify(manifest));
    await put(current, 'review.json', JSON.stringify(review));
  }
  await put(game, item.path, 'bonus = 3');
  await put(root, mapping.projectPath, 'bonus = 2');
  await save();
  return { current, game, root, target, item, manifest, mapping, reviewed, review, put, save,
    read: () => readReviewText(root, target, item.path) };
}

test('单文件对照核对实例和侧别源文件的实际 SHA-256', async t => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.path, f.item.path);
  assert.deepEqual(result.instance, { text: 'bonus = 3', origin: 'source', sha256: f.item.sha256 });
  assert.deepEqual(result.mappings, [{ projectPath: f.mapping.projectPath, side: 'client', sha256: f.mapping.sha256, text: 'bonus = 2' }]);
  await f.put(f.root, f.mapping.projectPath, 'bonus = 1');
  await assert.rejects(f.read, /SHA-256.*pnpm review/);
  await f.put(f.game, f.item.path, 'bonus = 4');
  await assert.rejects(f.read, /SHA-256.*pnpm intake/);
});

test('复用其他路径的同内容快照，保留离线或已移动实例的审阅能力', async t => {
  const f = await fixture(t);
  const path = 'kubejs/server_scripts/sample.js';
  const snapshot = 'files/' + path;
  f.manifest.items.push({ ...f.item, kind: 'kubejs', path, snapshot });
  await f.put(f.current, snapshot, 'bonus = 3');
  await fs.rename(f.game, f.game + '-moved');
  await f.save();
  assert.deepEqual((await f.read()).instance, { text: 'bonus = 3', sha256: f.item.sha256, origin: 'snapshot', snapshot });
  f.item.snapshot = snapshot;
  f.reviewed.snapshot = snapshot;
  await f.save();
  assert.equal((await f.read()).instance.snapshot, snapshot);
  await f.put(f.current, snapshot, 'bonus = 7');
  await assert.rejects(f.read, /SHA-256.*pnpm intake/);
});

test('拒绝过期或错 Target 的报告以及不属于候选的路径映射', async t => {
  const f = await fixture(t);
  await assert.rejects(() => readReviewText(f.root, f.target, 'config/unlisted.toml'), /不在当前/);
  await assert.rejects(() => readReviewText(f.root, { ...f.target, path: 'packs/other' }, f.item.path), /其他 Target/);
  f.review.scanId = 'old';
  await f.save();
  await assert.rejects(f.read, /采集与审查/);
  f.review.scanId = f.manifest.scanId;
  f.mapping.projectPath = 'packs/other/config/tuning.toml';
  await f.save();
  await assert.rejects(f.read, /目标覆盖映射无效/);
  f.item.snapshot = '../private.json';
  f.reviewed.snapshot = f.item.snapshot;
  await f.save();
  await assert.rejects(f.read, /快照路径/);
});

test('拒绝过大文件、非 UTF-8、NUL 和可能含凭据的文本', async t => {
  const f = await fixture(t);
  for (const [bytes, reason] of [
    [Buffer.alloc(256 * 1024 + 1), /256 KiB/], [Buffer.from([0xff]), /UTF-8/],
    [Buffer.from([0x41, 0]), /NUL/], [Buffer.from('accessToken="fixture-secret"'), /凭据/],
  ]) {
    Object.assign(f.item, { size: bytes.length, sha256: sha256(bytes) });
    f.reviewed.sha256 = f.item.sha256;
    await f.put(f.game, f.item.path, bytes);
    await f.save();
    await assert.rejects(f.read, reason);
  }
  await f.put(f.root, f.mapping.projectPath, Buffer.alloc(256 * 1024 + 1));
  await f.put(f.game, f.item.path, 'bonus = 3');
  Object.assign(f.item, { size: 9, sha256: sha256('bonus = 3') });
  f.reviewed.sha256 = f.item.sha256;
  await f.save();
  await assert.rejects(f.read, /256 KiB/);
});

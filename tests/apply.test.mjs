import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPrepared, prepareSelection } from '../tools/lib/apply.mjs';
import { runIntake } from '../tools/lib/intake.mjs';
import { reviewIntake } from '../tools/lib/review.mjs';

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith-preview-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  async function put(name, text) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const target = { id: 'pack', path: 'packs/pack', artifacts: ['modrinth'] };
  await put('packs/pack/pakku.json', JSON.stringify({ name: 'fixture', version: '1', overrides: ['config'] }));
  await put('packs/pack/pakku-lock.json', JSON.stringify({ target: 'modrinth', lockfile_version: 2, mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' } }));
  const name = 'config/foo.toml', dest = 'packs/pack/' + name;
  const before = 'plate = 1\nui = false\n', source = 'plate = 2\nui = true\n';
  const content = 'plate = 2\nui = false\n';
  await put(dest, before);
  await put('game/' + name, source);
  const manifest = await runIntake(root, path.join(root, 'game'));
  await reviewIntake(root, target, { offline: true });
  const file = { type: 'file', path: name, destination: name, side: 'common', content };
  async function propose(operations) {
    const features = operations.map((op, i) => ({ id: String(i + 1), title: '功能 ' + (i + 1), operations: [op] }));
    await put('.intake/current/proposal.json', JSON.stringify({ schema: 1, scanId: manifest.scanId, target: target.id, features }));
  }
  await propose([file, { ...file, content: source }]);
  const preview = (...ids) => prepareSelection(root, target, ids);
  const apply = id => applyPrepared(root, target, id);
  return { before, content, dest, file, name, put, propose, preview, apply, read: name => fs.readFile(path.join(root, name), 'utf8') };
}

test('同一文件只预览所选功能的文本差异，多个功能要求不同全文时由维护者合并', async t => {
  const { preview, content, before, name, dest, read } = await fixture(t);
  await assert.rejects(preview(), /选择/);
  await assert.rejects(preview('missing'), /功能 ID/);
  await assert.rejects(preview('1', '2'), /合并/);
  const { plan, directory } = await preview('1');
  assert.deepEqual(plan.features.map(f => f.id), ['1']);
  assert.equal(await read(dest), before);
  assert.equal(await fs.readFile(path.join(directory, 'after', name), 'utf8'), content);
  const diff = await fs.readFile(path.join(directory, 'changes.diff'), 'utf8');
  assert.match(diff, /\+plate = 2/);
  assert.doesNotMatch(diff, /ui = true/);
});

test('改写预览或审查后加入新侧别均不能覆盖正式文件', async t => {
  const { preview, apply, name, dest, before, read, put } = await fixture(t);
  const first = await preview('1');
  await fs.appendFile(path.join(first.directory, 'plan.json'), ' ');
  await assert.rejects(apply(first.id), /预览内容已变化/);
  const next = await preview('1');
  await put('packs/pack/.pakku/client-overrides/' + name, 'plate = 9\n');
  await assert.rejects(apply(next.id), /侧别在审查后已变化/);
  assert.equal(await read(dest), before);
});

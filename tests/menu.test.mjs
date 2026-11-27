import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runIntake } from '../tools/lib/intake.mjs';
import { runMenu } from '../tools/menu.mjs';
import { reviewFromMenu } from '../tools/menu-review.mjs';

test('多 Target 菜单记住当前选择，取消切换后仍使用原目标', async t => {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'Packsmith targets '));
  t.after(() => temp.remove());
  const root = await fs.realpath(temp.path);
  const targets = ['fabric', 'neo'].map(id => ({ id, path: 'packs/' + id, artifacts: ['modrinth'] }));
  for (const target of targets) await fs.mkdir(path.join(root, target.path), { recursive: true });
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ targets }));

  const prompts = [];
  const actions = ['检查与构建', 'neo', null, '切换 Target', null, '检查与构建', null, '切换 Target', 'fabric', null];
  await runMenu(root, {
    choose(title, labels) {
      prompts.push(title);
      assert.ok(actions.length);
      const action = actions.shift();
      if (action === null) return null;
      const index = labels.indexOf(action);
      assert.notEqual(index, -1, action);
      return index;
    },
    write: message => assert.fail(message),
  });
  assert.deepEqual(actions, []);
  assert.deepEqual(prompts.filter(title => title.startsWith('检查与构建')), ['检查与构建 · neo', '检查与构建 · neo']);
  assert.match(prompts.at(-1), /Target：fabric/);
});

test('离线审查只预览勾选项，拒绝应用保留原文件，也不会要求安装 Pakku', async t => {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'Packsmith 菜单 '));
  t.after(() => temp.remove());
  const root = await fs.realpath(temp.path);
  const target = { id: 'fabric', path: 'packs/fabric', artifacts: ['modrinth'] };
  const pack = path.join(root, target.path);
  const game = path.join(root, '游戏 实例');
  await fs.mkdir(path.join(pack, 'config'), { recursive: true });
  await fs.writeFile(path.join(pack, 'pakku.json'), JSON.stringify({ name: 'Menu', version: '1.0', overrides: ['config'] }));
  await fs.writeFile(path.join(pack, 'pakku-lock.json'), JSON.stringify({
    target: 'modrinth', mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' }, lockfile_version: 2,
  }));
  await fs.mkdir(path.join(game, 'config'), { recursive: true });
  const files = ['difficulty.json', 'visual.json'];
  for (const file of files) {
    await fs.writeFile(path.join(pack, 'config', file), '{"level":1}\n');
    await fs.writeFile(path.join(game, 'config', file), '{"level":2}\n');
  }
  const { scanId } = await runIntake(root, game);
  const features = files.map((id, index) => ({
    id, title: ['难度调整', '视觉设置'][index],
    operations: [{ type: 'file', side: 'common', path: 'config/' + id, destination: 'config/' + id }],
  }));
  const proposal = path.join(root, '.intake', 'current', 'proposal.json');
  const save = targetId => fs.writeFile(proposal, JSON.stringify({ schema: 1, scanId, target: targetId, features }));
  await save(target.id);

  const output = [];
  const ui = {
    write: line => output.push(line),
    choose: (_, labels) => labels.findIndex(label => label.startsWith('离线审查')),
    chooseMany(_, labels) {
      assert.match(labels[1], /视觉设置/);
      return [1];
    },
    confirm() {
      const diff = output.find(line => line.startsWith('diff --git'));
      assert.match(diff, /visual\.json/);
      assert.doesNotMatch(diff, /difficulty\.json/);
      return false;
    },
  };
  const noInstall = () => assert.fail('纯文件预览不需要 Pakku');
  await reviewFromMenu(root, target, ui, noInstall);
  assert.ok(output.some(line => line.startsWith('diff --git')), '应展示实际差异');
  for (const file of files) assert.equal(await fs.readFile(path.join(pack, 'config', file), 'utf8'), '{"level":1}\n');

  await save('other');
  output.length = 0;
  await reviewFromMenu(root, target, { ...ui, chooseMany: () => assert.fail('其他 Target 的提案不可选') }, noInstall);
  assert.match(output.join('\n'), /提案.*Target 不符/);
});

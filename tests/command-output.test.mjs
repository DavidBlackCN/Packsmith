import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  printBootstrap, printBuild, printCheck, printIntake, printReview, printSelection, printTargets,
} from '../tools/lib/command-output.mjs';
import { intakeKinds } from '../tools/lib/intake.mjs';

const target = { id: 'fabric', path: 'packs/fabric', artifacts: ['modrinth', 'serverpack'] };

function render(print) {
  const lines = [];
  print(line => lines.push(line));
  return lines.join('\n');
}

test('每个平台分别按路径计数，缺证据、失败、未查询和锁定跳过的路径保持可区分', () => {
  const pathFor = (status, modrinth, curseforge) => ({
    kind: 'mod', comparison: { status }, platforms: modrinth && { modrinth, curseforge },
  });
  const fail = { status: 'error', reason: 'HTTP 429\x1b[2J' };
  const review = {
    offline: false, conflicts: [{ id: 'example' }], issues: [], items: [
      pathFor('locked'),
      pathFor('possible-replacement', { status: 'exact' }, fail),
      pathFor('unmapped', { status: 'exact' }, fail),
      pathFor('unmapped', { status: 'no-match' }, { status: 'unverified', reason: '部分指纹匹配' }),
      pathFor('unmapped', { status: 'not-queried', reason: '缺少哈希' }, { status: 'exact' }),
      { kind: 'config', comparison: { status: 'same' } },
    ],
  };
  const result = render(write => printReview(target, review, write));
  assert.match(result, /JAR 路径：5 条.*已锁定：1 条/);
  assert.match(result, /已锁定并跳过平台查询：1 条/);
  assert.match(result, /Modrinth[^\n]*\n  精确命中 2  无匹配 1  证据不足 0  查询失败 0  未查询 1/);
  assert.match(result, /CurseForge[^\n]*\n  精确命中 1  无匹配 0  证据不足 1  查询失败 2  未查询 0/);
  assert.equal(result.split('HTTP 429').length, 2);
  assert.ok(result.includes('HTTP 429\\x1b[2J'));
  assert.ok(result.includes('缺少哈希') && result.includes('部分指纹匹配') && result.includes('冲突：1 组'));
  assert.match(result, /\.intake\/current\/review\.json/);
});

test('Intake 按已记录路径分类，与哈希、内容重复、已保存快照分别计数', () => {
  const manifest = {
    source: '/tmp/game', items: [{ kind: 'script' }, { kind: 'config' }, { kind: 'config' }], issues: [{}],
    stats: { filesHashed: 4, duplicates: 1, snapshots: 2, bytesRead: 8192, elapsedMs: 7 },
  };
  const result = render(write => printIntake(manifest, intakeKinds, write));
  for (const value of ['候选路径：3', '配置  2', 'CraftTweaker  1', '完成哈希计算：4', '重复内容：1', '已保存文本快照：2',
    '8192 字节', '7 ms', '1 条问题', '.intake/current/report.md', '.intake/current/manifest.json']) assert.ok(result.includes(value), value);
});

test('Preview 与 Apply 使用同一完整编号，区分所选变更、实际写入、幂等以及零变更', () => {
  const id = '3'.repeat(64);
  const directory = path.join('.work', 'prepared', id);
  const plan = {
    features: [{ id: 'plate', title: '压板\n配方', operations: [{ type: 'file', destination: 'config/plate.toml', side: 'server' }] }],
    changes: [{ path: 'config/plate.toml', before: 'a', after: 'b' }, { path: 'pakku-lock.json', before: 'a', after: 'b' }],
    dependencies: { changes: [{ kind: 'remove', direct: true, name: 'Old Mod', before: {
      side: 'BOTH', files: [{ fileName: 'old.jar', platform: 'modrinth', fileId: 'V1' }],
    }, after: null }] },
  };
  const preview = render(write => printSelection(target, { id, directory, plan }, true, write));
  const applied = render(write => printSelection(target, { plan, alreadyApplied: false, out: 'dist/actual' }, false, write, id));
  for (const result of [preview, applied]) {
    for (const value of ['预览编号：' + id, '压板\\x0a配方 [plate]', '服务端  packs/fabric/config/plate.toml',
      '工程元数据  packs/fabric/pakku-lock.json', '移除直接依赖  Old Mod', 'modrinth/V1 (old.jar)']) assert.ok(result.includes(value), value);
  }
  assert.ok(preview.includes('差异：' + path.join(directory, 'changes.diff')));
  assert.ok(!preview.includes('检查与构建通过'));
  assert.ok(applied.includes('已写入，检查与构建通过') && applied.includes('产物：dist/actual'));
  const repeated = render(write => printSelection(target, { plan, alreadyApplied: true, out: 'dist/retry' }, false, write, id));
  assert.match(repeated, /已含批准的改动.*重新检查与构建通过/);
  const noChange = { ...plan, changes: [], dependencies: { changes: [] } };
  const same = render(write => printSelection(target, { plan: noChange, alreadyApplied: true }, false, write, id));
  assert.ok(same.includes('无需写入和构建') && !same.includes('产物：'));
});

test('Targets 区分显式默认、唯一可选和需要 --target，Check 统计覆盖映射，Build 展示实际附件', () => {
  const second = { id: 'other', path: 'packs/other', artifacts: ['curseforge'] };
  const targets = workspace => render(write => printTargets(workspace, write));
  assert.match(targets({ targets: [target] }), /唯一 Target，自动选中/);
  assert.match(targets({ targets: [target, second], defaultTarget: 'other' }), /other  （已配置默认 Target）/);
  const multiple = targets({ targets: [target, second] });
  assert.ok(multiple.includes('--target') && !multiple.includes('已配置默认'));
  const info = { lock: { mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' } }, mapping: [{ side: 'common' }, { side: 'server' }] };
  const checked = render(write => printCheck(target, info, write));
  for (const text of ['覆盖映射：2 条', '公共  1', '客户端  0', '服务端  1', 'fabric 0.16.14']) assert.ok(checked.includes(text), text);
  const out = path.join('dist', 'fabric', 'build-actual');
  const report = { version: '1.0', artifacts: [{ kind: 'serverpack', name: 'Server.zip', size: 380 }] };
  const built = render(write => printBuild(target, { out, report }, write));
  for (const text of ['Server.zip', 'serverpack', '380 字节', path.join(out, 'SHA256SUMS'), path.join(out, 'build-report.json')]) {
    assert.ok(built.includes(text), text);
  }
  assert.ok(!built.includes('MRPACK 内的'));
  assert.equal(built.split('\n').at(-1), 'fabric 已构建 1 份产物，输出目录 ' + out);
  const tool = render(write => printBootstrap({ version: '1.5.0', jar: '.cache/pakku-1.5.0.jar' }, write));
  assert.match(tool, /1\.5\.0 的 SHA-256 校验通过/);
  assert.ok(tool.includes('.cache/pakku-1.5.0.jar'));
});

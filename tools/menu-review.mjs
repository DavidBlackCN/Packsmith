import fs from 'node:fs/promises';
import { applyPrepared, prepareSelection } from './lib/apply.mjs';
import { printReview, printSelection } from './lib/command-output.mjs';
import { reviewIntake } from './lib/review.mjs';
import { readJson, safePath } from './lib/workspace.mjs';

const current = '.intake/current/';
const comparisonLabels = {
  unmapped: '新增候选（Target 未映射）',
  same: '与 Target 相同',
  different: '内容已变更',
  mixed: '不同映射的对照结果不一致',
  locked: 'Pakku 已锁定相同文件',
  'possible-replacement': '同一项目的其他发布文件，待确认',
};

async function readCurrent(root, name, reportInvalid) {
  try {
    return await readJson(await safePath(root, current + name));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      const message = current + name + ' 不是有效的 JSON：' + error.message;
      if (!reportInvalid) throw new Error(message);
      reportInvalid(message);
      return null;
    }
    throw error;
  }
}

async function showDiff(directory, write) {
  const file = await fs.open(await safePath(directory, 'changes.diff'), 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 16 * 1024);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, 0);
    // Keep tabs and line breaks while displaying control bytes from instance files literally.
    const text = new TextDecoder().decode(bytes.subarray(0, bytesRead), { stream: bytesRead < size })
      .replaceAll('\r\n', '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ch => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
    if (text) write(text.replace(/\n$/, ''));
    if (bytesRead < size) write('终端只显示了差异的开头。请打开上面的 changes.diff 查看余下内容，再决定是否写入。');
  } finally {
    await file.close();
  }
}

export async function reviewFromMenu(root, target, ui, ensurePakku) {
  const manifest = await readCurrent(root, 'manifest.json');
  if (!manifest) {
    ui.write('请先在菜单中采集游戏实例，再审查想保留的改动。');
    return;
  }
  if (manifest.schema !== 1 || !manifest.scanId) throw new Error('当前采集清单无效，请重新采集。');
  ui.write('Target ' + target.id + ' · 采集 ' + manifest.scanId);
  const existing = await readCurrent(root, 'review.json', ui.write);
  const reusable = existing?.schema === 1 && existing.scanId === manifest.scanId &&
    existing.target?.id === target.id && existing.target.path === target.path &&
    Array.isArray(existing.items) && Array.isArray(existing.conflicts);
  const choices = ['联网审查（查询 Mod 来源）', '离线审查（只用本地证据）'];
  if (reusable) choices.unshift('使用已有审查' + (existing.offline ? '（离线）' : '（联网）'));
  const choice = await ui.choose('如何审查本次采集？', choices);
  if (choice === null) return;
  const review = reusable && choice === 0 ? existing : await reviewIntake(root, target, { offline: choice === choices.length - 1 });
  printReview(target, review, ui.write);
  const shown = review.items.slice(0, 20);
  ui.write('本次采集有 ' + review.items.length + ' 个候选。');
  for (const item of shown) {
    const status = item.comparison.status;
    ui.write('  ' + item.path + '  ' + (comparisonLabels[status] ?? status) + (item.enabled === false ? '（实例中已停用）' : ''));
  }
  if (shown.length < review.items.length) {
    ui.write('以上为前 ' + shown.length + ' 个候选，完整对照见 ' + await safePath(root, current + 'review.json'));
  }

  const proposal = await readCurrent(root, 'proposal.json');
  if (!proposal || proposal.schema !== 1 || proposal.target !== target.id || proposal.scanId !== review.scanId) {
    if (proposal) ui.write('已有提案与本次采集或 Target 不符，请按当前审查更新提案。');
    ui.write('告诉 Codex 想保留哪个功能，例如「保留测试中的压板配方，先给我方案」。提案保存在 ' + current + 'proposal.json。');
    return;
  }
  if (!Array.isArray(proposal.features) || !proposal.features.length) {
    ui.write('当前 proposal.json 缺少可选择的功能，请先补充提案。');
    return;
  }
  const features = proposal.features;
  const indices = await ui.chooseMany('选择要预览的功能', features.map(feature => feature.title + ' [' + feature.id + ']'));
  if (!indices?.length) return;
  const chosen = indices.map(index => features[index]);
  const hasDependencies = chosen.some(feature => feature.operations?.some(op => op?.type === 'dependency'));
  if (hasDependencies && !await ensurePakku()) return;
  const preview = await prepareSelection(root, target, chosen.map(feature => feature.id));
  if (preview.plan.scanId !== review.scanId) throw new Error('选择期间当前采集已更换，请重新审查。');
  printSelection(target, preview, true, ui.write);
  if (!preview.plan.changes.length) return;
  await showDiff(preview.directory, ui.write);
  if (!await ui.confirm('按上面的预览写入 ' + target.path + ' 并构建？')) return;
  if (!await ensurePakku()) return;
  const applied = await applyPrepared(root, target, preview.id);
  printSelection(target, applied, false, ui.write);
}

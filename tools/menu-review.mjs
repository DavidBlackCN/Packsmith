import fs from 'node:fs/promises';
import { applyPrepared, prepareSelection, readProposalFeatures } from './lib/apply.mjs';
import { approvalFacts, printReview, printSelection } from './lib/command-output.mjs';
import { readCurrentReview, readManifest, reviewIntake } from './lib/review.mjs';
import { field, multiline } from './lib/terminal.mjs';
import { safePath } from './lib/workspace.mjs';

const current = '.intake/current/';
const comparisonLabels = {
  unmapped: '新增候选（Target 未映射）',
  same: '与 Target 相同',
  different: '内容已变更',
  mixed: '不同映射的对照结果不一致',
  locked: 'Pakku 已锁定相同文件',
  'possible-replacement': '同一项目的其他发布文件，待确认',
};

function featureDetails(feature) {
  const meta = [];
  let files = 0, dependencies = 0;
  const sides = { common: '公共', client: '客户端', server: '服务端' };
  const actions = { add: '新增', update: '更新', replace: '替换', remove: '移除' };
  for (const op of Array.isArray(feature.operations) ? feature.operations : []) {
    if (op?.type === 'file') {
      files++;
      const side = sides[op.side] ?? op.side ?? '';
      if (op.path && op.path !== op.destination) meta.push('来源  ' + field(op.path));
      if (op.destination) meta.push(field(side) + '文件  ' + field(op.destination));
    } else if (op?.type === 'dependency') {
      dependencies++;
      const action = actions[op.action] ?? op.action ?? '';
      const identity = [op.platform, op.path, op.from && '原项目 ' + op.from].filter(Boolean);
      meta.push([field(action) + '依赖', ...identity.map(field)].join('  '));
    }
  }
  meta.unshift('文件操作 ' + files + ' 项 · 依赖操作 ' + dependencies + ' 项');
  return { detail: typeof feature.description === 'string' ? field(feature.description) : '', meta };
}

async function showDiff(directory, write) {
  const file = await fs.open(await safePath(directory, 'changes.diff'), 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 16 * 1024);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, 0);
    // Keep tabs and line breaks while displaying control bytes from instance files literally.
    const text = new TextDecoder().decode(bytes.subarray(0, bytesRead), { stream: bytesRead < size });
    if (text) write(multiline(text).replace(/\n$/, ''));
    if (bytesRead < size) write('终端只显示了差异的开头。请打开上面的 changes.diff 查看余下内容，再决定是否写入。');
  } finally {
    await file.close();
  }
}

export async function reviewFromMenu(root, target, ui, ensurePakku) {
  const manifest = await readManifest(root);
  const status = ui.status ?? ((_, text) => ui.write(text));
  const context = 'Target ' + field(target.id);
  const { review: existing, reason } = await readCurrentReview(root, manifest, target);
  if (reason) status('warn', field(reason));
  const choices = ['联网审查（查询 Mod 来源）', '离线审查（只用本地证据）'];
  const descriptions = ['查询候选 JAR 的平台发布记录。', '对照已采集的文件、Target 和锁文件。'];
  if (existing) {
    choices.unshift('使用已有审查' + (existing.offline ? '（离线）' : '（联网）'));
    descriptions.unshift('读取已保存的 .intake/current/review.json。');
  }
  const choice = await ui.choose('如何审查本次采集？', choices,
    { section: 'REVIEW MODE', context: context + ' · 采集 ' + field(manifest.scanId), descriptions });
  if (choice === null) return;
  const offline = choice === choices.length - 1;
  const reuse = existing && choice === 0;
  status(reuse ? 'info' : 'progress', reuse ? '使用本次采集已保存的审查。' :
    (offline ? '正在对照本地证据…' : '正在对照 Target 并查询 Mod 来源…'));
  const review = reuse ? existing : await reviewIntake(root, target, { offline });
  printReview(target, review, ui.write);
  const shown = review.items.slice(0, 20);
  ui.write('本次采集有 ' + review.items.length + ' 个候选。');
  for (const item of shown) {
    const status = item.comparison.status;
    ui.write('  ' + field(item.path) + '  ' + field(comparisonLabels[status] ?? status) + (item.enabled === false ? '（实例中已停用）' : ''));
  }
  if (shown.length < review.items.length) {
    ui.write('以上为前 ' + shown.length + ' 个候选，完整对照见 ' + field(await safePath(root, current + 'review.json')));
  }

  const { features, reason: proposalReason } = await readProposalFeatures(root, review.scanId, target);
  if (!features) {
    status('warn', field(proposalReason));
    ui.write('可用 AI 助手（如 Codex、DSH）起草提案，也可手写 ' + current + 'proposal.json。');
    return;
  }
  const indices = await ui.chooseMany('选择要预览的功能', features.map(feature => field(feature.title) + ' [' + field(feature.id) + ']'), {
    section: 'FEATURE SELECTION', context: context + (review.offline ? ' · 离线审查' : ' · 联网审查'),
    descriptions: features.map(featureDetails),
  });
  if (!indices?.length) return;
  const chosen = indices.map(index => features[index]);
  const hasDependencies = chosen.some(feature => feature.operations?.some(op => op?.type === 'dependency'));
  if (hasDependencies && !await ensurePakku()) return;
  status('progress', '正在为选中的 ' + chosen.length + ' 项功能生成预览…');
  const preview = await prepareSelection(root, target, chosen.map(feature => feature.id));
  if (preview.plan.scanId !== review.scanId) throw new Error('选择期间当前采集已更换，请重新审查。');
  printSelection(target, preview, true, ui.write);
  if (!preview.plan.changes.length) return;
  await showDiff(preview.directory, ui.write);
  if (!await ui.confirm('将这份预览写入正式 Target 并构建？', {
    section: 'APPLY', facts: approvalFacts(target, preview),
    warning: '确认后将复核源文件与 Target，写入上述改动并构建。',
    noLabel: '否，返回', yesLabel: '是，写入并构建',
  })) return;
  if (!await ensurePakku()) return;
  status('progress', '正在复核并应用批准的预览，随后构建 ' + field(target.id) + '…');
  const applied = await applyPrepared(root, target, preview.id);
  printSelection(target, applied, false, ui.write, preview.id);
}

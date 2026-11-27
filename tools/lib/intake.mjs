import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanInstance } from './intake-scan.mjs';
import { safePath } from './workspace.mjs';

const kinds = new Map([
  ['mod', 'Mod JAR'], ['config', '配置'], ['kubejs', 'KubeJS'], ['script', 'CraftTweaker'],
  ['datapack', '数据包'], ['resourcepack', '资源包'], ['shaderpack', '光影'],
]);

// Names and metadata come from the instance. Keep each value inside one literal Markdown span.
function literal(value) {
  const raw = String(value);
  const preview = raw.length > 240 ? raw.slice(0, 239) + '…' : raw;
  const text = preview.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(1 + runs.reduce((longest, run) => Math.max(longest, run.length), 0));
  return fence + ' ' + text + ' ' + fence;
}

function renderReport({ source, world, scannedAt, items, issues, stats }) {
  const lines = [
    '# 实例采集报告', '',
    `游戏目录 ${literal(source)}。扫描时间 ${literal(scannedAt)}。`,
    ...(world === undefined ? [] : [`包含存档 ${literal(world)} 的数据包。`]), '',
    `已计算 ${stats.filesHashed} 份文件的 SHA-256，读取 ${stats.bytesRead} 字节，用时 ${stats.elapsedMs} ms。`,
    `发现 ${stats.duplicates} 份重复内容，保存 ${stats.snapshots} 份文本快照。完整路径、哈希与 Mod 声明见同目录的 manifest.json。`,
    '', '| 文件类型 | 路径数 |', '| --- | ---: |',
  ];
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  for (const [kind, label] of kinds) lines.push(`| ${label} | ${counts.get(kind) ?? 0} |`);
  const mods = items.filter(item => item.kind === 'mod');
  if (mods.length) {
    const recognized = mods.filter(item => item.jar?.status === 'recognized').length;
    lines.push('', '## Mod 声明', '',
      `${recognized} 份 JAR 含可读取的 Mod 声明，${mods.filter(item => !item.enabled).length} 份标记为禁用。识别依据是本地元数据。`, '');
    for (const item of mods.slice(0, 15)) {
      const summary = item.jar.mods.slice(0, 5).map(mod => literal(mod.id) + (mod.version ? ' ' + literal(mod.version) : '')).join('、');
      const note = item.duplicateOf ? `，内容同 ${literal(item.duplicateOf)}` : '';
      lines.push(`- ${literal(item.path)} · ${summary || '声明待查'}${item.enabled ? '' : '，禁用'}${note}`);
    }
    if (mods.length > 15) lines.push(`- 另有 ${mods.length - 15} 份，见 Manifest。`);
  }
  const snapshots = items.filter(item => item.snapshot && item.snapshot === 'files/' + item.path);
  if (snapshots.length) {
    lines.push('', '## 可审查的文本', '');
    for (const item of snapshots.slice(0, 15)) lines.push('- ' + literal(item.snapshot));
    if (snapshots.length > 15) lines.push(`- 另有 ${snapshots.length - 15} 份，见 files/。`);
  }
  if (issues.length) {
    lines.push('', '## 扫描提示', '');
    for (const issue of issues.slice(0, 10)) lines.push(`- ${literal(issue.path)} · ${literal(issue.reason)}`);
    if (issues.length > 10) lines.push(`- 另有 ${issues.length - 10} 条，见 Manifest。`);
  }
  return lines.join('\n') + '\n';
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Stage and publish on the same volume. Windows requires moving a nonempty current aside first.
export async function runIntake(root, directory, { world } = {}) {
  const source = await fs.realpath(path.resolve(directory));
  if (!(await fs.stat(source)).isDirectory()) throw new Error('采集来源必须是游戏目录');
  await fs.access(source, constants.R_OK | constants.X_OK);
  const output = await safePath(await fs.realpath(root), '.intake');
  if (contains(source, output) || contains(output, source)) {
    throw new Error('游戏目录与采集输出 .intake/ 不能互相包含');
  }
  await fs.mkdir(output, { recursive: true });
  const pending = path.join(output, '.pending');
  try {
    await fs.mkdir(pending);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有采集正在运行，或上次采集中断。请检查 .intake/.pending/，恢复步骤见 README。');
    throw error;
  }

  let keepBackup = false;
  try {
    const current = await safePath(output, 'current');
    const existing = await fs.lstat(current).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing && !existing.isDirectory()) throw new Error('.intake/current 不是目录');
    const next = path.join(pending, 'next');
    const previous = path.join(pending, 'previous');
    await fs.mkdir(path.join(next, 'files'), { recursive: true });
    const scannedAt = new Date().toISOString();
    const start = performance.now();
    const { items, issues, stats } = await scanInstance(source, next, { world });
    const manifest = {
      schema: 1, scanId: randomUUID(), source, world, scannedAt,
      stats: { ...stats, elapsedMs: Math.round(performance.now() - start) }, items, issues,
    };
    await fs.writeFile(path.join(next, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(path.join(next, 'report.md'), renderReport(manifest));
    if (existing) {
      await fs.rename(current, previous);
      keepBackup = true;
    }
    try {
      await fs.rename(next, current);
    } catch (error) {
      if (keepBackup) {
        await fs.rename(previous, current);
        keepBackup = false;
      }
      throw error;
    }
    keepBackup = false;
    return manifest;
  } finally {
    if (!keepBackup) await fs.rm(pending, { recursive: true, force: true });
  }
}

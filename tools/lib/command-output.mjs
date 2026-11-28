import path from 'node:path';
import { field, terminal } from './terminal.mjs';

const sides = { common: '公共', client: '客户端', server: '服务端' };
const actions = { add: '新增', update: '更新', remove: '移除' };
const platforms = { modrinth: 'Modrinth', curseforge: 'CurseForge' };
const matchLabels = {
  exact: '精确命中', 'no-match': '无匹配', unverified: '证据不足', error: '查询失败', 'not-queried': '未查询',
};

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function heading(command, write, target) {
  const style = terminal();
  write(style.heading('PACKSMITH / ' + command));
  if (target) write('Target：' + field(target.id) + '  ' + field(target.path));
  return style;
}

export function printBootstrap(tool, write = console.log) {
  const style = heading('BOOTSTRAP', write);
  write(style.ok('Pakku ' + field(tool.version) + ' 的 SHA-256 校验通过。'));
  write('缓存：' + field(tool.jar));
}

export function printTargets(workspace, write = console.log) {
  heading('TARGETS', write);
  for (const target of workspace.targets) {
    let selection = '';
    if (workspace.defaultTarget === target.id) selection = '  （已配置默认 Target）';
    else if (workspace.targets.length === 1) selection = '  （唯一 Target，自动选中）';
    write(field(target.id) + selection);
    write('  工程：' + field(target.path));
    write('  产物：' + target.artifacts.map(field).join(', '));
  }
  if (workspace.targets.length > 1 && !workspace.defaultTarget) write('运行目标命令时，请用 --target <id> 选择。');
}

export function printIntake(manifest, kinds, write = console.log) {
  const style = heading('INTAKE', write);
  const { items, issues, stats } = manifest;
  write('实例：' + field(manifest.source));
  if (manifest.world !== undefined) write('存档：' + field(manifest.world));
  write('已记录候选路径：' + items.length);
  const counts = countBy(items, item => item.kind);
  for (const [kind, label] of kinds) write('  ' + label + '  ' + (counts.get(kind) ?? 0));
  write('完成哈希计算：' + stats.filesHashed + ' 份文件');
  write('重复内容：' + stats.duplicates + ' 份  ·  已保存文本快照：' + stats.snapshots + ' 份');
  write('实际读取：' + stats.bytesRead + ' 字节  ·  扫描耗时：' + stats.elapsedMs + ' ms');
  if (issues.length) write(style.warn('采集记录了 ' + issues.length + ' 条问题，详情见报告。'));
  write('报告：.intake/current/report.md');
  write('清单：.intake/current/manifest.json');
  write(style.ok('采集完成。'));
}

export function printReview(target, review, write = console.log) {
  const style = heading('REVIEW', write, target);
  const mods = review.items.filter(item => item.kind === 'mod');
  const locked = mods.filter(item => item.comparison.status === 'locked');
  const platformRows = mods.filter(item => item.platforms || item.comparison.status !== 'locked');
  write('模式：' + (review.offline ? '离线' : '联网'));
  write('JAR 路径：' + mods.length + ' 条  ·  Target 已锁定：' + locked.length + ' 条');
  write('已锁定并跳过平台查询：' + (mods.length - platformRows.length) + ' 条');
  for (const [platform, name] of Object.entries(platforms)) {
    const matches = platformRows.map(item => item.platforms?.[platform] ?? { status: 'not-queried' });
    const counts = countBy(matches, match => match.status);
    write(name + '（按 JAR 路径）');
    const totals = Object.entries(matchLabels).map(([key, label]) => label + ' ' + (counts.get(key) ?? 0));
    const separator = process.stdout.columns < 72 ? '\n  ' : '  ';
    write('  ' + totals.join(separator));
    const reasons = new Set();
    for (const { status, reason } of matches) {
      if (reason) reasons.add(matchLabels[status] + '：' + field(reason));
    }
    for (const reason of reasons) write('  ' + reason);
  }
  const conflicts = '同 Mod ID、同版本但内容不同的冲突：' + review.conflicts.length + ' 组';
  write(review.conflicts.length ? style.warn(conflicts) : conflicts);
  if (review.issues?.length) write(style.warn('另有 ' + review.issues.length + ' 条审查问题，详情见报告。'));
  write('报告：.intake/current/review.json');
  write(style.ok('审查完成。'));
}

function describeRelease(endpoint) {
  if (!endpoint) return '无';
  const files = endpoint.files.map(file => field(file.platform) + '/' + field(file.fileId) + ' (' + field(file.fileName) + ')');
  return field(endpoint.side) + ' ' + files.join('、');
}

const fileAction = change => change.before === null ? '新增' : change.after === null ? '移除' : '修改';

export function approvalFacts(target, preview) {
  const { changes, dependencies, features } = preview.plan;
  const files = countBy(changes, fileAction);
  const deps = dependencies.changes;
  const direct = deps.filter(change => change.direct).length;
  return [
    ['Target', field(target.id)],
    ['写入目录', field(target.path)],
    ['预览编号', field(preview.id)],
    ['所选功能', features.length + ' 项'],
    ['文件变更', ['新增', '修改', '移除'].map(action => action + ' ' + (files.get(action) ?? 0)).join(' · ')],
    ['依赖变更', '直接 ' + direct + ' · 连带 ' + (deps.length - direct)],
  ];
}

export function printSelection(target, result, preparing, write = console.log, preparedId = result.id) {
  const style = heading(preparing ? 'PREVIEW' : 'APPLY', write, target);
  const { features, changes, dependencies } = result.plan;
  write('所选功能：' + features.length);
  for (const feature of features) write('  ' + field(feature.title) + ' [' + field(feature.id) + ']');
  if (preparedId) write('预览编号：' + field(preparedId));
  const fileSides = new Map(features.flatMap(feature => feature.operations)
    .filter(op => op.type === 'file').map(op => [op.destination, sides[op.side]]));
  write('文件变更：' + changes.length);
  for (const change of changes) {
    const action = fileAction(change);
    const side = fileSides.get(change.path) ?? '工程元数据';
    write('  ' + action + '  ' + side + '  ' + field(target.path + '/' + change.path));
  }
  const deps = dependencies.changes;
  write('依赖变更：' + deps.length);
  if (deps.length) {
    const counts = countBy(deps, change => change.kind);
    write('  ' + Object.entries(actions).map(([kind, action]) => action + ' ' + (counts.get(kind) ?? 0)).join('  '));
  }
  for (const change of deps) {
    write('  ' + actions[change.kind] + (change.direct ? '直接依赖  ' : '连带依赖  ') + field(change.name));
    write('    原文件：' + describeRelease(change.before));
    write('    新文件：' + describeRelease(change.after));
  }
  if (preparing) {
    write('差异：' + field(path.join(result.directory, 'changes.diff')));
    write(style.ok(changes.length ? '预览已生成。请核对差异再写入。' : '所选功能已与 Target 一致。'));
  } else if (!changes.length) {
    write(style.ok('已复核，所选功能已与 Target 一致，无需写入和构建。'));
  } else {
    write(style.ok(result.alreadyApplied ? 'Target 已含批准的改动，本次重新检查与构建通过。' : '已写入，检查与构建通过。'));
    write('产物：' + field(result.out));
  }
}

export function printCheck(target, info, write = console.log) {
  const style = heading('CHECK', write, target);
  write('Minecraft：' + info.lock.mc_versions.map(field).join(', '));
  const loaders = Object.entries(info.lock.loaders).map(([name, version]) => field(name) + ' ' + field(version));
  write('Loader：' + (loaders.join(', ') || '未声明'));
  write('覆盖映射：' + info.mapping.length + ' 条');
  const counts = countBy(info.mapping, row => row.side);
  for (const [side, label] of Object.entries(sides)) write('  ' + label + '  ' + (counts.get(side) ?? 0));
  write(style.ok('目标配置、锁文件和覆盖映射检查通过，Pakku 已读取工程。'));
}

export function printBuild(target, { out, report }, write = console.log) {
  const style = heading('BUILD', write, target);
  write('包版本：' + field(report.version));
  write(style.ok('Target 检查、Pakku 导出、归档与覆盖资源校验通过。'));
  for (const file of report.artifacts) {
    write(field(file.name));
    write('  ' + field(file.kind) + '  ·  ' + file.size + ' 字节');
  }
  if (report.artifacts.some(file => file.kind === 'modrinth')) write('MRPACK 内的 Minecraft 和 Loader 已与锁文件核对。');
  write('报告：' + field(path.join(out, 'build-report.json')));
  write('校验清单：' + field(path.join(out, 'SHA256SUMS')));
  write(field(target.id) + ' 已构建 ' + report.artifacts.length + ' 份产物，输出目录 ' + field(out));
}

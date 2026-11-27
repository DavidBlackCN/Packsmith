import path from 'node:path';

export function printReview(target, review, write = console.log) {
  const mods = review.items.filter(item => item.kind === 'mod');
  const locked = mods.filter(item => item.comparison.status === 'locked').length;
  const exact = mods.filter(item => Object.values(item.platforms ?? {}).some(match => match.status === 'exact')).length;
  write(`${target.id} 共对照 ${mods.length} 条 JAR 路径，${locked} 条命中锁文件，${exact} 条获得平台精确匹配。发现 ${review.conflicts.length} 组同 ID、同版本但内容不同的声明。`);
  for (const platform of ['modrinth', 'curseforge']) {
    const failures = new Set(mods.map(item => item.platforms?.[platform]).filter(match => match?.status === 'error').map(match => match.reason));
    if (failures.size) write(`${platform} 查询未完成：${[...failures].join('，')}。`);
  }
}

export function printSelection(target, result, preparing, write = console.log) {
  write(`${target.id} · ${result.plan.features.map(feature => feature.title).join('、')}`);
  const fileSides = new Map(result.plan.features.flatMap(feature => feature.operations)
    .filter(op => op.type === 'file').map(op => [op.destination, { common: '两端', client: '客户端', server: '服务端' }[op.side]]));
  for (const change of result.plan.changes) {
    const action = change.before === null ? '新增' : change.after === null ? '移除' : '修改';
    const side = fileSides.get(change.path);
    write(`${action}  ${target.path}/${change.path}${side ? '  ' + side : ''}`);
  }
  for (const change of result.plan.dependencies.changes) {
    const release = endpoint => endpoint ? `${endpoint.side} ${endpoint.files.map(file => `${file.platform}/${file.fileId} (${file.fileName})`).join('、')}` : '无';
    const action = { add: '新增', update: '更新', remove: '移除' }[change.kind];
    write(`${action}${change.direct ? '所选' : '连带'}依赖  ${change.name}  ${release(change.before)} → ${release(change.after)}`);
  }
  if (!result.plan.changes.length) write('所选功能已与 Target 一致。');
  if (preparing) {
    write(`差异：${path.join(result.directory, 'changes.diff')}\n预览编号：${result.id}`);
  } else if (result.out) {
    write(`${result.alreadyApplied ? '已存在相同改动' : '已写入'}，检查与构建通过。产物：${result.out}`);
  }
}

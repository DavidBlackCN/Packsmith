import path from 'node:path';
import { parseArgs } from 'node:util';
import { bootstrap } from './lib/pakku.mjs';
import { loadWorkspace, selectTarget } from './lib/workspace.mjs';

const root = path.resolve(import.meta.dirname, '..');
const help = `Packsmith
  pnpm bootstrap               安装并校验固定版本的 Pakku
  pnpm targets                 列出已注册的 Target
  pnpm intake "<游戏目录>" [--world <存档目录名>]  离线采集实例候选
  pnpm review [--target <id>] [--offline]  对照当前采集与目标，识别 Mod 来源
  pnpm review --file "<游戏相对路径>" [--target <id>]  查看已对照的候选和正式文件文本
  pnpm preview --feature <功能ID> [--feature <功能ID>] [--target <id>]  预览所选功能的实际差异
  pnpm apply --prepared <预览编号> [--target <id>]  写入已批准的差异并构建
  pnpm check [--target <id>]   检查目标的 Pakku 工程与覆盖资源
  pnpm build [--target <id>]   构建并校验整合包
`;

async function main(args) {
  if (args[0] === '--') args.shift();
  const command = args.shift() ?? 'help';
  if (args[0] === '--') args.shift();
  const hasTarget = ['check', 'build', 'review', 'preview', 'apply'].includes(command);
  const isIntake = command === 'intake';
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: isIntake,
    options: {
      help: { type: 'boolean', short: 'h' },
      ...(isIntake ? { world: { type: 'string' } } : {}),
      ...(command === 'review' ? { offline: { type: 'boolean' }, file: { type: 'string' } } : {}),
      ...(command === 'preview' ? { feature: { type: 'string', multiple: true } } : {}),
      ...(command === 'apply' ? { prepared: { type: 'string' } } : {}),
      ...(hasTarget ? { target: { type: 'string' } } : {})
    }
  });
  if (values.help || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (command === 'bootstrap') {
    const tool = await bootstrap(root);
    console.log(`Pakku ${tool.version}  ${tool.jar}`);
    return;
  }
  if (isIntake) {
    if (positionals.length !== 1 || !positionals[0]) throw new Error('用法：pnpm intake "<游戏目录>" [--world <存档目录名>]');
    const { runIntake } = await import('./lib/intake.mjs');
    console.log('采集成功后会替换 .intake/current/ 中的上次结果。');
    const { stats } = await runIntake(root, positionals[0], { world: values.world });
    console.log(`采集完成，已计算 ${stats.filesHashed} 份文件的哈希，保存 ${stats.snapshots} 份文本快照。见 .intake/current/report.md`);
    return;
  }
  if (!hasTarget && command !== 'targets') {
    throw new Error(`未知命令 ${command}。运行 pnpm mp help 查看用法。`);
  }
  const workspace = await loadWorkspace(root);
  if (command === 'targets') {
    for (const target of workspace.targets) {
      console.log(`${target.id}  ${target.path}`);
    }
    return;
  }
  const target = selectTarget(workspace, values.target);
  if (command === 'preview' || command === 'apply') {
    const { applyPrepared, prepareSelection } = await import('./lib/apply.mjs');
    const preparing = command === 'preview';
    const result = preparing ? await prepareSelection(root, target, values.feature) : await applyPrepared(root, target, values.prepared);
    console.log(`${target.id} · ${result.plan.features.map(feature => feature.title).join('、')}`);
    const fileSides = new Map(result.plan.features.flatMap(feature => feature.operations)
      .filter(op => op.type === 'file').map(op => [op.destination, { common: '两端', client: '客户端', server: '服务端' }[op.side]]));
    for (const change of result.plan.changes) {
      const action = change.before === null ? '新增' : change.after === null ? '移除' : '修改';
      const side = fileSides.get(change.path);
      console.log(`${action}  ${target.path}/${change.path}${side ? '  ' + side : ''}`);
    }
    for (const change of result.plan.dependencies.changes) {
      const release = endpoint => endpoint ? `${endpoint.side} ${endpoint.files.map(file => `${file.platform}/${file.fileId} (${file.fileName})`).join('、')}` : '无';
      const action = { add: '新增', update: '更新', remove: '移除' }[change.kind];
      console.log(`${action}${change.direct ? '所选' : '连带'}依赖  ${change.name}  ${release(change.before)} → ${release(change.after)}`);
    }
    if (!result.plan.changes.length) console.log('所选功能已与 Target 一致。');
    if (preparing) {
      console.log(`差异：${path.join(result.directory, 'changes.diff')}\n预览编号：${result.id}`);
    } else if (result.out) {
      console.log(`${result.alreadyApplied ? '已存在相同改动' : '已写入'}，检查与构建通过。产物：${result.out}`);
    }
    return;
  }
  if (command === 'review') {
    if (values.file !== undefined) {
      const { readReviewText } = await import('./lib/review-text.mjs');
      console.log(JSON.stringify(await readReviewText(root, target, values.file), null, 2));
      return;
    }
    const { reviewIntake } = await import('./lib/review.mjs');
    const review = await reviewIntake(root, target, { offline: values.offline });
    const mods = review.items.filter(item => item.kind === 'mod');
    const locked = mods.filter(item => item.comparison.status === 'locked').length;
    const exact = mods.filter(item => Object.values(item.platforms ?? {}).some(match => match.status === 'exact')).length;
    console.log(`${target.id} 共对照 ${mods.length} 条 JAR 路径，${locked} 条命中锁文件，${exact} 条获得平台精确匹配。发现 ${review.conflicts.length} 组同 ID、同版本但内容不同的声明。`);
    for (const platform of ['modrinth', 'curseforge']) {
      const failures = new Set(mods.map(item => item.platforms?.[platform]).filter(match => match?.status === 'error').map(match => match.reason));
      if (failures.size) console.log(`${platform} 查询未完成：${[...failures].join('，')}。`);
    }
    console.log('证据见 .intake/current/review.json。可以告诉 Codex 想保留哪个功能。');
    return;
  }
  if (command === 'check') {
    const { checkTarget } = await import('./lib/check.mjs');
    const { mapping } = await checkTarget(root, target);
    console.log(`${target.id} 检查通过，包含 ${mapping.length} 个覆盖文件。`);
    return;
  }
  const { build } = await import('./lib/build.mjs');
  const { out, report } = await build(root, target);
  console.log(`${target.id} 已构建 ${report.artifacts.length} 份产物，输出目录 ${out}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}

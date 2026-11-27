import path from 'node:path';
import { parseArgs } from 'node:util';
import { printReview, printSelection } from './lib/command-output.mjs';
import { bootstrap } from './lib/pakku.mjs';
import { loadWorkspace, selectTarget } from './lib/workspace.mjs';

const root = path.resolve(import.meta.dirname, '..');
const help = `Packsmith
  pnpm menu                    打开本地维护菜单
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
    printSelection(target, result, preparing);
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
    printReview(target, review);
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
  for (const artifact of report.artifacts) console.log('  ' + artifact.name);
  console.log(`${target.id} 已构建 ${report.artifacts.length} 份产物，输出目录 ${out}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}

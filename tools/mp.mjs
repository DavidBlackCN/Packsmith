import path from 'node:path';
import { parseArgs } from 'node:util';
import { printBootstrap, printBuild, printCheck, printIntake, printReview, printSelection, printTargets } from './lib/command-output.mjs';
import { bootstrap } from './lib/pakku.mjs';
import { field, multiline, terminal } from './lib/terminal.mjs';
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
    console.log(terminal().muted('正在核验 Pakku，缺少本地缓存时会下载。'));
    printBootstrap(await bootstrap(root));
    return;
  }
  if (isIntake) {
    if (positionals.length !== 1 || !positionals[0]) throw new Error('用法：pnpm intake "<游戏目录>" [--world <存档目录名>]');
    const { intakeKinds, runIntake } = await import('./lib/intake.mjs');
    console.log(terminal().warn('采集成功后会替换 .intake/current/ 中的上次结果。'));
    printIntake(await runIntake(root, positionals[0], { world: values.world }), intakeKinds);
    return;
  }
  if (!hasTarget && command !== 'targets') {
    throw new Error(`未知命令 ${field(command)}。运行 pnpm mp help 查看用法。`);
  }
  const selection = command === 'preview' || command === 'apply' ? await import('./lib/apply.mjs') : null;
  if (command === 'preview') selection.requireFeatureIds(values.feature);
  const workspace = await loadWorkspace(root);
  if (command === 'targets') {
    printTargets(workspace);
    return;
  }
  const target = selectTarget(workspace, values.target);
  if (selection) {
    const preparing = command === 'preview';
    if (preparing && values.feature?.length) console.log(terminal().muted('正在 ' + field(target.id) + ' 的临时副本中准备预览。'));
    if (!preparing && values.prepared) {
      console.log(terminal().muted('正在处理 Target ' + field(target.id) + ' 的已批准预览 ' + field(values.prepared)));
    }
    const result = preparing ? await selection.prepareSelection(root, target, values.feature) : await selection.applyPrepared(root, target, values.prepared);
    printSelection(target, result, preparing, console.log, preparing ? result.id : values.prepared);
    return;
  }
  if (command === 'review') {
    if (values.file !== undefined) {
      const { readReviewText } = await import('./lib/review-text.mjs');
      console.log(JSON.stringify(await readReviewText(root, target, values.file), null, 2));
      return;
    }
    const { reviewIntake } = await import('./lib/review.mjs');
    console.log(terminal().muted('正在对照当前采集与 Target ' + field(target.id) + '。'));
    const review = await reviewIntake(root, target, { offline: values.offline });
    printReview(target, review);
    console.log('下一步：告诉 AI 助手（如 Codex、DSH）想保留哪个功能，或编写 .intake/current/proposal.json。');
    return;
  }
  if (command === 'check') {
    const { checkTarget } = await import('./lib/check.mjs');
    printCheck(target, await checkTarget(root, target));
    return;
  }
  const { build } = await import('./lib/build.mjs');
  console.log(terminal().muted('正在构建 Target ' + field(target.id) + '。'));
  printBuild(target, await build(root, target));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(terminal(process.stderr).fail(multiline(error.message)));
  process.exitCode = error.exitCode || 1;
}

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { bootstrap, requireSuccess, run, tool, verifiedTool } from './lib/pakku.mjs';
import { loadWorkspace, readJson, selectTarget } from './lib/workspace.mjs';
import { isCI, multiline, terminal } from './lib/terminal.mjs';
import { homeActions } from './menu-home.mjs';
import { createMenuUi, MenuCancelled } from './menu-ui.mjs';

async function mp(root, args) {
  requireSuccess(await run(process.execPath, [path.join(root, 'tools/mp.mjs'), ...args], { cwd: root }));
}

async function collect(root, ui) {
  // Windows Explorer copies a file path with surrounding double quotes.
  const directory = (await ui.ask('游戏目录（直接包含 mods、config 或 kubejs 的那一层，留空返回）'))
    .replace(/^"(.*)"$/u, '$1');
  if (!directory) return;
  const args = ['intake'];
  const includeWorld = await ui.confirm('同时采集指定存档中的数据包？');
  if (includeWorld === null) return;
  if (includeWorld) {
    const world = await ui.ask('存档目录名（saves 下的文件夹名，留空返回）');
    if (!world) return;
    args.push('--world=' + world);
  }
  await mp(root, [...args, path.resolve(root, directory)]);
}

async function ensurePakku(root, ui) {
  const spec = await tool(root);
  try {
    await fs.access(spec.jar);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!await ui.confirm(`需要 Pakku ${spec.version}。现在下载并校验吗？`)) return false;
    ui.write(`正在下载并校验 Pakku ${spec.version}…`);
    await bootstrap(root);
    return true;
  }
  await verifiedTool(root);
  return true;
}

async function commitStaged(root, ui) {
  const diff = requireSuccess(await run('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--stat', '--'],
    { cwd: root, capture: true }));
  if (!diff.stdout.trim()) {
    ui.write('暂存区为空。请先在编辑器中暂存，或用 git add 选择要提交的改动。');
    return;
  }
  ui.write(multiline(diff.stdout.trimEnd()));
  const packageFile = createRequire(path.join(root, 'package.json')).resolve('czg/package.json');
  const { bin } = await readJson(packageFile);
  const entry = path.resolve(path.dirname(packageFile), bin.czg);
  // czg bundles two renderers. One checks TERM, the other checks NO_COLOR and
  // treats even FORCE_COLOR=0 as an explicit request to turn colors on.
  let env = process.env;
  if (env.NO_COLOR !== undefined || env.TERM === 'dumb') {
    env = { ...env, NO_COLOR: '1', TERM: 'dumb' };
    delete env.FORCE_COLOR;
  }
  await ui.suspend(async () => requireSuccess(await run(process.execPath, [entry], { cwd: root, env })));
}

export async function runMenu(root, ui) {
  let current;
  let multiple = false;
  // Intake and Git are still available when the Target configuration needs repair.
  const reportError = ui.error ?? ui.write;
  try {
    const workspace = await loadWorkspace(root);
    multiple = workspace.targets.length > 1;
    if (!multiple || workspace.defaultTarget) current = selectTarget(workspace, workspace.defaultTarget);
  } catch (error) {
    reportError(error.message);
  }

  async function chooseTarget(switching = false) {
    const workspace = await loadWorkspace(root);
    multiple = workspace.targets.length > 1;
    current = workspace.targets.find(target => target.id === current?.id);
    const preferred = current?.id ?? workspace.defaultTarget;
    if (!multiple || (!switching && preferred)) {
      current = selectTarget(workspace, preferred);
      return current;
    }
    const index = await ui.choose('选择 Target', workspace.targets.map(target => {
      const suffix = target.id === current?.id ? '（当前）' : target.id === workspace.defaultTarget ? '（默认）' : '';
      return target.id + suffix;
    }));
    if (index === null) return null;
    current = workspace.targets[index];
    return current;
  }

  for (;;) {
    const actions = multiple ? homeActions : homeActions.slice(0, 4);
    const labels = actions.map(action => action.label);
    const details = actions.map(action => action.detail);
    const choice = await ui.choose('Packsmith', labels, '退出', details, {
      workspace: path.basename(root), version: pkg.version, target: current?.id ?? '待选择',
    });
    if (choice === null) return;
    try {
      if (choice === 0) {
        await collect(root, ui);
      } else if (choice === 3) {
        await commitStaged(root, ui);
      } else if (choice === 4) {
        await chooseTarget(true);
      } else {
        const target = await chooseTarget();
        if (!target) continue;
        const prepareTool = () => ensurePakku(root, ui);
        if (choice === 1) {
          const { reviewFromMenu } = await import('./menu-review.mjs');
          await reviewFromMenu(root, target, ui, prepareTool);
        } else {
          const action = await ui.choose(`检查与构建 · ${target.id}`, ['检查当前 Target', '构建当前 Target']);
          if (action === null || !await prepareTool()) continue;
          await mp(root, [action === 0 ? 'check' : 'build', '--target', target.id]);
        }
      }
    } catch (error) {
      if (error instanceof MenuCancelled) throw error;
      reportError(error.message);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  if (isCI() || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(terminal(process.stderr).fail('菜单需要交互式终端。运行 pnpm mp help 查看直接命令。'));
    process.exitCode = 1;
  } else {
    const ui = createMenuUi();
    try {
      await runMenu(root, ui);
    } catch (error) {
      if (!(error instanceof MenuCancelled)) {
        ui.error(error.message);
        process.exitCode = 1;
      }
    } finally {
      ui.close();
    }
    if (process.platform === 'win32') {
      // A Windows console read can outlive readline after czg returns to the menu.
      await Promise.all([process.stdout, process.stderr].map(stream =>
        new Promise(resolve => stream.write('', resolve))));
      process.exit(process.exitCode ?? 0);
    }
  }
}

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, requireSuccess, run, tool, verifiedTool } from './lib/pakku.mjs';
import { loadWorkspace, readJson, selectTarget } from './lib/workspace.mjs';
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
  if (await ui.confirm('同时采集指定存档中的数据包？')) {
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
  ui.write(diff.stdout.trimEnd());
  const packageFile = createRequire(path.join(root, 'package.json')).resolve('czg/package.json');
  const { bin } = await readJson(packageFile);
  const entry = path.resolve(path.dirname(packageFile), bin.czg);
  await ui.suspend(async () => requireSuccess(await run(process.execPath, [entry], { cwd: root })));
}

export async function runMenu(root, ui) {
  let current;
  let multiple = false;

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
    const labels = ['从实例采集', '审查与应用', '检查与构建', '提交已暂存的改动'];
    if (multiple) labels.push('切换 Target');
    const choice = await ui.choose(`Packsmith  ·  Target：${current?.id ?? '按需选择'}`, labels, '退出');
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
      ui.write(error.message);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const ui = createMenuUi();
  try {
    await runMenu(root, ui);
  } catch (error) {
    if (!(error instanceof MenuCancelled)) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } finally {
    ui.close();
  }
  if (process.platform === 'win32' && process.stdin.isTTY && process.stdout.isTTY) {
    // A Windows console read can outlive readline after czg returns to the menu.
    // Flush the terminal output before ending the standalone CLI.
    await Promise.all([process.stdout, process.stderr].map(stream =>
      new Promise(resolve => stream.write('', resolve))));
    process.exit(process.exitCode ?? 0);
  }
}

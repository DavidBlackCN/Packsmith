import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireSuccess, run } from './lib/pakku.mjs';
import { loadWorkspace, readJson, safePath } from './lib/workspace.mjs';

const buildInputs = new Set([
  'workspace.json', 'toolchain.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
  '.gitignore', '.gitattributes', 'tools/mp.mjs', 'tools/ci.mjs', '.github/workflows/ci.yml',
]);
const authoringTool = /^tools\/lib\/(?:(?:intake|review|apply)(?:-[\w-]+)?|curseforge-fingerprint)\.mjs$/;

export function classifyChanges(workspace, files, all = false) {
  const targets = new Set();
  let buildAll = all, tests = all, verify = all;
  for (const file of files) {
    const target = workspace.targets.find(item => file.startsWith(item.path + '/'));
    if (target) {
      targets.add(target.id);
    } else if (authoringTool.test(file) || file.startsWith('tests/verify-')) {
      tests = verify = true;
    } else if (buildInputs.has(file) || file.startsWith('tools/lib/') || file.startsWith('.github/actions/setup/')) {
      buildAll = tests = verify = true;
    } else if (file.startsWith('tests/') || file.startsWith('tools/') || file.startsWith('.github/workflows/')) {
      tests = true;
    }
  }
  return { targets: buildAll ? workspace.targets.map(item => item.id) : [...targets].sort(), tests, verify };
}

const git = (root, args) => run('git', args, { cwd: root, capture: true });
const commit = /^[a-f0-9]{40}$/;

export async function planCi(root, eventName, event) {
  const workspace = await loadWorkspace(root);
  if (eventName === 'workflow_dispatch') return classifyChanges(workspace, [], true);
  const pr = eventName === 'pull_request';
  if (!pr && eventName !== 'push') throw new Error('无法识别的 CI 事件: ' + eventName);
  if (!pr && event.deleted) return classifyChanges(workspace, []);
  const base = pr ? event.pull_request.base.sha : event.before;
  const head = pr ? event.pull_request.head.sha : event.after;
  if (!commit.test(head) || (base && !commit.test(base))) throw new Error('事件提交 SHA 无效');
  if (!base || /^0+$/.test(base)) return classifyChanges(workspace, [], true);
  // After a force push the previous commit may no longer be reachable in a fresh checkout.
  if ((await git(root, ['cat-file', '-e', base + '^{commit}'])).code !== 0) return classifyChanges(workspace, [], true);
  let start = base;
  if (pr) {
    const common = await git(root, ['merge-base', base, head]);
    if (common.code === 1) return classifyChanges(workspace, [], true);
    start = requireSuccess(common).stdout.trim();
  }
  // Report both endpoints of a rename (including a move across targets); retain arbitrary UTF-8 paths.
  const diff = requireSuccess(await git(root, ['diff', '--no-renames', '--name-only', '-z', start, head, '--']));
  return classifyChanges(workspace, diff.stdout.split('\0').filter(Boolean));
}

export async function assertClean(root) {
  const result = requireSuccess(await git(root, ['status', '--porcelain', '--untracked-files=all']));
  if (result.stdout) throw new Error('检查产生了源文件改动或未跟踪文件:\n' + result.stdout);
}

export async function buildCiTarget(root, id, expectedCommit) {
  const workspace = await loadWorkspace(root);
  const target = workspace.targets.find(item => item.id === id);
  if (!target) throw new Error('无效的 TARGET_ID: ' + id);
  const head = requireSuccess(await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (expectedCommit && expectedCommit !== head) throw new Error('当前检出与预期提交不符');
  await assertClean(root);
  // A manually selected release tag may predate this CI wrapper; use that checkout's builder.
  const { build } = await import(pathToFileURL(path.join(root, 'tools/lib/build.mjs')).href);
  const { out } = await build(root, target).catch(error => {
    if (!process.env.CURSEFORGE_API_KEY && /curseforge/i.test(error.message) &&
        /api[ _-]?key|unauthori[sz]ed|forbidden|\b(?:401|403)\b/i.test(error.message)) {
      throw new Error(error.message + '\n本次运行未提供 CURSEFORGE_API_KEY，无法完成这次导出。' +
        '请在有权使用此仓库密钥的受信分支重新构建。', { cause: error });
    }
    throw error;
  });
  const output = path.relative(root, out).split(path.sep).join('/');
  if (path.posix.dirname(output) !== 'dist/' + id || !path.posix.basename(output).startsWith('build-')) {
    throw new Error('构建返回了意外的产物目录: ' + output);
  }
  const report = await readJson(await safePath(root, output + '/build-report.json'));
  if (report.schema !== 1 || report.git !== head || report.dirty !== false || report.targetId !== id || report.missing.length) {
    throw new Error('构建报告中的提交、源文件状态、Target 或产物不符');
  }
  const kinds = report.artifacts.map(item => item.kind);
  if (kinds.length !== target.artifacts.length || target.artifacts.some(kind => !kinds.includes(kind))) {
    throw new Error('构建产物类型与 Target 声明不一致');
  }
  const expected = new Set(['build-report.json', 'SHA256SUMS', ...report.artifacts.map(item => item.name)]);
  const entries = await fs.readdir(out, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error('上传目录中的文件与构建报告不一致');
  }
  await assertClean(root);
  return output;
}

async function outputs(values) {
  for (const [key, value] of Object.entries(values)) {
    const line = key + '=' + (typeof value === 'string' ? value : JSON.stringify(value));
    console.log(line);
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, line + '\n');
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  switch (process.argv[2]) {
    case 'plan': {
      const event = await readJson(process.env.GITHUB_EVENT_PATH);
      const plan = await planCi(root, process.env.GITHUB_EVENT_NAME, event);
      await outputs({ matrix: { target: plan.targets }, has_targets: plan.targets.length > 0,
        run_tests: plan.tests, verify_build: plan.verify });
      break;
    }
    case 'build':
      await outputs({ output: await buildCiTarget(process.cwd(), process.env.TARGET_ID, process.env.EXPECTED_COMMIT) });
      break;
    case 'clean':
      await assertClean(root);
      break;
    default:
      throw new Error('用法: node tools/ci.mjs plan|build|clean');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

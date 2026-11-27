import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prepareDependencies } from './apply-dependencies.mjs';
import { stageFileOperations, verifySelectionSources } from './apply-files.mjs';
import { publishChanges } from './apply-publish.mjs';
import { build } from './build.mjs';
import { inspectTarget } from './check.mjs';
import { requireSuccess, run, sha256 } from './pakku.mjs';
import { createTargetComparison } from './review-target.mjs';
import { readJson, safePath } from './workspace.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';

async function evidence(root, target) {
  const current = await safePath(root, '.intake/current');
  const [manifest, reviewBytes] = await Promise.all([
    readJson(await safePath(current, 'manifest.json')),
    fs.readFile(await safePath(current, 'review.json')),
  ]).catch(error => {
    if (error.code === 'ENOENT') throw new Error('请先运行 pnpm intake 和 pnpm review');
    throw error;
  });
  const review = JSON.parse(reviewBytes.toString('utf8'));
  if (manifest.schema !== 1 || review.schema !== 1 || !manifest.scanId || manifest.scanId !== review.scanId ||
      review.target?.id !== target.id || review.target.path !== target.path) {
    throw new Error('当前采集与 Target 的审查不一致，请重新运行 pnpm review --target ' + target.id);
  }
  return { manifest, review, reviewHash: sha256(reviewBytes), target };
}

function selectFeatures(proposal, requested, { manifest, target }) {
  if (proposal.schema !== 1 || proposal.scanId !== manifest.scanId || proposal.target !== target.id ||
      !Array.isArray(proposal.features)) throw new Error('proposal.json 须对应本次采集和选定 Target');
  if (!requested?.length) throw new Error('请用 --feature <id> 选择本次准备的功能');
  return [...new Set(requested)].map(id => {
    const matching = proposal.features.filter(feature => feature.id === id);
    if (matching.length !== 1) throw new Error('提案中找不到唯一的功能 ID：' + id);
    const [feature] = matching;
    if (typeof feature.title !== 'string' || !feature.title.trim() || !Array.isArray(feature.operations) || !feature.operations.length) {
      throw new Error('功能缺少标题或操作：' + id);
    }
    return { id, title: feature.title, operations: feature.operations };
  });
}

function selectedOperations(features) {
  const operations = [];
  const destinations = new Set();
  for (const op of features.flatMap(feature => feature.operations)) {
    if (operations.some(previous => isDeepStrictEqual(previous, op))) continue;
    if (op?.type === 'file' && typeof op.destination === 'string') {
      if (Object.keys(op).some(key => !['type', 'path', 'destination', 'side', 'content', 'redistributable'].includes(key))) {
        throw new Error('文件操作含未知字段：' + op.destination);
      }
      const key = op.destination.toLowerCase();
      if (destinations.has(key)) throw new Error('所选功能对同一文件提出不同写法，请先合并：' + op.destination);
      destinations.add(key);
    } else if (op?.type !== 'dependency') throw new Error('操作须为 file 或 dependency，文件操作须指定 destination');
    else if (Object.keys(op).some(key => !['type', 'path', 'action', 'platform', 'from'].includes(key))) {
      throw new Error('依赖操作含未知字段：' + (op.path ?? op.from));
    }
    operations.push(op);
  }
  return operations;
}

async function checkBaseline(root, context, operations) {
  const { manifest, review, target } = context;
  const info = await inspectTarget(root, target);
  if (info.hashes['pakku.json'] !== review.target.configSha256 || info.hashes['pakku-lock.json'] !== review.target.lockSha256) {
    throw new Error('Target 的 Pakku 配置或锁文件在审查后已变化，请重新审查');
  }
  const compare = createTargetComparison(info, target);
  const candidates = new Map(manifest.items.map(item => [item.path, item]));
  const reviewed = new Map(review.items.map(item => [item.path, item]));
  for (const name of new Set(operations.map(op => op.path).filter(Boolean))) {
    const item = candidates.get(name), previous = reviewed.get(name);
    if (!item || !previous || previous.sha256 !== item.sha256) throw new Error('候选与当前审查不一致：' + name);
    const mapping = entries => entries.map(({ projectPath, side, sha256 }) => [projectPath, side, sha256]).sort();
    const current = compare(item, previous.platforms);
    if (!isDeepStrictEqual(mapping(current.mappings), mapping(previous.comparison.mappings))) {
      throw new Error('候选对应的正式文件或侧别在审查后已变化，请重新审查：' + name);
    }
  }
  return info;
}

async function copyChecked(from, to, name, expected) {
  const bytes = await fs.readFile(await safePath(from, name));
  if (sha256(bytes) !== expected) throw new Error('准备期间文件已变化：' + name);
  const destination = await safePath(to, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx' });
}

async function recordDiff(record, original, staged, operations, source) {
  const beforeDir = path.join(record, 'before'), afterDir = path.join(record, 'after');
  await fs.mkdir(beforeDir);
  await fs.mkdir(afterDir);
  const allowed = new Set(operations.filter(op => op.type === 'file').map(op => op.destination));
  if (operations.some(op => op.type === 'dependency')) {
    allowed.add('pakku.json');
    allowed.add('pakku-lock.json');
  }
  const changes = [];
  for (const name of [...new Set([...original.source, ...staged.source])].sort()) {
    const before = original.hashes[name] ?? null, after = staged.hashes[name] ?? null;
    if (before === after) continue;
    if (!allowed.has(name)) throw new Error('准备过程中还改动了未选定的文件：' + name);
    const relative = path.relative(source, path.resolve(original.dir, name));
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      throw new Error('写入路径位于采集实例内：' + name);
    }
    if (before !== null) await copyChecked(original.dir, beforeDir, name, before);
    if (after !== null) await copyChecked(staged.dir, afterDir, name, after);
    changes.push({ path: name, before, after });
  }
  const diff = await run('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', 'diff', '--no-index',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--', 'before', 'after'], { cwd: record, capture: true });
  if (diff.code !== 1) requireSuccess(diff);
  await fs.writeFile(path.join(record, 'changes.diff'), diff.stdout);
  return { changes, diffSha256: sha256(diff.stdout) };
}

export async function prepareSelection(root, target, featureIds) {
  const context = await evidence(root, target);
  const proposal = await readJson(await safePath(root, '.intake/current/proposal.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error('请将功能提案写入 .intake/current/proposal.json');
    throw error;
  });
  const features = selectFeatures(proposal, featureIds, context);
  const operations = selectedOperations(features);
  const original = await checkBaseline(root, context, operations);
  const dependencyOps = operations.filter(op => op.type === 'dependency');
  await verifySelectionSources(context.manifest, dependencyOps);

  const store = await safePath(root, '.work/prepared');
  await fs.mkdir(store, { recursive: true });
  const temp = await fs.mkdtemp(path.join(store, '.preparing-'));
  try {
    const dir = path.join(temp, 'target');
    await fs.mkdir(dir);
    for (const name of original.source) await copyChecked(original.dir, dir, name, original.hashes[name]);
    await stageFileOperations(dir, operations.filter(op => op.type === 'file'), context);
    const dependencies = await prepareDependencies(root, dir, dependencyOps, context);
    const staged = await inspectTarget(root, { ...target, path: path.relative(root, dir).split(path.sep).join('/') });
    const record = path.join(temp, 'record');
    await fs.mkdir(record);
    const { changes, diffSha256 } = await recordDiff(record, original, staged, operations, context.manifest.source);
    const plan = { schema: 1, preparedAt: new Date().toISOString(), scanId: context.manifest.scanId, reviewHash: context.reviewHash,
      target, features, dependencies, changes, diffSha256 };
    const bytes = json(plan), id = sha256(bytes);
    await fs.writeFile(path.join(record, 'plan.json'), bytes);
    const destination = await safePath(store, id);
    try {
      await fs.rename(record, destination);
    } catch (error) {
      // Equivalent selections can produce the same preview concurrently.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) ||
          sha256(await fs.readFile(await safePath(destination, 'plan.json'))) !== id) throw error;
    }
    return { id, plan, directory: destination };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function applyPrepared(root, target, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('请用 --prepared 指定已核对的完整预览编号');
  const directory = await safePath(root, '.work/prepared/' + id);
  const raw = await fs.readFile(await safePath(directory, 'plan.json'));
  if (sha256(raw) !== id) throw new Error('预览内容已变化，请重新准备');
  const plan = JSON.parse(raw.toString('utf8'));
  if (plan.schema !== 1 || !isDeepStrictEqual(plan.target, target)) throw new Error('这个预览属于不同的 Target 定义');
  if (sha256(await fs.readFile(await safePath(directory, 'changes.diff'))) !== plan.diffSha256) throw new Error('预览差异已变化，请重新准备');
  const operations = selectedOperations(plan.features);
  const verified = async () => {
    const context = await evidence(root, target);
    if (context.reviewHash !== plan.reviewHash || context.manifest.scanId !== plan.scanId) throw new Error('采集或审查已更换，请重新准备');
    await checkBaseline(root, context, operations);
    await verifySelectionSources(context.manifest, operations);
  };
  if (!plan.changes.length) {
    await verified();
    return { plan, alreadyApplied: true };
  }
  const { alreadyApplied } = await publishChanges(root, target, await safePath(directory, 'after'), plan.changes, verified);
  try {
    const { out } = await build(root, target);
    return { plan, alreadyApplied, out };
  } catch (error) {
    throw new Error(`批准的文件已写入 ${target.path}，构建失败：${error.message}\n可用 pnpm build --target ${target.id} 重试。差异见 ${path.join(directory, 'changes.diff')}`);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectArchive } from './archive.mjs';
import { checkTarget, inspectTarget } from './check.mjs';
import { exportPakku, run, sha256, verifiedTool } from './pakku.mjs';
import { filesUnder, safePath } from './workspace.mjs';

function verifyOverrides(entries, kind, { mapping, hashes }) {
  const checkFile = (entry, source) => {
    if (!Object.hasOwn(entries, entry) || sha256(entries[entry]) !== hashes[source]) {
      throw new Error(`${kind} 导出遗漏/修改覆盖资源: ${source}`);
    }
  };
  if (kind === 'modrinth') {
    for (const item of mapping) checkFile(item.archivePath, item.source);
    return;
  }

  // Flat exports place the chosen side's file over the common one at the same destination.
  const side = kind === 'serverpack' ? 'server' : 'client';
  const prefix = kind === 'curseforge' ? 'overrides/' : '';
  const expected = new Map();
  for (const layer of ['common', side]) {
    for (const item of mapping) {
      if (item.side === layer) expected.set(item.destination, item.source);
    }
  }
  for (const [destination, source] of expected) checkFile(prefix + destination, source);
  for (const { destination, source } of mapping) {
    const entry = entries[prefix + destination];
    if (!expected.has(destination) && entry && sha256(entry) === hashes[source]) {
      throw new Error(`${kind} 导出包含另一侧的覆盖资源: ${source}`);
    }
  }
}

function fingerprint(hashes, tool) {
  return sha256(JSON.stringify({ hashes, pakku: tool.sha256 }));
}

export async function build(root, target, options = {}) {
  const info = await checkTarget(root, target, options);
  const loaders = Object.fromEntries(Object.entries(info.lock.loaders).map(([name, version]) => [
    ({ fabric: 'fabric-loader', quilt: 'quilt-loader' })[name] ?? name, version,
  ]));
  const tool = await verifiedTool(root);
  const sourceFingerprint = fingerprint(info.hashes, tool);
  const workRoot = await safePath(root, '.work');
  await fs.mkdir(workRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(workRoot, `${target.id}-`));
  for (const file of info.source) {
    const bytes = await fs.readFile(await safePath(info.dir, file));
    if (sha256(bytes) !== info.hashes[file]) throw new Error('复制期间源文件发生变化: ' + file);
    const dest = path.join(work, file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes, { flag: 'wx' });
  }
  await exportPakku(root, work, options);

  const found = (await filesUnder(work)).filter(file =>
    file.startsWith('build/') && !file.startsWith('build/.cache/') && /\.(mrpack|zip)$/.test(file));
  const artifacts = [];
  let dependencies = { minecraft: info.lock.mc_versions[0], ...loaders };
  for (const kind of target.artifacts) {
    const extension = kind === 'modrinth' ? '.mrpack' : '.zip';
    const matches = found.filter(file => file.startsWith(`build/${kind}/`) && file.endsWith(extension));
    if (matches.length !== 1) throw new Error(`${kind} 期望 1 份产物，实际 ${matches.length}。准备区: ${work}`);
    const [source] = matches;
    const bytes = await fs.readFile(await safePath(work, source));
    const entries = inspectArchive(bytes, kind);
    verifyOverrides(entries, kind, info);
    if (kind === 'modrinth') {
      dependencies = JSON.parse(Buffer.from(entries['modrinth.index.json']).toString('utf8')).dependencies;
      const declaredLoaders = Object.keys(dependencies).filter(name => name !== 'minecraft');
      if (!info.lock.mc_versions.includes(dependencies.minecraft) ||
          (Object.keys(loaders).length && !declaredLoaders.length) ||
          declaredLoaders.some(name => dependencies[name] !== loaders[name])) {
        throw new Error('MRPACK 中的 Minecraft / Loader 与目标锁文件不匹配');
      }
    }
    const basename = path.basename(source);
    const name = artifacts.some(item => item.name.toLowerCase() === basename.toLowerCase())
      ? `${kind}-${basename}` : basename;
    artifacts.push({ source, bytes, kind, name, sha256: sha256(bytes), size: bytes.length });
  }
  const current = await inspectTarget(root, target);
  if (fingerprint(current.hashes, await verifiedTool(root)) !== sourceFingerprint) {
    throw new Error('构建期间源文件或工具链发生变化，请重新构建');
  }

  const gitOptions = { cwd: root, capture: true };
  const [revision, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], gitOptions),
    run('git', ['status', '--porcelain', '--untracked-files=normal'], gitOptions),
  ]);
  const report = {
    schema: 1, targetId: target.id, version: info.config.version,
    git: revision.code === 0 ? revision.stdout.trim() : null,
    dirty: status.code !== 0 || Boolean(status.stdout.trim()),
    toolchain: tool.chain, sourceFingerprint, lockHash: info.hashes['pakku-lock.json'], configHash: info.hashes['pakku.json'],
    dependencies,
    artifacts: artifacts.map(({ kind, name, sha256, size }) => ({ kind, name, sha256, size })),
    missing: [], uncollected: found.filter(file => !artifacts.some(item => item.source === file)), mapping: info.mapping,
  };

  const outRoot = await safePath(root, `dist/${target.id}`);
  await fs.mkdir(outRoot, { recursive: true });
  const pending = await fs.mkdtemp(path.join(outRoot, '.pending-'));
  // Publish the directory only once all artifacts, the report and checksums are complete.
  const out = path.join(outRoot, 'build-' + path.basename(pending).slice('.pending-'.length));
  for (const { name, bytes } of artifacts) await fs.writeFile(path.join(pending, name), bytes, { flag: 'wx' });
  const reportText = JSON.stringify(report, null, 2) + '\n';
  await fs.writeFile(path.join(pending, 'build-report.json'), reportText);
  const sums = [...artifacts.map(item => `${item.sha256}  ${item.name}`), `${sha256(reportText)}  build-report.json`];
  await fs.writeFile(path.join(pending, 'SHA256SUMS'), sums.join('\n') + '\n');
  await fs.rename(pending, out);
  return { out, report };
}

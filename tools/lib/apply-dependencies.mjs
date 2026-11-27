import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { enrichJarFingerprints } from './intake-scan.mjs';
import { pakku, requireSuccess } from './pakku.mjs';
import { readJson, safePath } from './workspace.mjs';

const platforms = ['modrinth', 'curseforge'];
const algorithms = ['sha512', 'sha256', 'sha1'];
const fileId = release => String(release.versionId ?? release.fileId ?? '');
const key = (platform, id) => platform + ':' + id;

function projectIndex(lock) {
  const byId = new Map(), byPlatform = new Map();
  for (const project of lock.projects ?? []) {
    if (!project.pakku_id || byId.has(project.pakku_id)) throw new Error('锁中 pakku_id 缺失或重复');
    byId.set(project.pakku_id, project);
    for (const [platform, id] of Object.entries(project.id ?? {})) {
      const name = key(platform, id);
      if (byPlatform.has(name)) throw new Error('锁中存在重复的平台项目：' + name);
      byPlatform.set(name, project);
    }
  }
  return { byId, byPlatform };
}

function describe(project) {
  if (!project) return null;
  return {
    pakkuId: project.pakku_id, name: Object.values(project.name ?? project.slug ?? {})[0] ?? project.pakku_id,
    projects: project.id, side: project.side ?? 'BOTH', links: project.pakku_links ?? [],
    files: (project.files ?? []).map(f => ({
      platform: f.type, projectId: String(f.parent_id ?? project.id?.[f.type] ?? ''), fileId: String(f.id),
      fileName: f.file_name, size: f.size, hashes: f.hashes ?? {},
    })),
  };
}

function checkRelease(platform, release, item, lock) {
  const pattern = platform === 'modrinth' ? /^[a-zA-Z0-9]+$/ : /^[1-9]\d*$/;
  if (!pattern.test(release?.projectId ?? '') || !pattern.test(fileId(release ?? {})) ||
      !release.fileName || release.size !== item.size) throw new Error('审查缺少有效的发布文件身份或长度：' + item.path);
  const required = platform === 'modrinth' ? 'sha512' : 'sha1';
  if (!release.hashes?.[required] || !item[required] ||
      algorithms.some(a => release.hashes[a] && release.hashes[a] !== item[a])) {
    throw new Error('发布文件哈希与实例采集不一致：' + item.path);
  }
  if ((release.gameVersions?.length && !release.gameVersions.some(v => lock.mc_versions.includes(v))) ||
      (release.loaders?.length && !release.loaders.some(v => Object.hasOwn(lock.loaders, v)))) {
    throw new Error('发布文件与 Target 的 Minecraft 或 Loader 不兼容：' + item.path);
  }
}

async function planRequests(operations, context, lock, before) {
  const requests = [], fromIds = new Set(), destinations = new Set();
  for (const op of operations) {
    const { action, platform } = op;
    if (op.type !== 'dependency' || !['add', 'update', 'replace', 'remove'].includes(action)) throw new Error('无效的依赖操作');
    const from = before.byId.get(op.from);
    if (action !== 'add') {
      if (!from || from.type !== 'MOD' || fromIds.has(op.from)) throw new Error('需要唯一的现有 Mod pakku_id：' + op.from);
      fromIds.add(op.from);
    } else if (op.from !== undefined) throw new Error('add 不能同时指定 from');
    if (action === 'remove') {
      if (op.path !== undefined || platform !== undefined) throw new Error('移除只接受明确的锁内 from 项目');
      requests.push({ action, from, removeFirst: true });
      continue;
    }
    if (!platforms.includes(platform)) throw new Error('请选择 Modrinth 或 CurseForge 的精确发布文件');
    const reviewed = context.review.items.find(i => i.kind === 'mod' && i.path === op.path);
    const scanned = context.manifest.items.find(i => i.kind === 'mod' && i.path === op.path);
    if (!reviewed || !scanned || reviewed.sha256 !== scanned.sha256 || reviewed.platforms?.[platform]?.status !== 'exact') {
      throw new Error('所选实例 JAR 缺少一致的采集和精确发布记录：' + op.path);
    }
    const item = await enrichJarFingerprints(context.manifest.source, scanned);
    const release = reviewed.platforms[platform].release;
    checkRelease(platform, release, item, lock);
    const identity = key(platform, release.projectId);
    if (destinations.has(identity)) throw new Error('同一平台项目被多次选择：' + identity);
    destinations.add(identity);
    const existing = before.byPlatform.get(identity);
    const related = new Set();
    for (const p of platforms) {
      const match = reviewed.platforms[p];
      if (match?.status !== 'exact') continue;
      const known = before.byPlatform.get(key(p, match.release?.projectId));
      if (known) {
        checkRelease(p, match.release, item, lock);
        related.add(known);
      }
    }
    if ((action === 'add' && related.size) || (action === 'update' && existing !== from) ||
        (action === 'replace' && !related.has(from)) || [...related].some(prior => prior !== from)) {
      throw new Error('操作与锁内平台项目不对应；不同项目请明确选择移除旧项目和新增新项目：' + op.path);
    }
    const releases = { [platform]: release };
    // In a multiplatform pack both precise project:file selectors belong to the same JAR.
    for (const p of platforms) {
      if (p === platform || (lock.target !== 'multiplatform' && lock.target !== p)) continue;
      const peer = reviewed.platforms[p];
      if (peer?.status === 'exact') {
        checkRelease(p, peer.release, item, lock);
        const prior = before.byPlatform.get(key(p, peer.release.projectId));
        if (prior && prior !== from) throw new Error('另一平台的项目已被其他锁条目占用：' + p + '/' + peer.release.projectId);
        releases[p] = peer.release;
      }
    }
    requests.push({ action, from, platform, releases, item, removeFirst: action === 'replace' && !existing });
  }
  return requests;
}

function verifyLockedRelease(project, platform, release, item, lock) {
  const files = (project?.files ?? []).filter(f => f.type === platform);
  const [file] = files;
  const required = platform === 'modrinth' ? 'sha512' : 'sha1';
  if (project?.type !== 'MOD' || files.length !== 1 || String(file.id) !== fileId(release) || file.file_name !== release.fileName || file.size !== item.size ||
      (file.parent_id != null && String(file.parent_id) !== String(release.projectId)) ||
      file.hashes?.[required]?.toLowerCase() !== item[required] ||
      algorithms.some(a => file.hashes?.[a] && item[a] && file.hashes[a].toLowerCase() !== item[a]) ||
      (file.mc_versions?.length && !file.mc_versions.some(v => lock.mc_versions.includes(v))) ||
      (file.loaders?.length && !file.loaders.some(v => Object.hasOwn(lock.loaders, v)))) {
    throw new Error('Pakku 未锁定已审查的兼容发布文件：' + platform + '/' + release.projectId + ':' + fileId(release));
  }
}

function linkedProjects(project, index) {
  const linked = (project.pakku_links ?? []).map(id => index.byId.get(id));
  for (const file of project.files ?? []) {
    for (const id of file.required_dependencies ?? []) linked.push(index.byPlatform.get(key(file.type, id)));
  }
  return linked;
}

function previousProject(project, before) {
  const known = [before.byId.get(project.pakku_id)];
  for (const [platform, id] of Object.entries(project.id ?? {})) known.push(before.byPlatform.get(key(platform, id)));
  const unique = [...new Set(known.filter(Boolean))];
  if (unique.length > 1) throw new Error('Pakku 合并了多个原锁项目，无法确认预期变更');
  return unique[0];
}

function summarize(before, after, requests, lock) {
  const originals = new Set(requests.map(r => r.from).filter(Boolean));
  const selected = new Set();
  for (const request of requests) {
    if (request.action === 'remove') {
      if (after.byId.has(request.from.pakku_id) || Object.entries(request.from.id ?? {}).some(([p, id]) => after.byPlatform.has(key(p, id)))) {
        throw new Error('Pakku 未移除指定项目：' + request.from.pakku_id);
      }
      continue;
    }
    const project = after.byPlatform.get(key(request.platform, request.releases[request.platform].projectId));
    if (request.removeFirst && after.byId.has(request.from.pakku_id) && after.byId.get(request.from.pakku_id) !== project) {
      throw new Error('Pakku 未替换指定的旧项目：' + request.from.pakku_id);
    }
    for (const [platform, release] of Object.entries(request.releases)) {
      if (after.byPlatform.get(key(platform, release.projectId)) !== project) throw new Error('不同平台的发布文件未归入同一项目');
      verifyLockedRelease(project, platform, release, request.item, lock);
      for (const dep of release.dependencies ?? []) {
        if (dep.type !== 'required') continue;
        const parent = dep.projectId && after.byPlatform.get(key(platform, dep.projectId));
        const candidates = dep.projectId ? (parent ? [parent] : []) : [...after.byId.values()];
        if ((dep.projectId && !parent) || (dep.versionId && !candidates.some(candidate =>
          candidate.files?.some(f => f.type === platform && String(f.id) === String(dep.versionId))))) {
          throw new Error('Pakku 未解析发布方声明的必需依赖：' + key(platform, dep.projectId ?? dep.versionId));
        }
      }
    }
    // Platform lookup by Pakku can add a second distribution. Its file must still contain the reviewed bytes.
    for (const file of project.files ?? []) {
      if (Object.hasOwn(request.releases, file.type)) continue;
      const available = algorithms.filter(a => file.hashes?.[a] && request.item[a]);
      if (file.size !== request.item.size || !available.length ||
          available.some(a => file.hashes[a].toLowerCase() !== request.item[a])) {
        throw new Error('Pakku 为所选项目关联了无法核实或含不同字节的另一平台文件，请分别审查两份发布文件：' + file.file_name);
      }
    }
    if (selected.has(project)) throw new Error('多个所选操作指向同一项目');
    selected.add(project);
  }

  const closure = new Set(selected);
  for (const project of closure) {
    for (const dependency of linkedProjects(project, after)) {
      if (!dependency) throw new Error('Pakku 候选缺少必需依赖或含失效关联：' + project.pakku_id);
      closure.add(dependency);
    }
  }
  const touchedIds = new Set([...originals, ...closure].map(p => p.pakku_id));
  for (const project of closure) {
    const old = previousProject(project, before);
    if (old) touchedIds.add(old.pakku_id);
  }
  const seen = new Set(), changes = [];
  function record(kind, direct, old, current) {
    const a = describe(old), b = describe(current);
    changes.push({ kind, direct, name: (b ?? a).name, before: a, after: b });
  }
  for (const project of after.byId.values()) {
    for (const id of project.pakku_links ?? []) {
      if (before.byId.has(id) && !after.byId.has(id)) throw new Error('锁中仍有项目关联已移除的 pakku_id：' + id);
    }
    const old = previousProject(project, before);
    if (old) {
      if (seen.has(old)) throw new Error('Pakku 将一个原锁项目拆成了多项');
      seen.add(old);
    }
    if (!old) {
      if (!closure.has(project)) throw new Error('Pakku 引入了未选项目的无关依赖：' + project.pakku_id);
      record('add', selected.has(project), null, project);
      continue;
    }
    if (isDeepStrictEqual(old, project)) continue;
    if (!closure.has(project)) {
      const { pakku_links: prev = [], ...oldCore } = old;
      const { pakku_links: next = [], ...nextCore } = project;
      const links = new Set([...prev, ...next]);
      if (!isDeepStrictEqual(oldCore, nextCore) || [...links].some(id =>
        prev.includes(id) !== next.includes(id) && !touchedIds.has(id))) throw new Error('Pakku 改动了无关的原锁项目：' + old.pakku_id);
    }
    record('update', selected.has(project), old, project);
  }
  for (const old of before.byId.values()) {
    if (seen.has(old)) continue;
    if (!requests.some(r => r.removeFirst && r.from === old)) throw new Error('Pakku 意外移除了原锁项目：' + old.pakku_id);
    record('remove', true, old, null);
  }
  // A removed project can still be required by an otherwise unchanged installed mod.
  for (const project of after.byId.values()) {
    for (const file of project.files ?? []) {
      for (const id of file.required_dependencies ?? []) {
        const identity = key(file.type, id);
        if (before.byPlatform.has(identity) && !after.byPlatform.has(identity)) throw new Error('仍有项目需要已移除依赖：' + identity);
      }
    }
  }
  return { changes };
}

export async function prepareDependencies(root, stagedTargetDir, operations, context) {
  if (!operations.length) return { changes: [] };
  const dir = await fs.realpath(stagedTargetDir);
  const packs = await safePath(await fs.realpath(root), 'packs');
  const relative = path.relative(packs, dir);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Pakku 依赖操作只能在 Target 的临时副本中执行');
  }
  const lockPath = await safePath(dir, 'pakku-lock.json');
  const original = await readJson(lockPath);
  const before = projectIndex(original);
  const requests = await planRequests(operations, context, original, before);
  const run = async args => requireSuccess(await pakku(root, dir, ['--yes', ...args], {
    capture: true, execute: context.execute, java: context.java,
  }));
  for (const { from, removeFirst } of requests) {
    if (!removeFirst) continue;
    const id = Object.values(from.id ?? {}).find(value => value != null && String(value).length);
    if (!id) throw new Error('原锁项目缺少可交给 Pakku 的平台 ID：' + from.pakku_id);
    await run(['rm', '--no-deps', '--', String(id)]);
  }
  for (const { releases } of requests) {
    if (!releases) continue;
    const args = ['add', 'prj'];
    for (const [platform, release] of Object.entries(releases)) {
      args.push(platform === 'modrinth' ? '--mr' : '--cf', release.projectId + ':' + fileId(release));
    }
    await run(args);
  }
  const current = await readJson(lockPath);
  const { projects: oldProjects, ...oldHeader } = original;
  const { projects: newProjects, ...newHeader } = current;
  if (!isDeepStrictEqual(oldHeader, newHeader)) throw new Error('Pakku 改动了锁文件中的 Target 或版本信息');
  return summarize(before, projectIndex(current), requests, current);
}

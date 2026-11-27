import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectTarget } from './check.mjs';
import { inspectJar } from './intake-jar.mjs';
import { enrichJarFingerprints } from './intake-scan.mjs';
import { lookupReleases } from './review-platforms.mjs';
import { createTargetComparison, isTargetMod } from './review-target.mjs';
import { readJson, safePath } from './workspace.mjs';

async function readManifest(root) {
  try {
    const manifest = await readJson(await safePath(root, '.intake/current/manifest.json'));
    if (manifest.schema !== 1 || !manifest.scanId || !path.isAbsolute(manifest.source) || !Array.isArray(manifest.items)) {
      throw new Error('采集清单格式无效，请重新运行 pnpm intake');
    }
    return manifest;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('没有找到当前采集，请先运行 pnpm intake "<游戏目录>"');
    throw error;
  }
}

function compatibility(published, target) {
  if (!published?.length || !target.length) return 'unknown';
  const covered = target.filter(value => published.includes(value));
  if (!covered.length) return 'mismatch';
  return covered.length === target.length ? 'matches' : 'partial';
}

// A SHA-256 identifies content even if an old intake recorded several names for it.
async function resolveMods(manifest, info, compare, options, issues) {
  const groups = Map.groupBy(manifest.items.filter(item => item.kind === 'mod'), item => item.sha256);
  const samples = new Map();
  const queries = [];
  const hasLockedFiles = info.lock.projects?.some(project => project.files?.length);
  for (const [hash, copies] of groups) {
    let sample = copies[0];
    if (compare(sample).status !== 'locked' && (hasLockedFiles || !options.offline)) {
      const errors = [];
      for (const item of copies) {
        try {
          sample = await enrichJarFingerprints(manifest.source, item, { needCurseForge: !options.offline && !!options.curseforgeKey });
          break;
        } catch (error) {
          errors.push({ path: item.path, reason: '补算旧采集指纹失败：' + error.message });
        }
      }
      if (errors.length === copies.length) issues.push(...errors);
    }
    samples.set(hash, sample);
    if (compare(sample).status !== 'locked') queries.push(sample);
  }
  const releases = await lookupReleases(queries, options);
  for (const result of releases.values()) {
    for (const match of Object.values(result)) {
      if (match.status !== 'exact') continue;
      const { gameVersions, loaders } = match.release;
      match.compatibility = {
        minecraft: compatibility(gameVersions, info.lock.mc_versions),
        loader: compatibility(loaders, Object.keys(info.lock.loaders)),
      };
    }
  }
  return { samples, releases };
}

async function identityConflicts(items, info, target, issues) {
  const groups = new Map();
  const metadata = new Map();
  function add(mods, location) {
    const seen = new Set();
    for (const mod of mods) {
      if (!mod.id || !mod.version) continue;
      const key = JSON.stringify([mod.id, mod.version]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, { id: mod.id, version: mod.version, files: [] });
      groups.get(key).files.push(location);
    }
  }
  for (const item of items) {
    if (item.kind !== 'mod') continue;
    const mods = item.jar?.mods ?? [];
    metadata.set(item.sha256, mods);
    add(mods, { scope: 'instance', path: item.path, sha256: item.sha256 });
  }
  if (!groups.size) return [];
  for (const mapping of info.mapping) {
    if (!isTargetMod(mapping.destination, info.config)) continue;
    const hash = info.hashes[mapping.source];
    const projectPath = target.path + '/' + mapping.source;
    if (!metadata.has(hash)) {
      const file = await fs.open(await safePath(info.dir, mapping.source), 'r');
      try {
        const parsed = await inspectJar(file, (await file.stat()).size);
        const digest = createHash('sha256');
        for await (const bytes of file.createReadStream({ start: 0, autoClose: false })) digest.update(bytes);
        if (digest.digest('hex') !== hash) throw new Error('审查期间目标 JAR 已变化：' + projectPath);
        metadata.set(hash, parsed.mods);
        for (const reason of parsed.issues ?? []) issues.push({ path: projectPath, reason });
      } finally {
        await file.close();
      }
    }
    add(metadata.get(hash), { scope: 'target', path: projectPath, side: mapping.side, sha256: hash });
  }
  return [...groups.values()].filter(group => group.files.some(file => file.scope === 'instance') &&
    new Set(group.files.map(file => file.sha256)).size > 1);
}

// Hold the intake writer's lock only while publishing. A new scan can proceed while APIs are busy.
async function publish(root, review) {
  const pending = await safePath(root, '.intake/.pending');
  try {
    await fs.mkdir(pending);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('采集结果正在更新或上次操作已中断，请检查 .intake/.pending/ 后重新审查');
    throw error;
  }
  try {
    if ((await readManifest(root)).scanId !== review.scanId) throw new Error('采集结果已更换，请重新审查');
    const staged = path.join(pending, 'review.json');
    await fs.writeFile(staged, JSON.stringify(review, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(staged, await safePath(root, '.intake/current/review.json'));
  } finally {
    await fs.rm(pending, { recursive: true, force: true });
  }
}

export async function reviewIntake(root, target, { offline = false, curseforgeKey = process.env.CURSEFORGE_API_KEY, fetchImpl = fetch } = {}) {
  const manifest = await readManifest(root);
  const info = await inspectTarget(root, target);
  const compare = createTargetComparison(info, target);
  const issues = [];
  const { samples, releases } = await resolveMods(manifest, info, compare, { offline, curseforgeKey, fetchImpl }, issues);
  const items = manifest.items.map(item => {
    const { path, kind, sha256, enabled, snapshot, duplicateOf } = item;
    const sample = kind === 'mod' ? samples.get(sha256) : undefined;
    const platforms = sample ? releases.get(sha256) : undefined;
    const comparison = compare(sample ? { ...sample, ...item } : item, platforms);
    return { path, kind, sha256, enabled, snapshot, duplicateOf, comparison, platforms };
  });
  const conflicts = await identityConflicts(manifest.items, info, target, issues);
  const review = {
    schema: 1, scanId: manifest.scanId, reviewedAt: new Date().toISOString(), offline,
    target: { id: target.id, path: target.path, platform: info.lock.target, mcVersions: info.lock.mc_versions,
      loaders: info.lock.loaders, lockSha256: info.hashes['pakku-lock.json'], configSha256: info.hashes['pakku.json'] },
    items, conflicts, issues,
  };
  await publish(root, review);
  return review;
}

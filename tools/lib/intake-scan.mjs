import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedPath, portablePath, publicContent } from './content-policy.mjs';
import { CurseForgeFingerprint, normalizedLength } from './curseforge-fingerprint.mjs';
import { inspectJar } from './intake-jar.mjs';
import { safePath } from './workspace.mjs';

const roots = new Map([
  ['mods', 'mod'], ['config', 'config'], ['defaultconfigs', 'config'], ['kubejs', 'kubejs'],
  ['scripts', 'script'], ['datapacks', 'datapack'], ['resourcepacks', 'resourcepack'], ['shaderpacks', 'shaderpack'],
]);
const skippedDirectories = new Set(['logs', 'cache', 'caches', '.cache', '.git', '.intake', 'node_modules']);
export const textExtension = /\.(?:js|mjs|ts|zs|json5?|toml|ya?ml|properties|mcmeta|mcfunction|snbt|glsl|vsh|fsh|lang|txt)$/i;
const jarName = /\.jar(\.(?:disabled?|bak))?$/i;
export const maxTextSize = 256 * 1024;
const chunkSize = 128 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function discover(source, world, issues) {
  const candidates = [];
  async function visit(name, kind, policyPath, optional = false, explicit = false) {
    let entries;
    try {
      const directory = await safePath(source, name);
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (optional && error.code === 'ENOENT') return;
      if (explicit) {
        if (error.code !== 'ENOENT') throw new Error(`无法读取存档数据包目录 ${name}: ${error.message}`);
        issues.push({ path: name, reason: '指定存档没有 datapacks 目录' });
        return;
      }
      issues.push({ path: name, reason: error.message });
      return;
    }
    for (const entry of entries) {
      const relative = `${name}/${entry.name}`;
      const gamePath = `${policyPath}/${entry.name}`;
      const lower = entry.name.toLowerCase();
      if (skippedDirectories.has(lower) || /\.log(?:\.gz)?$/.test(lower) ||
          relative.toLowerCase() === 'kubejs/exported') continue;
      try {
        managedPath(gamePath);
      } catch (error) {
        issues.push({ path: relative, reason: error.message });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(relative, kind, gamePath);
      } else if (entry.isFile()) {
        if (kind !== 'mod' || jarName.test(lower)) candidates.push({ path: relative, kind });
      } else {
        issues.push({ path: relative, reason: '已跳过链接或特殊文件' });
      }
    }
  }

  for (const [directory, kind] of roots) await visit(directory, kind, directory, true);
  if (world !== undefined) {
    portablePath(world);
    if (world.includes('/')) throw new Error('--world 只接受一个存档目录名');
    const dir = `saves/${world}`;
    try {
      const actual = await safePath(source, dir);
      if (!(await fs.stat(actual)).isDirectory()) throw new Error('不是目录');
      await fs.access(actual, constants.R_OK);
    } catch (error) {
      throw new Error(`无法读取指定的存档 ${dir}: ${error.message}`);
    }
    await visit(`${dir}/datapacks`, 'datapack', 'datapacks', false, true);
  }
  return candidates.sort((a, b) => compare(a.path, b.path));
}

function unchanged(before, after) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export async function withStableFile(source, relative, read) {
  const file = await safePath(source, relative);
  const before = await fs.lstat(file);
  if (!before.isFile()) throw new Error('已跳过链接或特殊文件');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!unchanged(before, await handle.stat())) throw new Error('打开前源文件已变化');
    const result = await read(handle, before);
    const currentPath = await safePath(source, relative);
    if (!unchanged(before, await handle.stat()) || !unchanged(before, await fs.lstat(currentPath))) {
      throw new Error('读取期间源文件已变化');
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function readChunks(handle, size, buffer, stats, consume) {
  for (let offset = 0; offset < size; offset += buffer.length) {
    const length = Math.min(buffer.length, size - offset);
    for (let filled = 0; filled < length;) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (!bytesRead) throw new Error('读取期间源文件已变化');
      stats.bytesRead += bytesRead;
      filled += bytesRead;
    }
    consume(buffer.subarray(0, length), offset);
  }
}

async function jarHashes(handle, size, buffer, stats, { needCurseForge, cache, expected }) {
  const sha1 = createHash('sha1'), sha256 = createHash('sha256'), sha512 = createHash('sha512');
  let length = 0;
  await readChunks(handle, size, buffer, stats, bytes => {
    sha1.update(bytes);
    sha256.update(bytes);
    sha512.update(bytes);
    if (needCurseForge) length += normalizedLength(bytes);
  });
  const hashes = { sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
  if (expected && hashes.sha256 !== expected) throw new Error('原 JAR 的 SHA-256 已变化，请重新采集');
  if (!needCurseForge) return hashes;
  const cached = cache?.get(hashes.sha256);
  if (cached) {
    hashes.curseforgeFingerprint = cached.curseforgeFingerprint;
  } else {
    const fingerprint = new CurseForgeFingerprint(length);
    // MurmurHash2 needs the normalized length first. Small files still fit
    // in the read buffer. For large files stream a second pass on this handle.
    if (size <= buffer.length) fingerprint.update(buffer.subarray(0, size));
    else await readChunks(handle, size, buffer, stats, bytes => fingerprint.update(bytes));
    hashes.curseforgeFingerprint = fingerprint.digest();
  }
  return hashes;
}

async function readCandidate(source, candidate, buffer, stats, jarCache) {
  const result = await withStableFile(source, candidate.path, async (handle, stat) => {
    const item = { ...candidate, size: stat.size, mtimeMs: stat.mtimeMs };
    if (item.kind === 'mod') {
      Object.assign(item, await jarHashes(handle, item.size, buffer, stats, { needCurseForge: true, cache: jarCache }));
      stats.filesHashed++;
      item.enabled = /\.jar$/i.test(item.path);
      item.jar = jarCache.get(item.sha256)?.jar;
      if (!item.jar) {
        const { readBytes, ...metadata } = await inspectJar(handle, item.size);
        stats.bytesRead += readBytes;
        item.jar = metadata;
      }
      return { item };
    }
    const hash = createHash('sha256');
    const reviewText = item.kind !== 'config' && item.size <= maxTextSize && textExtension.test(item.path);
    let snapshot = reviewText ? Buffer.allocUnsafe(item.size) : null;
    await readChunks(handle, item.size, buffer, stats, (bytes, offset) => {
      hash.update(bytes);
      if (snapshot) bytes.copy(snapshot, offset);
    });
    item.sha256 = hash.digest('hex');
    stats.filesHashed++;
    if (snapshot) {
      if (snapshot.includes(0) || !isUtf8(snapshot)) snapshot = null;
      else publicContent(snapshot, item.path);
    }
    return { item, snapshot };
  });
  if (result.item.jar) jarCache.set(result.item.sha256, result.item);
  return result;
}

export async function enrichJarFingerprints(source, item, { needCurseForge = false } = {}) {
  if (item.kind !== 'mod' || !item.path?.startsWith('mods/') || !jarName.test(item.path) ||
      !Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) {
    throw new Error('采集清单缺少有效的 Mod 路径、大小或 SHA-256');
  }
  managedPath(item.path);
  const hasFingerprint = Number.isInteger(item.curseforgeFingerprint) &&
    item.curseforgeFingerprint >= 0 && item.curseforgeFingerprint <= 0xffffffff;
  if (/^[0-9a-f]{40}$/.test(item.sha1) && /^[0-9a-f]{128}$/.test(item.sha512) &&
      (!needCurseForge || hasFingerprint)) return item;
  return withStableFile(source, item.path, async (handle, stat) => {
    if (item.size !== stat.size) throw new Error('原 JAR 的大小已变化，请重新采集');
    const hashes = await jarHashes(handle, stat.size, Buffer.allocUnsafe(chunkSize), { bytesRead: 0 }, {
      needCurseForge: needCurseForge && !hasFingerprint, expected: item.sha256,
    });
    return { ...item, ...hashes };
  });
}

export async function scanInstance(source, stage, { world } = {}) {
  const issues = [], items = [];
  const stats = { filesHashed: 0, bytesRead: 0, duplicates: 0, snapshots: 0 };
  const first = new Map(), snapshots = new Map(), jars = new Map();
  const buffer = Buffer.allocUnsafe(chunkSize);
  for (const candidate of await discover(source, world, issues)) {
    let result;
    try {
      result = await readCandidate(source, candidate, buffer, stats, jars);
    } catch (error) {
      issues.push({ path: candidate.path, reason: error.message });
      continue;
    }
    const { item, snapshot } = result;
    if (first.has(item.sha256)) {
      item.duplicateOf = first.get(item.sha256);
      stats.duplicates++;
    } else {
      first.set(item.sha256, item.path);
    }
    if (snapshot) {
      let reference = snapshots.get(item.sha256);
      if (!reference) {
        reference = `files/${item.path}`;
        const output = await safePath(stage, reference);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, snapshot, { flag: 'wx' });
        snapshots.set(item.sha256, reference);
        stats.snapshots++;
      }
      item.snapshot = reference;
    }
    if (item.jar?.issues?.length) {
      issues.push({ path: item.path, reason: item.jar.issues.join('；') });
    }
    items.push(item);
  }
  issues.sort((a, b) => compare(a.path, b.path));
  return { items, issues, stats };
}

import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { managedPath, portablePath, publicContent } from './content-policy.mjs';
import { maxTextSize, textExtension, withStableFile } from './intake-scan.mjs';
import { sha256 } from './pakku.mjs';
import { readReviewEvidence } from './review.mjs';
import { safePath } from './workspace.mjs';

function validateTextCandidate(item, world) {
  const name = portablePath(item.path);
  const worldPrefix = 'saves/' + world + '/';
  if (world && item.kind === 'datapack' && name.startsWith(worldPrefix + 'datapacks/')) {
    managedPath(name.slice(worldPrefix.length));
  } else {
    managedPath(name);
  }
  const config = item.kind === 'config' && /^(?:config|defaultconfigs)\//.test(name);
  const otherText = /^(?:kubejs|scripts|datapacks|resourcepacks|shaderpacks)\//.test(name) ||
    (world && item.kind === 'datapack' && name.startsWith(worldPrefix + 'datapacks/'));
  if ((!config && !otherText) || !(textExtension.test(name) || (config && /\.(?:cfg|conf|ini|xml|hocon)$/i.test(name)))) {
    throw new Error('该候选不是可审阅的文本文件：' + name);
  }
  if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > maxTextSize) {
    throw new Error('文本须在 256 KiB 以内：' + name);
  }
}

async function checkedText(base, relative, expected, remedy, expectedSize) {
  try {
    return await withStableFile(base, relative, async (handle, stat) => {
      if (stat.size > maxTextSize) throw new Error('文件超过 256 KiB：' + relative);
      if (expectedSize !== undefined && expectedSize !== stat.size) throw new Error('文件长度已变化，' + remedy);
      const bytes = Buffer.allocUnsafe(stat.size);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error('读取期间文件长度已变化，' + remedy);
        offset += bytesRead;
      }
      if (sha256(bytes) !== expected) throw new Error('文件 SHA-256 已变化，' + remedy + '：' + relative);
      if (bytes.includes(0) || !isUtf8(bytes)) throw new Error('文件须为不含 NUL 的 UTF-8 文本：' + relative);
      publicContent(bytes, relative);
      return bytes.toString('utf8');
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到文件，' + remedy + '：' + relative);
    throw error;
  }
}

const sideDirectories = { common: 'overrides', client: 'client-overrides', server: 'server-overrides' };

export async function readReviewText(root, target, relative) {
  portablePath(relative);
  const current = await safePath(root, '.intake/current');
  const { manifest, review } = await readReviewEvidence(root, target);
  const item = manifest.items.find(entry => entry.path === relative);
  const reviewed = review.items.find(entry => entry.path === relative);
  if (!item || !reviewed) throw new Error('此路径不在当前采集与审查清单中：' + relative);
  if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.sha256 !== reviewed.sha256 || item.kind !== reviewed.kind ||
      item.snapshot !== reviewed.snapshot || !Array.isArray(reviewed.comparison?.mappings)) {
    throw new Error('审查条目与采集清单不一致，请重新运行 pnpm review');
  }
  validateTextCandidate(item, manifest.world);

  const snapshot = item.snapshot ?? manifest.items.find(entry => entry.sha256 === item.sha256 && entry.snapshot)?.snapshot;
  let instance;
  if (snapshot !== undefined) {
    const owner = manifest.items.find(entry => snapshot === 'files/' + entry.path && entry.snapshot === snapshot && entry.sha256 === item.sha256);
    if (!owner) throw new Error('快照路径与采集清单不一致，请重新运行 pnpm intake');
    validateTextCandidate(owner, manifest.world);
    const value = await checkedText(current, snapshot, item.sha256, '请重新运行 pnpm intake', item.size);
    instance = { text: value, sha256: item.sha256, origin: 'snapshot', snapshot };
  } else {
    if (typeof manifest.source !== 'string' || !path.isAbsolute(manifest.source)) throw new Error('采集来源目录无效');
    const value = await checkedText(manifest.source, relative, item.sha256, '请重新运行 pnpm intake', item.size);
    instance = { text: value, sha256: item.sha256, origin: 'source' };
  }

  const directory = await safePath(root, target.path);
  const mappings = [];
  for (const { projectPath, destination, source, side, sha256: expected } of reviewed.comparison.mappings) {
    if (!Object.hasOwn(sideDirectories, side) || typeof destination !== 'string' ||
        destination.toLowerCase() !== relative.toLowerCase() || projectPath !== target.path + '/' + source ||
        (source !== destination && source !== '.pakku/' + sideDirectories[side] + '/' + destination) ||
        !/^[a-f0-9]{64}$/.test(expected)) throw new Error('目标覆盖映射无效，请重新运行 pnpm review');
    managedPath(destination);
    const value = await checkedText(directory, source, expected, '请重新运行 pnpm review');
    mappings.push({ projectPath, side, sha256: expected, text: value });
  }
  return { path: relative, instance, mappings };
}

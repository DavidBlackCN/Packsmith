import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedPath, portablePath, publicContent } from './content-policy.mjs';
import { maxTextSize, textExtension, withStableFile } from './intake-scan.mjs';
import { sha256 } from './pakku.mjs';
import { readJson, safePath } from './workspace.mjs';

const sides = {
  common: { folder: 'overrides', rule: 'overrides' },
  client: { folder: 'client-overrides', rule: 'client_overrides' },
  server: { folder: 'server-overrides', rule: 'server_overrides' },
};
const kinds = new Map([
  ['mods', 'mod'], ['config', 'config'], ['defaultconfigs', 'config'], ['kubejs', 'kubejs'],
  ['scripts', 'script'], ['datapacks', 'datapack'], ['resourcepacks', 'resourcepack'], ['shaderpacks', 'shaderpack'],
]);

function selectedItem(manifest, name) {
  portablePath(name);
  const item = manifest.items.find(entry => entry.path === name);
  if (!item || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error('采集清单缺少所选文件或有效哈希：' + name);
  }
  let gamePath = name;
  if (manifest.world && !manifest.world.includes('/') && name.startsWith(`saves/${manifest.world}/datapacks/`)) {
    gamePath = name.slice(`saves/${manifest.world}/`.length);
  }
  managedPath(gamePath);
  const [root] = gamePath.split('/');
  if (!gamePath.includes('/') || kinds.get(root) !== item.kind ||
      (item.kind === 'mod' && !/\.jar(?:\.(?:disabled?|bak))?$/i.test(name))) {
    throw new Error('所选文件不属于采集范围：' + name);
  }
  return item;
}

async function readSelected(manifest, item, keepBytes) {
  if (!path.isAbsolute(manifest.source)) throw new Error('采集来源目录无效');
  return withStableFile(manifest.source, item.path, async (handle, stat) => {
    if (stat.size !== item.size) throw new Error('所选源文件的大小已变化，请重新采集：' + item.path);
    const hash = createHash('sha256');
    const result = keepBytes ? Buffer.allocUnsafe(stat.size) : undefined;
    let offset = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (offset + chunk.length > stat.size) throw new Error('读取期间源文件大小已变化：' + item.path);
      hash.update(chunk);
      if (result) chunk.copy(result, offset);
      offset += chunk.length;
    }
    if (offset !== item.size || hash.digest('hex') !== item.sha256) throw new Error('所选源文件的 SHA-256 已变化，请重新采集：' + item.path);
    return result;
  });
}

export async function verifySelectionSources(manifest, operations) {
  const verified = new Set();
  for (const operation of operations) {
    if (operation.type === 'dependency' && operation.action === 'remove' && operation.path === undefined) continue;
    const item = selectedItem(manifest, operation.path);
    if (operation.type === 'dependency' && item.kind !== 'mod') throw new Error('依赖操作需要所选 Mod JAR：' + item.path);
    if (verified.has(item.path)) continue;
    await readSelected(manifest, item, false);
    verified.add(item.path);
  }
}

function validateGameDestination(name) {
  managedPath(name);
  if (name.split('/').some(part => ['.intake', '.agents', '.codex', '.github'].includes(part.toLowerCase())) ||
      /^(?:build|dist|tools)(?:\/|$)|^(?:pakku(?:-lock)?|workspace|toolchain|package)\.json$/i.test(name)) {
    throw new Error('不能将候选写入项目工具或元数据路径：' + name);
  }
}

function reviewedDestination(op, item, reviewed, target, config) {
  const dest = portablePath(op.destination);
  if (!Object.hasOwn(sides, op.side)) throw new Error('请选择有效的分发侧别：' + dest);
  const { folder, rule } = sides[op.side];
  const prefix = '.pakku/' + folder + '/';
  const manual = dest.startsWith(prefix);
  const gamePath = manual ? dest.slice(prefix.length) : dest;
  if (!manual && dest.toLowerCase().startsWith('.pakku/')) throw new Error('覆盖路径与分发侧别不符：' + dest);
  validateGameDestination(gamePath);
  const projectPath = target.path + '/' + dest;
  const { mappings, recommendations } = reviewed.comparison;
  const mapping = mappings.find(entry => entry.source === dest && entry.side === op.side &&
    entry.projectPath === projectPath && entry.destination === gamePath);
  const samePath = gamePath.toLowerCase() === item.path.toLowerCase();
  const newSide = manual && samePath && mappings.some(entry => entry.destination === gamePath) &&
    !mappings.some(entry => entry.side === op.side);
  if (mappings.length && !mapping && !newSide) throw new Error('请选择审查中已有的正式文件及侧别：' + dest);
  if (!manual) {
    const declared = (config[rule] ?? []).some(name => dest === name || dest.startsWith(name + '/'));
    const recommended = recommendations.some(entry => entry.projectPath === projectPath && entry.side === op.side);
    if (!declared || (!mapping && (!samePath || !recommended))) throw new Error('目标不属于此侧别已审查的覆盖规则：' + dest);
  }
  if (mapping) {
    if (!/^[a-f0-9]{64}$/.test(mapping.sha256) ||
        (!samePath && !(item.kind === 'mod' && mapping.matchedBy === 'sha256' && mapping.sha256 === item.sha256))) {
      throw new Error('源文件与目标覆盖映射不一致：' + dest);
    }
  } else if (manual && !samePath) {
    const mods = (config.paths?.mods ?? 'mods').toLowerCase();
    const lower = gamePath.toLowerCase();
    const localJar = item.kind === 'mod' && lower.endsWith('.jar') &&
      (lower.startsWith('mods/') || lower.startsWith(mods + '/'));
    const sameExtension = path.posix.extname(lower) === path.posix.extname(item.path.toLowerCase());
    const relocatedConfig = item.kind === 'config' && /^(?:config|defaultconfigs)\//.test(lower) && sameExtension;
    const internal = item.path.split('/').slice(item.path.startsWith('saves/') ? 4 : 2).join('/');
    const relocatedPack = item.kind === 'datapack' && (internal ? gamePath.endsWith('/' + internal) : sameExtension);
    if (!localJar && !relocatedConfig && !relocatedPack) throw new Error('手动覆盖应保留候选的游戏路径或数据包内部路径：' + dest);
  }
  return mapping?.sha256;
}

async function verifyDestination(directory, dest, expected) {
  let actual;
  try {
    actual = await withStableFile(directory, dest, async handle => {
      const hash = createHash('sha256');
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
      return hash.digest('hex');
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (actual !== expected) throw new Error('目标文件与审查时不同，请重新审查：' + dest);
}

function selectedBytes(op, item, bytes) {
  const binary = item.kind === 'mod' || /\.(?:zip|jar|mrpack|png|jpe?g|gif|ogg|nbt)$/i.test(item.path) ||
    bytes.includes(0) || !isUtf8(bytes);
  if (binary && op.redistributable !== true) throw new Error('请明确确认该二进制资源允许分发：' + item.path);
  if (op.content === undefined) {
    publicContent(bytes, item.path);
    return bytes;
  }
  const text = textExtension.test(item.path) || (item.kind === 'config' && /\.(?:cfg|conf|ini|xml|hocon)$/i.test(item.path));
  if (binary || !text || item.size > maxTextSize || typeof op.content !== 'string' || op.content.includes('\0') ||
      !op.content.isWellFormed() || Buffer.byteLength(op.content) > maxTextSize) {
    throw new Error('content 仅支持 256 KiB 以内的 UTF-8 文本：' + item.path);
  }
  const edited = Buffer.from(op.content);
  publicContent(edited, item.path);
  return edited;
}

// The caller owns the disposable Target copy and discards it if preparation fails.
export async function stageFileOperations(stagedTargetDir, operations, { manifest, review, target }) {
  if (!manifest.scanId || manifest.scanId !== review.scanId || review.target?.id !== target.id || review.target.path !== target.path) {
    throw new Error('采集与所选 Target 的审查不一致，请重新审查');
  }
  const config = await readJson(await safePath(stagedTargetDir, 'pakku.json'));
  const destinations = new Set();
  for (const op of operations) {
    if (op.type !== 'file') throw new Error('仅接受 file 类型的覆盖操作');
    const item = selectedItem(manifest, op.path);
    const reviewed = review.items.find(entry => entry.path === item.path);
    if (reviewed?.sha256 !== item.sha256 || reviewed.kind !== item.kind) throw new Error('所选文件缺少对应审查：' + op.path);
    const expected = reviewedDestination(op, item, reviewed, target, config);
    const key = op.destination.toLowerCase();
    if (destinations.has(key)) throw new Error('同一目标文件被选择多次：' + op.destination);
    destinations.add(key);
    const bytes = selectedBytes(op, item, await readSelected(manifest, item, true));
    await verifyDestination(stagedTargetDir, op.destination, expected);
    const file = await safePath(stagedTargetDir, op.destination);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (expected === undefined) {
      await fs.writeFile(file, bytes, { flag: 'wx' });
    } else {
      // Replacing the directory entry also leaves any external hard links unchanged.
      const temporary = file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      try { await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    }
  }
}

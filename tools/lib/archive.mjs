import { crc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { managedPath, portablePath, publicContent } from './content-policy.mjs';

const MiB = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Read the central directory before allocating buffers for any entry.
function centralDirectory(bytes) {
  if (bytes.length > 512 * MiB || bytes.length < 22) throw new Error('ZIP 大小无效或超过 512 MiB');
  const first = Math.max(0, bytes.length - 22 - 65535);
  for (let end = bytes.length - 22; end >= first; end--) {
    if (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(end + 10);
    const start = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count ||
        count > 20000 || start + bytes.readUInt32LE(end + 12) !== end) {
      throw new Error('不支持分卷/ZIP64 或无效 ZIP 目录');
    }
    return { count, start, end };
  }
  throw new Error('ZIP 缺少完整目录');
}

export function inspectZip(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const { count, start, end } = centralDirectory(bytes);
  const records = [];
  const names = new Map();
  let cursor = start;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end || (flags & 1) || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) !== 0) {
      throw new Error('ZIP 编码/加密/压缩方式不受支持');
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = utf8.decode(nameBytes);
    const key = portablePath(name.replace(/\/$/, '')).toLowerCase();
    if (names.has(key)) throw new Error('ZIP 重复/大小写冲突路径: ' + name);
    names.set(key, name.endsWith('/'));
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) throw new Error('ZIP 含链接或特殊文件');
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 ||
        bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) {
      throw new Error('ZIP 本地头不一致');
    }
    const localName = bytes.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localName + bytes.readUInt16LE(offset + 28);
    const dataEnd = dataStart + compressed;
    if (dataEnd > start || !bytes.subarray(offset + 30, offset + 30 + localName).equals(nameBytes)) {
      throw new Error('ZIP 路径或数据边界不一致');
    }
    total += length;
    if (total > 1024 * MiB || length > 256 * MiB) throw new Error('ZIP 解压大小超限');
    records.push({ name, length, crc, offset, dataEnd });
    cursor = next;
  }
  if (cursor !== end) throw new Error('ZIP 目录长度不符');
  records.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < records.length; i++) {
    if (records[i].offset < records[i - 1].dataEnd) throw new Error('ZIP 文件数据重叠');
  }
  for (const key of names.keys()) {
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      if (names.get(key.slice(0, slash)) === false) throw new Error('ZIP 文件/目录冲突: ' + key);
    }
  }

  const entries = unzipSync(bytes);
  for (const item of records) {
    const contents = entries[item.name];
    if (!Object.hasOwn(entries, item.name) || contents.length !== item.length || crc32(contents) !== item.crc) {
      throw new Error('ZIP 内容长度/CRC 校验失败: ' + item.name);
    }
  }
  return entries;
}

function validateDownload(entry) {
  managedPath(entry.path);
  for (const side of ['client', 'server']) {
    if (!['required', 'optional', 'unsupported'].includes(entry.env?.[side] ?? 'required')) {
      throw new Error(`未知侧别 ${side}: ${entry.path}`);
    }
  }
  if (!/^[a-f0-9]{128}$/.test(entry.hashes?.sha512 ?? '') || !/^[a-f0-9]{40}$/.test(entry.hashes?.sha1 ?? '')) {
    throw new Error(`缺少可信哈希: ${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.fileSize) || entry.fileSize < 0 || entry.fileSize > 512 * MiB ||
      !Array.isArray(entry.downloads) || !entry.downloads.length) {
    throw new Error(`无效/超过 512 MiB 下载记录: ${entry.path}`);
  }
  for (const url of entry.downloads) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('依赖下载仅支持无凭据 HTTPS URL');
  }
}

function validateModrinth(entries) {
  const raw = entries['modrinth.index.json'];
  if (!raw || raw.length > 8 * MiB) throw new Error('缺少或过大的 MRPACK index');
  const index = JSON.parse(utf8.decode(raw));
  if (index.formatVersion !== 1 || index.game !== 'minecraft' || !Array.isArray(index.files) || !index.dependencies?.minecraft) {
    throw new Error('无效 MRPACK index');
  }
  for (const entry of index.files) validateDownload(entry);
  for (const [name, bytes] of Object.entries(entries)) {
    if (name === 'modrinth.index.json') continue;
    const match = /^(overrides|client-overrides|server-overrides)\/(.*)$/.exec(name);
    if (!match) throw new Error('MRPACK 未知内容: ' + name);
    if (match[2]) managedPath(match[2].replace(/\/$/, ''));
    if (!name.endsWith('/')) publicContent(bytes, name);
  }
  // In MRPACK the common files and then the side-specific files overlay the indexed downloads.
  for (const side of ['client', 'server']) {
    const files = new Set();
    for (const entry of index.files) {
      if (entry.env?.[side] === 'unsupported') continue;
      const key = entry.path.toLowerCase();
      if (files.has(key)) throw new Error(`MRPACK ${side} 依赖路径重复: ${entry.path}`);
      files.add(key);
    }
    for (const prefix of ['overrides/', side + '-overrides/']) {
      for (const name of Object.keys(entries)) {
        if (name.startsWith(prefix) && !name.endsWith('/')) files.add(name.slice(prefix.length).toLowerCase());
      }
    }
    for (const file of files) {
      for (let slash = file.indexOf('/'); slash >= 0; slash = file.indexOf('/', slash + 1)) {
        if (files.has(file.slice(0, slash))) throw new Error(`MRPACK ${side} 文件/目录冲突: ${file}`);
      }
    }
  }
}

export function inspectArchive(bytes, kind) {
  const entries = inspectZip(bytes);
  if (kind === 'modrinth') validateModrinth(entries);
  if (kind === 'curseforge') {
    if (!entries['manifest.json']) throw new Error('缺少 CurseForge manifest');
    const manifest = JSON.parse(utf8.decode(entries['manifest.json']));
    if (manifest.manifestVersion !== 1 || !manifest.minecraft?.version || !Array.isArray(manifest.files) ||
        manifest.files.some(f => !Number.isSafeInteger(f.projectID) || !Number.isSafeInteger(f.fileID))) {
      throw new Error('无效 CurseForge manifest');
    }
  }
  return entries;
}

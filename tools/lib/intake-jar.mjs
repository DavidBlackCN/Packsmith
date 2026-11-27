import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { parse as parseToml } from 'smol-toml';
import yauzl from 'yauzl';

const descriptors = ['fabric.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml'];
const manifestPath = 'META-INF/MANIFEST.MF';
const jarVersion = '${file.jarVersion}';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MiB = 1024 * 1024;

class Unsupported extends Error {}

// yauzl reads each directory entry in small pieces. Reuse a 64 KiB window
// and count only bytes actually read from the caller's open file.
class JarReader extends yauzl.RandomAccessReader {
  constructor(handle, size) {
    super();
    this.handle = handle;
    this.size = size;
    this.readBytes = 0;
    this.start = 0;
    this.window = Buffer.alloc(0);
  }

  async range(start, length) {
    if (start < 0 || start + length > this.size) throw new Error('ZIP 条目超出文件范围');
    if (start < this.start || start + length > this.start + this.window.length) {
      const count = Math.min(this.size - start, Math.max(length, 64 * 1024));
      if (this.readBytes + count > 32 * MiB) throw new Unsupported('ZIP 目录与元数据读取超过 32 MiB');
      const window = Buffer.allocUnsafe(count);
      for (let offset = 0; offset < count;) {
        const { bytesRead } = await this.handle.read(window, offset, count - offset, start + offset);
        this.readBytes += bytesRead;
        if (!bytesRead) throw new Error('JAR 读取期间提前结束');
        offset += bytesRead;
      }
      this.start = start;
      this.window = window;
    }
    return this.window.subarray(start - this.start, start - this.start + length);
  }

  read(buffer, offset, length, position, callback) {
    this.range(position, length).then(data => callback(null, data.copy(buffer, offset)), callback);
  }

  _readStreamForRange(start, end) {
    return Readable.from([this.range(start, end - start)]);
  }
}

async function readText(zip, entry) {
  if (entry.compressedSize > MiB || entry.uncompressedSize > MiB) throw new Unsupported('元数据超过 1 MiB');
  if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Unsupported('不支持此元数据条目的加密或压缩方式');
  const stream = await zip.openReadStreamPromise(entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (crc32(bytes) !== entry.crc32) throw new Error('元数据 CRC 校验失败');
  return utf8.decode(bytes);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function fabricMods(raw) {
  const spec = JSON.parse(raw);
  if (spec.schemaVersion !== undefined && spec.schemaVersion !== 1) throw new Unsupported('不支持此 Fabric 元数据版本');
  if (!text(spec.id) || !text(spec.version)) throw new Error('缺少 Mod ID 或版本');
  const dependencies = [];
  for (const [field, type] of [
    ['depends', 'required'], ['recommends', 'recommended'], ['suggests', 'suggested'],
    ['breaks', 'incompatible'], ['conflicts', 'conflicts'],
  ]) {
    const group = spec[field] ?? {};
    if (typeof group !== 'object' || Array.isArray(group)) throw new Error('依赖声明格式无效');
    for (const [id, versionRange] of Object.entries(group)) {
      if (!(typeof versionRange === 'string' || (Array.isArray(versionRange) && versionRange.every(v => typeof v === 'string')))) {
        throw new Error('依赖版本范围无效');
      }
      dependencies.push({ id, type, versionRange });
    }
  }
  const environment = spec.environment ?? '*';
  if (!['*', 'client', 'server'].includes(environment)) throw new Error('Fabric 环境声明无效');
  return [{
    id: spec.id, version: spec.version, name: text(spec.name), loader: 'fabric',
    license: Array.isArray(spec.license) ? spec.license.filter(value => text(value)) : text(spec.license),
    metadataPath: descriptors[0], side: environment === '*' ? 'both' : environment, dependencies,
  }];
}

function forgeMods(raw, metadataPath) {
  const spec = parseToml(raw);
  if (!Array.isArray(spec.mods) || !spec.mods.length) throw new Error('缺少 [[mods]] 声明');
  // Early NeoForge versions also used META-INF/mods.toml.
  const usesNeoForge = Object.values(spec.dependencies ?? {}).some(group => Array.isArray(group) &&
    group.some(dep => dep?.modId === 'neoforge' && (dep.type ?? 'required') === 'required' && dep.mandatory !== false));
  const loader = metadataPath === descriptors[2] || usesNeoForge ? 'neoforge' : 'forge';
  return spec.mods.map(mod => {
    if (!text(mod.modId)) throw new Error('缺少 modId');
    const declarations = Object.hasOwn(spec.dependencies ?? {}, mod.modId) ? spec.dependencies[mod.modId] : [];
    if (!Array.isArray(declarations)) throw new Error('依赖应为 TOML 表数组');
    const dependencies = declarations.map(dep => {
      if (!text(dep.modId)) throw new Error('依赖缺少 modId');
      const side = (dep.side ?? 'BOTH').toLowerCase();
      const versionRange = dep.versionRange ?? '*';
      if (!['both', 'client', 'server'].includes(side) || typeof versionRange !== 'string' ||
          (dep.mandatory !== undefined && typeof dep.mandatory !== 'boolean')) throw new Error('依赖声明格式无效');
      return {
        id: dep.modId, type: text(dep.type) ?? (dep.mandatory === false ? 'optional' : 'required'),
        versionRange, side,
      };
    });
    const declared = text(mod.version);
    const unresolved = declared?.includes('${');
    return {
      id: mod.modId, name: text(mod.displayName), version: unresolved ? null : declared ?? null,
      ...(unresolved ? { declaredVersion: declared } : {}),
      loader, metadataPath, license: text(spec.license),
      ...(loader === 'forge' && spec.clientSideOnly === true ? { side: 'client' } : {}),
      languageLoader: text(spec.modLoader), languageLoaderVersionRange: text(spec.loaderVersion), dependencies,
    };
  });
}

export async function inspectJar(handle, size) {
  const reader = new JarReader(handle, size);
  const mods = [];
  const issues = [];
  let zip;
  let status = 'unknown';
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(reader, size, { autoClose: false, strictFileNames: true });
    if (zip.entryCount > 100000) throw new Unsupported('JAR 超过 100000 个条目');
    const entries = new Map();
    for await (const entry of zip.eachEntry()) {
      if (!descriptors.includes(entry.fileName) && entry.fileName !== manifestPath) continue;
      if (entries.has(entry.fileName)) throw new Error('JAR 中的元数据路径重复');
      entries.set(entry.fileName, entry);
    }
    for (const name of descriptors) {
      if (!entries.has(name)) continue;
      try {
        const raw = await readText(zip, entries.get(name));
        const found = name === descriptors[0] ? fabricMods(raw) : forgeMods(raw, name);
        mods.push(...found);
      } catch (error) {
        if (error.syscall === 'read') throw error;
        if (status !== 'invalid') status = error instanceof Unsupported ? 'unsupported' : 'invalid';
        // Parser errors can quote arbitrary lines of the original document.
        issues.push(name + (error instanceof Unsupported ? '：' + error.message : '：元数据无效'));
      }
    }
    const unresolved = mods.filter(mod => mod.declaredVersion === jarVersion);
    if (unresolved.length && entries.has(manifestPath)) {
      try {
        const raw = await readText(zip, entries.get(manifestPath));
        const main = raw.replace(/\r\n?/g, '\n').split('\n\n', 1)[0].replace(/\n /g, '');
        const version = /^Implementation-Version: ([^\n]+)$/im.exec(main)?.[1];
        if (version) for (const mod of unresolved) mod.version = version.trim();
      } catch (error) {
        if (error.syscall === 'read') throw error;
        issues.push(manifestPath + '：无法读取 Implementation-Version');
      }
    }
    if (mods.length && status === 'unknown') status = 'recognized';
  } catch (error) {
    if (error.syscall === 'read') throw error;
    status = error instanceof Unsupported ? 'unsupported' : 'invalid';
    issues.push(error instanceof Unsupported ? error.message : '无法读取 JAR 目录或元数据');
  } finally {
    zip?.close();
  }
  return { status, mods, readBytes: reader.readBytes, ...(issues.length ? { issues } : {}) };
}

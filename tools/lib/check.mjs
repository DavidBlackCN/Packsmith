import fs from 'node:fs/promises';
import { filesUnder, relativePath, safePath } from './workspace.mjs';
import { pakku, requireSuccess, sha256 } from './pakku.mjs';
import { managedPath, publicContent } from './content-policy.mjs';

const generated = /^(?:build\/|\.pakku\/(?:shelf|remote|docs|exports)(?:\/|$))/;
const overrides = [
  { side: 'common', rule: 'overrides', folder: 'overrides' },
  { side: 'client', rule: 'client_overrides', folder: 'client-overrides' },
  { side: 'server', rule: 'server_overrides', folder: 'server-overrides' },
];

function validateMetadata(config, lock) {
  if (typeof config?.name !== 'string' || !config.name.trim() ||
      typeof config.version !== 'string' || !config.version.trim()) {
    throw new Error('Pakku name/version 必须非空');
  }
  if (/[\\/:*?"<>|\x00-\x1f]/.test(config.name + config.version)) throw new Error('包名/版本含不安全输出文件名字符');
  if (![1, 2].includes(lock?.lockfile_version) || !['modrinth', 'curseforge', 'multiplatform'].includes(lock.target) ||
      !Array.isArray(lock.mc_versions) || !lock.mc_versions.length || lock.mc_versions.some(v => typeof v !== 'string' || !v) ||
      !lock.loaders || typeof lock.loaders !== 'object' || Array.isArray(lock.loaders) ||
      Object.values(lock.loaders).some(v => typeof v !== 'string' || !v)) {
    throw new Error('Pakku 锁数据无效');
  }
  if (lock.projects !== undefined && !Array.isArray(lock.projects)) throw new Error('Pakku projects 必须是数组');
  for (const location of Object.values(config.paths ?? {})) relativePath(location);
}

function mapOverrides(source, config) {
  const output = new Map();
  const mapping = [];
  for (const { side, rule, folder } of overrides) {
    const claim = (origin, destination) => {
      managedPath(destination);
      const item = { source: origin, destination, side, archivePath: `${folder}/${destination}` };
      for (const scope of side === 'common' ? ['client', 'server'] : [side]) {
        const key = `${scope}/${destination}`.toLowerCase();
        const previous = output.get(key);
        if (previous && (previous.side !== 'common' || side === 'common' ||
            previous.source === origin || previous.destination !== destination)) {
          throw new Error(`重复/冲突输出: ${key} (${previous.source}, ${origin})`);
        }
        output.set(key, item);
      }
      mapping.push(item);
    };

    const rules = config[rule] ?? [];
    if (!Array.isArray(rules)) throw new Error(`${rule} 必须是数组`);
    for (const pattern of rules) {
      relativePath(pattern);
      if (/[!*?{}\[\]]/.test(pattern)) throw new Error(`检查仅支持明确的文件/目录规则，请展开通配符: ${pattern}`);
      if (pattern.startsWith('.pakku/')) throw new Error('manual overrides 自动纳入，不要重复声明 .pakku');
      const matches = source.filter(file => file === pattern || file.startsWith(pattern + '/'));
      if (!matches.length) throw new Error(`override 未匹配文件: ${pattern}`);
      for (const file of matches) claim(file, file);
    }

    const prefix = `.pakku/${folder}/`;
    for (const file of source) {
      if (file.startsWith(prefix)) claim(file, file.slice(prefix.length));
    }
  }
  const declared = new Set(mapping.map(item => item.source));
  for (const file of source) {
    if (!declared.has(file) && (/\.(jar|zip|mrpack)$/i.test(file) || /(^|\/)assets(\/|$)/i.test(file))) {
      throw new Error('归档/资源必须放入正式 overrides 或由 Pakku overrides 规则明确声明: ' + file);
    }
  }
  return { outputs: [...output.keys()], mapping };
}

export async function inspectTarget(root, target) {
  const dir = await safePath(root, target.path);
  const source = (await filesUnder(dir)).filter(file => !generated.test(file));
  const hashes = Object.create(null);
  let config;
  let lock;
  for (const file of source) {
    const gamePath = file.replace(/^\.pakku\/(?:(?:overrides|client-overrides|server-overrides)\/)?/, '');
    managedPath(gamePath);
    const bytes = await fs.readFile(await safePath(dir, file));
    publicContent(bytes, file);
    hashes[file] = sha256(bytes);
    if (file === 'pakku.json') config = JSON.parse(bytes.toString('utf8'));
    if (file === 'pakku-lock.json') lock = JSON.parse(bytes.toString('utf8'));
  }
  validateMetadata(config, lock);
  return { dir, source, hashes, config, lock, ...mapOverrides(source, config) };
}

export async function checkTarget(root, target, options = {}) {
  const info = await inspectTarget(root, target);
  const result = requireSuccess(await pakku(root, info.dir, ['ls'], { ...options, capture: true }));
  // Pakku 1.5.0 may report a parse error with exit code zero.
  if (!/Projects total: \d+/.test(result.stdout)) throw new Error(`Pakku 无法读取工程: ${result.stdout}\n${result.stderr}`);
  return info;
}

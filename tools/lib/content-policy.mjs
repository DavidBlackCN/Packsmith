import { relativePath } from './workspace.mjs';

const internalDirectories = new Set(['.git', '.local', '.cache', '.work', '.pakku', 'node_modules']);
const gameDirectories = new Set([
  'saves', 'logs', 'crash-reports', 'screenshots', 'assets', 'libraries', 'versions', 'pcl', 'hmcl', '.minecraft',
]);
const credentialFiles = new Set(['accounts.json', 'launcher_accounts.json', 'credentials', 'credentials.json']);
const gameFiles = new Set([
  'launcher_profiles.json', 'launcher_settings.json', 'hmclversion.cfg', 'hmcl.json',
  'modpack.cfg', 'usercache.json', 'usernamecache.json', 'session.lock',
]);

export function portablePath(name) {
  relativePath(name);
  for (const component of name.split('/')) {
    if (/[<>"|?*]/.test(component) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(component)) {
      throw new Error(`不安全 Windows 路径: ${name}`);
    }
  }
  return name;
}

// These rules describe paths relative to the game directory, after stripping the archive wrapper.
export function managedPath(name) {
  portablePath(name);
  const parts = name.toLowerCase().split('/');
  const leaf = parts.at(-1);
  if (parts.some(part => internalDirectories.has(part))) throw new Error(`禁止纳管工具内部目录: ${name}`);
  if (gameDirectories.has(parts[0])) throw new Error(`禁止纳管玩家数据/启动器目录: ${name}`);
  if (credentialFiles.has(leaf) || /^\.env(?:\..*)?$/.test(leaf)) throw new Error(`禁止纳管账户或凭据文件: ${name}`);
  if (parts.length === 1 && gameFiles.has(leaf)) throw new Error(`禁止纳管启动器/运行文件: ${name}`);
  return name;
}

export function publicContent(bytes, name) {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  if (/-----BEGIN .*PRIVATE KEY-----|["']?(?:accessToken|refreshToken|curseforge_api_key)["']?\s*[:=]\s*["'][^"'\r\n]+["']/i.test(text)) {
    throw new Error(`疑似凭据: ${name}`);
  }
}

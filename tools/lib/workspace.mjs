import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function relativePath(value) {
  if (typeof value !== 'string' || /[\\:\x00-\x1f]/u.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error(`不安全的相对路径: ${value}`);
  }
  return value;
}

export async function safePath(root, relative) {
  const destination = path.resolve(root, relativePath(relative));
  const anchor = path.parse(destination).root;
  let current = anchor;
  // 同时检查工作区根目录的上级路径，避免经由 junction 写到其他位置。
  for (const part of destination.slice(anchor.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`禁止符号链接/junction: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
  return destination;
}

export async function filesUnder(root, prefix = '') {
  const result = [];
  async function visit(directory) {
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`禁止符号链接/junction: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result.push(name);
      else throw new Error(`非普通文件: ${name}`);
    }
  }
  if (prefix) await safePath(root, prefix);
  await visit(prefix);
  return result.sort();
}

export function isTargetId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(value) && value.trim() === value;
}

export async function loadWorkspace(root) {
  const workspace = await readJson(await safePath(root, 'workspace.json'));
  if (!workspace || Object.keys(workspace).some(key => !['targets', 'defaultTarget'].includes(key)) ||
      !Array.isArray(workspace.targets) || !workspace.targets.length) {
    throw new Error('workspace.json 需要非空的 targets 数组，可选 defaultTarget');
  }
  const ids = new Set();
  const paths = [];
  for (const target of workspace.targets) {
    if (!target || Object.keys(target).some(key => !['id', 'path', 'artifacts'].includes(key)) ||
        !isTargetId(target.id) || ids.has(target.id)) {
      throw new Error('Target 定义无效或 ID 重复');
    }
    ids.add(target.id);
    const relative = relativePath(target.path);
    const key = relative.toLowerCase();
    if (!relative.startsWith('packs/') || paths.some(other =>
      key === other || key.startsWith(other + '/') || other.startsWith(key + '/'))) {
      throw new Error(`Target 路径重复、嵌套或不属于 packs/: ${relative}`);
    }
    paths.push(key);
    const directory = await safePath(root, relative);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error(`Target 不是目录: ${relative}`);
    if (!Array.isArray(target.artifacts) || !target.artifacts.length ||
        new Set(target.artifacts).size !== target.artifacts.length ||
        target.artifacts.some(kind => !['modrinth', 'curseforge', 'serverpack'].includes(kind))) {
      throw new Error(`Target ${target.id} 的 artifacts 无效或重复`);
    }
  }
  if (workspace.defaultTarget !== undefined && !ids.has(workspace.defaultTarget)) {
    throw new Error(`默认 Target 不存在: ${workspace.defaultTarget}`);
  }
  return workspace;
}

export function selectTarget(workspace, explicit) {
  const id = explicit ?? workspace.defaultTarget ??
    (workspace.targets.length === 1 ? workspace.targets[0].id : undefined);
  const target = workspace.targets.find(item => item.id === id);
  if (!target) {
    const choices = workspace.targets.map(item => item.id).join(', ');
    throw new Error(`请用 --target <id> 选择目标，可选: ${choices}`);
  }
  return target;
}

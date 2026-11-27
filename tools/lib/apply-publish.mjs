import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedPath } from './content-policy.mjs';
import { sha256 } from './pakku.mjs';
import { isTargetId, readJson, safePath } from './workspace.mjs';

function validateChanges(rows) {
  if (!Array.isArray(rows)) throw new Error('发布清单无效');
  const names = new Set();
  return rows.map(({ path: name, before, after }) => {
    managedPath(name.replace(/^\.pakku\/(?:overrides|client-overrides|server-overrides)\//, ''));
    if (names.has(name.toLowerCase())) throw new Error('发布清单路径重复: ' + name);
    names.add(name.toLowerCase());
    if (before === after || [before, after].some(hash => hash !== null && !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('发布清单的前后哈希无效: ' + name);
    }
    return { path: name, before, after };
  });
}

async function stat(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function hash(file) {
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error('需要普通文件: ' + file);
  return sha256(await fs.readFile(file));
}

async function hashes(directory, changes) {
  const result = [];
  for (const entry of changes) result.push(await hash(await safePath(directory, entry.path)));
  return result;
}

function sameFile(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}

async function probePaths(directory, changes) {
  const parents = new Set();
  for (const entry of changes) {
    let parent = path.dirname(await safePath(directory, entry.path));
    while (!(await stat(parent))) parent = path.dirname(parent);
    parents.add(path.relative(directory, parent).split(path.sep).join('/'));
  }
  const leaf = '.packsmith-link-' + randomUUID() + '.tmp';
  return [...parents].map(parent => parent ? parent + '/' + leaf : leaf);
}

async function checkLinks(directory, journal, probes, cleanupOnly) {
  const source = await safePath(journal, 'probe');
  const info = await stat(source);
  for (const name of probes) {
    if (!/^\.packsmith-link-[a-f\d-]{36}\.tmp$/.test(path.posix.basename(name))) throw new Error('发布探测路径无效');
    const dest = await safePath(directory, name);
    if (!cleanupOnly) {
      try { await fs.link(source, dest); }
      catch (error) {
        throw new Error(`无法在目标目录建立硬链接；.work 与 Target 须位于同一支持硬链接的文件系统，并允许在此目录创建文件: ${path.dirname(dest)} (${error.code})`);
      }
    }
    if (sameFile(info, await stat(dest))) await fs.unlink(dest);
  }
}

// Move the journal out of consideration atomically, before deleting its contents.
async function retire(journal) {
  const done = journal + '-' + randomUUID() + '.done';
  await fs.rename(journal, done);
  await fs.rm(done, { recursive: true, force: true });
}

async function restore(directory, journal, changes) {
  const conflicts = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    try {
      const saved = await safePath(journal, 'old-' + i);
      const savedInfo = await stat(saved);
      if (change.before !== null && !savedInfo) continue;
      const next = await stat(await safePath(journal, 'new-' + i));
      const dest = await safePath(directory, change.path);
      let current = await stat(dest);
      // A hard link identifies exactly the file this transaction installed. A
      // concurrent rename can put unrelated bytes at the same path.
      const taken = await safePath(journal, 'undo-' + i);
      if (!await stat(taken) && sameFile(next, current)) await fs.rename(dest, taken);
      const moved = await stat(taken);
      if (moved) {
        if (!sameFile(moved, next) || await hash(taken) !== change.after) {
          if (!sameFile(moved, await stat(dest))) await fs.link(taken, dest);
          await fs.unlink(taken);
          throw new Error('文件在回滚期间已被编辑，已保留修改');
        }
        await fs.unlink(taken);
        current = await stat(dest);
      }
      if (!savedInfo) continue;
      if (current && await hash(dest) === change.before) continue;
      if (current) throw new Error('文件已被其他操作修改');
      if (await hash(saved) !== change.before) throw new Error('备份内容与原哈希不同');
      await fs.link(saved, dest);
    } catch (error) {
      conflicts.push(change.path + ' (' + error.message + ')');
    }
  }
  if (conflicts.length) {
    throw new Error(`有文件需要人工核对，备份保留在 ${journal}: ${conflicts.join('、')}`);
  }
  await retire(journal);
}

async function recover(directory, target, journal) {
  if (!await stat(journal)) return;
  const record = await readJson(await safePath(journal, 'journal.json'));
  if (record.target !== target.path || record.schema !== 1) throw new Error('待恢复的发布记录与 Target 不符: ' + journal);
  const changes = validateChanges(record.changes);
  await checkLinks(directory, journal, record.probes, true);
  const current = await hashes(directory, changes);
  if (changes.every((entry, i) => current[i] === entry.after)) await retire(journal);
  else await restore(directory, journal, changes);
}

async function publishLocked(directory, target, stagedDir, changes, verify, parent, journal) {
  await recover(directory, target, journal);
  const current = await hashes(directory, changes);
  if (changes.every((entry, i) => current[i] === entry.after)) return { alreadyApplied: true };
  for (const [i, entry] of changes.entries()) {
    if (current[i] !== entry.before) throw new Error('正式文件与批准时不一致，请重新审查: ' + entry.path);
  }
  const probes = await probePaths(directory, changes);
  const prep = await fs.mkdtemp(path.join(parent, 'prepare-'));
  try {
    for (const [i, entry] of changes.entries()) {
      const source = await safePath(stagedDir, entry.path);
      if (entry.after === null) {
        if (await stat(source)) throw new Error('候选中仍有批准删除的文件: ' + entry.path);
        continue;
      }
      if (!(await stat(source))?.isFile()) throw new Error('候选文件缺失或不是普通文件: ' + entry.path);
      const next = path.join(prep, 'new-' + i);
      await fs.copyFile(source, next);
      if (await hash(next) !== entry.after) throw new Error('候选与批准哈希不符: ' + entry.path);
      if (entry.before !== null) {
        const original = await safePath(directory, entry.path);
        await fs.chmod(next, (await fs.stat(original)).mode & 0o777);
      }
    }
    await fs.writeFile(path.join(prep, 'probe'), '');
    await fs.writeFile(path.join(prep, 'journal.json'), JSON.stringify({ schema: 1, target: target.path, changes, probes }));
    await verify();
    const checked = await hashes(directory, changes);
    for (const [i, entry] of changes.entries()) {
      if (checked[i] !== entry.before) throw new Error('写入前正式文件已变化: ' + entry.path);
    }
    await fs.rename(prep, journal);
  } finally {
    await fs.rm(prep, { recursive: true, force: true });
  }

  try {
    await checkLinks(directory, journal, probes, false);
    for (const [i, entry] of changes.entries()) {
      const dest = await safePath(directory, entry.path);
      if (entry.before !== null) {
        const saved = path.join(journal, 'old-' + i);
        await fs.rename(dest, saved);
        if (await hash(saved) !== entry.before) {
          // Preserve the bytes captured by rename, including a concurrent edit.
          await fs.link(saved, dest);
          await fs.unlink(saved);
          throw new Error('发布时正式文件已变化: ' + entry.path);
        }
      }
      if (entry.after !== null) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        // link publishes complete bytes without replacing a concurrently created file.
        await fs.link(path.join(journal, 'new-' + i), await safePath(directory, entry.path));
      }
    }
    const installed = await hashes(directory, changes);
    for (const [i, entry] of changes.entries()) {
      if (installed[i] !== entry.after) throw new Error('发布期间正式文件已变化: ' + entry.path);
    }
  } catch (error) {
    await checkLinks(directory, journal, probes, true);
    await restore(directory, journal, changes);
    throw error;
  }
  await retire(journal);
  return { alreadyApplied: false };
}

export async function publishChanges(root, target, stagedDir, changes, verify) {
  if (!isTargetId(target.id) || !target.path.startsWith('packs/')) throw new Error('无效的发布 Target');
  const directory = await safePath(root, target.path);
  if (!(await stat(directory))?.isDirectory()) throw new Error('正式 Target 目录不存在: ' + target.path);
  const rows = validateChanges(changes);
  const parent = await safePath(root, '.work/publish');
  await fs.mkdir(parent, { recursive: true });
  const journal = await safePath(parent, target.id + '.journal');
  const lockFile = await safePath(parent, target.id + '.lock');
  let lock;
  try { lock = await fs.open(lockFile, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Target 正在发布或上次发布中断。确认记录的 PID 已退出后，仅移走锁文件再重试: ${lockFile}`);
  }
  try {
    await lock.writeFile(String(process.pid));
    return await publishLocked(directory, target, stagedDir, rows, verify, parent, journal);
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

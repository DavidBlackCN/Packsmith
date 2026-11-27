import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';

// The approved feature retires one locked dependency and adds only its replacement recipe.
export async function verifyApprovedFeature(root, target, other) {
  const cli = (...args) => execFileSync(process.execPath, ['tools/mp.mjs', ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', stdio: 'pipe',
  });
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8' });
  const json = data => JSON.stringify(data, null, 2) + '\n';
  const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  async function put(name, bytes) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const lockPath = target.path + '/pakku-lock.json';
  const lock = await read(lockPath);
  const retired = 'OldRecipes000001';
  lock.projects = [{
    pakku_id: retired, type: 'MOD', side: 'BOTH', slug: { modrinth: 'retired-recipes' },
    name: { modrinth: 'Retired Recipes' }, id: { modrinth: 'OldRecip' },
    files: [{ type: 'modrinth', file_name: 'old.jar', mc_versions: ['1.21.1'], loaders: ['fabric'], release_type: 'release',
      url: 'https://example.invalid/old.jar', id: 'OldV0001', parent_id: 'OldRecip',
      hashes: { sha512: '1'.repeat(128), sha1: '2'.repeat(40) }, required_dependencies: [], size: 123,
      date_published: '2025-01-01T00:00:00Z' }],
  }];
  await put(lockPath, json(lock));
  git('init', '-q');
  git('add', '--', 'packs');
  const game = 'Dev/.minecraft/versions/Playtest';
  const recipe = 'kubejs/server_scripts/plate.js', visual = 'config/visual.json';
  const code = "ServerEvents.recipes(e => e.shapeless('minecraft:heavy_weighted_pressure_plate', ['minecraft:iron_ingot']))\n";
  await put(game + '/' + recipe, code);
  await put(game + '/' + visual, '{"enabled":true}\n');
  cli('intake', path.join(root, game));
  cli('review', '--target', target.id, '--offline');
  const { scanId } = await read('.intake/current/manifest.json');
  const destination = '.pakku/overrides/' + recipe;
  await put('.intake/current/proposal.json', json({ schema: 1, scanId, target: target.id, features: [
    { id: 'recipe', title: '用脚本替代旧配方 Mod', operations: [
      { type: 'file', path: recipe, destination, side: 'common' },
      { type: 'dependency', action: 'remove', from: retired },
    ] },
    { id: 'visual', title: '视觉设置', operations: [{ type: 'file', path: visual, destination: visual, side: 'common' }] },
  ] }));
  const preview = cli('preview', '--feature', 'recipe', '--target', target.id);
  const id = /预览编号：([a-f0-9]{64})/.exec(preview)?.[1];
  assert.ok(id, preview);
  assert.match(preview, /Retired Recipes/);
  const diff = await fs.readFile(path.join(root, '.work/prepared', id, 'changes.diff'), 'utf8');
  assert.ok(diff.includes(code.trim()) && diff.includes('Retired Recipes'));
  assert.doesNotMatch(diff, /visual\.json/);
  const status = () => [git('diff', '--name-only', '--', 'packs'), git('ls-files', '--others', '--exclude-standard', '--', 'packs')]
    .join('\n').split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(status(), []);
  const applying = (...extra) => cli('apply', '--prepared', id, ...extra);
  assert.throws(() => applying('--target', other.id), /Target/);
  await put(game + '/' + recipe, code + '// later edit\n');
  assert.throws(() => applying('--target', target.id), /变化|重新采集|哈希|SHA/);
  assert.deepEqual(status(), []);
  await put(game + '/' + recipe, code);
  const output = applying('--target', target.id);
  assert.match(output, /检查与构建通过/);
  assert.deepEqual(status(), [lockPath, target.path + '/' + destination].sort());
  assert.equal((await read(lockPath)).projects?.length ?? 0, 0);
  const out = /产物：(.+)/.exec(output)[1].trim();
  for (const name of await fs.readdir(out)) {
    if (!/\.(mrpack|zip)$/.test(name)) continue;
    const archive = unzipSync(await fs.readFile(path.join(out, name)));
    const prefix = name.endsWith('.mrpack') ? 'overrides/' : '';
    assert.equal(Buffer.from(archive[prefix + recipe]).toString('utf8'), code);
    assert.ok(!archive[prefix + visual]);
  }
  console.log('两个功能仅写入所选配方及批准移除的依赖，验证了 Git 差异、过期候选拦截和实际产物。');
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { reviewIntake } from '../tools/lib/review.mjs';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const config = 'config/demo.toml', script = 'kubejs/server_scripts/recipe.js';
const sourceJar = 'mods/experiment.jar', duplicateJar = 'mods/renamed.jar.disabled';
const targetJar = '.pakku/overrides/mods/published.jar';
const json = data => JSON.stringify(data, null, 2) + '\n';
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function put(directory, relative, bytes) {
  const file = path.join(directory, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

async function tree(directory) {
  const hashes = {};
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(directory, file)] = sha('sha256', await fs.readFile(file));
  }
  return hashes;
}

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temp, 'Packsmith 审查 '));
  t.after(async () => {
    assert.equal(path.dirname(base), temp);
    await fs.rm(base, { recursive: true, force: true });
  });
  const project = path.join(base, '项目'), game = path.join(base, '独立实例');
  await fs.cp(path.join(repo, 'tools'), path.join(project, 'tools'), { recursive: true });
  await fs.copyFile(path.join(repo, 'package.json'), path.join(project, 'package.json'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const targets = ['primary', 'alternate'].map(id => ({ id, path: 'packs/' + id, artifacts: ['modrinth'] }));
  const [primary, alternate] = targets;
  await put(project, 'workspace.json', json({ defaultTarget: primary.id, targets }));
  function jar(payload) {
    return zipSync({
      'fabric.mod.json': Buffer.from(json({ schemaVersion: 1, id: 'recipe_tool', version: '1.0.0' })),
      'test-data.txt': Buffer.from(payload),
    });
  }
  const local = jar('local recipe changes');
  await put(game, sourceJar, local);
  await put(game, duplicateJar, local);
  await put(game, config, 'bonus = 7\n');
  await put(game, script, 'throw Error("static text only");\n');
  for (const target of targets) {
    const directory = path.join(project, target.path);
    await put(directory, 'pakku.json', json({ name: target.id, version: '1', overrides: ['config'] }));
    const lock = { target: 'modrinth', mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' }, lockfile_version: 2 };
    if (target === alternate) {
      lock.projects = [{
        type: 'MOD', pakku_id: 'test-recipe-tool', side: 'BOTH', id: { modrinth: 'recipeProject' },
        files: [{ type: 'modrinth', parent_id: 'recipeProject', id: 'recipeFile', file_name: 'recipe.jar',
          size: local.byteLength, hashes: { sha512: sha('sha512', local) } }],
      }];
    }
    await put(directory, 'pakku-lock.json', json(lock));
    await put(directory, config, target === primary ? 'bonus = 1\n' : 'bonus = 7\n');
  }
  await put(project, primary.path + '/' + targetJar, jar('upstream recipe'));
  const forbidFetch = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => process.exit(78);');
  const cli = (...args) => exec(process.execPath, ['--import', forbidFetch, 'tools/mp.mjs', ...args], {
    cwd: project, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, CURSEFORGE_API_KEY: '', PACKSMITH_JAVA: path.join(base, 'missing-java') },
  });
  const current = name => path.join(project, '.intake/current', name);
  return { project, game, primary, alternate, cli, current };
}

test('空工程的 preview 和 review --file 提示所缺输入，退出时保留简短的诊断', async t => {
  const { cli, project, primary, alternate } = await fixture(t);
  await put(project, 'workspace.json', json({ targets: [primary, alternate] }));
  for (const [args, expected] of [
    [['preview'], /--feature <id>/],
    [['preview', '--feature', 'plate', '--target', primary.id], /pnpm intake.*pnpm review/],
    [['review', '--file', config, '--target', primary.id], /pnpm intake.*pnpm review/],
  ]) {
    await assert.rejects(cli(...args), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, expected);
      assert.doesNotMatch(error.stderr, /node:internal|ENOENT/);
      if (args[0] === 'review') assert.equal(error.stdout, '');
      return true;
    });
  }
});

test('离线 CLI 逐 Target 对照：同声明异内容单列、精确命中 Pakku、同一采集保留重复路径', async t => {
  const { project, game, primary, alternate, cli, current } = await fixture(t);
  const beforeGame = await tree(game), beforePacks = await tree(path.join(project, 'packs'));
  const workspace = await fs.readFile(path.join(project, 'workspace.json'));
  await cli('intake', game);
  const manifest = await readJson(current('manifest.json'));
  await cli('review', '--offline');
  const first = await readJson(current('review.json'));
  assert.equal(first.scanId, manifest.scanId);
  assert.equal(first.target.id, primary.id);
  assert.equal(first.offline, true);
  const items = new Map(first.items.map(item => [item.path, item]));
  assert.equal(items.get(duplicateJar).duplicateOf, sourceJar);
  assert.equal(items.get(duplicateJar).enabled, false);
  assert.equal(items.get(sourceJar).platforms.modrinth.status, 'not-queried');
  assert.equal(items.get(sourceJar).platforms.curseforge.status, 'not-queried');
  assert.equal(items.get(config).comparison.status, 'different');
  assert.equal(first.conflicts.length, 1);
  const [conflict] = first.conflicts;
  assert.equal(conflict.id, 'recipe_tool');
  assert.equal(conflict.version, '1.0.0');
  assert.deepEqual(conflict.files.filter(file => file.scope === 'instance').map(file => file.path).sort(), [sourceJar, duplicateJar]);
  const upstream = conflict.files.find(file => file.scope === 'target');
  assert.equal(upstream.path, primary.path + '/' + targetJar);
  assert.notEqual(upstream.sha256, items.get(sourceJar).sha256);

  await cli('review', '--target', alternate.id, '--offline');
  const second = await readJson(current('review.json'));
  assert.equal(second.scanId, manifest.scanId);
  assert.equal(second.target.id, alternate.id);
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.items.find(item => item.path === config).comparison.status, 'same');
  for (const item of second.items.filter(item => item.kind === 'mod')) {
    assert.equal(item.comparison.status, 'locked');
    assert.equal(item.comparison.lockMatches[0].fileId, 'recipeFile');
  }
  assert.deepEqual(await tree(game), beforeGame);
  assert.deepEqual(await tree(path.join(project, 'packs')), beforePacks);
  assert.deepEqual(await fs.readFile(path.join(project, 'workspace.json')), workspace);
  assert.deepEqual(await readJson(current('manifest.json')), manifest);
});

test('review --file 按需显示已核验的文本与侧别，并拒绝把另一个 Target 当作当前依据', async t => {
  const { project, game, primary, alternate, cli } = await fixture(t);
  await cli('intake', game);
  await cli('review', '--offline');
  const read = async (name, target = primary) => JSON.parse((await cli('review', '--target', target.id, '--file', name)).stdout);
  const fromSource = await read(config);
  assert.equal(fromSource.instance.origin, 'source');
  assert.equal(fromSource.instance.text, 'bonus = 7\n');
  assert.deepEqual(fromSource.mappings.map(({ projectPath, side, text }) => [projectPath, side, text]),
    [[primary.path + '/' + config, 'common', 'bonus = 1\n']]);
  const fromSnapshot = await read(script);
  assert.equal(fromSnapshot.instance.origin, 'snapshot');
  assert.equal(fromSnapshot.instance.text, 'throw Error("static text only");\n');
  await assert.rejects(read(config, alternate), error => /其他 Target/.test(error.stderr));
  await put(game, config, 'bonus = 8\n');
  await assert.rejects(read(config), error => /SHA-256 已变化.*intake/.test(error.stderr));
  await put(game, config, 'bonus = 7\n');
  await put(project, primary.path + '/' + config, 'bonus = 2\n');
  await assert.rejects(read(config), error => /SHA-256 已变化.*review/.test(error.stderr));
});

test('模拟 Modrinth 精确命中后将发布文件及目标兼容性写入 review.json', async t => {
  const { project, game, primary, cli, current } = await fixture(t);
  const lockPath = primary.path + '/pakku-lock.json';
  const lock = await readJson(path.join(project, lockPath));
  await put(project, lockPath, json({ ...lock, mc_versions: ['1.21.1', '1.21.2'], loaders: { neoforge: '21.1.172' } }));
  await cli('intake', game);
  const bytes = await fs.readFile(path.join(game, sourceJar));
  const hashes = { sha1: sha('sha1', bytes), sha512: sha('sha512', bytes) };
  const requests = [];
  await reviewIntake(project, primary, {
    curseforgeKey: '',
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return Response.json({
        [hashes.sha512]: {
          project_id: 'recipeProject', id: 'recipeFile', version_number: '1.0.0',
          files: [{ filename: 'recipe-fabric.jar', size: bytes.length, hashes }],
          game_versions: ['1.21.1'], loaders: ['fabric'],
        },
      });
    },
  });
  assert.deepEqual(requests, [{
    url: 'https://api.modrinth.com/v2/version_files', method: 'POST', body: { hashes: [hashes.sha512], algorithm: 'sha512' },
  }]);
  const review = await readJson(current('review.json'));
  assert.equal(review.scanId, (await readJson(current('manifest.json'))).scanId);
  const releases = review.items.filter(item => item.kind === 'mod').map(item => item.platforms.modrinth);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[0], releases[1]);
  const [match] = releases;
  assert.equal(match.status, 'exact');
  assert.deepEqual(match.compatibility, { minecraft: 'partial', loader: 'mismatch' });
  assert.equal(match.release.projectId, 'recipeProject');
  assert.equal(match.release.versionId, 'recipeFile');
  assert.equal(match.release.fileName, 'recipe-fabric.jar');
  assert.deepEqual(match.release.hashes, hashes);
});

test('联网审查等候 API 期间重新采集，旧 scanId 的结果不会写入新的 current', async t => {
  const { project, game, primary, cli, current } = await fixture(t);
  await cli('intake', game);
  const before = await readJson(current('manifest.json'));
  const started = Promise.withResolvers(), resume = Promise.withResolvers();
  const reviewing = reviewIntake(project, primary, {
    curseforgeKey: '',
    fetchImpl: async () => {
      started.resolve();
      await resume.promise;
      return new Response('{}');
    },
  });
  try {
    await Promise.race([started.promise, reviewing.then(() => { throw new Error('审查未走预期的发布查询'); })]);
    await put(game, config, 'bonus = 9\n');
    await cli('intake', game);
  } finally {
    resume.resolve();
  }
  await assert.rejects(reviewing, /重新审查/);
  assert.notEqual((await readJson(current('manifest.json'))).scanId, before.scanId);
  await assert.rejects(fs.access(current('review.json')), { code: 'ENOENT' });
});

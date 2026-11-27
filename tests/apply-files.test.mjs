import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { stageFileOperations, verifySelectionSources } from '../tools/lib/apply-files.mjs';
import { inspectTarget } from '../tools/lib/check.mjs';
import { scanInstance } from '../tools/lib/intake-scan.mjs';
import { createTargetComparison } from '../tools/lib/review-target.mjs';

const recipe = 'kubejs/server_scripts/recipes.js';
const officialRecipe = '.pakku/overrides/' + recipe;
const config = 'config/energy.toml';
const localJar = 'mods/local.jar.disabled';
const pack = 'saves/创作/datapacks/d/data/demo/recipe/test.json';
const operation = (path, destination, side = 'common', extra = {}) => ({ type: 'file', path, destination, side, ...extra });

async function put(directory, key, bytes) {
  const file = path.join(directory, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 文件候选 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = { id: 'one', path: 'packs/one' };
  const source = path.join(root, '实例'), directory = path.join(root, target.path);
  const stage = path.join(root, '副本');
  const intake = path.join(root, '采集');
  await fs.mkdir(intake);
  const archive = zipSync({ 'fabric.mod.json': Buffer.from('{"schemaVersion":1,"id":"local","version":"1"}') });
  await put(source, recipe, 'keep();\nunrelated();\n');
  await put(source, config, 'enabled = 1\n');
  await put(source, 'config/new.toml', 'speed = 7\n');
  await put(source, 'defaultconfigs/side.toml', 'value = 4\n');
  await put(source, localJar, archive);
  await put(source, pack, '{"type":"demo"}');
  await put(source, 'datapacks/test/data/demo/function/select.mcfunction', 'say demo');
  await put(directory, 'pakku.json', '{"name":"Demo","version":"1","overrides":["config"]}');
  await put(directory, 'pakku-lock.json', '{"lockfile_version":2,"target":"modrinth","mc_versions":["1.21.1"],"loaders":{"fabric":"0.16.14"}}');
  await put(directory, officialRecipe, 'base();\n');
  await put(directory, config, 'enabled = 0\n');
  const info = await inspectTarget(root, target);
  const comparison = createTargetComparison(info, target);
  const manifest = { ...(await scanInstance(source, intake, { world: '创作' })), scanId: 'test', source, world: '创作' };
  const review = { scanId: manifest.scanId, target, items: manifest.items.map(item => ({
    ...item, comparison: comparison(item),
  })) };
  await fs.cp(directory, stage, { recursive: true });
  const prepare = (...operations) => stageFileOperations(stage, operations, { manifest, review, target });
  return { directory, stage, prepare, source, manifest, archive };
}

test('仅在 Target 副本写入批准的全文与选中的目录覆盖项，尊重原侧别', async t => {
  const { directory, stage, prepare, source } = await fixture(t);
  const ops = [
    operation(recipe, officialRecipe, 'common', { content: 'base();\nkeep();\n' }),
    operation('config/new.toml', 'config/new.toml'),
    operation('defaultconfigs/side.toml', '.pakku/server-overrides/config/server.toml', 'server'),
  ];
  await prepare(...ops);
  assert.equal(await fs.readFile(path.join(stage, officialRecipe), 'utf8'), 'base();\nkeep();\n');
  assert.equal(await fs.readFile(path.join(stage, 'config/new.toml'), 'utf8'), 'speed = 7\n');
  assert.equal(await fs.readFile(path.join(stage, ops[2].destination), 'utf8'), 'value = 4\n');
  assert.equal(await fs.readFile(path.join(stage, config), 'utf8'), 'enabled = 0\n');
  assert.equal(await fs.readFile(path.join(directory, officialRecipe), 'utf8'), 'base();\n');
  assert.equal(await fs.readFile(path.join(source, recipe), 'utf8'), 'keep();\nunrelated();\n');
});

test('源内容需要与本次采集相符，包括有快照的文本和选定的依赖 JAR', async t => {
  const { source, manifest, archive, prepare } = await fixture(t);
  const edit = operation(recipe, officialRecipe, 'common', { content: 'keep();' });
  const dep = { type: 'dependency', action: 'add', path: localJar };
  await verifySelectionSources(manifest, [edit, dep, { type: 'dependency', action: 'remove', from: 'old' }]);
  await put(source, recipe, 'keep();\nDIFFERENT();\n');
  await assert.rejects(verifySelectionSources(manifest, [edit]), /已变化/);
  await assert.rejects(prepare(edit), /已变化/);
  const modified = Buffer.from(archive);
  modified[0] ^= 1;
  await put(source, localJar, modified);
  await assert.rejects(verifySelectionSources(manifest, [dep]), /SHA-256 已变化/);
  await assert.rejects(verifySelectionSources(manifest, [{ ...dep, path: config }]), /Mod JAR/);
});

test('同一路径可新增客户端覆盖，公共默认值和已有侧别映射保持独立', async t => {
  const { stage, prepare } = await fixture(t);
  const client = '.pakku/client-overrides/' + config;
  await assert.rejects(prepare(operation(config, '.pakku/overrides/' + config)), /已审查|审查中/);
  await prepare(operation(config, client, 'client'));
  assert.equal(await fs.readFile(path.join(stage, client), 'utf8'), 'enabled = 1\n');
  assert.equal(await fs.readFile(path.join(stage, config), 'utf8'), 'enabled = 0\n');
  await assert.rejects(prepare(operation(config, client, 'client')), /重新审查/);
});

test('本地 JAR 经分发确认后可写入所选侧别，世界数据包可选正式加载位置', async t => {
  const { stage, prepare, archive } = await fixture(t);
  const local = operation(localJar, '.pakku/client-overrides/mods/example.jar', 'client');
  await assert.rejects(prepare(local), /允许分发/);
  await assert.rejects(prepare({ ...local, redistributable: true, content: 'anything' }), /UTF-8/);
  await prepare({ ...local, redistributable: true });
  assert.deepEqual(await fs.readFile(path.join(stage, local.destination)), Buffer.from(archive));
  const relocation = '.pakku/overrides/global_packs/required_data/d/data/demo/recipe/test.json';
  const global = '.pakku/overrides/kubejs/data/demo/function/select.mcfunction';
  await prepare(operation(pack, relocation), operation('datapacks/test/data/demo/function/select.mcfunction', global));
  assert.equal(await fs.readFile(path.join(stage, relocation), 'utf8'), '{"type":"demo"}');
  assert.equal(await fs.readFile(path.join(stage, global), 'utf8'), 'say demo');
});

test('拒绝路径越界、未审查的覆盖侧别、保护路径和带凭据的最终内容', async t => {
  const { prepare } = await fixture(t);
  for (const target of ['../escape', 'pakku-lock.json', '.pakku/shelf/x', '.pakku/overrides/.git/config',
    '.pakku/overrides/.intake/private', '.pakku/overrides/config/.env', '.pakku/overrides/saves/world/level.dat']) {
    await assert.rejects(prepare(operation(config, target)), undefined, target);
  }
  await assert.rejects(prepare(operation(config, config, 'server')), /侧别|覆盖/);
  await assert.rejects(prepare(operation(recipe, officialRecipe, 'client')), /侧别/);
  await assert.rejects(prepare(operation('config/new.toml', 'config/new.toml', 'server')), /侧别/);
  await assert.rejects(prepare(operation(config, config, 'common', { content: '{"accessToken":"secret"}' })), /凭据/);
});

test('已有源被改动或新增位置已有文件时要求重新审查', async t => {
  const { stage, prepare } = await fixture(t);
  await put(stage, config, 'a different draft');
  await assert.rejects(prepare(operation(config, config)), /重新审查/);
  assert.equal(await fs.readFile(path.join(stage, config), 'utf8'), 'a different draft');
  await put(stage, 'config/new.toml', 'someone added this');
  await assert.rejects(prepare(operation('config/new.toml', 'config/new.toml')), /重新审查/);
  await fs.unlink(path.join(stage, officialRecipe));
  await assert.rejects(prepare(operation(recipe, officialRecipe)), /重新审查/);
});

test('Git 可收集 Target 自定义覆盖中的 JAR、ZIP 与嵌套素材，排除构建与玩家数据', async t => {
  const { directory } = await fixture(t);
  const repo = path.resolve(directory, '../..');
  const options = { cwd: repo, encoding: 'utf8', windowsHide: true };
  execFileSync('git', ['init', '--quiet'], options);
  await fs.copyFile(path.resolve(import.meta.dirname, '../.gitignore'), path.join(repo, '.gitignore'));
  const accepted = ['packs/one/vendor/addon.jar', 'packs/one/resourcepacks/paint.zip',
    'packs/one/resourcepacks/paint/assets/demo/textures/pixel.png', 'packs/one/kubejs/assets/demo/lang/en_us.json',
    'packs/one/config/theme/assets/example.png', 'packs/one/.pakku/client-overrides/resourcepacks/manual.zip'];
  const ignored = ['loose.jar', 'dist/one/release.zip', 'packs/one/build/serverpack/pack.zip',
    'packs/one/.pakku/shelf/cache.jar', 'packs/one/saves/world/data/backup.zip', 'packs/one/assets/indexes/1.json',
    'packs/one/.pakku/client-overrides/saves/world/backup.jar', 'packs/one/config/.env'];
  await put(directory, 'pakku.json', JSON.stringify({
    name: 'Demo', version: '1', overrides: ['config', 'kubejs', 'vendor'], client_overrides: ['resourcepacks'],
  }));
  for (const name of accepted) await put(repo, name, 'fixture');
  const { mapping } = await inspectTarget(repo, { id: 'one', path: 'packs/one' });
  for (const name of accepted) assert.ok(mapping.some(entry => 'packs/one/' + entry.source === name), name);
  for (const name of ignored) await put(repo, name, 'fixture');
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    ...options, input: [...accepted, ...ignored].join('\0') + '\0',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\0').filter(Boolean).sort(), ignored.sort());
});

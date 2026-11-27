import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectTarget } from '../tools/lib/check.mjs';
import { sha256 } from '../tools/lib/pakku.mjs';
import { createTargetComparison } from '../tools/lib/review-target.mjs';

const target = { id: 'fabric', path: 'packs/fabric' };
const lock = {
  target: 'modrinth', mc_versions: ['26.2'], loaders: { fabric: '0.20.0' }, lockfile_version: 2,
  projects: [{
    pakku_id: 'RFvO7GFOkoWm67e7', type: 'MOD', side: 'BOTH',
    id: { modrinth: 'lhGA9TYQ', curseforge: '419699' },
    name: { modrinth: 'Architectury API' }, slug: { modrinth: 'architectury-api' },
    files: [{ type: 'modrinth', file_name: 'architectury-fabric-21.1.12.jar', id: 'ohb3PBGZ', parent_id: 'lhGA9TYQ',
      mc_versions: ['26.2'], loaders: ['fabric'], size: 624143,
      hashes: { sha512: 'df244fce6ffe38209e70d88696e05570e261b43780f76bd19e7a1813ffc29e128b21de6776816f3e76e50ffa0dcd32141fc3a09e5c33066f46e35d9d364dc173',
        sha1: '13358dcb2fcd29890f9ee73109553c179940c9e6' },
      required_dependencies: ['P7dR8mSH'] }],
  }],
};
const file = lock.projects[0].files[0];
const item = { kind: 'mod', path: 'mods/renamed.jar', size: file.size, ...file.hashes };
const compare = createTargetComparison({ lock, config: {}, source: [], mapping: [], hashes: {} }, target);

test('按原生锁文件的字节哈希认出改名 JAR；共同哈希冲突、大小不符或无哈希均不算锁定', () => {
  const result = compare(item);
  assert.equal(result.status, 'locked');
  assert.equal(result.lockMatches[0].pakkuId, 'RFvO7GFOkoWm67e7');
  assert.equal(result.lockMatches[0].fileId, 'ohb3PBGZ');
  assert.equal(result.lockMatches[0].side, 'common');
  assert.equal(result.lockMatches[0].matchedBy, 'sha512');
  assert.equal(compare({ ...item, sha512: '4'.repeat(128) }).status, 'unmapped');
  assert.equal(compare({ ...item, size: item.size + 1 }).status, 'unmapped');
  assert.equal(compare({ kind: 'mod', path: 'mods/' + file.file_name, size: file.size }).status, 'unmapped');
});

test('只有精确平台来源的项目 ID 能关联旧锁；同一 Modrinth 版本也可能含不同文件', () => {
  const changed = { ...item, sha512: '7'.repeat(128), sha1: '8'.repeat(40) };
  const mr = (id, version) => ({ modrinth: { status: 'exact', release: { projectId: id, versionId: version,
    fileName: file.file_name, slug: 'architectury-api' } } });
  const result = compare(changed, mr('lhGA9TYQ', 'another-version'));
  assert.equal(result.status, 'possible-replacement');
  assert.equal(result.lockMatches[0].fileId, 'ohb3PBGZ');
  assert.equal(result.lockMatches[0].releaseId, 'another-version');
  assert.equal(result.lockMatches[0].sameReleaseId, false);
  assert.equal(compare(changed, mr('lhGA9TYQ', 'ohb3PBGZ')).status, 'possible-replacement');
  assert.equal(compare(changed, mr('other-project', 'ohb3PBGZ')).status, 'unmapped');
  assert.equal(compare(changed, { modrinth: { status: 'unavailable' } }).status, 'unmapped');
  const cf = compare(changed, { curseforge: { status: 'exact', release: { projectId: '419699', fileId: '123456' } } });
  assert.equal(cf.status, 'possible-replacement');
  assert.equal(cf.lockMatches[0].matchedPlatform, 'curseforge');
  assert.equal(cf.lockMatches[0].platform, 'modrinth');
  assert.equal(cf.lockMatches[0].sameReleaseId, null);
});

test('以 Target 的实际源路径对照三个侧别，并沿已声明规则推荐新路径', async t => {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith Target 对照 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const contents = {
    'pakku.json': JSON.stringify({ name: 'Fixture', version: '1.0', overrides: ['config'], paths: { mods: 'custom-mods' } }),
    'pakku-lock.json': JSON.stringify(lock),
    'config/tuning.toml': 'power = 1',
    '.pakku/client-overrides/config/tuning.toml': 'power = 2',
    '.pakku/server-overrides/config/tuning.toml': 'power = 3',
    '.pakku/overrides/mods/local.jar': 'local build',
    '.pakku/overrides/custom-mods/example.jar': 'custom location build',
    '.pakku/client-overrides/mods/occupied.jar': 'another build',
    '.pakku/overrides/resourcepacks/archived.jar': 'local build',
  };
  for (const [relative, bytes] of Object.entries(contents)) {
    const dest = path.join(root, target.path, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }
  const comparisonFor = createTargetComparison(await inspectTarget(root, target), target);
  const config = comparisonFor({ path: 'config/tuning.toml', kind: 'config', sha256: sha256('power = 2') });
  assert.equal(config.status, 'mixed');
  assert.deepEqual(config.mappings.map(entry => [entry.side, entry.state, entry.projectPath, entry.sha256]), [
    ['common', 'different', 'packs/fabric/config/tuning.toml', sha256('power = 1')],
    ['client', 'same', 'packs/fabric/.pakku/client-overrides/config/tuning.toml', sha256('power = 2')],
    ['server', 'different', 'packs/fabric/.pakku/server-overrides/config/tuning.toml', sha256('power = 3')],
  ]);
  const local = comparisonFor({ path: 'mods/local.jar', kind: 'mod', sha256: sha256('local build') });
  assert.equal(local.status, 'same');
  assert.deepEqual(local.lockMatches, []);
  assert.equal(local.mappings.length, 1);
  assert.equal(local.mappings[0].source, '.pakku/overrides/mods/local.jar');
  const custom = comparisonFor({ path: 'mods/renamed.jar', kind: 'mod', sha256: sha256('custom location build') });
  assert.equal(custom.mappings[0].destination, 'custom-mods/example.jar');
  assert.equal(comparisonFor({ path: 'mods/local.jar', kind: 'mod', sha256: sha256('other') }).status, 'different');
  const disabled = { path: 'mods/renamed.jar.disabled', kind: 'mod', enabled: false, sha256: sha256('local build') };
  const renamed = comparisonFor(disabled);
  assert.equal(disabled.enabled, false);
  assert.equal(renamed.status, 'same');
  assert.deepEqual(renamed.mappings.map(entry => [entry.destination, entry.side, entry.matchedBy]),
    [['mods/local.jar', 'common', 'sha256']]);
  assert.match(renamed.recommendations[0].reason, /复用/);
  const occupied = comparisonFor({ ...disabled, path: 'mods/occupied.jar', enabled: true });
  assert.equal(occupied.status, 'mixed');
  assert.deepEqual(occupied.mappings.map(entry => [entry.side, entry.state, entry.source, entry.matchedBy]), [
    ['client', 'different', '.pakku/client-overrides/mods/occupied.jar', 'path'],
    ['common', 'same', '.pakku/overrides/mods/local.jar', 'sha256'],
  ]);
  const recommend = (relative, kind) => comparisonFor({ path: relative, kind, sha256: sha256('candidate') }).recommendations[0];
  assert.equal(recommend('config/new.toml', 'config').projectPath, 'packs/fabric/config/new.toml');
  assert.equal(recommend('kubejs/server_scripts/x.js', 'kubejs').projectPath, 'packs/fabric/.pakku/overrides/kubejs/server_scripts/x.js');
  assert.equal(recommend('resourcepacks/x.zip', 'resourcepack').side, 'client');
  assert.equal(recommend('saves/World/datapacks/x.zip', 'datapack').projectPath, null);
  assert.equal(recommend('defaultconfigs/unknown.toml', 'config').side, null);
});

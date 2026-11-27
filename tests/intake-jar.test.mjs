import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectJar } from '../tools/lib/intake-jar.mjs';

async function inspect(t, entries) {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'Packsmith-jar-'));
  t.after(() => temp.remove());
  const file = path.join(temp.path, '本地测试.jar');
  const bytes = Buffer.isBuffer(entries) ? entries : zipSync(entries);
  await fs.writeFile(file, bytes);
  const handle = await fs.open(file);
  try {
    const result = await inspectJar(handle, bytes.length);
    assert.equal((await handle.stat()).size, bytes.length, '调用者仍然拥有文件句柄');
    return result;
  } finally {
    await handle.close();
  }
}

test('Fabric 记录原始依赖范围和客户端侧别，仅按需读取 JAR', async t => {
  const spec = {
    schemaVersion: 1, id: 'recipe_helper', name: 'Recipe Helper', version: '2.0', environment: 'client',
    depends: { minecraft: ['1.20.x', '1.21.x'], fabricloader: '>=0.16' },
    suggests: { editor: '*' }, breaks: { legacy: '<2' },
  };
  const result = await inspect(t, {
    'fabric.mod.json': strToU8(JSON.stringify(spec)),
    'large-texture': [new Uint8Array(3 * 1024 * 1024), { level: 0 }],
  });
  assert.equal(result.status, 'recognized');
  assert.ok(result.readBytes > 0 && result.readBytes < 256 * 1024);
  const [mod] = result.mods;
  assert.equal(mod.loader, 'fabric');
  assert.equal(mod.id, spec.id);
  assert.equal(mod.side, 'client');
  assert.deepEqual(mod.dependencies, [
    { id: 'minecraft', type: 'required', versionRange: spec.depends.minecraft },
    { id: 'fabricloader', type: 'required', versionRange: '>=0.16' },
    { id: 'editor', type: 'suggested', versionRange: '*' },
    { id: 'legacy', type: 'incompatible', versionRange: '<2' },
  ]);
});

test('同一个 JAR 的多项 Forge 与 NeoForge 声明分别保留各自依赖', async t => {
  const versionPlaceholder = '${file.jarVersion}';
  const forge = [
    'modLoader = "javafml"', 'loaderVersion = "[47,)"', 'license = "MIT"', 'clientSideOnly = true', '[[mods]]', 'modId = "tools"',
    'version = "' + versionPlaceholder + '"', '[[mods]]', 'modId = "recipes"', 'version = "1.3"',
    '[[dependencies.tools]]', 'modId = "editor"', 'mandatory = false', 'versionRange = "[1,3)"', 'side = "CLIENT"',
  ].join('\n');
  const neo = [
    '[[mods]]', 'modId = "tools"', 'version = "2.1"', '[[dependencies.tools]]',
    'modId = "alt"', 'type = "discouraged"', 'versionRange = "[1,)"', 'side = "SERVER"',
  ].join('\n');
  const result = await inspect(t, {
    'META-INF/mods.toml': strToU8(forge), 'META-INF/neoforge.mods.toml': strToU8(neo),
    'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\r\nImplementation-Version: 2.\r\n 0\r\n\r\nName: tools.class\r\nImplementation-Version: 9\r\n'),
  });
  assert.equal(result.status, 'recognized');
  assert.deepEqual(result.mods.map(mod => [mod.loader, mod.id, mod.version]), [
    ['forge', 'tools', '2.0'], ['forge', 'recipes', '1.3'], ['neoforge', 'tools', '2.1'],
  ]);
  assert.deepEqual(result.mods[0].dependencies, [{ id: 'editor', type: 'optional', versionRange: '[1,3)', side: 'client' }]);
  assert.deepEqual(result.mods[1].dependencies, []);
  assert.equal(result.mods[1].side, 'client');
  assert.equal(result.mods[1].license, 'MIT');
  assert.deepEqual(result.mods[2].dependencies, [{ id: 'alt', type: 'discouraged', versionRange: '[1,)', side: 'server' }]);
});

test('普通 JAR、损坏的声明和读取超限分别报告', async t => {
  const unknown = await inspect(t, { 'nested/fabric.mod.json': strToU8('{}') });
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknown.mods, []);
  for (const contents of [Buffer.from('broken'), { 'META-INF/mods.toml': strToU8('[[mods') }]) {
    const invalid = await inspect(t, contents);
    assert.equal(invalid.status, 'invalid');
    assert.ok(invalid.issues.length);
  }
  const large = await inspect(t, { 'fabric.mod.json': new Uint8Array(1024 * 1024 + 1) });
  assert.equal(large.status, 'unsupported');
});

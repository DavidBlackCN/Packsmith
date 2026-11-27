import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CurseForgeFingerprint, normalizedLength } from '../tools/lib/curseforge-fingerprint.mjs';
import { inspectJar } from '../tools/lib/intake-jar.mjs';
import { enrichJarFingerprints, scanInstance } from '../tools/lib/intake-scan.mjs';

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

// Expected integers computed independently with Pakku 1.5.0's
// teksturepako.pakku.io.Murmur2Kt.toMurmur2(byte[]) on the unfiltered input.
test('CurseForge 指纹匹配 Pakku，覆盖四种空白、末尾不足四字节与无符号结果', () => {
  const vectors = [
    ['', 1540447798], ['1', 1111412596], ['12', 4044587327], ['123', 2528427729],
    ['1234', 3111641025], ['12345', 751248136], ['\t \r\n', 1540447798],
    ['ab\tc\nd\re f', 455443312], ['\v\f', 824117372],
  ];
  for (const [input, expected] of vectors) {
    const bytes = Buffer.from(input);
    const hash = new CurseForgeFingerprint(normalizedLength(bytes));
    for (let i = 0; i < bytes.length; i += 3) hash.update(bytes.subarray(i, i + 3));
    assert.equal(hash.digest(), expected, JSON.stringify(input));
  }
});

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 指纹 '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, '实例'), stage = path.join(root, 'stage');
  await fs.mkdir(path.join(source, 'mods'), { recursive: true });
  await fs.mkdir(stage);
  return { source, stage };
}

test('大 JAR 的三种 SHA 同遍计算，CF 第二遍读取计入统计且同内容仅执行一次', async t => {
  const { source, stage } = await fixture(t);
  const bytes = Buffer.alloc(128 * 1024 + 37);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i * 31 + 7;
  bytes[0] = 32;
  const active = path.join(source, 'mods', 'a.jar');
  await fs.writeFile(active, bytes);
  await fs.copyFile(active, path.join(source, 'mods', 'b.jar.disabled'));
  const handle = await fs.open(active);
  let metadataReads;
  try { metadataReads = (await inspectJar(handle, bytes.length)).readBytes; }
  finally { await handle.close(); }
  const { items, stats } = await scanInstance(source, stage);
  assert.equal(items.length, 2);
  for (const item of items) {
    for (const algorithm of ['sha1', 'sha256', 'sha512']) assert.equal(item[algorithm], digest(algorithm, bytes));
    assert.equal(item.curseforgeFingerprint, 2878337356);
  }
  assert.equal(stats.bytesRead, bytes.length * 3 + metadataReads);
});

test('旧清单按需补算并核对原字节，可离线使用已保存的指纹', async t => {
  const { source } = await fixture(t);
  const bytes = Buffer.from('12345');
  const item = { path: 'mods/old.jar.disabled', kind: 'mod', size: bytes.length, sha256: digest('sha256', bytes) };
  const file = path.join(source, item.path);
  await fs.writeFile(file, bytes);
  const partial = await enrichJarFingerprints(source, item);
  assert.equal(partial.sha1, digest('sha1', bytes));
  assert.equal(partial.sha512, digest('sha512', bytes));
  assert.equal(partial.curseforgeFingerprint, undefined);
  const complete = await enrichJarFingerprints(source, partial, { needCurseForge: true });
  assert.equal(complete.curseforgeFingerprint, 751248136);
  assert.equal(item.sha1, undefined);
  await fs.writeFile(file, '12344');
  await assert.rejects(enrichJarFingerprints(source, item), /SHA-256 已变化/);
  await fs.writeFile(file, '123');
  await assert.rejects(enrichJarFingerprints(source, partial, { needCurseForge: true }), /大小已变化/);
  await fs.unlink(file);
  assert.equal(await enrichJarFingerprints(source, complete, { needCurseForge: true }), complete);
  await assert.rejects(enrichJarFingerprints(source, { ...item, path: 'config/suspicious.jar' }), /Mod 路径/);
  await assert.rejects(enrichJarFingerprints(source, { ...item, path: 'mods/../private.jar' }), /路径/);
});

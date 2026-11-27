import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectArchive, inspectZip } from '../tools/lib/archive.mjs';

const dependency = {
  path: 'mods/example.jar',
  hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
  fileSize: 12,
  downloads: ['https://example.invalid/example.jar'],
};

function mrpack(files, overrides = {}) {
  const index = { formatVersion: 1, game: 'minecraft', files, dependencies: { minecraft: '1.21.1' } };
  return zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(index)), ...overrides });
}

test('ZIP 校验识别文件内容损坏', () => {
  const payload = 'fixture contents';
  const zip = Buffer.from(zipSync({ 'example.txt': strToU8(payload) }, { level: 0 }));
  assert.equal(Buffer.from(inspectZip(zip)['example.txt']).toString(), payload);
  const offset = zip.indexOf(payload);
  assert.notEqual(offset, -1);
  zip[offset] ^= 1;
  assert.throws(() => inspectZip(zip), /CRC/);
});

test('ZIP 拒绝大小写重复和文件目录重名', () => {
  const content = strToU8('fixture');
  for (const entries of [{ 'A.txt': content, 'a.txt': content }, { config: content, 'config/a.json': content }]) {
    assert.throws(() => inspectZip(zipSync(entries)), /冲突/);
  }
});

test('MRPACK 按客户端和服务端分别检查依赖的重复路径', () => {
  const client = { ...dependency, env: { server: 'unsupported' } };
  const server = { ...dependency, env: { client: 'unsupported' } };
  assert.doesNotThrow(() => inspectArchive(mrpack([client, server]), 'modrinth'));
  assert.throws(() => inspectArchive(mrpack([dependency, server]), 'modrinth'), /server.*重复/);
});

test('MRPACK 检查下载地址、哈希以及服务端覆盖路径', () => {
  for (const [patch, reason] of [
    [{ downloads: ['http://example.invalid/example.jar'] }, /HTTPS/],
    [{ hashes: { sha1: dependency.hashes.sha1 } }, /哈希/],
  ]) {
    const file = { ...dependency, ...patch, env: { client: 'unsupported' } };
    assert.throws(() => inspectArchive(mrpack([file]), 'modrinth'), reason);
  }
  const packed = mrpack([], { 'server-overrides/launcher_accounts.json': strToU8('{}') });
  assert.throws(() => inspectArchive(packed, 'modrinth'), /账户或凭据/);
});

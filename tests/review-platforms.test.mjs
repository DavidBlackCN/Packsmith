import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupReleases } from '../tools/lib/review-platforms.mjs';

function jar(number, fingerprint = number) {
  const hash = length => number.toString(16).padStart(length, '0');
  return { sha256: hash(64), sha512: hash(128), sha1: hash(40), curseforgeFingerprint: fingerprint, size: 1024 };
}

test('两个平台各用一次批量请求，按文件而非路径或首个版本附件识别发布身份', async () => {
  const a = jar(1, 0);
  const b = jar(2);
  const requests = [];
  const output = await lookupReleases([a, b, { ...a, path: '另一个文件名.jar' }], {
    curseforgeKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      if (url === 'https://api.modrinth.com/v2/version_files') {
        assert.equal(options.headers['x-api-key'], undefined);
        assert.deepEqual(body, { algorithm: 'sha512', hashes: [a.sha512, b.sha512] });
        return Response.json({ [a.sha512]: {
          project_id: 'P123', id: 'V456', version_number: '2.0', game_versions: ['1.21.1'], loaders: ['fabric'],
          files: [{ filename: 'sources.jar', hashes: { sha512: b.sha512 }, size: b.size },
            { filename: 'release.jar', hashes: { sha512: a.sha512, sha1: a.sha1 }, size: a.size }],
          dependencies: [{ dependency_type: 'required', version_id: 'D78', project_id: null, file_name: null }],
        } });
      }
      assert.equal(url, 'https://api.curseforge.com/v1/fingerprints/432');
      assert.equal(options.headers['x-api-key'], 'test-key');
      assert.deepEqual(body, { fingerprints: [0, 2] });
      return Response.json({ data: { exactMatches: [{ id: 12, file: {
        id: 34, modId: 12, gameId: 432, fileName: 'published.jar', displayName: 'Latest stable',
        fileFingerprint: 0, hashes: [{ algo: 1, value: a.sha1 }], fileLength: a.size,
        gameVersions: ['1.21.1', 'NeoForge', 'Java 21', 'Client', '25w14a'],
        dependencies: [{ modId: 3, relationType: 3 }, { modId: 4, relationType: 4 }],
      } }] } });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(output.size, 2);
  const { modrinth, curseforge } = output.get(a.sha256);
  assert.equal(modrinth.status, 'exact');
  assert.deepEqual([modrinth.release.fileName, modrinth.release.projectId, modrinth.release.versionId], ['release.jar', 'P123', 'V456']);
  assert.deepEqual(modrinth.release.dependencies, [{ type: 'required', versionId: 'D78' }]);
  assert.equal(curseforge.status, 'exact');
  assert.deepEqual([curseforge.release.projectId, curseforge.release.fileId, curseforge.release.fileName], ['12', '34', 'published.jar']);
  assert.equal(curseforge.release.version, undefined);
  assert.deepEqual(curseforge.release.gameVersions, ['1.21.1', '25w14a']);
  assert.deepEqual(curseforge.release.loaders, ['neoforge']);
  assert.deepEqual(curseforge.release.dependencies.map(dep => dep.type), ['required', 'tool']);
  assert.deepEqual(output.get(b.sha256), { modrinth: { status: 'no-match' }, curseforge: { status: 'no-match' } });
});

test('指纹碰撞、部分匹配及与附件长度矛盾的版本都不会升级为精确匹配', async () => {
  const a = jar(1), collision = jar(2, 1), partial = jar(3);
  const result = await lookupReleases([a, collision, partial], {
    curseforgeKey: 'test-key',
    fetchImpl: async url => url.includes('modrinth') ? Response.json({
      [a.sha512]: { project_id: 'P', id: 'V', files: [{ filename: 'a.jar', hashes: a, size: a.size + 1 }] },
      [collision.sha512]: { project_id: 'P', id: 'V', files: [{ filename: 'b.jar', hashes: { sha512: collision.sha512, sha1: a.sha1 }, size: collision.size }] },
    }) : Response.json({ data: {
      exactMatches: [{ file: { fileFingerprint: 1, modId: 1, id: 2, fileName: 'a.jar', fileLength: a.size, hashes: [{ algo: 1, value: a.sha1 }] } }],
      partialMatches: [], partialMatchFingerprints: { '42': [3] },
    } }),
  });
  assert.equal(result.get(a.sha256).modrinth.status, 'unverified');
  assert.equal(result.get(a.sha256).curseforge.status, 'exact');
  assert.equal(result.get(collision.sha256).curseforge.status, 'unverified');
  assert.equal(result.get(collision.sha256).modrinth.status, 'unverified');
  assert.equal(result.get(partial.sha256).curseforge.status, 'unverified');
  assert.equal(result.get(partial.sha256).curseforge.release, undefined);
});

test('离线、旧 Manifest 和无凭据只影响各自可查询的平台', async () => {
  const a = jar(1);
  const old = { sha256: jar(2).sha256, size: 3 };
  const offline = await lookupReleases([a], { offline: true, curseforgeKey: 'test-key', fetchImpl: () => assert.fail('离线不应发起请求') });
  assert.equal(offline.get(a.sha256).modrinth.status, 'not-queried');
  assert.equal(offline.get(a.sha256).curseforge.status, 'not-queried');
  const requests = [];
  const output = await lookupReleases([a, old], {
    curseforgeKey: '', fetchImpl: async url => { requests.push(url); return Response.json({}); },
  });
  assert.deepEqual(requests, ['https://api.modrinth.com/v2/version_files']);
  assert.equal(output.get(old.sha256).modrinth.status, 'not-queried');
  assert.equal(output.get(a.sha256).curseforge.status, 'not-queried');
});

test('遇到限流停止该平台后续批次，HTTP 响应和连接错误不会泄露请求密钥', async () => {
  const items = Array.from({ length: 101 }, (_, i) => jar(i + 1));
  const calls = [];
  const result = await lookupReleases(items, {
    curseforgeKey: 'fixture-private-key',
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes('modrinth')) return new Response('fixture-private-key', { status: 429 });
      throw new Error('invalid header: fixture-private-key');
    },
  });
  assert.equal(calls.length, 2);
  assert.match(result.get(items[0].sha256).modrinth.reason, /429/);
  assert.equal(result.get(items[0].sha256).curseforge.status, 'error');
  assert.equal(result.get(items[100].sha256).modrinth.status, 'not-queried');
  assert.doesNotMatch(JSON.stringify([...result.values()]), /fixture-private-key/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { requireSuccess, run, sha256 } from '../tools/lib/pakku.mjs';
import { publishDraft, selectRelease, verifyReleaseBundle } from '../tools/release.mjs';

const tag = 'Preview/Autumn-RC_2', version = '27.4', repo = 'example/pack';
const directory = '.work/bundle';
const git = async (cwd, ...args) => requireSuccess(await run('git', args, { cwd, capture: true })).stdout.trim();
const json = obj => JSON.stringify(obj, null, 2) + '\n';
const write = async (root, file, content) => {
  const dest = path.join(root, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content);
};

async function fixture(t, { kinds = ['modrinth', 'serverpack'], multi = false } = {}) {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'packsmith-release-'));
  t.after(temp.remove);
  const root = temp.path;
  const target = { id: 'fabric', path: 'packs/fabric', artifacts: kinds };
  const second = { id: 'other', path: 'packs/other', artifacts: ['curseforge'] };
  const config = json({ name: 'A pack', version });
  const lock = json({ target: 'modrinth' });
  const targets = multi ? [target, second] : [target];
  await write(root, '.gitignore', '/.work/\n');
  await write(root, 'workspace.json', json({ defaultTarget: target.id, targets }));
  for (const entry of targets) {
    await write(root, entry.path + '/pakku.json', config);
    await write(root, entry.path + '/pakku-lock.json', lock);
  }
  await git(root, 'init', '-q');
  await git(root, 'add', '.');
  const user = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
  await git(root, ...user, 'commit', '-qm', 'test fixture');
  const commit = await git(root, 'rev-parse', 'HEAD');
  await git(root, '-c', 'tag.gpgSign=false', 'tag', tag);
  const annotated = 'candidate/Rc.4';
  await git(root, ...user, '-c', 'tag.gpgSign=false', 'tag', '-a', annotated, '-m', 'test');
  const selected = await selectRelease(root, { tag, event: 'workflow_dispatch', targetId: target.id });
  const files = kinds.map(kind => {
    const name = kind === 'modrinth' ? 'test.mrpack' : kind + '.zip';
    return { kind, name };
  });
  async function bundle({ overrideVersion = version, corruptReport, mutateSums } = {}) {
    const artifacts = [];
    for (const file of files) {
      const content = file.kind === 'modrinth'
        ? { 'modrinth.index.json': strToU8(json({ formatVersion: 1, game: 'minecraft', versionId: overrideVersion,
          files: [], dependencies: { minecraft: '1.21.1' } })) }
        : file.kind === 'curseforge'
          ? { 'manifest.json': strToU8(json({ manifestVersion: 1, version: overrideVersion, minecraft: { version: '1.21.1' }, files: [] })) }
          : { 'server.properties': strToU8('motd=hello') };
      const bytes = zipSync(content);
      await write(root, directory + '/' + file.name, bytes);
      artifacts.push({ ...file, sha256: sha256(bytes), size: bytes.length });
    }
    const report = { schema: 1, git: commit, dirty: false, version, targetId: target.id, artifacts,
      configHash: sha256(config), lockHash: sha256(lock), missing: [], uncollected: [] };
    corruptReport?.(report);
    const reportText = json(report);
    await write(root, directory + '/build-report.json', reportText);
    const entries = [...artifacts, { name: 'build-report.json', sha256: sha256(reportText) }];
    const sums = entries.map(a => a.sha256 + '  ' + a.name).join('\n') + '\n';
    await write(root, directory + '/SHA256SUMS', mutateSums ? mutateSums(sums) : sums);
  }
  await bundle();
  return { root, target, commit, selected, annotated, bundle };
}

function remote(selected, { annotated, existing, failUpload, wrongDigest, remoteCommit, keep = [], secondPage } = {}) {
  const calls = [], releases = [...keep];
  async function fetchImpl(input, options) {
    const url = new URL(input);
    calls.push([options.method ?? 'GET', url.pathname, url.search]);
    assert.equal(options.headers.Authorization, 'Bearer fixture-only');
    assert.equal(options.redirect, 'error');
    assert.ok(['api.github.com', 'uploads.github.com'].includes(url.hostname));
    const stem = '/repos/' + repo;
    const tagObject = 'a'.repeat(40);
    if (url.pathname.startsWith(stem + '/git/ref/')) {
      assert.equal(decodeURIComponent(url.pathname.slice((stem + '/git/ref/tags/').length)), selected.tag);
      return Response.json({ ref: 'refs/tags/' + selected.tag, object: annotated
        ? { type: 'tag', sha: tagObject } : { type: 'commit', sha: remoteCommit ?? selected.commit } });
    }
    if (url.pathname === stem + '/git/tags/' + tagObject) return Response.json({ object: { type: 'commit', sha: remoteCommit ?? selected.commit } });
    if (url.pathname === stem + '/releases' && !options.method) {
      if (secondPage && url.searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, i) => ({ tag_name: 'v' + i })));
      return Response.json(existing ? [{ draft: existing === 'draft', tag_name: selected.tag }] : releases);
    }
    if (url.pathname === stem + '/releases' && options.method === 'POST') {
      const request = JSON.parse(options.body);
      assert.equal(request.draft, true);
      assert.equal(request.prerelease, false);
      assert.equal(request.tag_name, selected.tag);
      assert.equal(request.target_commitish, selected.commit);
      assert.ok(request.body.includes(selected.version));
      assert.ok(request.body.includes(selected.tag));
      releases.push({ ...request, id: 12 });
      return Response.json(releases.at(-1));
    }
    assert.equal(url.hostname, 'uploads.github.com');
    assert.equal(url.pathname, stem + '/releases/12/assets');
    const name = url.searchParams.get('name');
    if (name === failUpload) return new Response(null, { status: 502 });
    return Response.json({ name, digest: 'sha256:' + (wrongDigest ? '0'.repeat(64) : sha256(options.body)) });
  }
  return { calls, releases, options: { repo, token: 'fixture-only', fetchImpl } };
}

test('任意合法标签按原拼写发布；多目标按标签内容提示手选，即使有默认目标', async t => {
  const a = await fixture(t);
  assert.deepEqual(await selectRelease(a.root, { tag, event: 'push' }), a.selected);
  const annotated = await selectRelease(a.root, { tag: a.annotated, event: 'push' });
  assert.equal(annotated.commit, a.commit);
  assert.equal(annotated.tag, a.annotated);
  await assert.rejects(selectRelease(a.root, { tag: 'test/not-there', event: 'push' }));
  await assert.rejects(selectRelease(a.root, { tag, event: 'push', expectedCommit: '2'.repeat(40) }), /提交/);
  const b = await fixture(t, { multi: true });
  assert.deepEqual((await selectRelease(b.root, { tag, event: 'push' })).targets, ['fabric', 'other']);
  assert.equal((await selectRelease(b.root, { tag, event: 'workflow_dispatch', targetId: 'other' })).target.id, 'other');
  await assert.rejects(selectRelease(b.root, { tag, event: 'workflow_dispatch', targetId: 'not-in-tag' }), /选择 Target/);
});

test('轻量标签及附注标签解析到实际提交，仅 POST 草稿和清单指定的附件', async t => {
  const f = await fixture(t);
  for (const tagName of [tag, f.annotated]) {
    const selected = await selectRelease(f.root, { event: 'push', tag: tagName });
    const api = remote(selected, { annotated: tagName === f.annotated });
    const result = await publishDraft(f.root, selected, directory, api.options);
    assert.equal(result.draftId, 12);
    assert.deepEqual(result.assets.map(a => a.name), ['test.mrpack', 'serverpack.zip', 'build-report.json', 'SHA256SUMS']);
    assert.equal(api.calls.filter(c => c[0] === 'POST').length, 5);
    assert.ok(api.calls.every(c => ['GET', 'POST'].includes(c[0])));
  }
});

test('分页查重识别已发布和草稿；移动的远端标签在写请求前终止', async t => {
  const f = await fixture(t);
  for (const status of ['draft', 'published']) {
    const api = remote(f.selected, { existing: status, secondPage: true });
    await assert.rejects(publishDraft(f.root, f.selected, directory, api.options), /已有 Release 或草稿/);
    assert.ok(api.calls.every(c => c[0] === 'GET'));
    assert.ok(api.calls.some(c => c[2].includes('page=2')));
  }
  const api = remote(f.selected, { annotated: true, remoteCommit: '0'.repeat(40) });
  await assert.rejects(publishDraft(f.root, f.selected, directory, api.options), /远端标签提交/);
  assert.ok(api.calls.every(c => c[0] === 'GET'));
});

test('上传中断或服务端摘要错误留下草稿；重跑检查草稿后终止', async t => {
  const f = await fixture(t);
  for (const failure of [{ failUpload: 'serverpack.zip' }, { wrongDigest: true }]) {
    const api = remote(f.selected, failure);
    await assert.rejects(publishDraft(f.root, f.selected, directory, api.options), /草稿 #12 已保留/);
    const retry = remote(f.selected, { keep: api.releases });
    await assert.rejects(publishDraft(f.root, f.selected, directory, retry.options), /已有/);
    assert.ok(retry.calls.every(c => c[0] === 'GET'));
  }
});

test('草稿阶段从独立 checkout 读取标签元数据，从本次运行下载目录读取附件', async t => {
  const f = await fixture(t);
  const staging = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'packsmith-release-run-'));
  t.after(staging.remove);
  await fs.rename(path.join(f.root, directory), path.join(staging.path, 'downloaded'));
  const api = remote(f.selected);
  const result = await publishDraft(f.root, f.selected, 'downloaded', { ...api.options, bundleRoot: staging.path });
  assert.equal(result.draftId, 12);
});

test('按 Target 支持单独的 CurseForge 或 serverpack；有清单的格式必须核对包内版本', async t => {
  for (const kind of ['curseforge', 'modrinth', 'serverpack']) {
    const f = await fixture(t, { kinds: [kind] });
    if (kind === 'serverpack') {
      // Pakku can also export an MRPACK into its build scratch directory; it is not part of the release directory.
      await f.bundle({ corruptReport: r => { r.uncollected = ['build/modrinth/extra.mrpack']; } });
    }
    assert.equal((await verifyReleaseBundle(f.root, f.selected, directory)).length, 3);
    if (kind !== 'serverpack') {
      await f.bundle({ overrideVersion: 'old' });
      const api = remote(f.selected);
      await assert.rejects(publishDraft(f.root, f.selected, directory, api.options), /包内版本/);
      assert.deepEqual(api.calls, []);
    }
  }
});

test('拒绝错误提交、脏报告、配置不符、平台遗漏、损坏字节、缺失或多余附件', async t => {
  const f = await fixture(t);
  const verify = () => verifyReleaseBundle(f.root, f.selected, directory);
  for (const change of [{ git: '1'.repeat(40) }, { dirty: true }, { version: 'old' }, { configHash: 'f'.repeat(64) },
    { targetId: 'other' }, { missing: ['a'] }, { uncollected: null }, { artifacts: [] }]) {
    await f.bundle({ corruptReport: r => Object.assign(r, change) });
    await assert.rejects(verify(), /构建报告/);
  }
  await f.bundle({ mutateSums: s => s + s.split('\n')[0] + '\n' });
  await assert.rejects(verify(), /SHA256SUMS/);
  await f.bundle();
  await write(f.root, directory + '/test.mrpack', Buffer.from('old bytes'));
  await assert.rejects(verify(), /SHA-256/);
  await f.bundle();
  await write(f.root, directory + '/extra.txt', 'private');
  await assert.rejects(verify(), /未声明/);
  await fs.unlink(path.join(f.root, directory, 'serverpack.zip'));
  await assert.rejects(verify(), /ENOENT/);
});

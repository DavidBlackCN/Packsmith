import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireSuccess, run, sha256 } from './lib/pakku.mjs';
import { filesUnder, loadWorkspace, readJson, relativePath, safePath } from './lib/workspace.mjs';

const commitId = /^[0-9a-f]{40}$/;
async function git(root, args) {
  return requireSuccess(await run('git', args, { cwd: root, capture: true })).stdout.trim();
}

export async function selectRelease(source, { tag, targetId, event, expectedCommit }) {
  if (!tag || !['push', 'workflow_dispatch'].includes(event)) throw new Error('需要已有 Git 标签和发布触发方式');
  const ref = 'refs/tags/' + tag;
  await git(source, ['check-ref-format', ref]);
  const commit = await git(source, ['rev-parse', '--verify', ref + '^{commit}']);
  if (!commitId.test(commit) || await git(source, ['rev-parse', 'HEAD']) !== commit ||
      (expectedCommit && expectedCommit !== commit)) throw new Error('检出的提交与指定标签或预期提交不符');
  const workspace = await loadWorkspace(source);
  if (event === 'push' && workspace.targets.length > 1) {
    return { skip: true, tag, commit, targets: workspace.targets.map(t => t.id) };
  }
  const target = event === 'push' ? workspace.targets[0] : workspace.targets.find(t => t.id === targetId);
  if (!target) throw new Error('请从标签对应的 workspace.json 选择 Target，候选有 ' + workspace.targets.map(t => t.id).join(', '));
  const config = await readJson(await safePath(source, target.path + '/pakku.json'));
  if (typeof config.version !== 'string' || !config.version.trim()) throw new Error('Target 缺少有效包版本');
  return { skip: false, tag, commit, target, version: config.version };
}

export async function verifyReleaseBundle(source, selected, directory, bundleRoot = source) {
  const { inspectArchive } = await import('./lib/archive.mjs');
  const { target, version, commit } = selected;
  const dir = await safePath(bundleRoot, directory);
  const reportBytes = await fs.readFile(await safePath(dir, 'build-report.json'));
  const report = JSON.parse(reportBytes);
  if (report.schema !== 1 || report.targetId !== target.id || report.version !== version || report.git !== commit ||
      report.dirty !== false || !Array.isArray(report.missing) || report.missing.length ||
      !Array.isArray(report.uncollected) ||
      !Array.isArray(report.artifacts) || report.artifacts.length !== target.artifacts.length) {
    throw new Error('构建报告的 Target、包版本、提交或产物完整性不符');
  }
  for (const [file, field] of [['pakku.json', 'configHash'], ['pakku-lock.json', 'lockHash']]) {
    if (report[field] !== sha256(await fs.readFile(await safePath(source, target.path + '/' + file)))) {
      throw new Error('构建报告与标签内的 ' + file + ' 不符');
    }
  }
  const assets = [];
  const names = new Set(['build-report.json', 'sha256sums']);
  const kinds = new Set(target.artifacts);
  for (const artifact of report.artifacts) {
    const { name, kind, size } = artifact;
    if (!kinds.delete(kind) || relativePath(name).includes('/') || names.has(name.toLowerCase()) ||
        !name.endsWith(kind === 'modrinth' ? '.mrpack' : '.zip')) throw new Error('发布产物类型或文件名不符');
    names.add(name.toLowerCase());
    const bytes = await fs.readFile(await safePath(dir, name));
    if (size !== bytes.length || sha256(bytes) !== artifact.sha256) throw new Error('发布产物大小或 SHA-256 不符：' + name);
    const entries = inspectArchive(bytes, kind);
    if (kind === 'modrinth' || kind === 'curseforge') {
      const mr = kind === 'modrinth';
      const manifest = JSON.parse(Buffer.from(entries[mr ? 'modrinth.index.json' : 'manifest.json']).toString('utf8'));
      if ((mr ? manifest.versionId : manifest.version) !== version) throw new Error('发布包内版本与 Pakku 版本不符：' + name);
    }
    assets.push({ name, sha256: artifact.sha256 });
  }
  assets.push({ name: 'build-report.json', sha256: sha256(reportBytes) });
  const sums = await fs.readFile(await safePath(dir, 'SHA256SUMS'));
  const actual = sums.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/).sort();
  const expected = assets.map(a => a.sha256 + '  ' + a.name).sort();
  if (actual.length !== expected.length || actual.some((line, i) => line !== expected[i])) throw new Error('SHA256SUMS 与完整发布清单不符');
  assets.push({ name: 'SHA256SUMS', sha256: sha256(sums) });
  const inventory = await filesUnder(dir);
  if (inventory.length !== assets.length || assets.some(a => !inventory.includes(a.name))) throw new Error('发布目录包含未声明的文件或缺少资产');
  return assets;
}

export async function publishDraft(source, selected, directory, { repo, token, fetchImpl = fetch, bundleRoot = source }) {
  const assets = await verifyReleaseBundle(source, selected, directory, bundleRoot);
  if (!/^[\w-]+\/[\w.-]+$/.test(repo ?? '') || ['.', '..'].includes(repo.split('/')[1]) || !token) {
    throw new Error('创建草稿需要 GitHub 仓库名和有发布权限的 token');
  }
  const route = '/repos/' + repo;
  async function request(url, init = {}) {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28', ...init.headers } });
    if (!response.ok) throw new Error('GitHub 返回 HTTP ' + response.status);
    return response.json();
  }
  const api = (endpoint, init) => request('https://api.github.com' + route + endpoint, init);
  const tagPath = selected.tag.split('/').map(encodeURIComponent).join('/');
  const ref = await api('/git/ref/tags/' + tagPath);
  if (ref.ref !== 'refs/tags/' + selected.tag) throw new Error('GitHub 返回了不同的标签');
  let object = ref.object;
  const seen = new Set();
  while (object?.type === 'tag' && commitId.test(object.sha) && !seen.has(object.sha)) {
    seen.add(object.sha);
    object = (await api('/git/tags/' + object.sha)).object;
  }
  if (object?.type !== 'commit' || object.sha !== selected.commit) throw new Error('远端标签提交与构建不符');
  // GET /releases/tags/{tag} only promises a published release. The write token can list drafts as well.
  for (let page = 1; ; page++) {
    const releases = await api('/releases?per_page=100&page=' + page);
    if (!Array.isArray(releases)) throw new Error('GitHub 发布列表无效');
    if (releases.some(r => r.tag_name === selected.tag)) throw new Error('此标签已有 Release 或草稿，请检查已有发布');
    if (releases.length < 100) break;
  }
  const { tag, version, commit, target } = selected;
  const draft = await api('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: target.id + ' ' + version, draft: true,
      prerelease: false, body: ['Target: ' + target.id, '包版本: ' + version, 'Git 标签: ' + tag,
        '提交: ' + commit, '', '请核对附件与 SHA256SUMS，再手动公开。'].join('\n') }) });
  if (!draft.draft || draft.tag_name !== tag || !Number.isSafeInteger(draft.id) || draft.id <= 0) throw new Error('未得到预期的 GitHub 发布草稿');
  const dir = await safePath(bundleRoot, directory);
  try {
    for (const asset of assets) {
      const bytes = await fs.readFile(await safePath(dir, asset.name));
      if (sha256(bytes) !== asset.sha256) throw new Error('上传前资产已变化：' + asset.name);
      const uploaded = await request('https://uploads.github.com' + route + '/releases/' + draft.id +
        '/assets?name=' + encodeURIComponent(asset.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (uploaded.name !== asset.name || uploaded.digest !== 'sha256:' + asset.sha256) throw new Error('上传结果文件名或 SHA-256 不符：' + asset.name);
    }
  } catch (error) {
    throw new Error('草稿 #' + draft.id + ' 已保留，请检查其附件。' + error.message, { cause: error });
  }
  return { draftId: draft.id, tag, version, targetId: target.id, commit, assets };
}

async function main() {
  const env = process.env;
  const source = env.RELEASE_SOURCE ? await safePath(process.cwd(), env.RELEASE_SOURCE) : process.cwd();
  const selected = await selectRelease(source, { event: env.GITHUB_EVENT_NAME, tag: env.RELEASE_TAG,
    targetId: env.TARGET_ID, expectedCommit: env.EXPECTED_COMMIT });
  if (process.argv[2] === 'select') {
    const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const summary = selected.skip ? '标签对应多个 Target。请手动运行 Draft Release，填写此标签并选择 ' +
      selected.targets.join(' / ') + ' 中的一个。' : '发布目标 <code>' + selected.target.id +
      '</code>，包版本 <code>' + escape(selected.version) + '</code>。';
    const message = 'Git 标签 <code>' + escape(selected.tag) + '</code>。' + summary;
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, message + '\n');
    if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, [
      'publish=' + !selected.skip, 'target=' + (selected.target?.id ?? ''), 'commit=' + selected.commit,
      'tag_key=' + sha256(selected.tag), '',
    ].join('\n'));
    return;
  }
  if (selected.skip) throw new Error('此标签含多个 Target，请手动选择发布目标');
  if (process.argv[2] === 'verify') await verifyReleaseBundle(source, selected, env.RELEASE_DIRECTORY, process.cwd());
  else if (process.argv[2] === 'draft') {
    const result = await publishDraft(source, selected, env.RELEASE_DIRECTORY, {
      repo: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, bundleRoot: process.cwd(),
    });
    console.log('已创建草稿 #' + result.draftId);
  } else throw new Error('用法：node tools/release.mjs select | verify | draft');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

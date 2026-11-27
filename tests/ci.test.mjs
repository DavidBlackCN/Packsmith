import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCiTarget, classifyChanges, planCi } from '../tools/ci.mjs';

const workspace = { targets: ['a', 'b'].map(id => ({ id, path: 'packs/' + id, artifacts: ['serverpack'] })) };
const none = { targets: [], tests: false, verify: false };
const everything = { targets: ['a', 'b'], tests: true, verify: true };

test('根据包内容、构建输入、维护工具和普通文档选择预览与验证范围', () => {
  const plan = (...files) => classifyChanges(workspace, files);
  assert.deepEqual(plan('README.md', 'docs/maintenance.md', '.agents/skills/modpack-maintainer/SKILL.md'), none);
  assert.deepEqual(plan('packs/a/.pakku/overrides/AGENTS.md'), { ...none, targets: ['a'] });
  assert.deepEqual(plan('packs/b/pakku-lock.json', 'tests/ci.test.mjs'), { targets: ['b'], tests: true, verify: false });
  for (const file of ['workspace.json', 'package.json', 'toolchain.json', 'pnpm-lock.yaml', 'tools/lib/build.mjs',
    'tools/lib/content-policy.mjs', 'tools/ci.mjs', '.github/workflows/ci.yml', '.github/actions/setup/action.yml']) {
    assert.deepEqual(plan(file), everything, file);
  }
  for (const file of ['tools/lib/intake-jar.mjs', 'tools/lib/review.mjs', 'tools/lib/apply-publish.mjs',
    'tools/lib/curseforge-fingerprint.mjs', 'tests/verify-apply.mjs']) {
    assert.deepEqual(plan(file), { targets: [], tests: true, verify: true }, file);
  }
});

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith CI '));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const put = async (name, bytes) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  await put('workspace.json', JSON.stringify(workspace));
  await put('.gitignore', 'dist/\n.work/\n');
  for (const target of workspace.targets) await put(target.path + '/pakku.json', '{}');
  return { root, git, put, commit, first: commit() };
}

test('push 只看本次提交范围；跨 Target 移动选两包，随后的文档 push 不触发预览', async t => {
  const f = await fixture(t);
  await f.put('packs/a/中文文件.md', 'one');
  const added = f.commit();
  const push = (before, after) => planCi(f.root, 'push', { before, after });
  assert.deepEqual(await push(f.first, added), { ...none, targets: ['a'] });
  f.git('mv', 'packs/a/中文文件.md', 'packs/b/中文文件.md');
  const moved = f.commit();
  assert.deepEqual(await push(added, moved), { ...none, targets: ['a', 'b'] });
  await f.put('README.md', 'docs');
  assert.deepEqual(await push(moved, f.commit()), none);
});

test('PR 从共同祖先计算累计修改，首次 push、不可达基线与手动运行保守全量', async t => {
  const f = await fixture(t);
  f.git('checkout', '-qb', 'topic');
  await f.put('packs/a/recipe.json', '{}');
  const head = f.commit();
  f.git('checkout', '-q', 'main');
  await f.put('packs/b/recipe.json', '{}');
  const base = f.commit();
  const pr = { pull_request: { base: { sha: base }, head: { sha: head } } };
  assert.deepEqual(await planCi(f.root, 'pull_request', pr), { ...none, targets: ['a'] });
  for (const before of [undefined, '0'.repeat(40), 'f'.repeat(40)]) {
    assert.deepEqual(await planCi(f.root, 'push', { before, after: head }), everything);
  }
  assert.deepEqual(await planCi(f.root, 'workflow_dispatch', {}), everything);
  assert.deepEqual(await planCi(f.root, 'push', { deleted: true }), none);
});

test('CI 包装器使用所选检出的构建器和目录；仅声明 serverpack 时允许临时副本产生其他格式', async t => {
  const f = await fixture(t);
  // Simulate a tag that already contains the builder but predates tools/ci.mjs.
  await f.put('tools/lib/build.mjs', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    export async function build(root, target) {
      const out = path.join(root, 'dist', target.id, 'build-fixture');
      await fs.mkdir(out, { recursive: true });
      const git = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const report = { schema: 1, targetId: target.id, git, dirty: false, missing: [],
        artifacts: [{ kind: 'serverpack', name: 'server.zip' }], uncollected: ['build/modrinth/sample.mrpack'] };
      await fs.writeFile(path.join(out, 'build-report.json'), JSON.stringify(report));
      await fs.writeFile(path.join(out, 'server.zip'), 'fixture');
      await fs.writeFile(path.join(out, 'SHA256SUMS'), 'fixture');
      return { out, report };
    }
  `);
  const head = f.commit();
  const ci = fileURLToPath(new URL('../tools/ci.mjs', import.meta.url));
  const outputFile = path.join(f.root, '.work', 'github-output');
  await fs.mkdir(path.dirname(outputFile));
  execFileSync(process.execPath, [ci, 'build'], { cwd: f.root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TARGET_ID: 'a', EXPECTED_COMMIT: head, GITHUB_OUTPUT: outputFile } });
  assert.equal((await fs.readFile(outputFile, 'utf8')).trim(), 'output=dist/a/build-fixture');
  await assert.rejects(buildCiTarget(f.root, 'a', '0'.repeat(40)), /预期提交/);
  await f.put('untracked.txt', 'unexpected source change');
  await assert.rejects(buildCiTarget(f.root, 'a', head), /未跟踪/);
});

test('空凭据时仍实际尝试构建，保留 CurseForge 授权失败的原始错误并解释如何复验', async t => {
  const f = await fixture(t);
  await f.put('tools/lib/build.mjs', "export async function build() { throw new Error('CurseForge HTTP 403: Forbidden'); }");
  const head = f.commit();
  const env = { ...process.env, TARGET_ID: 'a', EXPECTED_COMMIT: head };
  delete env.CURSEFORGE_API_KEY;
  const ci = fileURLToPath(new URL('../tools/ci.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [ci, 'build'], { cwd: f.root, env, encoding: 'utf8',
    stdio: 'pipe', windowsHide: true }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /CurseForge HTTP 403: Forbidden/);
    assert.match(error.stderr, /CURSEFORGE_API_KEY/);
    return true;
  });
});

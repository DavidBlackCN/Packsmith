import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDependencies } from '../tools/lib/apply-dependencies.mjs';

const hash = (a, s) => createHash(a).update(s).digest('hex');
const artifact = 'reviewed JAR bytes';
const item = {
  kind: 'mod', path: 'mods/renamed.jar', size: Buffer.byteLength(artifact),
  ...Object.fromEntries(['sha512', 'sha256', 'sha1'].map(a => [a, hash(a, artifact)])),
};
const release = {
  projectId: 'P2', versionId: 'V2', fileName: 'example-2.jar', size: item.size,
  hashes: { sha1: item.sha1, sha512: item.sha512 }, gameVersions: ['1.21.1'], loaders: ['fabric'],
};
const exact = { status: 'exact', release };
const add = { type: 'dependency', action: 'add', path: item.path, platform: 'modrinth' };
const remove = from => ({ type: 'dependency', action: 'remove', from });
const header = { target: 'modrinth', mc_versions: ['1.21.1'], loaders: { fabric: '0.16.14' }, lockfile_version: 2 };

function project(pakkuId, projectId, versionId, fileName, platform = 'modrinth') {
  return {
    pakku_id: pakkuId, type: 'MOD', side: 'BOTH', id: { [platform]: projectId }, name: { [platform]: projectId },
    files: [{ type: platform, id: versionId, parent_id: projectId, file_name: fileName, hashes: { ...release.hashes },
      size: item.size, required_dependencies: [], mc_versions: ['1.21.1'], loaders: ['fabric'] }],
  };
}
const selected = () => project('new', 'P2', 'V2', release.fileName);
const old = () => project('old', 'P2', 'V1', 'example-1.jar');
const library = () => project('lib', 'L', 'L1', 'library.jar');

async function fixture(t, initial = [], platforms = { modrinth: exact }, target = 'modrinth') {
  const { path: root, remove: cleanup } = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'packsmith-pakku-'));
  t.after(cleanup);
  const dir = path.join(root, '.work', 'target');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, '.cache'));
  await fs.writeFile(path.join(root, '.cache', 'pakku-1.5.0.jar'), 'fixture');
  await fs.writeFile(path.join(root, 'toolchain.json'), JSON.stringify({
    pakku: { version: '1.5.0', sha256: hash('sha256', 'fixture'), url: 'https://example.test/pakku.jar' },
  }));
  const lockPath = path.join(dir, 'pakku-lock.json');
  const lock = { ...header, target, projects: initial };
  await fs.writeFile(lockPath, JSON.stringify(lock));
  const calls = [];
  const review = { items: [{ ...item, platforms }] };
  const manifest = { items: [item] };
  async function run(ops, invoke = () => assert.fail('unexpected Pakku command')) {
    return prepareDependencies(root, dir, ops, { review, manifest, execute: async (java, args, options) => {
      assert.equal(options.cwd, await fs.realpath(dir));
      assert.deepEqual(args.slice(3, 6), ['--working-path', '.', '--yes']);
      const cmd = args.slice(6);
      calls.push(cmd);
      const document = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      await invoke(document, cmd);
      await fs.writeFile(lockPath, JSON.stringify(document));
      return { code: 0, stdout: '', stderr: '' };
    } });
  }
  return { root, run, calls, review };
}

test('新增锁定已核对的发布文件，并在真实锁差异中区分显式和递归依赖', async t => {
  const { run, calls } = await fixture(t, [], { modrinth: { ...exact, release: {
    ...release, dependencies: [{ type: 'required', projectId: 'L', versionId: 'L1' }],
  } } });
  const result = await run([add], lock => {
    const direct = selected(), dep = library(), nested = project('nested', 'N', 'N1', 'nested.jar');
    direct.files[0].required_dependencies.push('L');
    direct.pakku_links = ['lib'];
    dep.files[0].required_dependencies.push('N');
    lock.projects.push(direct, dep, nested);
  });
  assert.deepEqual(calls, [['add', 'prj', '--mr', 'P2:V2']]);
  assert.deepEqual(result.changes.map(c => [c.kind, c.direct, c.name]), [
    ['add', true, 'P2'], ['add', false, 'L'], ['add', false, 'N'],
  ]);
  assert.equal(result.changes[0].before, null);
  assert.deepEqual(result.changes[0].after.files[0], { platform: 'modrinth', projectId: 'P2',
    fileId: 'V2', fileName: release.fileName, hashes: release.hashes, size: item.size });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('按外部项目 ID 将原生 Pakku 变动的内部 ID 对应到同一次升级', async t => {
  const { run, calls } = await fixture(t, [old(), library()]);
  const result = await run([{ ...add, action: 'update', from: 'old' }], lock => { lock.projects[0] = selected(); });
  assert.deepEqual(calls, [['add', 'prj', '--mr', 'P2:V2']]);
  assert.deepEqual(result.changes.map(c => [c.kind, c.direct, c.before.pakkuId, c.after.pakkuId,
    c.before.files[0].fileName, c.after.files[0].fileName]), [
    ['update', true, 'old', 'new', 'example-1.jar', 'example-2.jar'],
  ]);
});

const cf = { status: 'exact', release: { projectId: '123', fileId: '456', fileName: release.fileName,
  size: item.size, hashes: { sha1: item.sha1 }, gameVersions: ['1.21.1'], loaders: ['fabric'] } };
test('允许有双平台字节证据的来源替换；多平台工程显式固定两个文件 ID', async t => {
  const platforms = { modrinth: exact, curseforge: cf };
  const source = project('cur', '123', '155', 'old.jar', 'curseforge');
  const a = await fixture(t, [source], platforms);
  const result = await a.run([{ ...add, action: 'replace', from: 'cur' }], (lock, args) => {
    lock.projects = args[0] === 'rm' ? [] : [selected()];
  });
  assert.deepEqual(a.calls, [['rm', '--no-deps', '--', '123'], ['add', 'prj', '--mr', 'P2:V2']]);
  assert.deepEqual(result.changes.map(c => [c.kind, c.direct]), [['add', true], ['remove', true]]);
  const b = await fixture(t, [], platforms, 'multiplatform');
  await b.run([add], lock => {
    const direct = selected();
    Object.assign(direct.id, source.id);
    direct.files.push(project('cur', '123', '456', release.fileName, 'curseforge').files[0]);
    lock.projects.push(direct);
  });
  assert.deepEqual(b.calls, [['add', 'prj', '--mr', 'P2:V2', '--cf', '123:456']]);
});

test('目标平台自动关联的每一个发布文件都要匹配已批准 JAR 的长度与哈希', async t => {
  const cfAdd = { ...add, platform: 'curseforge' };
  const make = () => {
    const direct = selected();
    direct.id.curseforge = '123';
    direct.files.push(project('cur', '123', '456', release.fileName, 'curseforge').files[0]);
    return direct;
  };
  for (const size of [item.size, item.size + 1]) {
    const good = size === item.size;
    const f = await fixture(t, [], { curseforge: cf });
    const result = f.run([cfAdd], lock => {
      const direct = make();
      direct.files[0].size = size;
      lock.projects.push(direct);
    });
    if (good) assert.equal((await result).changes[0].after.files.length, 2);
    else await assert.rejects(result, /不同字节/);
    assert.deepEqual(f.calls, [['add', 'prj', '--cf', '123:456']]);
  }
  for (const hashes of [{}, { ...release.hashes, sha1: '1'.repeat(40) }]) {
    const f = await fixture(t, [], { curseforge: cf }, 'multiplatform');
    await assert.rejects(f.run([cfAdd], lock => {
      const direct = make();
      direct.files[0].hashes = hashes;
      lock.projects.push(direct);
    }), /不同字节/);
  }
});

test('显式移除只处理指定项目，已安装项目仍需此库时拒绝候选', async t => {
  const a = await fixture(t, [old(), library()]);
  const result = await a.run([remove('old')], lock => { lock.projects.shift(); });
  assert.deepEqual(a.calls, [['rm', '--no-deps', '--', 'P2']]);
  assert.deepEqual(result.changes.map(c => [c.kind, c.direct, c.before.name, c.after]), [['remove', true, 'P2', null]]);
  const dependent = old();
  dependent.files[0].required_dependencies.push('L');
  const b = await fixture(t, [dependent, library()]);
  await assert.rejects(b.run([remove('lib')], lock => { lock.projects.pop(); }), /仍有项目需要已移除依赖/);
  const c = await fixture(t, [old(), library()]);
  await assert.rejects(c.run([remove('old')], () => {}), /未移除指定项目/);
});

test('同批显式移除旧项目和新增无关项目时，预览列出两项直接变更', async t => {
  const f = await fixture(t, [library()]);
  const report = await f.run([add, remove('lib')], (lock, args) => {
    if (args[0] === 'rm') lock.projects.pop();
    else lock.projects.push(selected());
  });
  assert.deepEqual(f.calls, [['rm', '--no-deps', '--', 'L'], ['add', 'prj', '--mr', 'P2:V2']]);
  assert.deepEqual(report.changes.map(c => [c.kind, c.name, c.direct]), [['add', 'P2', true], ['remove', 'L', true]]);
});

test('在调用 Pakku 之前拒绝未核验的发布、冲突的来源、重复选择和不兼容 Target', async t => {
  const badHash = { ...release, hashes: { ...release.hashes, sha1: '0'.repeat(40) } };
  const cases = [
    [[], { modrinth: { status: 'unverified' } }, [add], /缺少一致/],
    [[], { modrinth: { ...exact, release: badHash } }, [add], /哈希/],
    [[], { modrinth: { ...exact, release: { ...release, loaders: ['neoforge'] } } }, [add], /不兼容/],
    [[library()], { modrinth: exact }, [{ ...add, action: 'update', from: 'lib' }], /不对应/],
    [[library()], { modrinth: exact }, [{ ...add, action: 'replace', from: 'lib' }], /不对应/],
    [[old()], { modrinth: exact }, [add], /不对应/],
    [[], { modrinth: exact }, [add, add], /多次选择/],
    [[], {}, [remove('missing')], /现有 Mod/],
  ];
  for (const [initial, matches, ops, pattern] of cases) {
    const f = await fixture(t, initial, matches);
    await assert.rejects(f.run(ops), pattern);
    assert.deepEqual(f.calls, []);
  }
});

test('Pakku 的成功退出码不能掩盖错误版本、错误文件、缺失依赖或不相干的锁变化', async t => {
  const cases = [
    [lock => {}, /未锁定/],
    [lock => { const p = selected(); p.files[0].id = 'V3'; lock.projects.push(p); }, /未锁定/],
    [lock => { const p = selected(); p.files[0].hashes.sha1 = 'abc'; lock.projects.push(p); }, /未锁定/],
    [lock => { const p = selected(); p.files[0].required_dependencies.push('X'); lock.projects.push(p); }, /缺少必需/],
    [lock => { lock.projects.push(selected(), project('extra', 'X', 'X1', 'extra.jar')); }, /无关依赖/],
    [lock => { lock.projects = [selected()]; }, /意外移除/],
    [lock => { lock.projects[0].side = 'CLIENT'; lock.projects.push(selected()); }, /无关的原锁项目/],
    [lock => { lock.mc_versions = ['1.20']; lock.projects.push(selected()); }, /Target 或版本/],
  ];
  for (const [mutation, pattern] of cases) {
    const f = await fixture(t, [library()]);
    await assert.rejects(f.run([add], mutation), pattern);
  }
  const f = await fixture(t, [library()], { modrinth: { ...exact, release: {
    ...release, dependencies: [{ type: 'required', projectId: 'L', versionId: 'L2' }],
  } } });
  await assert.rejects(f.run([add], lock => { lock.projects.push(selected()); }), /发布方声明的必需依赖/);
});

test('依赖工具拒绝操作正式 packs', async t => {
  const { root } = await fixture(t);
  const dir = path.join(root, 'packs', 'formal');
  await fs.mkdir(dir, { recursive: true });
  await assert.rejects(prepareDependencies(root, dir, [add], {}), /临时副本/);
});

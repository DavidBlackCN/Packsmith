import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bootstrap, exportPakku, requireSuccess, run, sha256, validateExportOutput, verifiedTool,
} from '../tools/lib/pakku.mjs';
import { loadWorkspace, safePath, selectTarget } from '../tools/lib/workspace.mjs';

async function temporaryRoot(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'Packsmith 测试-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('单 Target 自动选择，多 Target 要求默认或显式选择', async t => {
  const root = await temporaryRoot(t);
  const fabric = { id: 'fabric', path: 'packs/Fabric 示例', artifacts: ['modrinth'] };
  const forge = { id: 'forge', path: 'packs/Forge 示例', artifacts: ['serverpack'] };
  for (const target of [fabric, forge]) await fs.mkdir(path.join(root, target.path), { recursive: true });
  const write = value => fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify(value));

  await write({ targets: [fabric] });
  assert.deepEqual(selectTarget(await loadWorkspace(root)), fabric);
  await write({ targets: [fabric, forge] });
  const multi = await loadWorkspace(root);
  assert.throws(() => selectTarget(multi), /--target/);
  await write({ targets: [fabric, forge], defaultTarget: 'forge' });
  const workspace = await loadWorkspace(root);
  assert.deepEqual(selectTarget(workspace), forge);
  assert.deepEqual(selectTarget(workspace, 'fabric'), fabric);
  assert.throws(() => selectTarget(workspace, 'missing'), /--target/);

  await write({ targets: [fabric, { ...forge, path: fabric.path.toLowerCase() }] });
  await assert.rejects(loadWorkspace(root), /重复/);
  await write({ targets: [fabric, { ...forge, path: fabric.path + '/nested' }] });
  await assert.rejects(loadWorkspace(root), /嵌套/);
  await write({ targets: [fabric], defaultTarget: 'missing' });
  await assert.rejects(loadWorkspace(root), /默认 Target/);
});

test('工作目录和缓存目录中的链接不能将路径指向工作区以外', async t => {
  const root = await temporaryRoot(t);
  const outside = await temporaryRoot(t);
  const cache = path.join(root, '.cache');
  await fs.symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safePath(root, '.cache/tool.jar'), /junction/);
  await assert.rejects(safePath(cache, 'tool.jar'), /junction/);
  await assert.rejects(safePath(root, '../outside'), /相对路径/);
});

test('下载校验通过才缓存，Pakku 在目标目录用相对 working-path 导出', async t => {
  const root = await temporaryRoot(t);
  const bytes = Buffer.from('fixture Pakku JAR');
  const spec = { version: '1.5.0', url: 'https://example.invalid/pakku.jar', sha256: sha256(bytes) };
  await fs.writeFile(path.join(root, 'toolchain.json'), JSON.stringify({ pakku: spec }));
  await assert.rejects(verifiedTool(root), /pnpm bootstrap/);
  await assert.rejects(bootstrap(root, async () => new Response('corrupt')), /SHA-256/);
  await assert.rejects(verifiedTool(root), /pnpm bootstrap/);
  const cached = await bootstrap(root, async () => new Response(bytes));
  await bootstrap(root, async () => assert.fail('缓存命中时不应重新下载'));
  const targetPath = path.join(root, '目标');
  const result = await exportPakku(root, targetPath, {
    java: 'fixture-java',
    execute: async (java, args, options) => {
      assert.equal(java, 'fixture-java');
      assert.equal(options.cwd, targetPath);
      assert.equal(options.capture, true);
      assert.deepEqual(args, ['-Dfile.encoding=UTF-8', '-jar', cached.jar, '--working-path', '.', 'export']);
      return { code: 0, stdout: "[modrinth profile] exported to 'test.mrpack'", stderr: '' };
    },
  });
  assert.equal(result.code, 0);
  await fs.writeFile(cached.jar, 'corrupt');
  await assert.rejects(verifiedTool(root), /SHA-256/);
});

test('Pakku 退出码为零时仍检查每个 profile 和迁移信息', () => {
  const success = "[modrinth profile] exported to 'test.mrpack'";
  for (const extra of ['[serverpack profile] failed', '[Migration]']) {
    assert.throws(() => validateExportOutput({ code: 0, stdout: success, stderr: extra }), /导出报告/);
  }
  assert.throws(() => validateExportOutput({ code: 0, stdout: '', stderr: '' }), /导出报告/);
});

test('子进程原样收到参数和中文，非零退出码传给调用方', async () => {
  const value = '中文 空格 & example';
  const result = await run(process.execPath, ['-e', 'console.log(process.argv[1]); process.exit(17)', value], { capture: true });
  assert.equal(result.stdout.trim(), value);
  assert.throws(() => requireSuccess(result), error => error.exitCode === 17);
});

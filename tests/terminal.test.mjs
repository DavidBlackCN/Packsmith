import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { field, isCI, multiline, terminal } from '../tools/lib/terminal.mjs';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('输出按各自的 TTY 着色，NO_COLOR 保留文字和状态符号', () => {
  const tty = { isTTY: true };
  const ansi = /\x1b\[/;
  assert.match(terminal(tty, {}).heading('检查'), ansi);
  assert.equal(terminal(tty, { NO_COLOR: '1' }).ok('完成'), '✓ 完成');
  assert.equal(terminal({}, {}).ok('完成'), '[ok] 完成');
  for (const env of [{ TERM: 'dumb' }, { CI: 'true' }]) {
    const ui = terminal(tty, env);
    assert.equal(ui.warn('请先采集'), '[warn] 请先采集');
    assert.equal(ui.fail('构建失败'), '[fail] 构建失败');
    assert.doesNotMatch(ui.muted('产物'), ansi);
  }
  assert.equal(isCI({ CI: 'false' }), false);
});

test('外部字段只占一行，差异和诊断保留 LF 与制表符', () => {
  assert.equal(field('脚本\r\n\t配方\u009b\u202e'), '脚本\\x0d\\x0a\\x09配方\\x9b\\u202e');
  assert.equal(multiline('第一行\r\n\t第二行\r\x1b'), '第一行\n\t第二行\\x0d\\x1b');
  const longPath = 'packs/开发 实例/' + '配方/'.repeat(20) + 'press.js';
  assert.equal(field(longPath), longPath);
});

test('显式菜单遇到管道或 CI 会自行退出并在 stderr 给出直接命令', async () => {
  for (const ci of ['false', 'true']) {
    // execFile keeps the child's stdin pipe open. Waiting for EOF would time out.
    await assert.rejects(run(process.execPath, ['tools/menu.mjs'], {
      cwd: root, env: { ...process.env, CI: ci }, timeout: 5000,
    }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /pnpm mp/);
      assert.doesNotMatch(error.stderr, /\x1b/);
      return true;
    });
  }
});

test('CI 下三个帮助入口都能直接结束', async () => {
  for (const args of [[], ['help'], ['--help']]) {
    const { stdout, stderr } = await run(process.execPath, ['tools/mp.mjs', ...args], {
      cwd: root, env: { ...process.env, CI: 'true' }, timeout: 5000,
    });
    assert.match(stdout, /intake/);
    assert.doesNotMatch(stdout, /\x1b/);
    assert.equal(stderr, '');
  }
});

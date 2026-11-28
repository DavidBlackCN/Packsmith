import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { renderHome } from '../tools/menu-home.mjs';
import { createMenuUi, MenuCancelled } from '../tools/menu-ui.mjs';

const home = { version: '3.0.0-dev.0', workspace: '我的整合包', target: 'fabric-test' };
const labels = ['从实例采集', '审查与应用', '检查与构建', '提交已暂存的改动'];
const descriptions = ['记录候选文件', '对照所选功能', '导出当前 Target', '提交暂存内容'];
const options = labels.map((text, index) => ({ text, index, detail: descriptions[index] }));

function homeTerminal(t) {
  // Node's readline also checks the real TERM when emitting VT cursor movements.
  const previousTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = enabled => { input.isRaw = enabled; return input; };
  output.columns = 92;
  output.rows = 24;
  let buffer = '';
  output.on('data', chunk => { buffer += chunk.toString('utf8'); });
  const ui = createMenuUi({ input, output, env: { TERM: 'xterm-256color', NO_COLOR: '1' } });
  t.after(() => { ui.close(); input.destroy(); output.destroy(); });

  function frame(active) {
    return renderHome({ ...home, options, active, filter: '', columns: output.columns, rows: output.rows,
      ascii: false, color: false });
  }
  function takeOutput(raw = false) {
    const snapshot = buffer.replaceAll('\r\n', '\n');
    buffer = '';
    return raw ? snapshot : stripVTControlCharacters(snapshot);
  }
  const open = () => ui.choose('Packsmith', labels, '退出', descriptions, home);
  const listeners = () => [input.listenerCount('keypress'), output.listenerCount('resize')];
  return { ui, input, output, frame, takeOutput, open, listeners };
}

test('主页响应方向键和终端缩放，保留高亮并在 Enter 后释放主页监听器', async t => {
  const f = homeTerminal(t);
  const idle = f.listeners();
  const selection = f.open();
  assert.ok(f.takeOutput().includes(f.frame(0)), '宽屏首次打开显示第一项');
  f.input.write('\x1b[B');
  const wide = f.frame(1);
  assert.notEqual(wide, f.frame(0));
  assert.ok(f.takeOutput().includes(wide), '方向键立即更新高亮');

  f.output.columns = 44;
  f.output.rows = 22;
  f.output.emit('resize');
  const narrow = f.frame(1);
  assert.notEqual(narrow, wide);
  const repaint = f.takeOutput(true);
  assert.ok(stripVTControlCharacters(repaint).includes(narrow), '尺寸变化后不需要再按键就能看到保留高亮的窄屏主页');
  // The terminal has already wrapped the old wide frame when resize arrives.
  const measure = createInterface({ input: new PassThrough(), output: f.output, terminal: false });
  measure.setPrompt(wide + '\n');
  const oldCursorRows = measure.getCursorPos().rows;
  measure.close();
  const beforeErase = repaint.split('\x1b[0J')[0];
  const movedUp = [...beforeErase.matchAll(/\x1b\[(\d+)A/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(movedUp, oldCursorRows, '按旧主页在新宽度下实际占用的行数擦除，避免残留宽屏详情');
  f.input.write('\r');
  assert.equal(await selection, 1);
  assert.deepEqual(f.listeners(), idle);
  await f.ui.suspend(() => {
    assert.equal(f.input.isRaw, false);
    assert.deepEqual(f.listeners(), [0, 0], '将终端交给子进程时没有主页或 readline 监听器');
  });
  assert.deepEqual(f.listeners(), idle);
});

test('Esc 离开主页后可再次进入，Ctrl+C 释放 raw mode 与 resize 监听器', async t => {
  const f = homeTerminal(t);
  const idle = f.listeners();
  const first = f.open();
  f.input.write('\x1b');
  assert.equal(await first, null);
  assert.deepEqual(f.listeners(), idle);
  f.takeOutput();

  const cancelled = assert.rejects(f.open(), MenuCancelled);
  assert.ok(f.takeOutput().includes(f.frame(0)));
  f.input.write('\x03');
  await cancelled;
  assert.equal(f.input.isRaw, false);
  assert.deepEqual(f.listeners(), [0, 0]);
});

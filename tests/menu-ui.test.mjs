import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createMenuUi, MenuCancelled } from '../tools/menu-ui.mjs';
import { runMenu } from '../tools/menu.mjs';

function terminal(t, tty = false, env = {}) {
  const input = new PassThrough(), output = new PassThrough();
  if (tty) {
    input.isTTY = output.isTTY = true;
    input.setRawMode = raw => { input.isRaw = raw; };
  }
  let transcript = '';
  output.on('data', chunk => { transcript += chunk; });
  const ui = createMenuUi({ input, output, env });
  t.after(() => { ui.close(); input.destroy(); output.destroy(); });
  return { ui, input, transcript: () => transcript };
}

test('编号按显示顺序从一开始，只有单独的 0 返回', async t => {
  const { ui, input, transcript } = terminal(t);
  const chosen = ui.choose('主菜单', ['采集', '构建'], { backLabel: '退出' });
  for (const line of ['', '01', '2x', '3', '1 2']) {
    input.write(line + '\n');
    await setImmediate();
  }
  input.write(' 2 \n');
  assert.equal(await chosen, 1);
  assert.match(transcript(), /\[0\] 退出/);
  assert.equal(transcript().match(/请输入 1 到 2/g).length, 5);
  const back = ui.choose('子菜单', ['文件']);
  input.write('0\n');
  assert.equal(await back, null);
});

test('方向键选择、Esc 返回、Ctrl+C 退出，编号仍可直接输入', async t => {
  const { ui, input } = terminal(t, true);
  const selected = ui.choose('操作', ['审查', '构建', '提交']);
  input.write('\x1b[B\r');
  assert.equal(await selected, 1);
  const third = ui.choose('操作', ['审查', '构建', '提交']);
  input.write('3\r');
  assert.equal(await third, 2);
  const back = ui.choose('子菜单', ['目标']);
  input.write('\x1b');
  assert.equal(await back, null);
  const no = ui.confirm('确定？');
  input.write('\x1b');
  assert.equal(await no, null);
  const cancel = assert.rejects(ui.choose('子菜单', ['目标']), MenuCancelled);
  input.write('\x03');
  await cancel;
});

test('勾选跨筛选保留，不会因结果为空而自动批准', async t => {
  const { ui, input, transcript } = terminal(t, true);
  const selected = ui.chooseMany('功能', ['配方', '资源', '世界设置']);
  input.write(' ');
  input.write('/世界\r');
  await setImmediate();
  input.write(' ');
  input.write('/无此功能\r');
  await setImmediate();
  assert.match(transcript(), /没有匹配项/);
  input.write('\r');
  assert.deepEqual(await selected, [0, 2]);
});

test('TERM=dumb 在真实终端使用纯文本编号菜单', async t => {
  const { ui, input, transcript } = terminal(t, true, { TERM: 'dumb' });
  const selected = ui.chooseMany('功能', ['一', '二']);
  input.write('2，1\n');
  assert.deepEqual(await selected, [1, 0]);
  assert.doesNotMatch(transcript(), /\x1b|↑/);
});

test('全选和反选只影响筛选结果，搜索词中的 a、i 和空格仍是普通文字', async t => {
  const { ui, input, transcript } = terminal(t, true);
  const selected = ui.chooseMany('选择功能', ['通用配方', '矿物', '矿石'], {
    descriptions: ['', { detail: 'ai pack', meta: ['config/矿物.json'] }, { detail: 'ai pack' }],
  });
  input.write(' '); // 保留筛选范围外的第一项。
  input.write('/ai pack\r');
  await setImmediate();
  input.write('a');
  assert.match(transcript(), /已选 3 项/);
  input.write('i');
  assert.match(transcript(), /已选 1 项/);
  input.write('/矿物.json\r');
  await setImmediate();
  input.write('i');
  input.write('\r');
  assert.deepEqual(await selected, [0, 1]);
});

test('纯编号模式可以筛选、全选、反选，最后用回车提交勾选项', async t => {
  const { ui, input } = terminal(t, true, { TERM: 'dumb' });
  const selected = ui.chooseMany('选择功能', ['甲', '乙', '丙']);
  for (const line of ['a', '/乙', 'i']) {
    input.write(line + '\n');
    await setImmediate();
  }
  input.write('\n');
  assert.deepEqual(await selected, [0, 2]);
});

test('确认页首次回车为否，方向键明确选是后才能用回车同意', async t => {
  const { ui, input } = terminal(t, true);
  const view = { section: 'APPLY', facts: [['预览编号', 'd'.repeat(64)]], warning: '会写入正式工程' };
  const decline = ui.confirm('应用这份预览？', view);
  input.write('\r');
  assert.equal(await decline, false);
  const approve = ui.confirm('应用这份预览？', view);
  input.write('\x1b[B\r');
  assert.equal(await approve, true);
  const back = ui.confirm('应用这份预览？', view);
  input.write('0\r');
  assert.equal(await back, null);
});

test('按 Esc 取消存档选择会回到菜单，保留上次采集', async t => {
  const temp = await fs.mkdtempDisposable(path.join(os.tmpdir(), 'packsmith-menu-esc-'));
  t.after(temp.remove);
  const root = await fs.realpath(temp.path);
  await fs.mkdir(path.join(root, 'packs/test'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({
    targets: [{ id: 'test', path: 'packs/test', artifacts: ['modrinth'] }],
  }));
  let choices = 0, confirmations = 0;
  await runMenu(root, {
    choose: () => choices++ === 0 ? 0 : null,
    ask: () => root,
    confirm: () => { confirmations++; return null; },
    write: message => assert.fail(message),
  });
  assert.equal(confirmations, 1);
  assert.equal(choices, 2);
  await assert.rejects(fs.access(path.join(root, '.intake')), { code: 'ENOENT' });
});

test('多选整行有效才采用，支持中英文逗号、空格及重复编号', async t => {
  const { ui, input, transcript } = terminal(t);
  const chosen = ui.chooseMany('保留的功能', ['A', 'B', 'C', 'D']);
  for (const line of ['2,', '2，，3', '0 2', '2,9', '1-3']) {
    input.write(line + '\n');
    await setImmediate();
  }
  input.write('3， 1 3, 4\n');
  assert.deepEqual(await chosen, [2, 0, 3]);
  assert.equal(transcript().match(/请输入 1 到 4/g).length, 5);
  const back = ui.chooseMany('保留的功能', ['A']);
  input.write('0\n');
  assert.equal(await back, null);
});

test('自由输入去除边缘空白，确认需要明确的肯定回答', async t => {
  const { ui, input } = terminal(t);
  const dir = ui.ask('游戏目录：');
  input.write('  测试 实例  \n');
  assert.equal(await dir, '测试 实例');
  for (const [line, expected] of [['', false], ['0', null], ['否', false], ['不确认', false], ['y', true], ['YES', true], ['是', true], ['确认', true]]) {
    const confirmation = ui.confirm('确认应用？');
    input.write(line + '\n');
    assert.equal(await confirmation, expected);
  }
});

test('输入关闭或 Ctrl+C 会结束待确认操作', async t => {
  for (const tty of [false, true]) {
    const { ui, input } = terminal(t, tty);
    const pending = assert.rejects(ui.confirm('确认应用？'), MenuCancelled);
    if (tty) input.write('\x03');
    else input.end();
    await pending;
    await assert.rejects(ui.ask('下一步？'), MenuCancelled);
  }
});

test('交互子进程独占 stdin，正常返回或报错后恢复菜单', async t => {
  const { ui, input } = terminal(t, true);
  const checkReleased = () => {
    assert.equal(input.isRaw, false);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.listenerCount('keypress'), 0);
  };
  assert.equal(await ui.suspend(() => { checkReleased(); return 7; }), 7);
  assert.equal(input.isRaw, true);
  await assert.rejects(ui.suspend(() => { checkReleased(); throw new Error('子进程失败'); }), /子进程失败/);
  const resumed = ui.ask('操作：');
  input.write('继续\r');
  assert.equal(await resumed, '继续');
});

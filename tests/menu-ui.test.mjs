import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createMenuUi, MenuCancelled } from '../tools/menu-ui.mjs';

function terminal(t, tty = false) {
  const input = new PassThrough(), output = new PassThrough();
  if (tty) {
    input.isTTY = output.isTTY = true;
    input.setRawMode = raw => { input.isRaw = raw; };
  }
  let transcript = '';
  output.on('data', chunk => { transcript += chunk; });
  const ui = createMenuUi({ input, output });
  t.after(() => { ui.close(); input.destroy(); output.destroy(); });
  return { ui, input, transcript: () => transcript };
}

test('编号按显示顺序从一开始，只有单独的 0 返回', async t => {
  const { ui, input, transcript } = terminal(t);
  const chosen = ui.choose('主菜单', ['采集', '构建'], '退出');
  for (const line of ['', '01', '2x', '3', '1 2']) {
    input.write(line + '\n');
    await setImmediate();
  }
  input.write(' 2 \n');
  assert.equal(await chosen, 1);
  assert.match(transcript(), /0\. 退出/);
  assert.equal(transcript().match(/请输入 1 到 2/g).length, 5);
  const back = ui.choose('子菜单', ['文件']);
  input.write('0\n');
  assert.equal(await back, null);
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
  for (const [line, expected] of [['', false], ['否', false], ['不确认', false], ['y', true], ['YES', true], ['是', true], ['确认', true]]) {
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

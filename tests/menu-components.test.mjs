import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { renderInput, renderSelection, width } from '../tools/menu-components.mjs';

const choices = [
  { index: 0, text: '保留压板配方', detail: '保留实例中测试的配方。', meta: ['公共文件  kubejs/server_scripts/plates.js'] },
  { index: 1, text: '客户端选项', detail: '复制视频配置。', meta: ['客户端文件  config/video.json'] },
  { index: 3, text: '附加资源包' },
];
const view = (changes = {}) => renderSelection({ title: '选择要预览的功能', section: 'FEATURE SELECTION',
  context: 'Target fabric-1.21', options: choices, columns: 92, rows: 24, ...changes });

test('单选页跟随焦点显示详情，选项只有名称时使用整行', () => {
  const first = view();
  assert.match(first, /▌ \[1\] +保留压板配方 +当前项详情/);
  assert.match(first, /公共文件 +kubejs\/server_scripts\/plates\.js/);
  assert.doesNotMatch(first, /video\.json|Space|勾选/);
  const other = view({ active: 1 });
  assert.match(other, /▌ \[2\] +客户端选项/);
  assert.match(other, /客户端文件 +config\/video\.json/);
  const plain = view({ active: 2 });
  assert.match(plain, /▌ \[4\] +附加资源包/);
  assert.doesNotMatch(plain, /当前项详情|公共文件|客户端文件/);
});

test('多选中的焦点、已勾选的原编号和总数各自独立', () => {
  const filtered = view({ multiple: true, checked: new Set([0, 3]), active: 0, options: choices.slice(1),
    filter: '客户端', total: 4 });
  assert.match(filtered, /已选 2 项 \/ 共 4 项/);
  assert.match(filtered, /▌ \[2\] +\[ \] 客户端选项/);
  assert.match(filtered, /4 +\[x\] 附加资源包/);
  assert.match(filtered, /\[a\] 全选匹配项/);
  assert.match(filtered, /\[i\] 反选匹配项/);
  assert.match(filtered, /多编号 \+ Enter/);
  const none = view({ multiple: true, filter: '其他', options: [], total: 4, checked: new Set([3]) });
  assert.match(none, /没有匹配项/);
  assert.match(none, /已选 1 项 \/ 共 4 项/);
  assert.match(none, /Enter\] 继续/);
  assert.doesNotMatch(none, /Space|移动/);
  assert.doesNotMatch(view({ options: [] }), /移动|筛选/);
});

test('长列表的键盘窗口围绕焦点，长路径在窄屏详情中完整折行', () => {
  const options = Array.from({ length: 80 }, (_, index) => ({ index, text: '候选项 ' + (index + 1) }));
  const scroll = view({ options, active: 75, rows: 12, columns: 80 });
  assert.match(scroll, /▌ \[76\] +候选项 76/);
  assert.match(scroll, /\d+–\d+ \/ 80/);
  assert.doesNotMatch(scroll, /候选项 1\b/);
  assert.ok(scroll.split('\n').length < 12);
  const long = '资源包/村庄与工坊/👩‍🔧/材质/e\u0301合成台.png';
  const narrow = view({ options: [{ index: 0, text: '同步材质', detail: long }], columns: 44, rows: 22 });
  assert.ok(narrow.replace(/\n +/g, '').includes(long));
  assert.doesNotMatch(narrow, /当前项详情/);
  for (const line of narrow.split('\n')) assert.ok(width(line) < 44, line);
  assert.equal(width('测e\u0301👩‍🔧'), 5);
});

test('确认按默认否排列，警告、完整预览 ID 和实际目标路径在短屏上仍可读', () => {
  const id = 'e37c09fa'.repeat(8);
  const target = 'packs/我的整合包' + '/服务器配置'.repeat(8);
  const confirm = { facts: [['Target', 'fabric-example'], ['Preview ID', id], ['写入目标', target]],
    warning: '确认后将修改 Target。' };
  const options = [{ index: 0, text: '否，返回' }, { index: 1, text: '是，写入并构建' }];
  for (const columns of [100, 80, 44]) {
    const page = view({ section: 'APPLY', options, confirm, columns, rows: 12, color: true });
    const plain = stripVTControlCharacters(page);
    assert.match(plain, /▌ \[1\] +否，返回/);
    assert.match(page, /\x1b\[1;33m! 确认后将修改 Target。/);
    assert.ok(plain.replace(/\n +/g, '').includes(target));
    assert.ok(plain.replace(/\n +/g, '').includes(id));
    if (columns >= 80) assert.ok(plain.includes(id), '能容下的 ID 保持在同一行');
    assert.match(plain, /y \/ 是 \+ Enter/);
    assert.doesNotMatch(plain, /Space|筛选|…/);
    for (const line of plain.split('\n')) assert.ok(width(line) < columns, line);
  }
  assert.doesNotMatch(view({ options, confirm: {} }), /警告|修改 Target/);
});

test('ASCII 编号模式列全选项及实际可用的快捷键', () => {
  const options = Array.from({ length: 20 }, (_, index) => ({ index, text: '功能 ' + (index + 1) }));
  const page = view({ ascii: true, color: true, multiple: true, options, active: 15, rows: 12, checked: new Set([19]) });
  assert.match(page, /1\. +\[ \] 功能 1/);
  assert.match(page, /20\. +\[x\] 功能 20/);
  assert.match(page, /a \+ Enter/);
  assert.match(page, /i \+ Enter/);
  assert.match(page, /\/关键词 \+ Enter/);
  assert.doesNotMatch(page, /↑|▌|Space|Esc|\x1b/);
});

test('输入页保留题目，Esc 与留空可返回；外来文字抵达终端前转义', () => {
  const unsafe = '名\x1b[2J\n\u202e';
  const input = renderInput({ title: '游戏目录 ' + unsafe, section: unsafe, context: unsafe, columns: 44 });
  assert.match(input, /游戏目录 名\\x1b\[2J\\x0a\\u202e/);
  assert.match(input, /留空 \/ Esc/);
  assert.doesNotMatch(input, /\x1b|\u202e|\[0\]|[\r\n]$/);
  const plain = renderInput({ title: '游戏目录', ascii: true, color: true });
  assert.doesNotMatch(plain, /Esc|\x1b/);
  assert.match(plain, /留空 \+ Enter/);
  const confirm = view({ color: true, title: unsafe, confirm: { facts: [[unsafe, unsafe]], warning: unsafe } });
  const safe = stripVTControlCharacters(confirm);
  assert.match(safe, /名\\x1b\[2J\\x0a\\u202e/);
  assert.doesNotMatch(confirm, /\x1b\[2J|\u202e|[\r\n]$/);
});

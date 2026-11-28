import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { renderHome } from '../tools/menu-home.mjs';

const options = [
  ['从实例采集', '扫描 Mod、配置、脚本和资源'],
  ['审查与应用', '对照候选，预览并批准选中的改动'],
  ['检查与构建', '校验 Target 并导出整合包'],
  ['提交已暂存的改动', '使用 czg 提交 Git 暂存区的改动'],
  ['切换 Target', '选择本次审查或构建的整合包'],
].map(([text, detail], index) => ({ index, text, detail }));
const frame = (overrides = {}) => renderHome({ version: '3.0.0-dev.0', workspace: '我的工作区',
  target: 'fabric-main', options, active: 0, columns: 92, rows: 24, color: false, ascii: false, ...overrides });

test('宽屏按工作流、Git、Target 分组，选中动作与详情并列', () => {
  const home = frame({ columns: 160, rows: 34, active: 1 });
  assert.match(home, /Packsmith +Workspace +我的工作区/);
  assert.match(home, /v3\.0\.0-dev\.0 +Target +fabric-main/);
  assert.match(home, /WORKFLOW +Review & Apply/);
  assert.match(home, /来源 +采集清单与当前 Target/);
  assert.match(home, /结果 +预览差异，确认后写入并构建/);
  assert.match(home, /WORKFLOW[\s\S]+REPOSITORY[\s\S]+CONTEXT/);
  assert.match(home, /▌ \[2\] +≡ +审查与应用/);
  assert.doesNotMatch(home, /\x1b|[\r\n]$/);
  assert.doesNotMatch(frame({ options: options.slice(0, 4) }), /CONTEXT|切换 Target/);
});

test('过滤后保留原编号、分组和动作，不从光标位置猜测动作身份', () => {
  const filtered = frame({ options: options.slice(3), active: 1, filter: 'target' });
  assert.match(filtered, /筛选 +\/target/);
  assert.match(filtered, /Switch Target/);
  assert.match(filtered, /▌ \[5\] +↔ +切换 Target/);
  assert.doesNotMatch(filtered, /WORKFLOW|从实例采集/);
  const empty = frame({ options: [], filter: 'xyz' });
  assert.match(empty, /没有匹配项/);
  assert.match(empty, /\/ \+ Enter\] 清除/);
  assert.match(empty, /Esc \/ 0 \/ Ctrl\+C\] 退出/);
  assert.doesNotMatch(empty, /移动|Collect Instance/);
});

test('窄屏将动作说明紧接在选中项下方，短屏仍可找到焦点和退出键', () => {
  const narrow = frame({ columns: 44, rows: 22, active: 3 });
  assert.match(narrow, /▌ \[4\] +± +提交已暂存的改动 *\n +Commit Staged Changes\n +使用 czg/);
  assert.match(narrow, /来源 +Git 暂存区/);
  assert.match(narrow, /pnpm mp help/);
  for (const [columns, rows] of [[160, 34], [92, 24], [44, 22], [44, 16], [80, 12], [32, 8]]) {
    for (const active of [0, 3, 4]) {
      const result = frame({ columns, rows, active });
      assert.ok(result.split('\n').length < rows, '留出输入行 ' + columns + '×' + rows);
      assert.ok(result.includes('▌ [' + (active + 1) + ']'));
      assert.match(result, /退出/);
    }
  }
});

test('只用 SGR 着色，焦点整行高亮，清洗来自工程、键盘与选项的控制字符', () => {
  const injected = '注入\x1b[2J\n\u202e';
  const result = frame({ color: true, workspace: injected, target: injected, version: injected, filter: injected,
    options: [{ ...options[0], text: injected, detail: injected }] });
  assert.doesNotMatch(result, /\x1b\[2J|\u202e/);
  assert.match(result, /\\x1b\[2J\\x0a\\u202e/);
  const focus = result.match(/\x1b\[1;38;5;16;48;5;80m([^\x1b]*)\x1b\[0m/);
  assert.ok(focus && focus[1].startsWith('▌ [1]') && focus[1].endsWith(' '));
  assert.doesNotMatch(stripVTControlCharacters(result), /\x1b/);
  assert.match(result, /\x1b\[38;5;252;48;5;238m Enter \x1b\[0m 选择/);
});

test('宽中文、组合音标和 emoji 在行末按整簇截短', () => {
  const grapheme = '👩‍🔧';
  const input = ('工' + 'e\u0301' + grapheme).repeat(36);
  const result = frame({ columns: 44, rows: 22, workspace: input, target: input, version: input,
    options: [{ ...options[0], text: input, detail: input }] });
  assert.match(result, /…/);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const line of result.split('\n')) {
    let cells = 0;
    for (const { segment } of segmenter.segment(line)) {
      if (segment.includes('\u200d') || segment.includes('👩') || segment.includes('🔧')) assert.equal(segment, grapheme);
      cells += /\p{Script=Han}|\p{Emoji_Presentation}/u.test(segment) ? 2 : 1;
    }
    assert.ok(cells < 44, '超过终端宽度 ' + line);
    assert.doesNotMatch(line, /e…/);
  }
});

test('TERM=dumb 可按编号进入或退出，提示与实际按键能力吻合', () => {
  const basic = frame({ ascii: true, color: true });
  assert.match(basic, /1\. +从实例采集/);
  assert.match(basic, /数字 \+ Enter/);
  assert.match(basic, /0 \/ Ctrl\+C\] 退出/);
  assert.match(basic, /pnpm mp help/);
  assert.match(basic, /1\. +从实例采集 +扫描 Mod/);
  assert.match(basic, /4\. +提交已暂存的改动 +使用 czg/);
  assert.doesNotMatch(basic, /\x1b|↑|↓|Esc|筛选|▌|▟|Collect Instance/);
});

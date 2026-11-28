import { field } from './lib/terminal.mjs';

export const homeActions = [
  { group: 'WORKFLOW', icon: '↓', name: 'Collect Instance', label: '从实例采集', detail: '扫描 Mod、配置、脚本和资源',
    source: '游戏实例目录', result: '.intake/current/report.md' },
  { group: 'WORKFLOW', icon: '≡', name: 'Review & Apply', label: '审查与应用', detail: '对照候选，预览并批准选中的改动',
    source: '采集清单与当前 Target', result: '预览差异，确认后写入并构建' },
  { group: 'WORKFLOW', icon: '◇', name: 'Check & Build', label: '检查与构建', detail: '校验 Target 并导出整合包',
    source: 'Target 配置与 Pakku 锁文件', result: '检查结果或 dist/ 下的整合包' },
  { group: 'REPOSITORY', icon: '±', name: 'Commit Staged Changes', label: '提交已暂存的改动', detail: '使用 czg 提交 Git 暂存区的改动',
    source: 'Git 暂存区', result: '当前分支上的本地提交' },
  { group: 'CONTEXT', icon: '↔', name: 'Switch Target', label: '切换 Target', detail: '选择本次审查或构建的整合包',
    source: 'workspace.json 中的 Target', result: '切换本次菜单使用的 Target' },
];

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Terminal cell widths, with ambiguous symbols narrow (the usual VT setting).
function cells(cluster) {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(cluster)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(cluster)) return 2;
  const n = cluster.codePointAt(0);
  return n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) || (n >= 0xa960 && n <= 0xa97f) ||
    (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff) ||
    (n >= 0xfe10 && n <= 0xfe19) || (n >= 0xfe30 && n <= 0xfe6f) ||
    (n >= 0xff01 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) ||
    (n >= 0x1b000 && n <= 0x1b2ff) || (n >= 0x20000 && n <= 0x3fffd)) ? 2 : 1;
}

function width(text) {
  let count = 0;
  for (const { segment } of graphemes.segment(text)) count += cells(segment);
  return count;
}

function clip(text, limit, ellipsis = '…') {
  if (limit <= 0) return '';
  let count = 0, result = '', prefix = '';
  const stop = limit - width(ellipsis);
  for (const { segment } of graphemes.segment(text)) {
    count += cells(segment);
    if (count > limit) return prefix + (stop >= 0 ? ellipsis : '');
    result += segment;
    if (count <= stop) prefix = result;
  }
  return result;
}

function pad(text, length) {
  return text + ' '.repeat(Math.max(0, length - width(text)));
}

export function renderHome({ version = '', workspace = '', target = '', options = [], active = 0,
  filter = '', columns = 80, rows = 24, color = false, ascii = false }) {
  // Reserve the terminal's last column for readline's wrap handling.
  const margin = columns < 36 ? ' ' : '  ';
  const area = Math.max(1, columns - margin.length - 1);
  const wide = columns >= 80;
  const compact = rows < 18;
  const navWidth = wide ? Math.min(48, Math.floor(area * 0.39)) : area;
  const gutter = '    ';
  const asideWidth = area - navWidth - gutter.length;
  const shorten = (text, limit = area) => clip(text, limit, ascii ? '..' : '…');
  const paint = (code, text) => color && !ascii && text ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
  const accent = text => paint('1;36', text);
  const strong = text => paint('1', text);
  const dim = text => paint('90', text);
  const rule = dim((ascii ? '-' : '─').repeat(area));
  const line = text => margin + text;
  const leftRight = (left, leftCells, right) => left + ' '.repeat(Math.max(0, navWidth - leftCells)) + gutter + right;
  const pixel = ascii ? ['###.', '#_#\'', '#   '] : ['▟██▙', '██▄▛', '██  '];
  const ver = field(version);
  const stamp = ver && (ver.startsWith('v') ? ver : 'v' + ver);
  const brand = 'Packsmith' + (stamp ? '  ' + stamp : '');
  const meta = (key, value, max) => dim(key) + '  ' + shorten(field(value), max - width(key) - 2);
  const header = wide ? [
    leftRight(accent(pixel[0]) + '   ' + strong('Packsmith'), 16, meta('Workspace', workspace, asideWidth)),
    leftRight(accent(pixel[1]) + '   ' + dim(shorten(stamp, navWidth - 7)), 7 + width(shorten(stamp, navWidth - 7)), meta('Target   ', target, asideWidth)),
    accent(pixel[2].trimEnd()),
  ] : [
    accent(pixel[0]) + '   ' + strong(shorten(brand, area - 7)),
    accent(pixel[1]) + '   ' + meta('Workspace', workspace, area - 7),
    accent(pixel[2]) + '   ' + meta('Target   ', target, area - 7),
  ];
  const footer = [];
  const keys = ascii ? [['数字 + Enter', '选择'], ['0 / Ctrl+C', '退出']] : !options.length ?
    [['/关键词 + Enter', '重新筛选'], ['/ + Enter', '清除'], ['Esc / 0 / Ctrl+C', '退出']] :
    [['↑↓', '移动'], ['Enter', '选择'], ['数字 + Enter', '直达'], ['/关键词 + Enter', '筛选'], ['Esc / 0 / Ctrl+C', '退出']];
  let hints = '', hintWidth = 0;
  for (const [key, verb] of keys) {
    const label = color && !ascii ? ' ' + key + ' ' : '[' + key + ']';
    const plain = shorten(label + ' ' + verb);
    const tokenWidth = width(plain);
    if (hints && hintWidth + 3 + tokenWidth > area) {
      footer.push(hints);
      hints = '';
      hintWidth = 0;
    }
    const token = plain === label + ' ' + verb ? paint('38;5;252;48;5;238', label) + ' ' + verb : plain;
    hints += (hints ? '   ' : '') + token;
    hintWidth += (hintWidth ? 3 : 0) + tokenWidth;
  }
  footer.push(hints, dim(shorten('命令帮助  pnpm mp help')));

  const selection = options[active];
  const selectedAction = selection && homeActions[selection.index];
  const details = selectedAction && [
    accent(shorten(selectedAction.name, wide ? asideWidth : area - 4)),
    shorten(field(selection.detail ?? ''), wide ? asideWidth : area - 4),
    '',
    dim('来源') + '  ' + shorten(selectedAction.source, (wide ? asideWidth : area - 4) - 6),
    dim('结果') + '  ' + shorten(selectedAction.result, (wide ? asideWidth : area - 4) - 6),
  ];
  const nav = [];
  function add(text, plain = text, focused = false, summary = '') {
    nav.push({ text, cells: width(plain), focused, summary });
  }
  if (filter) {
    const status = shorten('筛选  /' + field(filter), navWidth);
    add(accent(status), status);
  }
  if (!options.length) add(shorten('没有匹配项。', navWidth));

  // Short terminals keep every numbered action in sight. Give taller ones
  // space between groups and place the selected action's details inline on mobile.
  const roomy = rows >= (wide ? 22 : 28);
  if (compact) {
    const context = shorten('Workspace  ' + field(workspace) + '   Target  ' + field(target), wide ? asideWidth : area);
    header.splice(0, header.length, ...(wide ?
      [leftRight(strong(shorten(brand, navWidth)), width(shorten(brand, navWidth)), context)] :
      [strong(shorten(brand)), context]));
  }
  let previous;
  for (const option of options) {
    const action = homeActions[option.index];
    if (!action) continue;
    if (!compact && action.group !== previous) {
      if (roomy && previous) add('');
      add(accent(action.group), action.group);
      previous = action.group;
    }
    const current = selection === option;
    const number = String(option.index + 1);
    const marker = ascii ? '  ' + number + '.  ' : current ? '▌ [' + number + ']  ' : '   ' + number + '   ';
    const symbol = ascii ? '' : action.icon + '  ';
    const summary = field(option.detail ?? '');
    const label = marker + symbol + field(option.text);
    const entry = shorten(ascii && compact && !wide && summary ? label + '  ' + summary : label, navWidth);
    const bar = current && !ascii ? pad(entry, navWidth) : entry;
    add(current ? paint('1;38;5;16;48;5;80', bar) : bar, bar, current,
      ascii && wide ? shorten(summary, asideWidth) : '');
    if (ascii && !wide && !compact && summary) add('     ' + shorten(summary, navWidth - 5));
    if (!wide && current && details && !ascii) {
      const inline = compact ? details.slice(0, 1) : details;
      for (const detail of inline.filter(Boolean)) add('    ' + detail, '');
    }
  }
  const panel = [];
  if (wide) {
    const right = ascii ? nav.map(row => row.summary) : details ?? [];
    for (let i = 0; i < Math.max(nav.length, right.length); i++) {
      const left = nav[i] ?? { text: '', cells: 0 };
      panel.push(right[i] ? leftRight(left.text, left.cells, right[i]) : left.text);
    }
  } else {
    panel.push(...nav.map(row => row.text));
  }

  // The prompt is outside this frame. Decorations yield first on short screens.
  const budget = Math.max(1, rows - 1);
  const size = () => header.length + panel.length + footer.length;
  if (size() > budget) header.splice(1);
  if (size() > budget) footer.splice(0, footer.length, dim(shorten(ascii ? '数字 + Enter 选择   0 退出' : 'Esc / 0 / Ctrl+C 退出')));
  if (size() > budget) {
    const available = Math.max(1, budget - header.length - footer.length);
    const focus = Math.max(0, nav.findIndex(row => row.focused));
    const start = Math.max(0, Math.min(focus - Math.floor(available / 2), panel.length - available));
    panel.splice(0, panel.length, ...panel.slice(start, start + available));
    if (size() > budget) header.length = 0;
    if (size() > budget) footer.length = 0;
  }
  const base = size();
  const extra = rows - 1 - base;
  return [...header, ...(extra >= 1 ? [rule] : []), ...(extra >= 4 ? [''] : []),
    ...panel, ...(extra >= 3 ? [''] : []), ...(extra >= 2 ? [rule] : []), ...footer]
    .map(text => text ? line(text) : '').join('\n');
}

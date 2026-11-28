import { field } from './lib/terminal.mjs';
import { layout, width } from './menu-components.mjs';

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

export function renderHome({ version = '', workspace = '', target = '', options = [], active = 0,
  filter = '', columns = 80, rows = 24, color = false, ascii = false }) {
  const { area, wide, compact, navWidth, asideWidth, shorten, accent, strong, dim, leftRight,
    choice, shortcuts, frame } = layout({ columns, rows, color, ascii });
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
  const keys = ascii ? [['数字 + Enter', '选择'], ['0 / Ctrl+C', '退出']] : !options.length ?
    [['/关键词 + Enter', '重新筛选'], ['/ + Enter', '清除'], ['Esc / 0 / Ctrl+C', '退出']] :
    [['↑↓', '移动'], ['Enter', '选择'], ['数字 + Enter', '直达'], ['/关键词 + Enter', '筛选'], ['Esc / 0 / Ctrl+C', '退出']];
  const footer = [...shortcuts(keys), dim(shorten('命令帮助  pnpm mp help'))];

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
    const symbol = ascii ? '' : action.icon + '  ';
    const summary = field(option.detail ?? '');
    const label = symbol + field(option.text) + (ascii && compact && !wide && summary ? '  ' + summary : '');
    nav.push({ ...choice(option.index, label, current, navWidth), summary: ascii && wide ? shorten(summary, asideWidth) : '' });
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
  return frame(header, panel, footer);
}

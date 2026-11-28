import { field } from './lib/terminal.mjs';

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

export function width(text) {
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

// Keep every code point of approved values when a single terminal row is too short.
function wrap(text, limit) {
  const lines = [];
  let line = '', count = 0;
  for (const { segment } of graphemes.segment(text)) {
    const next = cells(segment);
    if (line && count + next > limit) {
      lines.push(line);
      line = '';
      count = 0;
    }
    line += segment;
    count += next;
  }
  lines.push(line);
  return lines;
}

export function layout({ columns = 80, rows = 24, ascii = false, color = false }) {
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

  function choice(index, text, current, limit) {
    const number = String(index + 1);
    const marker = ascii ? '  ' + number + '.  ' : current ? '▌ [' + number + ']  ' : '   ' + number + '   ';
    const entry = shorten(marker + text, limit);
    const bar = current && !ascii ? pad(entry, limit) : entry;
    return { text: current ? paint('1;38;5;16;48;5;80', bar) : bar, cells: width(bar), focused: current };
  }

  function shortcuts(keys) {
    const footer = [];
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
    if (hints) footer.push(hints);
    return footer;
  }

  function frame(header, body, footer) {
    const extra = rows - 1 - header.length - body.length - footer.length;
    if (!body.length) return [...header, ...(extra >= 1 ? [rule] : []), ...footer].map(line).join('\n');
    return [...header, ...(extra >= 1 ? [rule] : []), ...(extra >= 4 ? [''] : []),
      ...body, ...(extra >= 3 ? [''] : []), ...(extra >= 2 ? [rule] : []), ...footer]
      .map(text => text ? line(text) : '').join('\n');
  }

  return { area, wide, compact, navWidth, asideWidth, shorten, paint, accent, strong, dim, leftRight,
    choice, shortcuts, frame };
}

function pageHeader(ui, section, title, context) {
  const label = 'PACKSMITH / ' + field(section);
  const info = field(context ?? '');
  const head = [];
  if (ui.wide && info && width(label) <= ui.navWidth) {
    head.push(ui.leftRight(ui.accent(label), width(label), ui.dim(ui.shorten(info, ui.asideWidth))));
  } else {
    head.push(ui.accent(ui.shorten(label)));
    if (info) head.push(ui.dim(ui.shorten(info)));
  }
  if (title) head.push(...wrap(field(title), ui.area).map(ui.strong));
  return head;
}

function selectionKeys({ ascii, confirm, multiple, options, filter, checked, backLabel }) {
  const keys = [];
  const back = [ascii ? '0' : 'Esc / 0', field(backLabel)];
  if (confirm) {
    if (!ascii) keys.push(['↑↓', '移动']);
    keys.push(['Enter', ascii ? '默认否' : '确定'], ['1 / 2 + Enter', '选择'], ['y / 是 + Enter', '同意']);
  } else {
    if (options.length) {
      if (!ascii) keys.push(['↑↓', '移动']);
      if (multiple) {
        if (!ascii) keys.push(['Space', '勾选']);
        keys.push([ascii ? 'a + Enter' : 'a', filter ? '全选匹配项' : '全选'],
          [ascii ? 'i + Enter' : 'i', filter ? '反选匹配项' : '反选']);
      }
      if (multiple || !ascii) keys.push(['Enter', multiple ? '继续' : '选择']);
      keys.push([multiple ? '多编号 + Enter' : '数字 + Enter', multiple ? '选择' : '直达']);
    } else if (multiple && checked.size) {
      keys.push(['Enter', '继续']);
    }
    keys.push(['/关键词 + Enter', options.length ? '筛选' : '重新筛选']);
    if (filter) keys.push(['/ + Enter', '清除']);
  }
  return [...keys, back, ['Ctrl+C', '退出']];
}

// Confirmation values are approval evidence. Keep them in full even when a
// long destination needs more terminal rows than one screen can display.
function confirmBody(ui, confirm, options, active) {
  const body = [];
  for (const [rawLabel, rawValue] of confirm.facts ?? []) {
    const label = field(rawLabel), value = field(rawValue);
    if (width(label) + 2 + width(value) <= ui.area) {
      body.push(ui.dim(label) + '  ' + value);
    } else {
      body.push(...wrap(label, ui.area).map(ui.dim), ...wrap(value, ui.area));
    }
  }
  if (confirm.warning) {
    body.push(...wrap('! ' + field(confirm.warning), ui.area).map(text => ui.paint('1;33', text)));
  }
  if (body.length && !ui.compact) body.push('');
  for (const [position, option] of options.entries()) {
    body.push(ui.choice(option.index, field(option.text), position === active, ui.area).text);
  }
  return body;
}

function optionDetails(option) {
  return [option.detail, ...(option.meta ?? [])].filter(value => value != null && value !== '').map(field);
}

export function renderSelection({ title = '', section = 'SELECT', context, options = [], active = 0,
  filter = '', checked = new Set(), total = options.length, multiple = false, confirm, backLabel = '返回',
  columns = 80, rows = 24, color = false, ascii = false }) {
  const ui = layout({ columns, rows, color, ascii });
  const header = pageHeader(ui, section, title, context);
  const footer = ui.shortcuts(selectionKeys({ ascii, confirm, multiple, options, filter, checked, backLabel }));
  if (confirm) return ui.frame(header, confirmBody(ui, confirm, options, active), footer);

  const status = [];
  if (multiple) status.push('已选 ' + checked.size + ' 项 / 共 ' + total + ' 项');
  if (filter) status.push('筛选  /' + field(filter) + '  ·  ' + options.length + ' 项匹配');
  if (status.length) header.push(ui.accent(ui.shorten(status.join('    '))));
  if (!options.length) return ui.frame(header, [filter ? '没有匹配项。' : '暂无可选项。'], filter ? footer : []);

  const checkbox = option => multiple ? (checked.has(option.index) ? '[x] ' : '[ ] ') : '';
  if (ascii) {
    // Numbered line mode has no moving cursor. Every index and its information
    // remain accessible even when the list extends into terminal scrollback.
    const body = [];
    for (const option of options) {
      body.push(...wrap('  ' + (option.index + 1) + '.  ' + checkbox(option) + field(option.text), ui.area));
      for (const detail of optionDetails(option)) {
        body.push(...wrap(detail, Math.max(1, ui.area - 4)).map(text => '    ' + text));
      }
    }
    return ui.frame(header, body, footer);
  }

  const focus = Math.max(0, Math.min(options.length - 1, active));
  const option = options[focus], name = field(option.text);
  const details = optionDetails(option);
  const truncated = width(checkbox(option) + name) + String(option.index + 1).length + 6 > ui.area;
  const showDetails = details.length || truncated;
  const split = ui.wide && showDetails;
  const listWidth = split ? ui.navWidth : ui.area;
  const detailWidth = split ? ui.asideWidth : Math.max(1, ui.area - 4);
  const detailLines = [];
  if (showDetails) {
    if (split) detailLines.push(ui.accent('当前项详情'));
    if (split || truncated) detailLines.push(...wrap(name, detailWidth).map(ui.strong));
    for (const [index, detail] of details.entries()) {
      const lines = wrap(detail, detailWidth);
      detailLines.push(...(index === 0 && option.detail ? lines : lines.map(ui.dim)));
    }
  }

  // Keep enough room for the focused option, shortcuts and the input line.
  if (header.length + footer.length + 4 > rows) {
    const essential = [...(multiple ? [['Space', '勾选']] : []), ['Enter', multiple ? '继续' : '选择'],
      ['Esc / 0', field(backLabel)]];
    footer.splice(0, footer.length, ...ui.shortcuts(essential));
  }
  const available = Math.max(1, rows - 1 - header.length - footer.length - 1);
  const detailBudget = split ? available : Math.min(detailLines.length, Math.floor(available / 2));
  const detailView = detailLines.slice(0, detailBudget);
  if (detailView.length && detailView.length < detailLines.length) detailView[detailView.length - 1] = ui.dim('…');
  let count = Math.max(1, available - (split ? 0 : detailView.length));
  const scroll = options.length > count;
  if (scroll) count = Math.max(1, count - 1);
  const start = Math.max(0, Math.min(focus - Math.floor(count / 2), options.length - count));
  const visible = options.slice(start, start + count);
  const body = [];
  const entries = visible.map(item => ui.choice(item.index, checkbox(item) + field(item.text), item === option, listWidth));
  if (split) {
    for (let i = 0; i < Math.max(entries.length, detailView.length); i++) {
      const entry = entries[i];
      body.push(detailView[i] ? ui.leftRight(entry?.text ?? '', entry?.cells ?? 0, detailView[i]) : entry.text);
    }
  } else {
    for (const entry of entries) {
      body.push(entry.text);
      if (entry.focused) body.push(...detailView.map(text => '    ' + text));
    }
  }
  if (scroll && available > 1) body.push(ui.dim((start + 1) + '–' + (start + visible.length) + ' / ' + options.length));
  return ui.frame(header, body, footer);
}

export function renderInput({ title = '', section = 'INPUT', context, columns = 80, rows = 24, color = false, ascii = false }) {
  const ui = layout({ columns, rows, color, ascii });
  return ui.frame(pageHeader(ui, section, title, context), [],
    ui.shortcuts([['Enter', '提交'], [ascii ? '留空 + Enter' : '留空 / Esc', '返回'], ['Ctrl+C', '退出']]));
}

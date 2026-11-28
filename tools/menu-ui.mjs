import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { field, multiline, terminal } from './lib/terminal.mjs';
import { renderHome } from './menu-home.mjs';

export class MenuCancelled extends Error {
  constructor() {
    super('已退出菜单。');
    this.name = 'MenuCancelled';
  }
}

export function createMenuUi({ input = process.stdin, output = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const keyboard = Boolean(input.isTTY && output.isTTY && env.TERM !== 'dumb');
  const style = terminal(output, env);
  function connect() {
    const reader = createInterface({ input, output, terminal: keyboard, historySize: 0, escapeCodeTimeout: 100, crlfDelay: Infinity });
    const controller = new AbortController();
    reader.on('SIGINT', () => reader.close());
    // readline.question() otherwise stays pending when stdin reaches EOF.
    reader.once('close', () => controller.abort());
    return { reader, signal: controller.signal };
  }

  let session = connect();
  const write = text => output.write(`${text}\n`);
  const error = text => stderr.write(terminal(stderr, env).fail(multiline(text)) + '\n');

  function current() {
    if (!session || session.signal.aborted || input.readableEnded || input.destroyed) throw new MenuCancelled();
    return session;
  }

  async function question(prompt, onKey, redraw) {
    const { reader, signal } = current();
    const back = new AbortController();
    let cursorRows = 0;
    function keypress(ch, key) {
      if (key.name === 'escape') back.abort();
      else onKey?.(reader, key);
      if (redraw) cursorRows = reader.getCursorPos().rows;
    }
    function resize() {
      // VT reflows the old frame before Node receives resize. readline will
      // move up by the old row count; account for rows gained or lost to wrapping.
      const reflowedRows = reader.getCursorPos().rows;
      if (cursorRows !== reflowedRows) moveCursor(output, 0, cursorRows - reflowedRows);
      reader.setPrompt(redraw());
      cursorRows = reader.getCursorPos().rows;
    }
    let completedRows = 0;
    function measureFrame(ch, key) {
      if (key.name === 'return' || key.name === 'enter' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        // readline finishes the question by moving to the end and writing CRLF.
        reader.write(null, { ctrl: true, name: 'e' });
        completedRows = reader.getCursorPos().rows + 1;
      }
    }
    if (redraw) {
      output.prependListener('resize', resize);
      input.prependListener('keypress', measureFrame);
    }
    if (keyboard) input.on('keypress', keypress);
    try {
      const answer = reader.question(prompt, { signal: AbortSignal.any([signal, back.signal]) });
      if (redraw) cursorRows = reader.getCursorPos().rows;
      return (await answer).trim();
    } catch (error) {
      if (signal.aborted) throw new MenuCancelled();
      if (back.signal.aborted) return null;
      throw error;
    } finally {
      if (keyboard) input.off('keypress', keypress);
      if (redraw) {
        output.off('resize', resize);
        input.off('keypress', measureFrame);
        if (completedRows) {
          moveCursor(output, 0, -completedRows);
          cursorTo(output, 0);
          clearScreenDown(output);
        }
      }
    }
  }

  const ask = async text => (await question(field(text) + (keyboard ? ' [Esc 返回] ' : ' '))) ?? '';

  async function select(title, labels, multiple, backLabel, descriptions = [], home) {
    if (!home) write(style.heading(field(title)));
    if (!labels.length) {
      write('暂无可选项。');
      return null;
    }
    const options = labels.map((label, index) => ({
      index, text: field(label), detail: descriptions[index] ? field(descriptions[index]) : '',
    }));
    let view = options, cursor = 0, filter = '';
    const checked = new Set();
    const labelFor = option => `${option.index + 1}. ${option.text}${option.detail ? '  ' + option.detail : ''}`;
    function homeFrame() {
      return renderHome({
        ...home, options: view, active: cursor, filter, columns: output.columns ?? 80,
        rows: output.rows ?? 24, ascii: !keyboard, color: keyboard && env.NO_COLOR === undefined,
      });
    }
    function render() {
      if (home) return homeFrame() + '\n  › ';
      const size = Math.max(1, Math.min(8, (output.rows ?? 24) - 6));
      const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), view.length - size));
      const lines = view.slice(start, start + size).map((option, row) => {
        const marker = multiple ? (checked.has(option.index) ? '[x] ' : '[ ] ') : '';
        return (start + row === cursor ? '> ' : '  ') + marker + labelFor(option);
      });
      if (!view.length) lines.push('没有匹配项。');
      if (view.length > size) lines.push(`  ${start + 1}–${Math.min(start + size, view.length)} / ${view.length}`);
      if (filter) lines.push('筛选 ' + field(filter));
      if (multiple) {
        const selected = [...checked].map(index => index + 1);
        lines.push('已选 ' + selected.length + ' 项' + (selected.length ? ' · ' + selected.join(', ') : ''));
      }
      return lines.join('\n') + '\n> ';
    }
    function navigate(reader, key) {
      if (reader.line === ' ' && key.name === 'space' && multiple) {
        reader.write(null, { name: 'backspace' });
        const option = view[cursor];
        if (option) {
          if (checked.has(option.index)) checked.delete(option.index);
          else checked.add(option.index);
        }
      } else if (key.name === 'up' || key.name === 'down') {
        cursor = Math.max(0, Math.min(view.length - 1, cursor + (key.name === 'up' ? -1 : 1)));
      } else return;
      // readline owns wrapped-line widths and cursor restoration, including CJK text.
      reader.setPrompt(render());
      reader.prompt(true);
    }
    if (home && !keyboard) {
      write(homeFrame());
    } else if (keyboard && !home) {
      write('↑↓ 移动 · Enter 确定 · Esc ' + backLabel + ' · Ctrl+C 退出');
      write((multiple ? '空格勾选，也可输入多个编号' : '也可输入编号') + ' · /关键词 + Enter 筛选 · 0 ' + backLabel);
    } else if (!keyboard) {
      options.forEach(option => write('  ' + labelFor(option)));
      write(`  0. ${backLabel}`);
    }
    while (true) {
      const answer = keyboard ? await question(render(), navigate, home && render) :
        await question(multiple ? '请输入编号，多个编号用逗号或空格分隔： ' : '请输入编号： ');
      if (answer === null || answer === '0') return null;
      if (keyboard && answer.startsWith('/')) {
        filter = answer.slice(1).trim().toLowerCase();
        view = options.filter(option => (option.text + ' ' + option.detail).toLowerCase().includes(filter));
        cursor = 0;
        continue;
      }
      if (keyboard && !answer) {
        if (multiple && checked.size) return [...checked];
        if (!multiple && view.length) return view[cursor].index;
        write(multiple ? '请先用空格勾选功能，或输入编号。' : '请更换筛选词，输入 / 可清除筛选。');
        continue;
      }
      const numbers = multiple ? answer.split(/[,，]/).flatMap(part => part.trim().split(/\s+/)) : [answer];
      if (numbers.every(n => /^[1-9]\d*$/.test(n) && Number(n) <= labels.length &&
          (!filter || view.some(option => option.index + 1 === Number(n))))) {
        const indexes = numbers.map(n => Number(n) - 1);
        return multiple ? [...new Set(indexes)] : indexes[0];
      }
      const hint = filter ? '请输入当前筛选中的编号' : `请输入 1 到 ${labels.length} 的编号`;
      write(`${hint}，或单独输入 0 ${backLabel}。`);
    }
  }

  return {
    ask, write, error,
    choose: (title, labels, backLabel = '返回', descriptions, home) => select(title, labels, false, backLabel, descriptions, home),
    chooseMany: (title, labels) => select(title, labels, true, '返回'),
    async confirm(text) {
      const answer = await question(field(text) + (keyboard ? ' [y/是/N，默认否；0/Esc 返回] ' : ' [y/是/N，默认否；0 返回] '));
      return answer === null || answer === '0' ? null : ['y', 'yes', '是', '确认'].includes(answer.toLowerCase());
    },
    async suspend(callback) {
      const active = current();
      // Closing restores terminal mode and releases stdin before the child inherits it.
      active.reader.close();
      try {
        return await callback();
      } finally {
        if (session === active && !input.readableEnded && !input.destroyed) session = connect();
      }
    },
    close() {
      session?.reader.close();
      session = null;
    },
  };
}

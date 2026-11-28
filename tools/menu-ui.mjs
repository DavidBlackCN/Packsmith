import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { multiline, terminal } from './lib/terminal.mjs';
import { renderHome } from './menu-home.mjs';
import { renderInput, renderSelection } from './menu-components.mjs';

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

  function screen() {
    return { columns: output.columns ?? 80, rows: output.rows ?? 24,
      ascii: !keyboard, color: keyboard && env.NO_COLOR === undefined };
  }

  function readFrame(frame, onKey) {
    if (!keyboard) {
      write(frame());
      return question('输入： ');
    }
    const prompt = () => frame() + '\n  › ';
    return question(prompt(), onKey, prompt);
  }

  async function ask(title, { section = 'INPUT', context = '' } = {}) {
    const frame = () => renderInput({ title, section, context, ...screen() });
    return (await readFrame(frame)) ?? '';
  }

  async function select(title, labels, { multiple = false, backLabel = '返回', descriptions = [],
    home, section = 'SELECT', context = '', confirm } = {}) {
    const options = labels.map((text, index) => {
      const description = descriptions[index];
      return { index, text, detail: description?.detail ?? (typeof description === 'string' ? description : ''),
        meta: description?.meta ?? [] };
    });
    let view = options, cursor = 0, filter = '';
    const checked = new Set();
    function render() {
      const layout = { options: view, active: cursor, filter, ...screen() };
      if (home) return renderHome({ ...home, ...layout });
      return renderSelection({ ...layout, title, section, context, checked, total: options.length, multiple, confirm, backLabel });
    }
    if (!options.length) {
      write(render());
      return null;
    }
    function toggle(index) {
      if (checked.has(index)) checked.delete(index);
      else checked.add(index);
    }
    function bulk(key) {
      for (const { index } of view) {
        if (key === 'a') checked.add(index);
        else toggle(index);
      }
    }
    function navigate(reader, key) {
      if (multiple && !key.ctrl && !key.meta && reader.line === key.sequence && [' ', 'a', 'i'].includes(key.sequence)) {
        reader.write(null, { name: 'backspace' });
        if (key.sequence !== ' ') bulk(key.sequence);
        else if (view[cursor]) toggle(view[cursor].index);
      } else if (key.name === 'up' || key.name === 'down') {
        cursor = Math.max(0, Math.min(view.length - 1, cursor + (key.name === 'up' ? -1 : 1)));
      } else return;
      reader.setPrompt(render() + '\n  › ');
      reader.prompt(true);
    }
    while (true) {
      const answer = await readFrame(render, navigate);
      if (answer === null || answer === '0') return null;
      if (confirm) {
        if (!answer) return cursor;
        return ['2', 'y', 'yes', '是', '确认'].includes(answer.toLowerCase()) ? 1 : 0;
      }
      if ((keyboard || !home) && answer.startsWith('/')) {
        filter = answer.slice(1).trim();
        const query = filter.toLowerCase();
        view = options.filter(option => [option.text, option.detail, ...option.meta].join(' ').toLowerCase().includes(query));
        cursor = 0;
        continue;
      }
      if (!keyboard && multiple && ['a', 'i'].includes(answer)) {
        bulk(answer);
        continue;
      }
      if (multiple && !answer && checked.size) return [...checked];
      if (keyboard && !answer) {
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
    status: (kind, text) => write(style[kind](multiline(text))),
    choose: select,
    chooseMany: (title, labels, view) => select(title, labels, { ...view, multiple: true }),
    async confirm(title, view = {}) {
      const choice = await select(title, [view.noLabel ?? '否', view.yesLabel ?? '是'], {
        section: view.section ?? 'CONFIRM', context: view.context, confirm: view,
      });
      return choice === null ? null : choice === 1;
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

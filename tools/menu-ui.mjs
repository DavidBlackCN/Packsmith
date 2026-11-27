import { createInterface } from 'node:readline/promises';

export class MenuCancelled extends Error {
  constructor() {
    super('已退出菜单。');
    this.name = 'MenuCancelled';
  }
}

export function createMenuUi({ input = process.stdin, output = process.stdout } = {}) {
  function connect() {
    const reader = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY), crlfDelay: Infinity });
    const controller = new AbortController();
    reader.on('SIGINT', () => reader.close());
    // readline.question() otherwise stays pending when stdin reaches EOF.
    reader.once('close', () => controller.abort());
    return { reader, signal: controller.signal };
  }

  let session = connect();
  const write = text => output.write(`${text}\n`);

  function current() {
    if (!session || session.signal.aborted || input.readableEnded || input.destroyed) throw new MenuCancelled();
    return session;
  }

  async function ask(text) {
    const { reader, signal } = current();
    try {
      return (await reader.question(text + ' ', { signal })).trim();
    } catch (error) {
      if (signal.aborted) throw new MenuCancelled();
      throw error;
    }
  }

  async function select(title, labels, multiple, backLabel) {
    write(title);
    if (!labels.length) {
      write('暂无可选项。');
      return null;
    }
    labels.forEach((label, index) => write(`  ${index + 1}. ${label}`));
    write(`  0. ${backLabel}`);
    while (true) {
      const answer = await ask(multiple ? '请输入编号，多个编号用逗号或空格分隔：' : '请输入编号：');
      if (answer === '0') return null;
      const numbers = multiple ? answer.split(/[,，]/).flatMap(part => part.trim().split(/\s+/)) : [answer];
      if (numbers.every(n => /^[1-9]\d*$/.test(n) && Number(n) <= labels.length)) {
        const indexes = numbers.map(n => Number(n) - 1);
        return multiple ? [...new Set(indexes)] : indexes[0];
      }
      write(`请输入 1 到 ${labels.length} 的编号，或单独输入 0 ${backLabel}。`);
    }
  }

  return {
    ask, write,
    choose: (title, labels, backLabel = '返回') => select(title, labels, false, backLabel),
    chooseMany: (title, labels) => select(title, labels, true, '返回'),
    confirm: async text => ['y', 'yes', '是', '确认'].includes((await ask(text + ' [y/是/N，默认否]')).toLowerCase()),
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

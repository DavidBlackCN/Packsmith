/** @type {import('czg').CommitizenGitOptions} */
module.exports = {
  types: [
    { value: 'feat', name: 'feat   新增或调整玩法、配方和整合包内容', emoji: '✨' },
    { value: 'fix', name: 'fix    修复崩溃、兼容问题或错误配方', emoji: '🐛' },
    { value: 'chore', name: 'chore  例行更新 Mod、包版本或维护工具', emoji: '🔧' },
    { value: 'docs', name: 'docs   更新安装说明、任务指南或更新日志', emoji: '📝' },
  ],
  useEmoji: true,
  emojiAlign: 'left',
  confirmColorize: process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
  messages: {
    type: '这次改动属于哪一类？',
    customScope: '改了哪部分？可填配方、Mod 名或 Target ID，回车跳过',
    subject: '用一句话说明改了什么',
    confirmCommit: '按这个标题提交？',
  },
  // czg 用这个标记直接打开范围输入框，回车即可留空。
  defaultScope: '___CUSTOM___:',
  skipQuestions: ['scope', 'body', 'breaking', 'footerPrefix', 'footer'],
};

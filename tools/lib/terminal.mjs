// Escape at the display boundary. Keep original paths, evidence and JSON intact.
function escapeControl(character) {
  const code = character.charCodeAt(0);
  return code <= 0xff ? '\\x' + code.toString(16).padStart(2, '0') : '\\u' + code.toString(16).padStart(4, '0');
}

export function field(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, escapeControl);
}

export function multiline(value) {
  return String(value).replaceAll('\r\n', '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, escapeControl);
}

export function isCI(env = process.env) {
  return Boolean(env.CI) && !/^(?:false|0)$/i.test(env.CI);
}

export function terminal(stream = process.stdout, env = process.env) {
  const interactive = stream.isTTY && !isCI(env) && env.TERM !== 'dumb';
  const color = interactive && env.NO_COLOR === undefined;
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    heading: text => paint('1;36', text),
    ok: text => paint(32, (interactive ? '✓ ' : '[ok] ') + text),
    warn: text => paint(33, (interactive ? '! ' : '[warn] ') + text),
    fail: text => paint(31, (interactive ? '× ' : '[fail] ') + text),
    muted: text => paint(90, text),
  };
}

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// Built via fromCharCode so the source file stays free of raw control bytes.
const ESC = String.fromCharCode(27);

const colorEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

function wrap(code) {
  return (value) => (colorEnabled ? `${ESC}[${code}m${value}${ESC}[0m` : String(value));
}

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

export function info(message = '') {
  stdout.write(`${message}\n`);
}

export function ok(message) {
  stdout.write(`${green('OK')} ${message}\n`);
}

export function warn(message) {
  stdout.write(`${yellow('!!')} ${message}\n`);
}

export function fail(message) {
  process.stderr.write(`${red('XX')} ${message}\n`);
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible width, ignoring ANSI escapes so colored cells still align. */
function width(value) {
  return String(value).replace(ANSI_PATTERN, '').length;
}

/** Render an array of row-arrays as an aligned, left-justified table. */
export function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const line = (cells, decorate) =>
    cells
      .map((cell, i) => {
        const text = String(cell ?? '');
        const padded = text + ' '.repeat(Math.max(0, widths[i] - width(text)));
        return decorate ? decorate(padded) : padded;
      })
      .join('  ')
      .trimEnd();

  info(line(headers, dim));
  for (const row of rows) info(line(row));
}

/**
 * Render numbered next-step lines with their descriptions in one column.
 *
 * The column is measured, not hardcoded: profile names appear inside the
 * commands, so `--main`/`--reserve` decide how wide it has to be. Items given
 * without a description are printed as-is and left out of the measurement, so
 * one long example line cannot push the column off the screen.
 *
 * @param {Array<[string, string?]>} items `[command, description]` pairs
 */
export function steps(items) {
  const described = items.filter(([, description]) => description);
  const column = described.length ? Math.max(...described.map(([command]) => width(command))) : 0;

  items.forEach(([command, description], index) => {
    const pad = ' '.repeat(Math.max(0, column - width(command)));
    info(`  ${index + 1}. ${command}${description ? `${pad}   ${description}` : ''}`);
  });
}

/** Yes/no prompt. Returns `fallback` when stdin is not a TTY. */
export async function confirm(question, fallback = false) {
  if (!stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = fallback ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${dim(suffix)} `)).trim().toLowerCase();
    if (answer === '') return fallback;
    return answer === 'y' || answer === 'yes' || answer === 'j' || answer === 'ja';
  } finally {
    rl.close();
  }
}

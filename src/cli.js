import { createRequire } from 'node:module';
import * as commands from './commands.js';
import {
  COMMANDS,
  TOPICS,
  findCommand,
  findTopic,
  renderAll,
  renderCommand,
  renderOverview,
  renderTopic,
} from './help.js';
import { cyan, dim, fail, info } from './ui.js';

const require = createRequire(import.meta.url);

const VALUE_FLAGS = new Set(['main', 'reserve', 'note', 'from']);
const ALIASES = { y: 'yes', h: 'help', v: 'version', j: 'json' };

/**
 * Minimal argv parser: `--flag`, `--flag=value`, `--flag value` (for VALUE_FLAGS),
 * `--no-flag`, short aliases, and `--` to end flag parsing.
 */
function parseArgs(argv) {
  const args = { _: [] };
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (passthrough) {
      args._.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        args[camel(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith('no-')) {
        args[camel(body.slice(3))] = false;
        continue;
      }
      const key = camel(body);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      for (const ch of token.slice(1)) {
        args[ALIASES[ch] ?? ch] = true;
      }
      continue;
    }

    args._.push(token);
  }
  return args;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function version() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/**
 * `codex-homes help [command|topic]`, and what every command's `--help` shows.
 * The pages themselves live in help.js, generated from one command reference so
 * they cannot drift from the flags the handlers read.
 */
function help(args = { _: [] }) {
  if (args.all) {
    info(renderAll(version()));
    return 0;
  }

  const target = args._[0];
  if (!target) {
    info(renderOverview(version()));
    return 0;
  }

  const command = findCommand(target);
  if (command) {
    info(renderCommand(command));
    return 0;
  }

  const topic = findTopic(target);
  if (topic) {
    info(renderTopic(topic));
    return 0;
  }

  fail(`no help for "${target}"`);
  info('');
  info(`${dim('commands')}  ${COMMANDS.map((c) => c.name).join(', ')}`);
  info(`${dim('guides')}    ${TOPICS.map((t) => t.name).join(', ')}`);
  info('');
  info(`run ${cyan('codex-homes help')} for the overview`);
  return 1;
}

export const HANDLERS = {
  init: commands.init,
  list: commands.list,
  ls: commands.list,
  use: commands.use,
  switch: commands.use,
  run: commands.runIn,
  login: commands.login,
  logout: commands.logout,
  add: commands.add,
  new: commands.add,
  remove: commands.remove,
  rm: commands.remove,
  status: commands.status,
  doctor: commands.doctor,
  restore: commands.restore,
  'config-sync': commands.configSync,
  shims: commands.shims,
  path: commands.printPath,
};

// Commands whose trailing arguments belong to codex, not to us.
const PASSTHROUGH = new Set(['run']);

export async function run(argv) {
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return help(parseArgs(argv.slice(1)));
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    info(version());
    return 0;
  }

  const handler = HANDLERS[command];
  if (!handler) {
    fail(`unknown command "${command}"`);
    info(`run ${cyan('codex-homes help')} to see the available commands`);
    return 1;
  }

  let args;
  if (PASSTHROUGH.has(command)) {
    const rest = argv.slice(1);
    const separator = rest.indexOf('--');
    const own = separator === -1 ? rest : rest.slice(0, separator);
    // Only a --help standing where the profile name belongs is a question about
    // "run" itself. Once a profile is named, or after the separator, it is one
    // of the arguments the command exists to hand to codex.
    if (own[0] === '--help' || own[0] === '-h') return help({ _: [command] });
    args = separator === -1 ? { _: rest } : { _: [...own, ...rest.slice(separator + 1)] };
  } else {
    args = parseArgs(argv.slice(1));
    if (args.help) return help({ _: [command] });
  }

  return handler(args);
}

export { parseArgs };

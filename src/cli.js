import { createRequire } from 'node:module';
import * as commands from './commands.js';
import { bold, cyan, dim, fail, info } from './ui.js';

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

function help() {
  info(`
${bold('codex-homes')} ${dim(`v${version()}`)} — switch between Codex accounts with isolated CODEX_HOME profiles

${bold('USAGE')}
  codex-homes <command> [options]        ${dim('(short alias: cxh)')}

${bold('SETUP')}
  init                     Migrate ~/.codex into a profile and set up the link
    --main <name>            name for the migrated profile   ${dim('(default: codex-main)')}
    --reserve <name>         name for the second profile      ${dim('(default: codex-reserve)')}
    --no-copy-config         do not copy config.toml to the new profile
    -y, --yes                skip confirmation

${bold('EVERYDAY')}
  list                     Show all profiles and their accounts   ${dim('(--json)')}
  use <profile>            Make a profile active for every shell
  run <profile> [args...]  Run codex once under a profile, without switching
  status                   Show the active profile and link health
  path [profile]           Print a profile's CODEX_HOME directory

${bold('ACCOUNTS')}
  login <profile>          Run "codex login" inside a profile
  logout <profile>         Run "codex logout" inside a profile

${bold('MANAGE')}
  add <profile>            Create a new empty profile   ${dim('(--from <profile>, --note <text>)')}
  remove <profile>         Unregister a profile         ${dim('(--purge to delete its files)')}
  config-sync <from> [to]  Copy config.toml between profiles   ${dim('(--force)')}
  shims [--path]           Generate per-profile launchers, optionally add to PATH
  doctor [--fix]           Diagnose and repair the setup
  restore [profile]        Undo the setup: turn ~/.codex back into a real directory

${bold('EXAMPLES')}
  ${cyan('codex-homes init')}
  ${cyan('codex-homes login codex-reserve')}
  ${cyan('codex-homes use codex-reserve')}      ${dim('# every shell now uses the reserve account')}
  ${cyan('codex-homes run codex-main -- "fix the failing test"')}
  ${cyan('codex-homes list')}

${bold('NOTES')}
  Profiles live in ~/.codex-homes/profiles/<name> and each one is a full
  CODEX_HOME: its own login, config.toml, sessions, history and MCP setup.
  ~/.codex becomes a junction (Windows) or symlink (POSIX) to the active one.
  A CODEX_HOME variable set in your shell overrides all of this.
`);
  return 0;
}

const HANDLERS = {
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

  if (!command || command === 'help' || command === '--help' || command === '-h') return help();
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
    args =
      separator === -1
        ? { _: rest }
        : { _: [...rest.slice(0, separator), ...rest.slice(separator + 1)] };
  } else {
    args = parseArgs(argv.slice(1));
    if (args.help) return help();
  }

  return handler(args);
}

export { parseArgs };

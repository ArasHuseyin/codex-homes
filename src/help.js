import { bold, cyan, dim } from './ui.js';

/**
 * The command reference both help views are rendered from.
 *
 * Every entry lists the flags its handler actually reads, so the help stays a
 * description of this program rather than a second program that drifts from it.
 * `signature` is the compact form for the overview; `usage` (when a command
 * needs a longer one) is what its own page shows.
 */
export const COMMANDS = [
  {
    name: 'init',
    group: 'Setup',
    aliases: [],
    signature: 'init [options]',
    summary: 'Migrate ~/.codex into a profile and set up the link',
    options: [
      ['--main <name>', 'name for the migrated profile (default: codex-main)'],
      ['--reserve <name>', 'name for the second, empty profile (default: codex-reserve)'],
      ['--no-link', 'leave ~/.codex alone; pick a profile per command instead'],
      ['--no-copy-config', 'do not copy config.toml into the new profile'],
      ['-y, --yes', 'skip the confirmation prompts'],
    ],
    details: [
      'The only command that touches existing data, and it prints the full plan',
      'and asks before doing so.',
      '',
      '~/.codex is moved to ~/.codex-homes/profiles/<main> and a directory',
      'junction (Windows) or symlink (POSIX) is left in its place, so every shell,',
      'editor and IDE keeps finding it. A junction needs no admin rights and no',
      'Developer Mode, but it does need a local NTFS volume — where that is',
      'refused, init explains why and offers no-link mode instead of failing.',
      '',
      'Running it again is safe: an existing link is left alone and nothing is',
      'migrated twice.',
    ],
    examples: [
      ['codex-homes init'],
      ['codex-homes init --main work --reserve private', 'your own names'],
      ['codex-homes init --no-link', 'never touch ~/.codex'],
    ],
    seeAlso: ['no-link', 'status', 'restore'],
  },
  {
    name: 'list',
    group: 'Everyday',
    aliases: ['ls'],
    signature: 'list [--json]',
    summary: 'Show every profile with its account, plan and login state',
    options: [['-j, --json', 'machine-readable output (mode, active profile, all profiles)']],
    details: [
      '"*" marks the active profile. The account, plan and expiry are read out of',
      "each profile's auth.json locally — nothing is sent anywhere and no token is",
      'ever printed.',
      '',
      'Warns when CODEX_HOME is set in your shell, because that overrides which',
      'profile codex actually uses.',
    ],
    examples: [['codex-homes list'], ['codex-homes list --json', 'for scripts']],
    seeAlso: ['status'],
  },
  {
    name: 'use',
    group: 'Everyday',
    aliases: ['switch'],
    signature: 'use <profile>',
    usage: 'use <profile> [-y]',
    summary: 'Make a profile the active one for every shell',
    options: [['-y, --yes', 'do not ask when a codex process is running']],
    details: [
      'Moves the ~/.codex link. The switch is instant and global — no environment',
      'variable, no shell integration, no reopening terminals.',
      '',
      'Because it selects one account for everything, it is not the way to run two',
      'accounts at once; see "codex-homes help parallel".',
      '',
      'Warns first when a codex process is running, since a session that follows',
      'the link holds state. Sessions started with "run" or a launcher are pinned',
      'to their profile and unaffected.',
      '',
      'Needs link mode. In no-link mode there is no link to move — use "run" or',
      'the launchers.',
    ],
    examples: [['codex-homes use codex-reserve'], ['codex-homes use codex-main -y']],
    seeAlso: ['run', 'shims', 'status'],
  },
  {
    name: 'run',
    group: 'Everyday',
    aliases: [],
    signature: 'run <profile> [args...]',
    usage: 'run <profile> [-- <codex args>]',
    summary: 'Run codex once under a profile, without switching',
    options: [],
    details: [
      'Sets CODEX_HOME for that single codex process, so any number of sessions',
      'can run side by side, each pinned to its own account, no matter which',
      'profile is active.',
      '',
      'Everything after "--" is handed to codex unchanged. The pinned CODEX_HOME',
      'also wins over one set in your shell.',
    ],
    examples: [
      ['codex-homes run codex-reserve', 'interactive session on that account'],
      ['codex-homes run codex-main -- "fix the failing test"'],
      ['codex-homes run codex-reserve -- --version', 'flags reach codex, not us'],
    ],
    seeAlso: ['parallel', 'shims', 'use'],
  },
  {
    name: 'status',
    group: 'Everyday',
    aliases: [],
    signature: 'status',
    summary: 'Show mode, active profile, link health and codex version',
    options: [],
    details: [
      'Answers the two questions that go wrong most often: which account a plain',
      '"codex" would use right now, and whether this install is in link or',
      'no-link mode.',
    ],
    examples: [['codex-homes status']],
    seeAlso: ['list', 'doctor'],
  },
  {
    name: 'path',
    group: 'Everyday',
    aliases: [],
    signature: 'path [profile]',
    summary: "Print a profile's CODEX_HOME directory",
    options: [],
    details: [
      'Defaults to the active profile. Prints nothing but the path, so it can be',
      'pasted into a CODEX_HOME assignment or consumed by a script.',
    ],
    examples: [
      ['codex-homes path codex-reserve'],
      ['set "CODEX_HOME=%USERPROFILE%\\.codex-homes\\profiles\\codex-reserve"', 'cmd, by hand'],
    ],
    seeAlso: ['run', 'shims'],
  },
  {
    name: 'login',
    group: 'Accounts',
    aliases: [],
    signature: 'login <profile>',
    summary: 'Run "codex login" inside a profile',
    options: [],
    details: [
      'Runs the real codex login with CODEX_HOME pointed at that profile, so the',
      'account lands there instead of overwriting the one you already have. The',
      'active profile is not changed.',
      '',
      'Creates the profile directory if it is missing, and reports which account',
      'ended up in it.',
    ],
    examples: [['codex-homes login codex-reserve']],
    seeAlso: ['logout', 'list'],
  },
  {
    name: 'logout',
    group: 'Accounts',
    aliases: [],
    signature: 'logout <profile>',
    summary: 'Run "codex logout" inside a profile',
    options: [],
    details: [
      'Signs that one profile out and leaves every other profile logged in.',
    ],
    examples: [['codex-homes logout codex-reserve']],
    seeAlso: ['login'],
  },
  {
    name: 'add',
    group: 'Manage',
    aliases: ['new'],
    signature: 'add <profile> [options]',
    summary: 'Create an additional profile',
    options: [
      ['--from <profile>', "copy that profile's config.toml into the new one"],
      ['--note <text>', 'remember a note for it in registry.json'],
    ],
    details: [
      'Names may hold letters, digits, dot, dash and underscore, up to 64',
      'characters, and must start with a letter or digit. "codex", "codex-homes"',
      'and "cxh" are refused: a launcher by those names would shadow the command',
      'it calls.',
      '',
      'The new profile starts empty and logged out — "codex-homes login <name>"',
      'is the next step. Launchers for every profile are rewritten afterwards.',
    ],
    examples: [
      ['codex-homes add client-x'],
      ['codex-homes add client-x --from codex-main', 'same model/tool settings'],
    ],
    seeAlso: ['login', 'remove', 'config-sync'],
  },
  {
    name: 'remove',
    group: 'Manage',
    aliases: ['rm'],
    signature: 'remove <profile> [--purge]',
    usage: 'remove <profile> [--purge] [-y]',
    summary: 'Unregister a profile, optionally deleting its files',
    options: [
      ['--purge', 'also delete the profile directory (login, sessions, history)'],
      ['-y, --yes', 'skip the confirmation --purge asks for'],
    ],
    details: [
      'Without --purge the files stay on disk and only the registry entry and the',
      'launcher go away, so the profile can be recovered with',
      '"codex-homes doctor --fix".',
      '',
      'The active profile cannot be removed — switch to another one first.',
    ],
    examples: [
      ['codex-homes remove client-x'],
      ['codex-homes remove client-x --purge', 'delete it for good'],
    ],
    seeAlso: ['add', 'restore', 'doctor'],
  },
  {
    name: 'config-sync',
    group: 'Manage',
    aliases: [],
    signature: 'config-sync <from> [to...]',
    usage: 'config-sync <from> [to...] [--force] [-y]',
    summary: 'Copy config.toml from one profile to others',
    options: [
      ['--force', 'overwrite existing config.toml files without asking'],
      ['-y, --yes', 'answer yes to the overwrite prompts'],
    ],
    details: [
      'With no targets, every other registered profile receives the file. Only',
      'config.toml is copied — never auth.json, sessions or history, which are',
      'exactly what the profiles keep separate.',
      '',
      'An existing config.toml is confirmed before it is overwritten; without a',
      'terminal to ask, it is skipped rather than replaced.',
    ],
    examples: [
      ['codex-homes config-sync codex-main', 'to all other profiles'],
      ['codex-homes config-sync codex-main codex-reserve --force'],
    ],
    seeAlso: ['add'],
  },
  {
    name: 'shims',
    group: 'Manage',
    aliases: [],
    signature: 'shims [--path]',
    summary: 'Generate one launcher command per profile',
    options: [['--path', 'add the launcher directory to your user PATH']],
    details: [
      'Writes <profile>.cmd (Windows) or <profile> (POSIX) into',
      '~/.codex-homes/bin. Each launcher pins CODEX_HOME to its own profile for',
      'its own process, which is what lets one terminal per account run at the',
      'same time.',
      '',
      'With --path the directory is added to the persistent user PATH; open a new',
      'terminal for it to take effect. Where PowerShell is locked down',
      '(Constrained Language Mode, AppLocker) the directory is printed to add by',
      'hand instead.',
      '',
      'init, add and "doctor --fix" regenerate the launchers on their own; run',
      'this when you want them refreshed or put on PATH.',
    ],
    examples: [
      ['codex-homes shims --path'],
      ['codex-reserve "review this diff"', 'afterwards, in a new terminal'],
    ],
    seeAlso: ['parallel', 'run', 'doctor'],
  },
  {
    name: 'doctor',
    group: 'Manage',
    aliases: [],
    signature: 'doctor [--fix]',
    summary: 'Diagnose the setup and repair what can be repaired',
    options: [['--fix', 'apply the repairs instead of only reporting them']],
    details: [
      'Checks the CODEX_HOME override, the health of the link, profile',
      'directories that are registered but missing (or present but unregistered),',
      'codex on PATH, and whether every launcher is present and up to date.',
      '',
      '--fix recreates or repoints the link, recreates missing directories,',
      'registers orphaned ones, rewrites stale launchers and removes a launcher',
      'that would call itself. Exits non-zero while anything is left unresolved.',
    ],
    examples: [['codex-homes doctor'], ['codex-homes doctor --fix']],
    seeAlso: ['status'],
  },
  {
    name: 'restore',
    group: 'Manage',
    aliases: [],
    signature: 'restore [profile]',
    usage: 'restore [profile] [-y]',
    summary: 'Undo the setup: turn ~/.codex back into a real directory',
    options: [['-y, --yes', 'skip the confirmation prompts']],
    details: [
      'Removes the link and moves that profile back to ~/.codex, which leaves you',
      'exactly where you were before init. Defaults to the active profile.',
      '',
      'Remaining profiles stay in ~/.codex-homes/profiles and can be moved or',
      'deleted by hand. In no-link mode there is nothing to restore; use',
      '"codex-homes remove <profile> --purge" there.',
    ],
    examples: [['codex-homes restore'], ['codex-homes restore codex-main -y']],
    seeAlso: ['remove', 'init'],
  },
  {
    name: 'help',
    group: 'Help',
    aliases: [],
    signature: 'help [command|topic]',
    usage: 'help [command|topic] [--all]',
    summary: 'Show this overview, one command in full, or a guide',
    options: [['--all', 'print every command page and every guide at once']],
    details: [
      '"codex-homes <command> --help" is the same as "codex-homes help <command>".',
    ],
    examples: [
      ['codex-homes help run'],
      ['codex-homes help parallel', 'a guide rather than a command'],
      ['codex-homes help --all', 'the whole manual'],
    ],
    seeAlso: [],
  },
];

const GROUP_ORDER = ['Setup', 'Everyday', 'Accounts', 'Manage', 'Help'];

/** Guides: the parts that are about how the pieces fit together, not one command. */
export const TOPICS = [
  {
    name: 'getting-started',
    title: 'Getting started',
    summary: 'set both accounts up from scratch',
    lines: [
      '1. codex-homes init',
      '     Moves your current ~/.codex into the profile "codex-main" and leaves a',
      '     link behind, then creates the empty profile "codex-reserve". Prints the',
      '     plan and asks before touching anything.',
      '',
      '2. codex-homes login codex-reserve',
      '     Runs the real "codex login" with CODEX_HOME pointed at the second',
      '     profile, so the other account lands there instead of replacing the first.',
      '',
      '3. codex-homes list',
      '     Shows which account sits in which profile. "*" marks the active one.',
      '',
      '4. Pick an account',
      '     codex-homes use codex-reserve      every shell switches at once',
      '     codex-homes run codex-reserve      one session, nothing else changes',
      '',
      'Each profile is a complete CODEX_HOME: its own auth.json, config.toml,',
      'sessions, history, MCP servers and skills. The two never see each other.',
    ],
  },
  {
    name: 'parallel',
    title: 'Two accounts at the same time',
    summary: 'one terminal per account, side by side',
    lines: [
      '"use" moves the ~/.codex link, so it can only ever select one account for',
      'everything. To work with both at once, pin each session to a profile:',
      '"run" and the generated launchers set CODEX_HOME for one process only.',
      '',
      '  Terminal 1                        Terminal 2',
      '  codex-homes run codex-main        codex-homes run codex-reserve',
      '',
      'Or, after "codex-homes shims --path" and reopening the terminals:',
      '',
      '  codex-main "explain this repo"    codex-reserve "review this diff"',
      '',
      'Worth knowing',
      '  - A plain "codex" always follows the link, so it is never the second of',
      '    the two accounts, whichever terminal it runs in.',
      '  - A pinned session keeps its account even if "use" runs while it is open.',
      '  - Give each parallel session its own profile. Two sessions on one profile',
      '    share a history and a refresh token.',
      '  - Both "run" and the launchers override a CODEX_HOME set in your shell.',
      '  - Nothing here needs the link, so it works the same in no-link mode.',
    ],
  },
  {
    name: 'no-link',
    title: 'Managed and locked-down machines',
    summary: 'when the machine refuses the link',
    lines: [
      'The link is the only part that depends on what the machine allows. A',
      'Windows directory junction needs no admin rights, but it does need a local',
      'NTFS volume: it is refused when the home directory sits on a network share',
      'or a mapped drive, on a roaming/VDI profile, or on FAT32/exFAT — and some',
      'endpoint-protection rules block reparse points outright.',
      '',
      '"init" detects this, explains it and offers no-link mode rather than',
      'failing. You can also ask for it directly:',
      '',
      '  codex-homes init --no-link',
      '',
      'In no-link mode ~/.codex is left exactly as it is and keeps serving a plain',
      '"codex". Profiles are selected per command with "run" or the launchers,',
      'which is also all you need for several sessions at once. "use" is the only',
      'command that requires the link, and "status" shows which mode you are in.',
      '',
      'If the restriction is lifted later, run "codex-homes init" again to migrate',
      '~/.codex into a profile and move to link mode.',
    ],
  },
];

const GLOBAL_OPTIONS = [
  ['-h, --help', 'this overview, or "<command> --help" for one command'],
  ['-v, --version', 'print the version'],
];

const ENVIRONMENT = [
  ['CODEX_HOME', 'read by codex — set in your shell it overrides the active'],
  ['', 'profile ("run" and the launchers set it themselves)'],
  ['CODEX_HOMES_ROOT', 'override ~/.codex-homes'],
  ['CODEX_HOMES_LINK', 'override the managed ~/.codex path'],
  ['CODEX_HOMES_DEBUG', 'print stack traces on error'],
  ['NO_COLOR', 'disable coloured output'],
];

/** Resolve a name or alias to its command spec. */
export function findCommand(name) {
  if (typeof name !== 'string') return null;
  const key = name.toLowerCase();
  return COMMANDS.find((c) => c.name === key || c.aliases.includes(key)) ?? null;
}

/** Resolve a guide by name. */
export function findTopic(name) {
  if (typeof name !== 'string') return null;
  const key = name.toLowerCase();
  return TOPICS.find((t) => t.name === key) ?? null;
}

/** Every name `help <name>` accepts, in the order the overview lists them. */
export function helpTargets() {
  return [
    ...COMMANDS.flatMap((c) => [c.name, ...c.aliases]),
    ...TOPICS.map((t) => t.name),
  ];
}

/**
 * Two aligned columns. The left column is coloured after padding, so the escape
 * codes never count towards the width.
 */
function columns(rows, { indent = '  ', gap = 3, width: fixed } = {}) {
  const width = fixed ?? Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => {
    if (!right) return `${indent}${cyan(left)}`;
    return `${indent}${cyan(left + ' '.repeat(width - left.length))}${' '.repeat(gap)}${right}`;
  });
}

function section(title, lines) {
  return lines.length ? ['', bold(title), ...lines] : [];
}

/** `codex-homes help` — every command with its usage, plus where to read more. */
export function renderOverview(version) {
  const lines = [
    '',
    `${bold('codex-homes')} ${dim(`v${version}`)} — switch between Codex accounts with isolated CODEX_HOME profiles`,
    '',
    bold('USAGE'),
    ...columns([
      ['codex-homes <command> [options]', dim('short alias: cxh')],
      ['codex-homes help <command>', dim('everything one command can do')],
      ['codex-homes help <topic>', dim('a guide — see GUIDES below')],
      ['codex-homes help --all', dim('the whole manual in one go')],
    ]),
  ];

  // One width across every group, so all the summaries line up in one column
  // however short the commands of a single group happen to be.
  const width = Math.max(...COMMANDS.map((c) => c.signature.length));
  for (const group of GROUP_ORDER) {
    const entries = COMMANDS.filter((c) => c.group === group);
    if (!entries.length) continue;
    lines.push(
      ...section(
        group.toUpperCase(),
        columns(
          entries.map((c) => [c.signature, c.summary]),
          { width },
        ),
      ),
    );
  }

  lines.push(...section('GLOBAL OPTIONS', columns(GLOBAL_OPTIONS)));
  lines.push(...section('ENVIRONMENT', columns(ENVIRONMENT)));
  lines.push(
    ...section(
      'GUIDES',
      columns(TOPICS.map((t) => [`codex-homes help ${t.name}`, t.summary])),
    ),
  );
  lines.push('');
  return lines.join('\n');
}

/** `codex-homes help <command>` — one command in full. */
export function renderCommand(spec) {
  const lines = [
    '',
    `${bold(`codex-homes ${spec.usage ?? spec.signature}`)}`,
    '',
    `  ${spec.summary}.`,
  ];

  if (spec.aliases.length) {
    lines.push(...section('ALIASES', columns([[spec.aliases.join(', '), '']])));
  }
  if (spec.options.length) {
    lines.push(...section('OPTIONS', columns(spec.options)));
  }
  if (spec.details.length) {
    lines.push(...section('DETAILS', spec.details.map((l) => (l ? `  ${l}` : ''))));
  }
  if (spec.examples.length) {
    lines.push(
      ...section(
        'EXAMPLES',
        columns(spec.examples.map(([cmd, note]) => [cmd, note ? dim(note) : ''])),
      ),
    );
  }

  const related = spec.seeAlso.map((name) =>
    findTopic(name) ? `${name} ${dim('(guide)')}` : name,
  );
  if (related.length) {
    lines.push('', bold('SEE ALSO'), `  ${related.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** `codex-homes help <topic>` — one guide. */
export function renderTopic(topic) {
  return ['', bold(topic.title.toUpperCase()), '', ...topic.lines.map((l) => (l ? `  ${l}` : '')), ''].join('\n');
}

/** `codex-homes help --all` — the whole manual in one go. */
export function renderAll(version) {
  // ASCII, so the separator still looks like one in a legacy Windows console.
  const rule = dim('-'.repeat(72));
  return [
    renderOverview(version),
    ...COMMANDS.map((spec) => [rule, renderCommand(spec)].join('\n')),
    ...TOPICS.map((topic) => [rule, renderTopic(topic)].join('\n')),
  ].join('\n');
}

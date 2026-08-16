import fs from 'node:fs';
import path from 'node:path';

import {
  assertCreatableName,
  assertValidName,
  codexLink,
  namesEqual,
  profileDir,
  profilesDir,
  registryPath,
  root,
  shimDir,
} from './paths.js';
import * as registry from './registry.js';
import * as link from './link.js';
import { describeAccount, readAccount } from './auth.js';
import { codexIsRunning, codexVersion, resolveExecutable, runCodex } from './codex.js';
import {
  addShimDirToUserPath,
  removeShim,
  shimBody,
  shimDirOnPath,
  shimExists,
  shimFileName,
  unshimmable,
  writeShims,
} from './shims.js';
import { bold, confirm, cyan, dim, fail, green, info, ok, steps, table, warn, yellow } from './ui.js';

const DEFAULT_MAIN = 'codex-main';
const DEFAULT_RESERVE = 'codex-reserve';

/** A stray CODEX_HOME in the environment silently overrides the junction. */
function warnAboutEnvOverride() {
  if (process.env.CODEX_HOME) {
    warn(
      `CODEX_HOME is set in this shell (${process.env.CODEX_HOME}).\n` +
        `   It overrides the active profile for every codex run here. Unset it to use codex-homes.`,
    );
  }
}

function requireInitialised() {
  if (!registry.registryExists()) {
    throw new Error('not initialised yet — run "codex-homes init" first');
  }
  return registry.load();
}

/** Resolve a user-typed name to the registered profile it addresses. */
function requireProfile(reg, name) {
  assertValidName(name);
  const profile = registry.findProfile(reg, name);
  if (!profile) {
    const known = reg.profiles.map((p) => p.name).join(', ') || '(none)';
    throw new Error(`unknown profile "${name}" — known profiles: ${known}`);
  }
  return profile;
}

/**
 * How this installation selects a profile.
 *  link    — ~/.codex is a junction/symlink, one profile is active everywhere
 *  no-link — ~/.codex was left alone, profiles are picked per command
 *  broken  — a profile is marked active but the link is gone or misdirected
 */
function linkMode(reg) {
  if (link.inspect(codexLink()).isLink) return 'link';
  return reg.active === null ? 'no-link' : 'broken';
}

/** True when the launcher on disk matches what this version would write. */
function shimIsCurrent(name) {
  try {
    return fs.readFileSync(path.join(shimDir(), shimFileName(name)), 'utf8') === shimBody(profileDir(name));
  } catch {
    return false;
  }
}

/**
 * True when `dir` is a placeholder an earlier `--no-link` run created, rather
 * than a profile holding something of the user's.
 *
 * That run copies `~/.codex/config.toml` in and nothing else, and the migration
 * about to happen brings the very same bytes along — so removing a byte-identical
 * copy loses nothing. A config.toml the user has since edited is their data and
 * is worth more than the convenience of reusing the name, "only file present" or
 * not: comparing the contents is what separates the two.
 */
function isInitPlaceholder(dir, migratedConfig) {
  let contents;
  try {
    contents = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (contents.length === 0) return true;
  if (contents.length !== 1 || contents[0] !== 'config.toml') return false;
  try {
    return fs.readFileSync(path.join(dir, 'config.toml')).equals(fs.readFileSync(migratedConfig));
  } catch {
    // No config.toml coming in to compare against, so this one is not a copy of it.
    return false;
  }
}

function explainNoLinkMode() {
  info('');
  info(`${dim('no-link mode:')} ${codexLink()} is not managed, so plain "codex" keeps using it.`);
  info(`${dim('Pick a profile per command instead — several can run at the same time:')}`);
  info(`  ${cyan('codex-homes run <profile> -- "…"')}   ${dim('or the launchers from "codex-homes shims"')}`);
}

// ---------------------------------------------------------------- init

export async function init(args) {
  const mainName = assertCreatableName(args.main ?? DEFAULT_MAIN);
  const reserveName = assertCreatableName(args.reserve ?? DEFAULT_RESERVE);
  if (namesEqual(mainName, reserveName)) throw new Error('main and reserve profiles need different names');

  const linkPath = codexLink();
  const state = link.inspect(linkPath);
  const reg = registry.registryExists() ? registry.load() : { version: 1, active: null, profiles: [] };

  let linkless = args.link === false;

  if (state.isLink) {
    if (linkless) throw new Error(`${linkPath} is already a link — --no-link would leave it pointing at whatever it points at now`);
    info(`${linkPath} is already a link — nothing to migrate.`);
  } else if (state.exists && !state.isDir) {
    throw new Error(`${linkPath} exists but is a file — remove it manually first`);
  }

  const willMigrate = !linkless && state.exists && !state.isLink;
  const mainTarget = profileDir(mainName);
  const reserveTarget = profileDir(reserveName);

  // Decided before the plan is printed, so the removal is something the user is
  // shown and agrees to, and a refusal arrives before the prompts, not after them.
  let replacePlaceholder = false;
  if (willMigrate && fs.existsSync(mainTarget)) {
    replacePlaceholder = isInitPlaceholder(mainTarget, path.join(linkPath, 'config.toml'));
    if (!replacePlaceholder) {
      throw new Error(
        `profile "${mainName}" already holds data at ${mainTarget} — ` +
          `pass --main <name> to migrate ${linkPath} into a different profile`,
      );
    }
  }

  info('');
  info(bold('Plan'));
  info(`  profiles root   ${cyan(profilesDir())}`);
  if (linkless) {
    info(`  keep as is      ${linkPath} ${dim('(stays your unmanaged default account)')}`);
    info(`  create          ${mainTarget} ${dim('(empty)')}`);
  } else if (willMigrate) {
    if (replacePlaceholder) {
      info(`  replace         ${mainTarget} ${dim('(placeholder from an earlier --no-link run)')}`);
    }
    info(`  migrate         ${linkPath}  ->  ${mainTarget}`);
    info(`  then link       ${linkPath}  ->  ${mainTarget}`);
  } else if (!state.exists) {
    info(`  create          ${mainTarget} ${dim('(empty)')}`);
    info(`  then link       ${linkPath}  ->  ${mainTarget}`);
  }
  info(`  create          ${reserveTarget} ${dim('(empty)')}`);
  info('');

  if (willMigrate && codexIsRunning()) {
    warn('a codex process appears to be running — close it before migrating.');
    if (!args.yes && !(await confirm('Continue anyway?', false))) {
      info('aborted.');
      return 1;
    }
  }

  if (!args.yes && !(await confirm('Apply this plan?', true))) {
    info('aborted.');
    return 1;
  }

  registry.ensureDirs();

  // migrateDirToProfile renames onto this path, so the placeholder has to go first.
  if (replacePlaceholder) fs.rmSync(mainTarget, { recursive: true, force: true });

  let mainCreated = false;

  if (!linkless) {
    try {
      if (willMigrate) {
        link.migrateDirToProfile(linkPath, mainTarget);
        ok(`migrated existing Codex home into profile "${mainName}"`);
      } else if (!state.exists) {
        mainCreated = !fs.existsSync(mainTarget);
        fs.mkdirSync(mainTarget, { recursive: true });
        link.setLink(linkPath, mainTarget);
        ok(`created empty profile "${mainName}"`);
      }
    } catch (err) {
      if (!err.linkUnsupported) throw err;
      info('');
      fail(err.message);
      info('');
      warn(`continuing without the link — ${linkPath} stays exactly as it is.`);
      if (!args.yes && !(await confirm('Set the profiles up in no-link mode?', true))) {
        info('aborted.');
        return 1;
      }
      linkless = true;
    }
  }

  if (linkless && !fs.existsSync(mainTarget)) {
    fs.mkdirSync(mainTarget, { recursive: true });
    mainCreated = true;
  }
  if (linkless && mainCreated) ok(`created profile "${mainName}"`);

  if (!registry.findProfile(reg, mainName)) {
    registry.addProfile(reg, mainName, linkless ? '' : 'migrated by init');
  }

  if (!fs.existsSync(reserveTarget)) {
    fs.mkdirSync(reserveTarget, { recursive: true });
    ok(`created profile "${reserveName}"`);
  }
  if (!registry.findProfile(reg, reserveName)) registry.addProfile(reg, reserveName);

  // Keep model/tool settings identical across profiles unless told otherwise.
  // In no-link mode ~/.codex was never moved, so that is where the config sits.
  if (args.copyConfig !== false) {
    const from = linkless && state.exists ? path.join(linkPath, 'config.toml') : path.join(mainTarget, 'config.toml');
    if (fs.existsSync(from)) {
      for (const target of linkless ? [mainTarget, reserveTarget] : [reserveTarget]) {
        const to = path.join(target, 'config.toml');
        if (!fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          ok(`copied config.toml to "${path.basename(target)}"`);
        }
      }
    }
  }

  if (linkless) {
    reg.active = null;
  } else if (state.isLink) {
    const active = reg.profiles.find((p) => link.pointsTo(linkPath, profileDir(p.name)));
    reg.active = active ? active.name : reg.active;
  } else {
    reg.active = mainName;
  }
  registry.save(reg);

  writeShims(reg.profiles.map((p) => p.name));

  info('');
  if (linkless) {
    explainNoLinkMode();
    info('');
    info('Next steps:');
    steps([
      [cyan(`codex-homes login ${mainName}`), 'log in with your first account'],
      [cyan(`codex-homes login ${reserveName}`), 'log in with your second account'],
      [cyan(`codex-homes run ${reserveName} -- "review this diff"`)],
      [cyan('codex-homes shims --path'), 'one command per account'],
    ]);
  } else {
    ok(`active profile: ${bold(reg.active ?? mainName)}`);
    info('');
    info('Next steps:');
    steps([
      [cyan(`codex-homes use ${reserveName}`), 'switch to the empty profile'],
      [cyan('codex login'), 'log in with your second account'],
      [cyan(`codex-homes use ${mainName}`), 'switch back'],
    ]);
  }
  info('');
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- list

export function list(args) {
  const reg = requireInitialised();
  const linkPath = codexLink();
  const mode = linkMode(reg);

  if (args.json) {
    const payload = reg.profiles.map((p) => {
      const home = profileDir(p.name);
      const account = readAccount(home);
      return {
        name: p.name,
        active: namesEqual(reg.active, p.name),
        home,
        exists: fs.existsSync(home),
        account: {
          state: account.state,
          email: account.email,
          plan: account.plan,
          expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
        },
      };
    });
    info(JSON.stringify({ link: linkPath, mode, active: reg.active, profiles: payload }, null, 2));
    return 0;
  }

  if (reg.profiles.length === 0) {
    warn('no profiles registered — run "codex-homes init"');
    return 0;
  }

  const rows = reg.profiles.map((p) => {
    const home = profileDir(p.name);
    const account = readAccount(home);
    const isActive = namesEqual(reg.active, p.name);
    const marker = isActive ? green('*') : ' ';
    const name = isActive ? bold(p.name) : p.name;
    const missing = fs.existsSync(home) ? '' : yellow(' (dir missing)');
    return [
      marker,
      name + missing,
      describeAccount(account),
      account.plan ?? dim('-'),
      account.state === 'chatgpt' ? green('logged in') : dim(account.state),
    ];
  });

  info('');
  table(['', 'PROFILE', 'ACCOUNT', 'PLAN', 'STATE'], rows);
  info('');
  if (mode === 'no-link') {
    info(`${dim('codex home')}  ${linkPath} ${dim('(unmanaged — profiles are selected per command)')}`);
  } else {
    const activeHome = reg.active ? profileDir(reg.active) : null;
    info(`${dim('codex home')}  ${linkPath} ${dim('->')} ${activeHome ?? dim('(none)')}`);
  }
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- use

export async function use(args) {
  const requested = args._[0];
  if (!requested) throw new Error('usage: codex-homes use <profile>');

  const reg = requireInitialised();
  const name = requireProfile(reg, requested).name;

  const home = profileDir(name);
  if (!fs.existsSync(home)) {
    throw new Error(`profile directory is missing: ${home} — run "codex-homes doctor --fix"`);
  }

  if (namesEqual(reg.active, name) && link.pointsTo(codexLink(), home)) {
    ok(`already using ${bold(name)}`);
    return 0;
  }

  if (codexIsRunning() && !args.yes) {
    warn('a codex process is running — switching now can confuse that session.');
    info(`   ${dim(`sessions started with "codex-homes run" or a shim are pinned and unaffected`)}`);
    if (!(await confirm('Switch anyway?', false))) {
      info('aborted.');
      return 1;
    }
  }

  link.setLink(codexLink(), home);
  reg.active = name;
  registry.save(reg);

  const account = readAccount(home);
  ok(`now using ${bold(name)} ${dim('->')} ${describeAccount(account)}`);
  if (account.state === 'logged-out') {
    info(`   ${dim(`no account yet — run: codex login`)}`);
  }
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- run

export async function runIn(args) {
  const requested = args._[0];
  if (!requested) throw new Error('usage: codex-homes run <profile> [-- <codex args>]');

  const reg = requireInitialised();
  const name = requireProfile(reg, requested).name;

  const home = profileDir(name);
  if (!fs.existsSync(home)) throw new Error(`profile directory is missing: ${home}`);

  return runCodex(args._.slice(1), home);
}

// ---------------------------------------------------------------- login / logout

export async function login(args) {
  const requested = args._[0];
  if (!requested) throw new Error('usage: codex-homes login <profile>');
  const reg = requireInitialised();
  const name = requireProfile(reg, requested).name;

  const home = profileDir(name);
  fs.mkdirSync(home, { recursive: true });
  info(`${dim('logging in for profile')} ${bold(name)} ${dim(`(CODEX_HOME=${home})`)}`);
  const code = await runCodex(['login'], home);
  if (code === 0) {
    const account = readAccount(home);
    ok(`"${name}" is now ${describeAccount(account)}`);
  }
  return code;
}

export async function logout(args) {
  const requested = args._[0];
  if (!requested) throw new Error('usage: codex-homes logout <profile>');
  const reg = requireInitialised();
  const name = requireProfile(reg, requested).name;
  return runCodex(['logout'], profileDir(name));
}

// ---------------------------------------------------------------- add / remove

export function add(args) {
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes add <profile>');
  assertCreatableName(name);

  const reg = requireInitialised();
  registry.addProfile(reg, name, args.note ?? '');
  fs.mkdirSync(profileDir(name), { recursive: true });

  if (args.from) {
    const from = requireProfile(reg, args.from).name;
    const source = path.join(profileDir(from), 'config.toml');
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(profileDir(name), 'config.toml'));
      ok(`copied config.toml from "${from}"`);
    }
  }

  registry.save(reg);
  writeShims(reg.profiles.map((p) => p.name));
  ok(`created profile ${bold(name)} at ${profileDir(name)}`);
  info(`   next: ${cyan(`codex-homes login ${name}`)}`);
  return 0;
}

export async function remove(args) {
  const requested = args._[0];
  if (!requested) throw new Error('usage: codex-homes remove <profile> [--purge]');

  const reg = requireInitialised();
  const name = requireProfile(reg, requested).name;

  if (namesEqual(reg.active, name)) {
    throw new Error(`"${name}" is the active profile — switch to another one first`);
  }

  const home = profileDir(name);
  if (args.purge) {
    warn(`this permanently deletes ${home} including its login and session history.`);
    if (!args.yes && !(await confirm(`Delete "${name}" for good?`, false))) {
      info('aborted.');
      return 1;
    }
    fs.rmSync(home, { recursive: true, force: true });
    ok(`deleted ${home}`);
  }

  registry.removeProfile(reg, name);
  registry.save(reg);
  removeShim(name);

  ok(`unregistered profile ${bold(name)}`);
  if (!args.purge && fs.existsSync(home)) {
    info(`   files kept at ${home} ${dim('(use --purge to delete them)')}`);
  }
  return 0;
}

// ---------------------------------------------------------------- status

export function status() {
  const reg = requireInitialised();
  const linkPath = codexLink();
  const state = link.inspect(linkPath);
  const mode = linkMode(reg);
  const activeHome = reg.active ? profileDir(reg.active) : null;
  const account = activeHome ? readAccount(activeHome) : null;

  info('');
  info(`${bold('mode')}             ${mode === 'no-link' ? yellow('no-link (per command)') : mode === 'broken' ? yellow('link missing') : green('link')}`);
  info(`${bold('active profile')}   ${reg.active ? green(reg.active) : dim('none (selected per command)')}`);
  if (account) {
    info(`${bold('account')}          ${describeAccount(account)}`);
    if (account.plan) info(`${bold('plan')}             ${account.plan}`);
    if (account.expiresAt) {
      const expired = account.expiresAt.getTime() < Date.now();
      const when = account.expiresAt.toISOString().replace('T', ' ').slice(0, 19);
      info(`${bold('token expires')}    ${expired ? yellow(`${when} (expired)`) : `${when} UTC`}`);
    }
  }
  info('');
  info(`${bold('codex home')}       ${linkPath}`);
  info(
    `${bold('link state')}       ${state.isLink ? green(process.platform === 'win32' ? 'junction' : 'symlink') : yellow(state.exists ? 'real directory' : 'missing')}`,
  );
  if (state.isLink && state.target) info(`${bold('points to')}        ${state.target}`);
  info(`${bold('profiles root')}    ${profilesDir()}`);
  info(`${bold('shims on PATH')}    ${shimDirOnPath() ? green('yes') : dim('no')}`);
  info('');
  info(`${bold('codex binary')}     ${resolveExecutable('codex') ?? yellow('not found on PATH')}`);
  info(`${bold('codex version')}    ${codexVersion() ?? dim('-')}`);
  if (mode === 'no-link') explainNoLinkMode();
  info('');
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- doctor

export async function doctor(args) {
  /** @type {{text: string, fixed: boolean}[]} */
  const problems = [];
  const note = (text) => problems.push({ text, fixed: false });
  const resolveLast = () => {
    problems[problems.length - 1].fixed = true;
  };
  const fixes = [];
  const linkPath = codexLink();

  if (!registry.registryExists()) {
    fail(`no registry at ${registryPath()} — run "codex-homes init"`);
    return 1;
  }
  const { registry: reg, corrupt: registryCorrupt } = registry.loadTolerant();
  const mode = linkMode(reg);

  info('');
  info(bold('Checks'));

  // 0. registry readable — a plain load() throws here and points at this very
  //    command, so doctor has to be able to get past a damaged file.
  if (registryCorrupt) {
    note(`${registryPath()} is not valid JSON`);
    info(`  ${yellow('!!')} registry is not valid JSON`);
    if (args.fix) {
      try {
        const backup = registry.quarantine();
        registry.save(reg);
        fixes.push(`moved the damaged registry to ${backup} and started a fresh one`);
        resolveLast();
      } catch (err) {
        info(`  ${dim(`could not replace the registry: ${err.message}`)}`);
      }
    }
  } else {
    info(`  ${green('OK')} registry is readable`);
  }

  // 1. CODEX_HOME override
  if (process.env.CODEX_HOME) {
    note(`CODEX_HOME is set to ${process.env.CODEX_HOME} and overrides the active profile`);
    info(`  ${yellow('!!')} CODEX_HOME env var is set — it overrides everything codex-homes does`);
  } else {
    info(`  ${green('OK')} CODEX_HOME env var is not set`);
  }

  // 2. link health — only a problem when this install is meant to have a link
  const state = link.inspect(linkPath);
  const activeHome = reg.active ? profileDir(reg.active) : null;
  // Held so the repair further down can mark it resolved: the link records the
  // answer, but the profiles it names are only registered after the orphan pass.
  let noActiveProblem = null;
  if (mode === 'no-link') {
    info(`  ${dim('--')} no-link mode: ${linkPath} is not managed, profiles are selected per command`);
  } else if (!state.exists) {
    note(`${linkPath} does not exist`);
    info(`  ${yellow('!!')} ${linkPath} is missing`);
    if (args.fix && activeHome && fs.existsSync(activeHome)) {
      // A machine that refuses reparse points is the reason the link is missing
      // as often as not, so report that instead of aborting the whole checkup.
      try {
        link.setLink(linkPath, activeHome);
        fixes.push(`recreated link -> ${activeHome}`);
        resolveLast();
      } catch (err) {
        info(`  ${yellow('!!')} could not recreate the link: ${err.message}`);
      }
    }
  } else if (!state.isLink) {
    note(`${linkPath} is a real directory, not a link — run "codex-homes init"`);
    info(`  ${yellow('!!')} ${linkPath} is a real directory (not managed by codex-homes)`);
  } else if (!activeHome) {
    // Saying the link "points at the active profile" here would be a lie:
    // there is no active profile to point at.
    note(`${linkPath} is a link but no profile is marked active`);
    noActiveProblem = problems[problems.length - 1];
    info(`  ${yellow('!!')} link exists but no profile is marked active`);
  } else if (!link.pointsTo(linkPath, activeHome)) {
    note(`${linkPath} does not point at the active profile "${reg.active}"`);
    info(`  ${yellow('!!')} link points at ${state.target}, expected ${activeHome}`);
    if (args.fix) {
      try {
        link.setLink(linkPath, activeHome);
        fixes.push(`repointed link -> ${activeHome}`);
        resolveLast();
      } catch (err) {
        info(`  ${yellow('!!')} could not repoint the link: ${err.message}`);
      }
    }
  } else {
    info(`  ${green('OK')} ${linkPath} points at the active profile`);
  }

  // 3. missing / orphaned profile directories
  const missing = registry.missingDirs(reg);
  if (missing.length) {
    note(`registered but missing on disk: ${missing.join(', ')}`);
    info(`  ${yellow('!!')} missing directories: ${missing.join(', ')}`);
    if (args.fix) {
      for (const name of missing) fs.mkdirSync(profileDir(name), { recursive: true });
      fixes.push(`recreated ${missing.length} profile directory/-ies`);
      resolveLast();
    }
  } else {
    info(`  ${green('OK')} every registered profile has a directory`);
  }

  const orphans = registry.orphanDirs(reg);
  if (orphans.length) {
    note(`unregistered profile directories: ${orphans.join(', ')}`);
    info(`  ${yellow('!!')} unregistered directories: ${orphans.join(', ')}`);
    if (args.fix) {
      let recovered = 0;
      for (const name of orphans) {
        try {
          registry.addProfile(reg, name, 'recovered by doctor');
          recovered += 1;
        } catch {
          /* name is not usable as a profile, leave the directory alone */
        }
      }
      registry.save(reg);
      if (recovered) {
        fixes.push(`registered ${recovered} orphaned directory/-ies`);
        if (recovered === orphans.length) resolveLast();
      }
    }
  } else {
    info(`  ${green('OK')} no unregistered profile directories`);
  }

  // 3b. A registry rebuilt from disk has no active profile, but the link still
  //     records which one it points at — without this the setup stays in link
  //     mode while reporting that no profile is active.
  if (args.fix && mode === 'link' && !reg.active && state.isLink) {
    const target = reg.profiles.find((p) => link.pointsTo(linkPath, profileDir(p.name)));
    if (target) {
      reg.active = target.name;
      registry.save(reg);
      fixes.push(`active profile restored to "${target.name}" from where the link points`);
      if (noActiveProblem) noActiveProblem.fixed = true;
    }
  }

  // 4. codex binary
  if (resolveExecutable('codex')) {
    info(`  ${green('OK')} codex found on PATH`);
  } else {
    note('codex is not on PATH');
    info(`  ${yellow('!!')} codex not found on PATH`);
  }

  // 5. shims — stale launchers are how "run under the other account" goes wrong
  const allNames = reg.profiles.map((p) => p.name);
  const reservedNames = unshimmable(allNames);
  const staleShims = allNames.filter((name) => !reservedNames.includes(name) && !shimIsCurrent(name));
  if (staleShims.length) {
    note(`launcher missing or outdated for: ${staleShims.join(', ')}`);
    info(`  ${yellow('!!')} launcher missing or outdated: ${staleShims.join(', ')}`);
    if (args.fix) {
      writeShims(allNames);
      fixes.push(`rewrote ${staleShims.length} launcher(s)`);
      resolveLast();
    }
  } else {
    info(`  ${green('OK')} every profile has an up-to-date launcher`);
  }

  // Names that predate the reserved-name check. Renaming is the user's call, so
  // this stays unresolved, but the self-calling launcher itself is removable.
  if (reservedNames.length) {
    note(`launcher would shadow the command it calls, so these profiles get none: ${reservedNames.join(', ')}`);
    info(`  ${yellow('!!')} no launcher for: ${reservedNames.join(', ')} ${dim('(the name shadows the command it runs)')}`);
    info(`     ${dim(`rename with "codex-homes add <new-name> --from <old>", then "codex-homes remove <old>"`)}`);
    const looping = reservedNames.filter((name) => shimExists(name));
    if (args.fix && looping.length) {
      for (const name of looping) removeShim(name);
      fixes.push(`removed ${looping.length} self-calling launcher(s): ${looping.join(', ')}`);
    }
  }

  if (shimDirOnPath()) {
    info(`  ${green('OK')} shim directory is on PATH`);
  } else {
    info(`  ${dim('--')} shim directory not on PATH ${dim('(optional — run "codex-homes shims --path")')}`);
  }

  info('');
  if (fixes.length) {
    for (const f of fixes) ok(f);
    info('');
  }
  const unresolved = problems.filter((p) => !p.fixed);
  if (unresolved.length === 0) {
    ok('everything looks healthy');
    return 0;
  }
  if (!args.fix) info(dim('run "codex-homes doctor --fix" to repair what can be repaired'));
  return 1;
}

// ---------------------------------------------------------------- config-sync

export async function configSync(args) {
  const [requested, ...targets] = args._;
  if (!requested) throw new Error('usage: codex-homes config-sync <from> [to...] (default: all others)');

  const reg = requireInitialised();
  const from = requireProfile(reg, requested).name;

  const source = path.join(profileDir(from), 'config.toml');
  if (!fs.existsSync(source)) throw new Error(`"${from}" has no config.toml at ${source}`);

  const destinations = targets.length
    ? targets.map((t) => requireProfile(reg, t).name)
    : reg.profiles.map((p) => p.name).filter((n) => !namesEqual(n, from));

  if (destinations.length === 0) {
    warn('no target profiles');
    return 0;
  }

  info(`copying ${source}`);
  for (const name of destinations) {
    const target = path.join(profileDir(name), 'config.toml');
    if (fs.existsSync(target) && !args.force) {
      if (!args.yes && !(await confirm(`overwrite config.toml of "${name}"?`, false))) {
        info(`  ${dim('skipped')} ${name}`);
        continue;
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    ok(`-> ${name}`);
  }
  return 0;
}

// ---------------------------------------------------------------- shims

export function shims(args) {
  const reg = requireInitialised();
  const names = reg.profiles.map((p) => p.name);
  const written = writeShims(names);

  ok(`wrote ${written.length} launcher(s) into ${shimDir()}`);
  for (const file of written) info(`   ${dim(path.basename(file))}`);

  const skipped = unshimmable(names);
  if (skipped.length) {
    info('');
    warn(
      `no launcher for ${skipped.join(', ')} — a launcher of that name would shadow the\n` +
        `   command it calls, and this directory goes on the front of your PATH.\n` +
        `   Rename with "codex-homes add <new-name> --from <old>", then "codex-homes remove <old>".`,
    );
  }

  if (args.path) {
    const result = addShimDirToUserPath();
    if (result.applied) ok(`added ${shimDir()} to your user PATH — ${result.hint}`);
    else if (result.alreadyPresent) info(`   ${dim('shim directory already on user PATH')}`);
    else warn(result.hint);
  } else if (!shimDirOnPath()) {
    info('');
    info(`Add the directory to your PATH to use them directly:`);
    info(`  ${cyan('codex-homes shims --path')}`);
  }

  info('');
  const example = names.find((name) => !skipped.includes(name)) ?? 'codex-main';
  info(`Then: ${cyan(`${example} "explain this repo"`)}`);
  info(dim('Each launcher sets CODEX_HOME for its own process, so one terminal per'));
  info(dim('account can run at the same time without them seeing each other.'));
  return 0;
}

// ---------------------------------------------------------------- restore

/**
 * Undo the managed setup: replace the junction with a real directory again.
 * The escape hatch that lets a user leave codex-homes without losing anything.
 */
export async function restore(args) {
  const reg = requireInitialised();
  const requested = args._[0] ?? reg.active;
  if (!requested) {
    throw new Error(
      'no active profile — pass one explicitly: codex-homes restore <profile>',
    );
  }
  const name = requireProfile(reg, requested).name;

  const linkPath = codexLink();
  const home = profileDir(name);
  const state = link.inspect(linkPath);

  if (!state.isLink) {
    throw new Error(
      `${linkPath} is not managed by codex-homes (it is not a link) — nothing to restore.\n` +
        `  To drop a profile in no-link mode use "codex-homes remove ${name} --purge",\n` +
        `  or move ${home} wherever you want it.`,
    );
  }
  if (!fs.existsSync(home)) throw new Error(`profile directory is missing: ${home}`);

  info('');
  info(bold('Plan'));
  info(`  remove link   ${linkPath}`);
  info(`  move back     ${home}  ->  ${linkPath}`);
  info('');
  info(dim(`  other profiles stay in ${profilesDir()} and can be moved manually`));
  info('');

  if (codexIsRunning() && !args.yes) {
    warn('a codex process is running — close it first.');
    if (!(await confirm('Continue anyway?', false))) {
      info('aborted.');
      return 1;
    }
  }
  if (!args.yes && !(await confirm(`Restore "${name}" as a plain directory?`, false))) {
    info('aborted.');
    return 1;
  }

  link.removeLink(linkPath);
  try {
    fs.renameSync(home, linkPath);
  } catch (err) {
    // Put the link back so the user is never left without a Codex home.
    link.setLink(linkPath, home);
    throw new Error(`could not move the profile back (${err.message}) — the link was restored`);
  }

  registry.removeProfile(reg, name);
  registry.save(reg);
  removeShim(name);

  ok(`${linkPath} is a normal directory again, holding the "${name}" account`);
  const remaining = reg.profiles.map((p) => p.name);
  if (remaining.length) {
    info(`   remaining profiles: ${remaining.join(', ')} ${dim(`(in ${profilesDir()})`)}`);
  }
  return 0;
}

// ---------------------------------------------------------------- path

export function printPath(args) {
  const reg = requireInitialised();
  const requested = args._[0] ?? reg.active;
  if (!requested) {
    throw new Error('no active profile — pass one explicitly: codex-homes path <profile>');
  }
  info(profileDir(requireProfile(reg, requested).name));
  return 0;
}

export { root };

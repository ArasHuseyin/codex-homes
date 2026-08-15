import fs from 'node:fs';
import path from 'node:path';

import { assertValidName, codexLink, profileDir, profilesDir, registryPath, root, shimDir } from './paths.js';
import * as registry from './registry.js';
import * as link from './link.js';
import { describeAccount, readAccount } from './auth.js';
import { codexIsRunning, codexVersion, resolveExecutable, runCodex } from './codex.js';
import { addShimDirToUserPath, removeShim, shimDirOnPath, writeShims } from './shims.js';
import { bold, confirm, cyan, dim, fail, green, info, ok, table, warn, yellow } from './ui.js';

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

function requireProfile(reg, name) {
  assertValidName(name);
  const profile = registry.findProfile(reg, name);
  if (!profile) {
    const known = reg.profiles.map((p) => p.name).join(', ') || '(none)';
    throw new Error(`unknown profile "${name}" — known profiles: ${known}`);
  }
  return profile;
}

// ---------------------------------------------------------------- init

export async function init(args) {
  const mainName = assertValidName(args.main ?? DEFAULT_MAIN);
  const reserveName = assertValidName(args.reserve ?? DEFAULT_RESERVE);
  if (mainName === reserveName) throw new Error('main and reserve profiles need different names');

  const linkPath = codexLink();
  const state = link.inspect(linkPath);
  const reg = registry.registryExists() ? registry.load() : { version: 1, active: null, profiles: [] };

  if (state.isLink) {
    info(`${linkPath} is already a link — nothing to migrate.`);
  } else if (state.exists && !state.isDir) {
    throw new Error(`${linkPath} exists but is a file — remove it manually first`);
  }

  const willMigrate = state.exists && !state.isLink;
  const mainTarget = profileDir(mainName);

  info('');
  info(bold('Plan'));
  info(`  profiles root   ${cyan(profilesDir())}`);
  if (willMigrate) {
    info(`  migrate         ${linkPath}  ->  ${mainTarget}`);
    info(`  then link       ${linkPath}  ->  ${mainTarget}`);
  } else if (!state.exists) {
    info(`  create          ${mainTarget} ${dim('(empty)')}`);
    info(`  then link       ${linkPath}  ->  ${mainTarget}`);
  }
  info(`  create          ${profileDir(reserveName)} ${dim('(empty)')}`);
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

  if (willMigrate) {
    link.migrateDirToProfile(linkPath, mainTarget);
    ok(`migrated existing Codex home into profile "${mainName}"`);
  } else if (!state.exists) {
    fs.mkdirSync(mainTarget, { recursive: true });
    link.setLink(linkPath, mainTarget);
    ok(`created empty profile "${mainName}"`);
  }

  if (!registry.findProfile(reg, mainName)) registry.addProfile(reg, mainName, 'migrated by init');

  const reserveTarget = profileDir(reserveName);
  if (!fs.existsSync(reserveTarget)) fs.mkdirSync(reserveTarget, { recursive: true });
  if (!registry.findProfile(reg, reserveName)) registry.addProfile(reg, reserveName);
  ok(`created profile "${reserveName}"`);

  // Keep model/tool settings identical across profiles unless told otherwise.
  if (args.copyConfig !== false) {
    const from = path.join(mainTarget, 'config.toml');
    const to = path.join(reserveTarget, 'config.toml');
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      ok(`copied config.toml to "${reserveName}"`);
    }
  }

  if (state.isLink) {
    const active = reg.profiles.find((p) => link.pointsTo(linkPath, profileDir(p.name)));
    reg.active = active ? active.name : reg.active;
  } else {
    reg.active = mainName;
  }
  registry.save(reg);

  writeShims(reg.profiles.map((p) => p.name));

  info('');
  ok(`active profile: ${bold(reg.active ?? mainName)}`);
  info('');
  info('Next steps:');
  info(`  1. ${cyan(`codex-homes use ${reserveName}`)}   switch to the empty profile`);
  info(`  2. ${cyan('codex login')}                        log in with your second account`);
  info(`  3. ${cyan(`codex-homes use ${mainName}`)}      switch back`);
  info('');
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- list

export function list(args) {
  const reg = requireInitialised();
  const linkPath = codexLink();

  if (args.json) {
    const payload = reg.profiles.map((p) => {
      const home = profileDir(p.name);
      const account = readAccount(home);
      return {
        name: p.name,
        active: reg.active === p.name,
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
    info(JSON.stringify({ link: linkPath, active: reg.active, profiles: payload }, null, 2));
    return 0;
  }

  if (reg.profiles.length === 0) {
    warn('no profiles registered — run "codex-homes init"');
    return 0;
  }

  const rows = reg.profiles.map((p) => {
    const home = profileDir(p.name);
    const account = readAccount(home);
    const isActive = reg.active === p.name;
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
  const activeHome = reg.active ? profileDir(reg.active) : null;
  info(`${dim('codex home')}  ${linkPath} ${dim('->')} ${activeHome ?? dim('(none)')}`);
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- use

export async function use(args) {
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes use <profile>');

  const reg = requireInitialised();
  requireProfile(reg, name);

  const home = profileDir(name);
  if (!fs.existsSync(home)) {
    throw new Error(`profile directory is missing: ${home} — run "codex-homes doctor --fix"`);
  }

  if (reg.active === name && link.pointsTo(codexLink(), home)) {
    ok(`already using ${bold(name)}`);
    return 0;
  }

  if (codexIsRunning() && !args.yes) {
    warn('a codex process is running — switching now can confuse that session.');
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
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes run <profile> [-- <codex args>]');

  const reg = requireInitialised();
  requireProfile(reg, name);

  const home = profileDir(name);
  if (!fs.existsSync(home)) throw new Error(`profile directory is missing: ${home}`);

  return runCodex(args._.slice(1), home);
}

// ---------------------------------------------------------------- login / logout

export async function login(args) {
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes login <profile>');
  const reg = requireInitialised();
  requireProfile(reg, name);

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
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes logout <profile>');
  const reg = requireInitialised();
  requireProfile(reg, name);
  return runCodex(['logout'], profileDir(name));
}

// ---------------------------------------------------------------- add / remove

export function add(args) {
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes add <profile>');
  assertValidName(name);

  const reg = requireInitialised();
  registry.addProfile(reg, name, args.note ?? '');
  fs.mkdirSync(profileDir(name), { recursive: true });

  if (args.from) {
    requireProfile(reg, args.from);
    const source = path.join(profileDir(args.from), 'config.toml');
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(profileDir(name), 'config.toml'));
      ok(`copied config.toml from "${args.from}"`);
    }
  }

  registry.save(reg);
  writeShims(reg.profiles.map((p) => p.name));
  ok(`created profile ${bold(name)} at ${profileDir(name)}`);
  info(`   next: ${cyan(`codex-homes login ${name}`)}`);
  return 0;
}

export async function remove(args) {
  const name = args._[0];
  if (!name) throw new Error('usage: codex-homes remove <profile> [--purge]');

  const reg = requireInitialised();
  requireProfile(reg, name);

  if (reg.active === name) {
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
  const activeHome = reg.active ? profileDir(reg.active) : null;
  const account = activeHome ? readAccount(activeHome) : null;

  info('');
  info(`${bold('active profile')}   ${reg.active ? green(reg.active) : yellow('none')}`);
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
  info(`${bold('link state')}       ${state.isLink ? green('junction') : yellow(state.exists ? 'real directory' : 'missing')}`);
  if (state.isLink && state.target) info(`${bold('points to')}        ${state.target}`);
  info(`${bold('profiles root')}    ${profilesDir()}`);
  info('');
  info(`${bold('codex binary')}     ${resolveExecutable('codex') ?? yellow('not found on PATH')}`);
  info(`${bold('codex version')}    ${codexVersion() ?? dim('-')}`);
  info('');
  warnAboutEnvOverride();
  return 0;
}

// ---------------------------------------------------------------- doctor

export async function doctor(args) {
  const problems = [];
  const fixes = [];
  const linkPath = codexLink();

  if (!registry.registryExists()) {
    fail(`no registry at ${registryPath()} — run "codex-homes init"`);
    return 1;
  }
  const reg = registry.load();

  info('');
  info(bold('Checks'));

  // 1. CODEX_HOME override
  if (process.env.CODEX_HOME) {
    problems.push(`CODEX_HOME is set to ${process.env.CODEX_HOME} and overrides the active profile`);
    info(`  ${yellow('!!')} CODEX_HOME env var is set — it overrides everything codex-homes does`);
  } else {
    info(`  ${green('OK')} CODEX_HOME env var is not set`);
  }

  // 2. link health
  const state = link.inspect(linkPath);
  const activeHome = reg.active ? profileDir(reg.active) : null;
  if (!state.exists) {
    problems.push(`${linkPath} does not exist`);
    info(`  ${yellow('!!')} ${linkPath} is missing`);
    if (args.fix && activeHome && fs.existsSync(activeHome)) {
      link.setLink(linkPath, activeHome);
      fixes.push(`recreated link -> ${activeHome}`);
    }
  } else if (!state.isLink) {
    problems.push(`${linkPath} is a real directory, not a link — run "codex-homes init"`);
    info(`  ${yellow('!!')} ${linkPath} is a real directory (not managed by codex-homes)`);
  } else if (activeHome && !link.pointsTo(linkPath, activeHome)) {
    problems.push(`${linkPath} does not point at the active profile "${reg.active}"`);
    info(`  ${yellow('!!')} link points at ${state.target}, expected ${activeHome}`);
    if (args.fix) {
      link.setLink(linkPath, activeHome);
      fixes.push(`repointed link -> ${activeHome}`);
    }
  } else {
    info(`  ${green('OK')} ${linkPath} points at the active profile`);
  }

  // 3. missing / orphaned profile directories
  const missing = registry.missingDirs(reg);
  if (missing.length) {
    problems.push(`registered but missing on disk: ${missing.join(', ')}`);
    info(`  ${yellow('!!')} missing directories: ${missing.join(', ')}`);
    if (args.fix) {
      for (const name of missing) fs.mkdirSync(profileDir(name), { recursive: true });
      fixes.push(`recreated ${missing.length} profile directory/-ies`);
    }
  } else {
    info(`  ${green('OK')} every registered profile has a directory`);
  }

  const orphans = registry.orphanDirs(reg);
  if (orphans.length) {
    problems.push(`unregistered profile directories: ${orphans.join(', ')}`);
    info(`  ${yellow('!!')} unregistered directories: ${orphans.join(', ')}`);
    if (args.fix) {
      for (const name of orphans) {
        try {
          registry.addProfile(reg, name, 'recovered by doctor');
        } catch {
          /* invalid name, skip */
        }
      }
      registry.save(reg);
      fixes.push(`registered ${orphans.length} orphaned directory/-ies`);
    }
  } else {
    info(`  ${green('OK')} no unregistered profile directories`);
  }

  // 4. codex binary
  if (resolveExecutable('codex')) {
    info(`  ${green('OK')} codex found on PATH`);
  } else {
    problems.push('codex is not on PATH');
    info(`  ${yellow('!!')} codex not found on PATH`);
  }

  // 5. shims
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
  if (problems.length === 0) {
    ok('everything looks healthy');
    return 0;
  }
  if (!args.fix) info(dim('run "codex-homes doctor --fix" to repair what can be repaired'));
  return problems.length && !fixes.length ? 1 : 0;
}

// ---------------------------------------------------------------- config-sync

export async function configSync(args) {
  const [from, ...targets] = args._;
  if (!from) throw new Error('usage: codex-homes config-sync <from> [to...] (default: all others)');

  const reg = requireInitialised();
  requireProfile(reg, from);

  const source = path.join(profileDir(from), 'config.toml');
  if (!fs.existsSync(source)) throw new Error(`"${from}" has no config.toml at ${source}`);

  const destinations = targets.length
    ? targets.map((t) => requireProfile(reg, t).name)
    : reg.profiles.map((p) => p.name).filter((n) => n !== from);

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
  const written = writeShims(reg.profiles.map((p) => p.name));

  ok(`wrote ${written.length} launcher(s) into ${shimDir()}`);
  for (const file of written) info(`   ${dim(path.basename(file))}`);

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
  info(`Then: ${cyan(`${reg.profiles[0]?.name ?? 'codex-main'} "explain this repo"`)}`);
  return 0;
}

// ---------------------------------------------------------------- restore

/**
 * Undo the managed setup: replace the junction with a real directory again.
 * The escape hatch that lets a user leave codex-homes without losing anything.
 */
export async function restore(args) {
  const reg = requireInitialised();
  const name = args._[0] ?? reg.active;
  if (!name) throw new Error('no active profile — pass one explicitly: codex-homes restore <profile>');
  requireProfile(reg, name);

  const linkPath = codexLink();
  const home = profileDir(name);
  const state = link.inspect(linkPath);

  if (!state.isLink) {
    throw new Error(`${linkPath} is not managed by codex-homes (it is not a link) — nothing to restore`);
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
  const name = args._[0] ?? reg.active;
  if (!name) throw new Error('no active profile');
  requireProfile(reg, name);
  info(profileDir(name));
  return 0;
}

export { root };

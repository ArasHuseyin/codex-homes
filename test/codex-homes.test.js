import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HANDLERS, parseArgs } from '../src/cli.js';
import {
  COMMANDS,
  TOPICS,
  findCommand,
  findTopic,
  helpTargets,
  renderAll,
  renderCommand,
  renderOverview,
  renderTopic,
} from '../src/help.js';
import * as link from '../src/link.js';
import { readAccount } from '../src/auth.js';
import { buildCmdPayload, buildNodeCodexProbe, quoteForCmd } from '../src/codex.js';
import { assertCreatableName, caseInsensitiveFs, isReservedName, sameFsName, splitPathEntries } from '../src/paths.js';
import { buildUserPathScript, shimBody, shimFileName } from '../src/shims.js';

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-homes-${label}-`));
}

/** Run `fn` against a throwaway CODEX_HOMES_ROOT / CODEX_HOMES_LINK. */
async function withSandbox(fn) {
  const base = tempDir('sandbox');
  const previousRoot = process.env.CODEX_HOMES_ROOT;
  const previousLink = process.env.CODEX_HOMES_LINK;
  process.env.CODEX_HOMES_ROOT = path.join(base, 'root');
  process.env.CODEX_HOMES_LINK = path.join(base, 'dot-codex');
  try {
    return await fn(base);
  } finally {
    if (previousRoot === undefined) delete process.env.CODEX_HOMES_ROOT;
    else process.env.CODEX_HOMES_ROOT = previousRoot;
    if (previousLink === undefined) delete process.env.CODEX_HOMES_LINK;
    else process.env.CODEX_HOMES_LINK = previousLink;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Run `fn` with stdout swallowed, so a command's own output stays out of the report. */
async function quiet(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

/** Run `fn` and return everything it wrote to stdout. */
async function capture(fn) {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

// ------------------------------------------------------------------ argv

test('parseArgs handles flags, values and passthrough', () => {
  const args = parseArgs(['codex-main', '--main', 'work', '--no-copy-config', '-y', '--json']);
  assert.deepEqual(args._, ['codex-main']);
  assert.equal(args.main, 'work');
  assert.equal(args.copyConfig, false);
  assert.equal(args.yes, true);
  assert.equal(args.json, true);
});

test('parseArgs supports --key=value and stops at --', () => {
  const args = parseArgs(['--note=hello world', '--', '--not-a-flag', 'x']);
  assert.equal(args.note, 'hello world');
  assert.deepEqual(args._, ['--not-a-flag', 'x']);
});

// ------------------------------------------------------------------ auth

test('readAccount reports logged-out for an empty home', () => {
  const dir = tempDir('auth-empty');
  try {
    assert.equal(readAccount(dir).state, 'logged-out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAccount decodes email and plan from the id_token', () => {
  const dir = tempDir('auth-jwt');
  try {
    const payload = {
      email: 'someone@example.com',
      exp: 2000000000,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acct_123',
      },
    };
    const encode = (obj) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    const idToken = `${encode({ alg: 'none' })}.${encode(payload)}.sig`;

    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken } }),
    );

    const account = readAccount(dir);
    assert.equal(account.state, 'chatgpt');
    assert.equal(account.email, 'someone@example.com');
    assert.equal(account.plan, 'plus');
    assert.equal(account.accountId, 'acct_123');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAccount flags a corrupt auth.json instead of throwing', () => {
  const dir = tempDir('auth-broken');
  try {
    fs.writeFileSync(path.join(dir, 'auth.json'), '{ not json');
    assert.equal(readAccount(dir).state, 'invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAccount tolerates a UTF-8 BOM in auth.json', () => {
  const dir = tempDir('auth-bom');
  try {
    const body = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' });
    fs.writeFileSync(path.join(dir, 'auth.json'), `﻿${body}`, 'utf8');
    assert.equal(readAccount(dir).state, 'apikey');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAccount recognises API-key auth', () => {
  const dir = tempDir('auth-apikey');
  try {
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }),
    );
    assert.equal(readAccount(dir).state, 'apikey');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ links

test('setLink / pointsTo / removeLink round-trip', () => {
  const base = tempDir('link');
  try {
    const targetA = path.join(base, 'a');
    const targetB = path.join(base, 'b');
    const linkPath = path.join(base, 'active');
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    fs.writeFileSync(path.join(targetA, 'marker.txt'), 'A');

    link.setLink(linkPath, targetA);
    assert.equal(link.pointsTo(linkPath, targetA), true);
    assert.equal(fs.readFileSync(path.join(linkPath, 'marker.txt'), 'utf8'), 'A');

    link.setLink(linkPath, targetB);
    assert.equal(link.pointsTo(linkPath, targetB), true);
    assert.equal(link.pointsTo(linkPath, targetA), false);

    link.removeLink(linkPath);
    assert.equal(link.inspect(linkPath).exists, false);
    // Repointing and unlinking must never touch the real directories.
    assert.equal(fs.existsSync(path.join(targetA, 'marker.txt')), true);
    assert.equal(fs.existsSync(targetB), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('removeLink refuses to delete a real directory', () => {
  const base = tempDir('link-guard');
  try {
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'keep.txt'), 'important');

    assert.throws(() => link.removeLink(real), /real directory/);
    assert.equal(fs.existsSync(path.join(real, 'keep.txt')), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('setLink refuses to replace a real directory', () => {
  const base = tempDir('link-guard2');
  try {
    const real = path.join(base, 'real');
    const target = path.join(base, 'target');
    fs.mkdirSync(real);
    fs.mkdirSync(target);

    assert.throws(() => link.setLink(real, target), /real directory/);
    assert.equal(fs.existsSync(real), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('migrateDirToProfile moves the data and links the old path back to it', () => {
  const base = tempDir('migrate');
  try {
    const source = path.join(base, 'dot-codex');
    const profile = path.join(base, 'root', 'profiles', 'codex-main');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fs.writeFileSync(path.join(source, 'config.toml'), 'model = "gpt-5"');

    link.migrateDirToProfile(source, profile);

    assert.equal(fs.existsSync(path.join(profile, 'auth.json')), true);
    assert.equal(link.inspect(source).isLink, true);
    assert.equal(link.pointsTo(source, profile), true);
    // Reading through the link must reach the migrated data.
    assert.equal(fs.readFileSync(path.join(source, 'config.toml'), 'utf8'), 'model = "gpt-5"');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('migrateDirToProfile refuses to overwrite an existing profile', () => {
  const base = tempDir('migrate-guard');
  try {
    const source = path.join(base, 'dot-codex');
    const profile = path.join(base, 'root', 'profiles', 'codex-main');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'auth.json'), 'existing');

    assert.throws(() => link.migrateDirToProfile(source, profile), /already exists/);
    assert.equal(fs.readFileSync(path.join(profile, 'auth.json'), 'utf8'), 'existing');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ registry

test('registry add/remove/persist round-trip', async () => {
  await withSandbox(async () => {
    const registry = await import(`../src/registry.js?t=${Date.now()}`);
    registry.ensureDirs();

    const reg = registry.load();
    registry.addProfile(reg, 'codex-main');
    registry.addProfile(reg, 'codex-reserve');
    reg.active = 'codex-main';
    registry.save(reg);

    const reloaded = registry.load();
    assert.equal(reloaded.active, 'codex-main');
    assert.deepEqual(
      reloaded.profiles.map((p) => p.name),
      ['codex-main', 'codex-reserve'],
    );

    assert.throws(() => registry.addProfile(reloaded, 'codex-main'), /already exists/);

    registry.removeProfile(reloaded, 'codex-reserve');
    registry.save(reloaded);
    assert.deepEqual(
      registry.load().profiles.map((p) => p.name),
      ['codex-main'],
    );
  });
});

test('registry rejects path-traversing profile names', async () => {
  await withSandbox(async () => {
    const registry = await import(`../src/registry.js?t=${Date.now()}-b`);
    const reg = registry.load();
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', '', '.hidden']) {
      assert.throws(() => registry.addProfile(reg, bad), /invalid profile name/);
    }
  });
});

// ------------------------------------------------------------------ names

test('assertCreatableName rejects names Windows or the shims cannot carry', () => {
  for (const good of ['codex-main', 'work', 'a', 'a.b_c-1']) {
    assert.equal(assertCreatableName(good), good);
  }
  // A launcher called "codex" would sit on PATH and shadow the binary it calls.
  assert.throws(() => assertCreatableName('codex'), /shadow/);
  assert.throws(() => assertCreatableName('CODEX'), /shadow|invalid/);
  assert.throws(() => assertCreatableName('con'), /device/);
  assert.throws(() => assertCreatableName('LPT1'), /device/);
  assert.throws(() => assertCreatableName('nul.txt'), /device/);
  assert.throws(() => assertCreatableName('trailing.'), /trailing dot/);
  assert.throws(() => assertCreatableName('../evil'), /invalid profile name/);
});

test('sameFsName follows the filesystem it is told about', () => {
  assert.equal(sameFsName('Work', 'work', true), true);
  assert.equal(sameFsName('Work', 'work', false), false);
  assert.equal(sameFsName('work', 'work', false), true);
});

// ------------------------------------------------------------------ PATH parsing

test('splitPathEntries unwraps quoted and padded Windows entries', () => {
  const entries = splitPathEntries('C:\\a; "C:\\Program Files\\node" ;;C:\\b', 'win32');
  assert.deepEqual(entries, ['C:\\a', 'C:\\Program Files\\node', 'C:\\b']);
});

test('splitPathEntries leaves POSIX entries alone', () => {
  assert.deepEqual(splitPathEntries('/usr/bin:/opt/x:', 'linux'), ['/usr/bin', '/opt/x']);
});

// ------------------------------------------------------------------ shims

test('the Windows launcher calls codex and forwards its exit code', () => {
  const body = shimBody('C:\\Users\\me\\.codex-homes\\profiles\\work', 'win32');
  assert.equal(shimFileName('work', 'win32'), 'work.cmd');
  // Without "call", codex.cmd would chain and endlocal would never run.
  assert.match(body, /^call codex %\*$/m);
  assert.match(body, /^endlocal & exit \/b %ERRORLEVEL%$/m);
  assert.match(body, /^set "CODEX_HOME=C:\\Users\\me\\\.codex-homes\\profiles\\work"$/m);
  assert.ok(body.includes('\r\n'), 'batch files need CRLF');
});

test('the Windows launcher escapes percent signs in the profile path', () => {
  const body = shimBody('C:\\odd%name\\work', 'win32');
  assert.match(body, /^set "CODEX_HOME=C:\\odd%%name\\work"$/m);
});

test('the POSIX launcher quotes the profile path', () => {
  const body = shimBody("/home/me/it's/work", 'linux');
  assert.equal(shimFileName('work', 'linux'), 'work');
  assert.match(body, /^CODEX_HOME='\/home\/me\/it'\\''s\/work'$/m);
  assert.match(body, /^exec codex "\$@"$/m);
  assert.ok(!body.includes('\r'), 'shell scripts must not carry CRLF');
});

test('the user-PATH script embeds the directory instead of reading $args', () => {
  const script = buildUserPathScript("C:\\Users\\o'brien\\.codex-homes\\bin");
  // -Command appends trailing arguments to the command text rather than binding
  // them to $args, so the directory has to be part of the script itself.
  assert.ok(!script.includes('$args'), 'the script must not depend on $args');
  assert.match(script, /\$dir = 'C:\\Users\\o''brien\\\.codex-homes\\bin'/);
  // Reading through [Environment] would expand %USERPROFILE% and freeze it.
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /GetValueKind\('Path'\)/);
});

// ------------------------------------------------------------------ cmd quoting

test('cmd payload keeps a quoted executable path in one piece', () => {
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('has space'), '"has space"');
  const payload = buildCmdPayload('C:\\Program Files\\nodejs\\codex.cmd', ['fix the test']);
  assert.equal(payload, '""C:\\Program Files\\nodejs\\codex.cmd" "fix the test""');
});

// ------------------------------------------------------------------ link failures

test('inspect treats a non-directory path component as absent', () => {
  const base = tempDir('link-notdir');
  try {
    const file = path.join(base, 'file');
    fs.writeFileSync(file, 'x');
    assert.deepEqual(link.inspect(path.join(file, 'child')), {
      exists: false,
      isLink: false,
      isDir: false,
      target: null,
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('setLink reports an unusable location as a link failure with a way out', () => {
  const base = tempDir('link-unsupported');
  try {
    const target = path.join(base, 'profile');
    fs.mkdirSync(target);
    const blocked = path.join(base, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');

    try {
      link.setLink(path.join(blocked, '.codex'), target);
      assert.fail('expected setLink to throw');
    } catch (err) {
      // init keys off this flag to offer no-link mode instead of giving up.
      assert.equal(err.linkUnsupported, true);
      assert.match(err.message, /--no-link/);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ registry

test('registry resolves and rejects names the way the filesystem does', async () => {
  await withSandbox(async () => {
    const registry = await import(`../src/registry.js?t=${Date.now()}-c`);
    const reg = registry.load();
    registry.addProfile(reg, 'work');

    if (caseInsensitiveFs) {
      // "Work" and "work" would share one directory here, so it must not register twice.
      assert.throws(() => registry.addProfile(reg, 'Work'), /already exists/);
      assert.equal(registry.findProfile(reg, 'WORK')?.name, 'work');
    } else {
      registry.addProfile(reg, 'Work');
      assert.equal(registry.findProfile(reg, 'Work')?.name, 'Work');
      assert.equal(registry.findProfile(reg, 'WORK'), null);
    }
  });
});

test('registry.save leaves no scratch file behind', async () => {
  await withSandbox(async () => {
    const registry = await import(`../src/registry.js?t=${Date.now()}-d`);
    const paths = await import(`../src/paths.js?t=${Date.now()}-d`);
    const reg = registry.load();
    registry.addProfile(reg, 'work');
    registry.save(reg);
    registry.save(reg);

    const leftovers = fs.readdirSync(paths.root()).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(
      registry.load().profiles.map((p) => p.name),
      ['work'],
    );
  });
});

// ------------------------------------------------------------------ running-process probe

test('the node probe never counts codex-homes itself as a running session', () => {
  const script = buildNodeCodexProbe(4321);

  // "codex-homes" contains "codex", so without an exclusion the tool matches its
  // own node process, every "use" warns, and a non-TTY run aborts on the fallback.
  assert.match(script, /\$id = 4321/);
  assert.match(script, /-not \$mine\.ContainsKey\(\[int\]\$_\.ProcessId\)/);
  // The npx/npm wrapper that launched us is a node process mentioning codex too.
  assert.match(script, /ParentProcessId/);
  // $PID inside the script is PowerShell's own process, not the one to skip.
  assert.ok(!script.includes('$PID'), 'the pid must be substituted, not read from $PID');
});

test('the node probe coerces the pid instead of splicing it in', () => {
  assert.ok(!buildNodeCodexProbe('123; Write-Output hacked').includes('hacked'));
});

// ------------------------------------------------------------------ reserved names

test('a launcher is never written for a name that would shadow the command it calls', async () => {
  await withSandbox(async () => {
    const shims = await import('../src/shims.js');
    const paths = await import('../src/paths.js');

    assert.equal(isReservedName('codex'), true);
    assert.equal(isReservedName('CODEX'), true);
    assert.equal(isReservedName('work'), false);

    // Versions before the reserved-name check registered "codex" happily, so the
    // self-calling launcher is already on disk — regenerating must clear it, not
    // recreate it. With the shim directory prepended to PATH it loops forever.
    const dir = paths.shimDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, shims.shimFileName('codex'));
    fs.writeFileSync(stale, shims.shimBody(paths.profileDir('codex')));

    const written = shims.writeShims(['codex', 'work']);

    assert.deepEqual(
      written.map((f) => path.basename(f)),
      [shims.shimFileName('work')],
    );
    assert.equal(fs.existsSync(stale), false, 'the self-calling launcher must be removed');
    assert.deepEqual(shims.unshimmable(['codex', 'work', 'cxh']), ['codex', 'cxh']);
  });
});

// ------------------------------------------------------------------ setLink safety

test('setLink keeps the existing link when the replacement cannot be created', () => {
  const base = tempDir('link-staging');
  try {
    const targetA = path.join(base, 'a');
    const targetB = path.join(base, 'b');
    const linkPath = path.join(base, 'active');
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    fs.writeFileSync(path.join(targetA, 'marker.txt'), 'A');

    link.setLink(linkPath, targetA);

    // Stand a real directory where the replacement wants to be built, so creating
    // it fails the way a filesystem that refuses reparse points would.
    fs.mkdirSync(link.stagingPath(linkPath));

    assert.throws(() => link.setLink(linkPath, targetB), (err) => {
      assert.equal(err.linkUnsupported, true);
      return true;
    });

    // The whole point: a refused link must not cost the user their Codex home.
    assert.equal(link.pointsTo(linkPath, targetA), true);
    assert.equal(fs.readFileSync(path.join(linkPath, 'marker.txt'), 'utf8'), 'A');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ init placeholders

test('init refuses to migrate over a profile whose config the user has edited', async () => {
  await withSandbox(async (base) => {
    const commands = await import('../src/commands.js');
    const registry = await import('../src/registry.js');
    const paths = await import('../src/paths.js');

    const linkPath = paths.codexLink();
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fs.writeFileSync(path.join(linkPath, 'config.toml'), 'model = "gpt-5"');

    const reg = registry.load();
    registry.addProfile(reg, 'work');
    registry.save(reg);
    const home = paths.profileDir('work');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "hand-edited"');

    await assert.rejects(
      () => quiet(() => commands.init({ _: [], main: 'work', yes: true })),
      /already holds data/,
    );

    // "only config.toml present" is not enough to call a directory disposable.
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "hand-edited"');
    assert.ok(base);
  });
});

test('init replaces the untouched placeholder an earlier --no-link run left behind', async () => {
  await withSandbox(async () => {
    const commands = await import('../src/commands.js');
    const paths = await import('../src/paths.js');

    const linkPath = paths.codexLink();
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fs.writeFileSync(path.join(linkPath, 'config.toml'), 'model = "gpt-5"');

    // What --no-link writes: a byte-for-byte copy of the config being migrated,
    // so removing it loses nothing the migration does not bring along.
    const home = paths.profileDir('codex-main');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5"');

    const code = await quiet(() => commands.init({ _: [], yes: true }));

    assert.equal(code, 0);
    assert.equal(link.pointsTo(linkPath, home), true);
    assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt"}');
  });
});

// ------------------------------------------------------------------ ui

test('steps aligns descriptions on the widest command, not on fixed padding', async () => {
  const { steps } = await import('../src/ui.js');

  // The profile name sits inside the command, so --main/--reserve decide the
  // width: padding written into the string cannot be right for both.
  const text = await capture(() =>
    steps([
      ['codex-homes use privat', 'switch to the empty profile'],
      ['codex login', 'log in with your second account'],
      ['codex-homes use firma-account-lang', 'switch back'],
    ]),
  );

  const lines = text.split('\n').filter(Boolean);
  const columns = [
    lines[0].indexOf('switch to the empty profile'),
    lines[1].indexOf('log in with your second account'),
    lines[2].indexOf('switch back'),
  ];
  assert.equal(new Set(columns).size, 1, `descriptions start at columns ${columns.join(', ')}`);
});

test('steps leaves an undescribed line out of the column measurement', async () => {
  const { steps } = await import('../src/ui.js');
  const long = 'codex-homes run privat -- "review this diff"';

  const text = await capture(() =>
    steps([
      ['codex-homes login privat', 'log in'],
      [long],
      ['codex-homes shims --path', 'one command per account'],
    ]),
  );

  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines[0].indexOf('log in'), lines[2].indexOf('one command per account'));
  // Otherwise the one long example would push every description past its width.
  assert.ok(lines[0].indexOf('log in') < long.length);
});

// ------------------------------------------------------------------ recovery

test('doctor --fix repairs the corrupt registry its own error message points at', async () => {
  await withSandbox(async () => {
    const commands = await import('../src/commands.js');
    const registry = await import('../src/registry.js');
    const paths = await import('../src/paths.js');

    const linkPath = paths.codexLink();
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'auth.json'), '{"auth_mode":"chatgpt"}');
    await quiet(() => commands.init({ _: [], yes: true }));

    fs.writeFileSync(paths.registryPath(), 'not json at all');
    // load() sends the user to doctor --fix, so doctor must get past this file.
    assert.throws(() => registry.load(), /doctor --fix/);

    const code = await quiet(() => commands.doctor({ _: [], fix: true }));
    assert.equal(code, 0);

    const reg = registry.load();
    assert.deepEqual(
      reg.profiles.map((p) => p.name).sort(),
      ['codex-main', 'codex-reserve'],
      'the profile directories on disk are registered again',
    );
    assert.ok(fs.existsSync(`${paths.registryPath()}.corrupt`), 'the damaged file is kept');
  });
});

test('doctor --fix takes the active profile from where the link points', async () => {
  await withSandbox(async () => {
    const commands = await import('../src/commands.js');
    const registry = await import('../src/registry.js');
    const paths = await import('../src/paths.js');

    const linkPath = paths.codexLink();
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'auth.json'), '{"auth_mode":"chatgpt"}');
    await quiet(() => commands.init({ _: [], yes: true }));

    // A registry rebuilt from disk knows the profiles but not which is active.
    const reg = registry.load();
    reg.active = null;
    registry.save(reg);

    const code = await quiet(() => commands.doctor({ _: [], fix: true }));
    assert.equal(code, 0);
    assert.equal(registry.load().active, 'codex-main');
    assert.equal(link.pointsTo(linkPath, paths.profileDir('codex-main')), true);
  });
});

// ------------------------------------------------------------------ help

/** The same camelisation the argv parser applies to a long flag. */
function camel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

test('the help documents every command the CLI dispatches, and nothing it does not', () => {
  const documented = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
  // "help" is answered before the dispatch table is consulted, so it is the one
  // documented name that has no handler behind it.
  const dispatched = [...Object.keys(HANDLERS), 'help'];
  assert.deepEqual(documented.sort(), dispatched.sort());
});

test('every flag the help documents is one the parser actually understands', () => {
  for (const spec of COMMANDS) {
    for (const [flags, description] of spec.options) {
      const forms = flags.split(',').map((f) => f.trim());
      const long = forms.find((f) => f.startsWith('--'));
      assert.ok(long, `${spec.name}: "${flags}" documents no long form`);
      assert.ok(description, `${spec.name}: "${flags}" has no description`);

      const name = long.replace(/\s+<.*$/, '');
      const negated = name.startsWith('--no-');
      const takesValue = /<[^>]+>/.test(long);
      const key = camel(negated ? name.slice(5) : name.slice(2));

      // A documented "--flag <value>" that is not a value flag would silently
      // parse as true and swallow the value as a positional argument.
      assert.equal(
        parseArgs(takesValue ? [name, 'x'] : [name])[key],
        takesValue ? 'x' : !negated,
        `${spec.name}: ${long} does not parse into "${key}"`,
      );

      const short = forms.find((f) => /^-[^-]/.test(f));
      if (short) {
        assert.equal(
          parseArgs([short])[key],
          true,
          `${spec.name}: ${short} is not an alias of ${name}`,
        );
      }
    }
  }
});

test('every name the help accepts renders a page', () => {
  for (const target of helpTargets()) {
    const spec = findCommand(target);
    const topic = findTopic(target);
    assert.ok(spec || topic, `no help page for "${target}"`);
    const page = spec ? renderCommand(spec) : renderTopic(topic);
    assert.ok(page.trim().length > 0, `empty help page for "${target}"`);
  }
});

test('the overview shows the usage of every command and points at every guide', () => {
  const overview = renderOverview('9.9.9');
  assert.match(overview, /9\.9\.9/);
  for (const spec of COMMANDS) {
    assert.ok(overview.includes(spec.signature), `overview is missing "${spec.signature}"`);
    assert.ok(overview.includes(spec.summary), `overview is missing the summary of "${spec.name}"`);
  }
  for (const topic of TOPICS) {
    assert.ok(overview.includes(topic.name), `overview is missing the guide "${topic.name}"`);
  }
});

test('help --all prints every command page and every guide', () => {
  const all = renderAll('9.9.9');
  for (const spec of COMMANDS) {
    assert.ok(
      all.includes(`codex-homes ${spec.usage ?? spec.signature}`),
      `--all is missing the page for "${spec.name}"`,
    );
  }
  for (const topic of TOPICS) {
    assert.ok(all.includes(topic.title.toUpperCase()), `--all is missing the guide "${topic.name}"`);
  }
});

test('a see-also always names something the help can show', () => {
  for (const spec of COMMANDS) {
    for (const name of spec.seeAlso) {
      assert.ok(
        findCommand(name) || findTopic(name),
        `"${spec.name}" points at unknown help target "${name}"`,
      );
    }
  }
});

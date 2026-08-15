import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from '../src/cli.js';
import * as link from '../src/link.js';
import { readAccount } from '../src/auth.js';

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

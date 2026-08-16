import fs from 'node:fs';
import path from 'node:path';
import {
  assertCreatableName,
  namesEqual,
  profileDir,
  profilesDir,
  registryPath,
  root,
} from './paths.js';

const CURRENT_VERSION = 1;

function emptyRegistry() {
  return { version: CURRENT_VERSION, active: null, profiles: [] };
}

export function ensureDirs() {
  fs.mkdirSync(profilesDir(), { recursive: true });
}

export function registryExists() {
  return fs.existsSync(registryPath());
}

export function load() {
  const file = registryPath();
  if (!fs.existsSync(file)) return emptyRegistry();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`registry at ${file} is not valid JSON (${err.message}) — run "codex-homes doctor --fix"`);
  }

  const registry = emptyRegistry();
  registry.active = typeof parsed.active === 'string' ? parsed.active : null;
  if (Array.isArray(parsed.profiles)) {
    for (const entry of parsed.profiles) {
      if (entry && typeof entry.name === 'string') {
        registry.profiles.push({
          name: entry.name,
          created: entry.created ?? null,
          note: entry.note ?? '',
        });
      }
    }
  }
  return registry;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write atomically so an interrupted write cannot corrupt the registry.
 * The temp file carries the pid so two codex-homes processes running side by
 * side never write the same scratch path, and the rename is retried because
 * on Windows a virus scanner holding the target open surfaces as EPERM.
 */
export function save(registry) {
  fs.mkdirSync(root(), { recursive: true });
  const file = registryPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return registry;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') break;
      sleepSync(50 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* nothing left to clean up */
  }
  throw lastError;
}

/**
 * Look a profile up. Falls back to a filesystem-equivalent match so that on
 * Windows `use WORK` finds the profile registered as `work` — the two share one
 * directory there, and reporting "unknown profile" would be a lie.
 */
export function findProfile(registry, name) {
  return (
    registry.profiles.find((p) => p.name === name) ??
    registry.profiles.find((p) => namesEqual(p.name, name)) ??
    null
  );
}

export function addProfile(registry, name, note = '') {
  assertCreatableName(name);
  const existing = findProfile(registry, name);
  if (existing) {
    throw new Error(
      existing.name === name
        ? `profile "${name}" already exists`
        : `profile "${existing.name}" already exists — on this filesystem "${name}" would share its directory`,
    );
  }
  registry.profiles.push({ name, created: new Date().toISOString(), note });
  return registry;
}

export function removeProfile(registry, name) {
  const before = registry.profiles.length;
  registry.profiles = registry.profiles.filter((p) => !namesEqual(p.name, name));
  if (registry.profiles.length === before) {
    throw new Error(`profile "${name}" is not registered`);
  }
  if (namesEqual(registry.active, name)) registry.active = null;
  return registry;
}

/** Profile directories on disk that the registry does not know about. */
export function orphanDirs(registry) {
  const dir = profilesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !registry.profiles.some((p) => namesEqual(p.name, e.name)))
    .map((e) => e.name);
}

/** Registered profiles whose directory is missing on disk. */
export function missingDirs(registry) {
  return registry.profiles.filter((p) => !fs.existsSync(profileDir(p.name))).map((p) => p.name);
}

export { profileDir, path };

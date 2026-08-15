import fs from 'node:fs';
import path from 'node:path';
import { assertValidName, profileDir, profilesDir, registryPath, root } from './paths.js';

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

/** Write atomically so an interrupted write cannot corrupt the registry. */
export function save(registry) {
  fs.mkdirSync(root(), { recursive: true });
  const file = registryPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function findProfile(registry, name) {
  return registry.profiles.find((p) => p.name === name) ?? null;
}

export function addProfile(registry, name, note = '') {
  assertValidName(name);
  if (findProfile(registry, name)) {
    throw new Error(`profile "${name}" already exists`);
  }
  registry.profiles.push({ name, created: new Date().toISOString(), note });
  return registry;
}

export function removeProfile(registry, name) {
  const before = registry.profiles.length;
  registry.profiles = registry.profiles.filter((p) => p.name !== name);
  if (registry.profiles.length === before) {
    throw new Error(`profile "${name}" is not registered`);
  }
  if (registry.active === name) registry.active = null;
  return registry;
}

/** Profile directories on disk that the registry does not know about. */
export function orphanDirs(registry) {
  const dir = profilesDir();
  if (!fs.existsSync(dir)) return [];
  const known = new Set(registry.profiles.map((p) => p.name));
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !known.has(e.name))
    .map((e) => e.name);
}

/** Registered profiles whose directory is missing on disk. */
export function missingDirs(registry) {
  return registry.profiles.filter((p) => !fs.existsSync(profileDir(p.name))).map((p) => p.name);
}

export { profileDir, path };

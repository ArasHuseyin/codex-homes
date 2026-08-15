import os from 'node:os';
import path from 'node:path';

// All paths are resolved lazily so tests (and power users) can redirect them
// via CODEX_HOMES_ROOT / CODEX_HOMES_LINK without reloading the module.

/** Root directory holding the registry, the profiles and the generated shims. */
export function root() {
  return process.env.CODEX_HOMES_ROOT || path.join(os.homedir(), '.codex-homes');
}

/** Directory containing one full CODEX_HOME per profile. */
export function profilesDir() {
  return path.join(root(), 'profiles');
}

/** Absolute path of a single profile's CODEX_HOME. */
export function profileDir(name) {
  return path.join(profilesDir(), name);
}

/** JSON file tracking known profiles and which one is active. */
export function registryPath() {
  return path.join(root(), 'registry.json');
}

/** Directory for the generated per-profile launcher shims. */
export function shimDir() {
  return path.join(root(), 'bin');
}

/**
 * The path Codex itself reads. Normally `~/.codex`; codex-homes turns it into a
 * directory junction (Windows) or symlink (POSIX) pointing at the active profile.
 */
export function codexLink() {
  return process.env.CODEX_HOMES_LINK || path.join(os.homedir(), '.codex');
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Profile names end up as directory names, so reject anything that could escape
 * the profiles directory or collide with the shim generator.
 */
export function assertValidName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid profile name "${name}" — use letters, digits, dot, dash or underscore (max 64 chars, must start alphanumeric)`,
    );
  }
  if (name === '.' || name === '..') {
    throw new Error(`invalid profile name "${name}"`);
  }
  return name;
}

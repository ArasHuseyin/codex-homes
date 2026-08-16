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

/**
 * True where the filesystem treats "Work" and "work" as the same directory.
 * Windows is case-insensitive throughout, and macOS is on the default APFS
 * volume — on both, two profiles differing only in case would share one home.
 */
export const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

/** Compare two names the way `caseInsensitive` says the filesystem would. */
export function sameFsName(a, b, caseInsensitive = caseInsensitiveFs) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // toLowerCase (not toLocaleLowerCase) so a Turkish locale cannot fold "I".
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Compare two profile names the way the local filesystem would. */
export function namesEqual(a, b) {
  return sameFsName(a, b);
}

/**
 * Split a PATH value into usable directories. Windows entries are routinely
 * written with surrounding quotes and stray padding (`"C:\Program Files\x" ;`),
 * which `path.join` would then carry into every lookup.
 */
export function splitPathEntries(value, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return String(value ?? '')
    .split(delimiter)
    .map((entry) => (platform === 'win32' ? entry.trim().replace(/^"(.*)"$/, '$1') : entry))
    .filter(Boolean);
}

/** Normalise a directory so two spellings of the same path compare equal. */
export function normalizeDirKey(dir) {
  const resolved = path.resolve(dir);
  return caseInsensitiveFs ? resolved.toLowerCase() : resolved;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Reserved device names: Windows cannot hold a directory called any of these.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// The shims run `codex`, so a shim called `codex` on PATH would call itself.
const RESERVED_NAMES = ['codex', 'codex-homes', 'cxh'];

/**
 * True for a name whose launcher would shadow the command it calls.
 *
 * Separate from assertCreatableName because the shim generator has to ask the
 * same question about profiles that already exist: versions before this check
 * happily registered a profile called `codex`, and `shims --path` tells POSIX
 * users to *prepend* the shim directory to PATH, which turns that launcher's
 * `exec codex "$@"` into an infinite loop.
 */
export function isReservedName(name) {
  return typeof name === 'string' && RESERVED_NAMES.includes(name.toLowerCase());
}

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

/**
 * The extra rules that only apply when a profile is *created*. Kept apart from
 * assertValidName so a profile created by an older version stays addressable
 * even if its name would be rejected today.
 */
export function assertCreatableName(name) {
  assertValidName(name);
  if (name.endsWith('.')) {
    throw new Error(`invalid profile name "${name}" — a trailing dot cannot be used as a directory name on Windows`);
  }
  if (WINDOWS_DEVICE_NAME.test(name)) {
    throw new Error(`invalid profile name "${name}" — Windows reserves this name for a device`);
  }
  // Compared case-insensitively on every platform, so a profile created on a
  // Mac or Linux box stays usable when the same name reaches Windows.
  if (isReservedName(name)) {
    throw new Error(
      `invalid profile name "${name}" — its launcher would shadow the "${name.toLowerCase()}" command on your PATH`,
    );
  }
  return name;
}

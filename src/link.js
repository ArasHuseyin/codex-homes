import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Inspect a path without following links.
 * @returns {{exists: boolean, isLink: boolean, isDir: boolean, target: string|null}}
 */
export function inspect(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, isLink: false, isDir: false, target: null };
    throw err;
  }

  if (stats.isSymbolicLink()) {
    let resolved = null;
    try {
      resolved = fs.readlinkSync(target);
      // Windows junctions come back with the \\?\ prefix and a trailing slash.
      resolved = resolved.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    } catch {
      /* dangling link */
    }
    return { exists: true, isLink: true, isDir: false, target: resolved };
  }

  return { exists: true, isLink: false, isDir: stats.isDirectory(), target: null };
}

/**
 * Delete a symlink/junction without ever touching the directory it points at.
 * Deliberately avoids recursive removal so a bug here can never eat a profile.
 */
export function removeLink(linkPath) {
  const state = inspect(linkPath);
  if (!state.exists) return false;
  if (!state.isLink) {
    throw new Error(`${linkPath} is a real directory, not a link — refusing to delete it`);
  }
  try {
    fs.unlinkSync(linkPath);
  } catch (err) {
    // Windows directory junctions must be removed with rmdir, not unlink.
    if (err.code === 'EPERM' || err.code === 'EISDIR') {
      fs.rmdirSync(linkPath);
    } else {
      throw err;
    }
  }
  return true;
}

/**
 * Point `linkPath` at `targetPath`, replacing an existing link.
 * Uses a Windows directory junction, which needs no elevated privileges
 * (unlike a true symlink, which requires admin or Developer Mode).
 */
export function setLink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`link target does not exist: ${targetPath}`);
  }
  const state = inspect(linkPath);
  if (state.exists && !state.isLink) {
    throw new Error(
      `${linkPath} is a real directory — run "codex-homes init" first so it can be migrated into a profile`,
    );
  }
  if (state.exists) removeLink(linkPath);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, isWindows ? 'junction' : 'dir');
}

/** True when `linkPath` is a link resolving to `targetPath`. */
export function pointsTo(linkPath, targetPath) {
  const state = inspect(linkPath);
  if (!state.isLink || !state.target) return false;
  try {
    return path.resolve(fs.realpathSync(linkPath)) === path.resolve(fs.realpathSync(targetPath));
  } catch {
    return path.resolve(state.target) === path.resolve(targetPath);
  }
}

/**
 * Move a real directory into the profiles tree, then link the old location to it.
 * Rolls the move back if the link cannot be created, so `~/.codex` is never lost.
 */
export function migrateDirToProfile(sourceDir, profilePath) {
  if (fs.existsSync(profilePath)) {
    throw new Error(`profile directory already exists: ${profilePath}`);
  }
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });

  try {
    fs.renameSync(sourceDir, profilePath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      throw new Error(
        `${sourceDir} and ${profilePath} are on different drives — set CODEX_HOMES_ROOT to a directory on the same drive`,
      );
    }
    throw err;
  }

  try {
    fs.symlinkSync(profilePath, sourceDir, isWindows ? 'junction' : 'dir');
  } catch (err) {
    // Undo the move so the user is left exactly as before.
    try {
      fs.renameSync(profilePath, sourceDir);
    } catch {
      throw new Error(
        `failed to create the link AND failed to roll back. Your Codex home is at ${profilePath} — ` +
          `move it back to ${sourceDir} manually. Original error: ${err.message}`,
      );
    }
    throw new Error(`could not create link at ${sourceDir}: ${err.message}`);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { profileDir, shimDir } from './paths.js';

const isWindows = process.platform === 'win32';

/**
 * Write one launcher per profile so `codex-reserve <args>` runs Codex under that
 * profile without changing the active one.
 * @returns {string[]} the shim files written
 */
export function writeShims(names) {
  const dir = shimDir();
  fs.mkdirSync(dir, { recursive: true });
  const written = [];

  for (const name of names) {
    const home = profileDir(name);
    if (isWindows) {
      const file = path.join(dir, `${name}.cmd`);
      const body = [
        '@echo off',
        'setlocal',
        `set "CODEX_HOME=${home}"`,
        'codex %*',
        'endlocal',
        '',
      ].join('\r\n');
      fs.writeFileSync(file, body, 'utf8');
      written.push(file);
    } else {
      const file = path.join(dir, name);
      const body = ['#!/bin/sh', `CODEX_HOME="${home}"`, 'export CODEX_HOME', 'exec codex "$@"', ''].join('\n');
      fs.writeFileSync(file, body, 'utf8');
      fs.chmodSync(file, 0o755);
      written.push(file);
    }
  }
  return written;
}

/** Remove a profile's launcher if it exists. */
export function removeShim(name) {
  const file = path.join(shimDir(), isWindows ? `${name}.cmd` : name);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** True when the shim directory is already on PATH for this process. */
export function shimDirOnPath() {
  const dir = path.resolve(shimDir());
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => {
      try {
        return path.resolve(entry).toLowerCase() === dir.toLowerCase();
      } catch {
        return false;
      }
    });
}

/**
 * Append the shim directory to the persistent user PATH.
 * Uses PowerShell rather than `setx`, which silently truncates PATH at 1024 chars.
 */
export function addShimDirToUserPath() {
  const dir = shimDir();
  if (!isWindows) {
    return {
      applied: false,
      hint: `add this to your shell profile:\n  export PATH="${dir}:$PATH"`,
    };
  }

  const script = `
$dir = $args[0]
$current = [Environment]::GetEnvironmentVariable('Path','User')
if ($null -eq $current) { $current = '' }
$parts = $current -split ';' | Where-Object { $_ -ne '' }
if ($parts -contains $dir) { Write-Output 'already-present'; exit 0 }
$next = (($parts + $dir) -join ';')
[Environment]::SetEnvironmentVariable('Path', $next, 'User')
Write-Output 'added'
`.trim();

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return {
      applied: out === 'added',
      alreadyPresent: out === 'already-present',
      hint: 'open a new terminal for the PATH change to take effect',
    };
  } catch (err) {
    return {
      applied: false,
      hint: `could not update PATH automatically (${err.message.trim()}). Add manually: ${dir}`,
    };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { isReservedName, normalizeDirKey, profileDir, shimDir, splitPathEntries } from './paths.js';
import { runPowerShell } from './win.js';

const isWindows = process.platform === 'win32';

/** Quote a value for `set "VAR=..."`. Only `%` survives the quotes in cmd. */
function escapeCmdValue(value) {
  return value.replace(/%/g, '%%');
}

/** Quote a value for /bin/sh so `$`, backticks and quotes stay literal. */
function escapeShellValue(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** File name of a profile's launcher on the given platform. */
export function shimFileName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

/**
 * The launcher body for one profile. Pure, so both platforms stay covered by
 * the test suite no matter which one it runs on.
 *
 * The cmd variant uses `call`, because `codex` is itself a .cmd on Windows and
 * batch files chain rather than return without it — `endlocal` would never run
 * and the exit code would leak from whichever script happened to finish last.
 */
export function shimBody(homeDir, platform = process.platform) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      `set "CODEX_HOME=${escapeCmdValue(homeDir)}"`,
      'call codex %*',
      'endlocal & exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `CODEX_HOME=${escapeShellValue(homeDir)}`,
    'export CODEX_HOME',
    'exec codex "$@"',
    '',
  ].join('\n');
}

/** The registered names that cannot be given a launcher, in registry order. */
export function unshimmable(names) {
  return names.filter((name) => isReservedName(name));
}

/** True when a launcher for `name` exists on disk. */
export function shimExists(name) {
  return fs.existsSync(path.join(shimDir(), shimFileName(name)));
}

/**
 * Write one launcher per profile so `codex-reserve <args>` runs Codex under that
 * profile without changing the active one. Because each launcher pins
 * CODEX_HOME for its own process only, several of them can run at the same time.
 *
 * Reserved names are skipped *and* actively cleaned up: a profile called `codex`
 * registered before that name was rejected already has a launcher on disk whose
 * `codex` call resolves straight back to itself once the shim directory is on
 * PATH. Removing it here means every path that regenerates shims — init, add,
 * shims, doctor --fix — heals that loop rather than recreating it.
 * @returns {string[]} the shim files written
 */
export function writeShims(names) {
  const dir = shimDir();
  fs.mkdirSync(dir, { recursive: true });
  const written = [];

  for (const name of names) {
    if (isReservedName(name)) {
      removeShim(name);
      continue;
    }
    const file = path.join(dir, shimFileName(name));
    fs.writeFileSync(file, shimBody(profileDir(name)), 'utf8');
    if (!isWindows) fs.chmodSync(file, 0o755);
    written.push(file);
  }
  return written;
}

/** Remove a profile's launcher if it exists. */
export function removeShim(name) {
  try {
    fs.unlinkSync(path.join(shimDir(), shimFileName(name)));
    return true;
  } catch {
    return false;
  }
}

/** True when the shim directory is already on PATH for this process. */
export function shimDirOnPath() {
  const dir = normalizeDirKey(shimDir());
  return splitPathEntries(process.env.PATH).some((entry) => {
    try {
      return normalizeDirKey(entry) === dir;
    } catch {
      return false;
    }
  });
}

/**
 * PowerShell that appends `dir` to the persistent user PATH.
 *
 * Deliberately goes through the registry rather than
 * [Environment]::SetEnvironmentVariable('Path', ...): that call reads the value
 * already expanded and writes it back as a plain string, which silently turns
 * an existing `%USERPROFILE%\bin` entry into a frozen absolute path.
 */
export function buildUserPathScript(dir) {
  const literal = `'${dir.replace(/'/g, "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
$dir = ${literal}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
try {
  $raw = ''
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $key.GetValueKind('Path')
  }
  $parts = @($raw -split ';' | Where-Object { $_.Trim() -ne '' })
  foreach ($part in $parts) {
    if ($part.TrimEnd('\\') -ieq $dir.TrimEnd('\\')) { Write-Output 'already-present'; exit 0 }
  }
  $key.SetValue('Path', (($parts + $dir) -join ';'), $kind)
} finally {
  if ($key) { $key.Close() }
}
try { [Environment]::SetEnvironmentVariable('CODEX_HOMES_REFRESH', $null, 'User') } catch { }
Write-Output 'added'
`.trim();
}

/** Append the shim directory to the persistent user PATH. */
export function addShimDirToUserPath() {
  const dir = shimDir();
  if (!isWindows) {
    return {
      applied: false,
      hint: `add this to your shell profile:\n  export PATH="${dir}:$PATH"`,
    };
  }

  try {
    const out = runPowerShell(buildUserPathScript(dir));
    if (out === 'already-present') return { applied: false, alreadyPresent: true, hint: '' };
    if (out === 'added') {
      return { applied: true, hint: 'open a new terminal for the PATH change to take effect' };
    }
    return { applied: false, hint: `PowerShell returned "${out}" — add ${dir} to your PATH manually` };
  } catch (err) {
    return {
      applied: false,
      hint: `could not update PATH automatically (${err.message}). Add this directory manually: ${dir}`,
    };
  }
}

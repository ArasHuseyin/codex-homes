import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { splitPathEntries } from './paths.js';
import { runPowerShell } from './win.js';

const isWindows = process.platform === 'win32';

/** Resolve an executable through PATH (honouring PATHEXT on Windows). */
export function resolveExecutable(name) {
  const dirs = splitPathEntries(process.env.PATH);
  const exts = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Quote a single argument for cmd.exe with windowsVerbatimArguments. */
export function quoteForCmd(arg) {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Build the `/c` payload for cmd.exe.
 *
 * With `/s`, cmd.exe strips the first and last character of the payload when
 * both are quotes. Wrapping the whole command in an extra pair therefore keeps
 * a quoted executable path (e.g. "C:\Program Files\...") intact — without it
 * cmd splits on the space and fails with 'C:\Program' is not recognized.
 */
export function buildCmdPayload(exe, args) {
  const inner = [quoteForCmd(exe), ...args.map(quoteForCmd)].join(' ');
  return `"${inner}"`;
}

/**
 * Run the real `codex` binary with CODEX_HOME pointed at `homeDir`.
 * Resolves .cmd shims through cmd.exe because Node refuses to spawn them directly.
 *
 * CODEX_HOME is set on the child only, so any number of these can run at once,
 * each pinned to its own profile regardless of which one is currently active.
 * @returns {Promise<number>} the child's exit code
 */
export function runCodex(args, homeDir, extraEnv = {}) {
  const exe = resolveExecutable('codex');
  if (!exe) {
    return Promise.reject(
      new Error('could not find "codex" on your PATH — install it with: npm i -g @openai/codex'),
    );
  }

  const env = { ...process.env, ...extraEnv, CODEX_HOME: homeDir };
  const isBatch = /\.(cmd|bat)$/i.test(exe);

  const child = isBatch
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', buildCmdPayload(exe, args)], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true,
      })
    : spawn(exe, args, { stdio: 'inherit', env });

  return new Promise((resolve, reject) => {
    const forward = (signal) => {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map((sig) => {
      const handler = () => forward(sig);
      process.on(sig, handler);
      return [sig, handler];
    });

    const cleanup = () => {
      for (const [sig, handler] of handlers) process.off(sig, handler);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

/**
 * Matches any node process whose command line mentions codex — the npm build of
 * Codex runs as `node .../codex/bin/codex.js`, so the image name gives nothing away.
 *
 * codex-homes is itself such a process ("codex-homes" contains "codex"), and so is
 * the npx/npm wrapper that may have launched it, so the walk up the parent chain is
 * what keeps the probe from always reporting yes and turning every `use` into a
 * refused switch. The PID has to be substituted in rather than read from `$PID`,
 * which inside the script is PowerShell's own process, not ours.
 *
 * Used only to warn before a switch, so a false negative costs a warning, never data.
 */
export function buildNodeCodexProbe(selfPid) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$mine = @{}
$id = ${Number(selfPid)}
for ($i = 0; $i -lt 16 -and $id -gt 0 -and -not $mine.ContainsKey($id); $i++) {
  $mine[$id] = $true
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if ($null -eq $p) { break }
  $id = [int]$p.ParentProcessId
}
$hit = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { -not $mine.ContainsKey([int]$_.ProcessId) -and $_.CommandLine -like '*codex*' } |
  Select-Object -First 1
if ($hit) { Write-Output 'yes' } else { Write-Output 'no' }
`.trim();
}

function windowsCodexRunning() {
  let listing;
  try {
    // One CSV listing instead of a name filter: tasklist filters cannot match a
    // wildcard, and the native build is called codex-<target>.exe, not codex.exe.
    listing = execFileSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
  } catch {
    return false;
  }

  if (/^"codex[^"]*\.exe"/im.test(listing)) return true;
  // The npm build runs inside node, where only the command line gives it away.
  // Skipped unless a node process exists at all, so the usual case stays cheap.
  if (!/^"node\.exe"/im.test(listing)) return false;
  try {
    return runPowerShell(buildNodeCodexProbe(process.pid), 8000) === 'yes';
  } catch {
    return false;
  }
}

/** Best-effort check whether a Codex process is currently running. */
export function codexIsRunning() {
  if (isWindows) return windowsCodexRunning();
  try {
    const out = execFileSync('pgrep', ['-x', 'codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // pgrep exits non-zero when nothing matches.
    return false;
  }
}

/** Version string of the installed codex CLI, or null. */
export function codexVersion() {
  const exe = resolveExecutable('codex');
  if (!exe) return null;
  try {
    const isBatch = /\.(cmd|bat)$/i.test(exe);
    const out = isBatch
      ? execFileSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', buildCmdPayload(exe, ['--version'])],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            // Without this Node re-quotes the /c payload and cmd.exe mis-parses it.
            windowsVerbatimArguments: true,
          },
        )
      : execFileSync(exe, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

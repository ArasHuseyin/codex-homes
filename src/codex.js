import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/** Resolve an executable through PATH (honouring PATHEXT on Windows). */
export function resolveExecutable(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
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
function quoteForCmd(arg) {
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
function buildCmdPayload(exe, args) {
  const inner = [quoteForCmd(exe), ...args.map(quoteForCmd)].join(' ');
  return `"${inner}"`;
}

/**
 * Run the real `codex` binary with CODEX_HOME pointed at `homeDir`.
 * Resolves .cmd shims through cmd.exe because Node refuses to spawn them directly.
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
    for (const sig of signals) process.on(sig, () => forward(sig));

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      for (const sig of signals) process.removeAllListeners(sig);
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

/** Best-effort check whether a Codex process is currently running. */
export function codexIsRunning() {
  try {
    if (isWindows) {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq codex.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /codex\.exe/i.test(out);
    }
    const out = execFileSync('pgrep', ['-x', 'codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // pgrep exits non-zero when nothing matches; tasklist may be unavailable.
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

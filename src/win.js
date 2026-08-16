import { execFileSync } from 'node:child_process';

/**
 * Run a PowerShell script and return its trimmed stdout.
 *
 * The script goes in as -EncodedCommand on purpose: with `-Command <string>`
 * PowerShell appends every following argument to the command *text* rather than
 * binding it to `$args` (that only happens with -File), so a script written to
 * read `$args[0]` silently receives nothing.
 *
 * @param {string} script PowerShell source
 * @param {number} timeout milliseconds before the interpreter is killed
 */
export function runPowerShell(script, timeout = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  let lastError;

  for (const exe of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
    try {
      return execFileSync(exe, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }).trim();
    } catch (err) {
      lastError = err;
      // Keep looking only while the interpreter itself is the thing missing.
      if (err.code !== 'ENOENT') break;
    }
  }

  const detail = String(lastError?.stderr || lastError?.message || lastError).trim();
  throw new Error(detail.split('\n')[0] || 'powershell failed');
}

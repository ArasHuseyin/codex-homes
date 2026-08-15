#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`codex-homes: ${message}\n`);
    if (process.env.CODEX_HOMES_DEBUG && err && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  },
);

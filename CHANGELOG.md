# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-16

Windows on locked-down machines, and a help system that documents the program
instead of describing it.

### Added

- `help` renders a page per command from a single command reference: the flags
  each handler actually reads, what they do, examples and related commands.
  Available as `codex-homes help <command>` and `codex-homes <command> --help`;
  `help --all` prints everything at once and the overview stays one screen.
- Three guides for what no single command owns: `getting-started`, `parallel`
  (two accounts in two terminals) and `no-link`.
- No-link mode (`init --no-link`): `~/.codex` is left untouched and the profile
  is selected per command, for machines that cannot host a junction or symlink.
  `run` and the shims keep working, since each pins `CODEX_HOME` to its own
  process. Re-running `init` later upgrades a no-link setup to link mode.
- Tests for the shim bodies, the PATH script, cmd quoting, PATH parsing, name
  rules, link-failure reporting and the registry — the two files carrying the
  Windows-only logic previously had no coverage.

### Changed

- Profile names are compared the way the filesystem compares them, so `Work`
  and `work` are one profile; lookups resolve to the registered spelling and
  every command uses that canonical name from there on.
- Creation rejects reserved device names (`CON`, `LPT1`, …), trailing dots and
  `codex`, whose launcher would sit on `PATH` and call itself.
- `init` explains why a junction is impossible and falls back to no-link mode
  instead of failing and leaving nothing behind.
- Registry writes use a pid-scoped temp file and retry the rename, so two
  sessions writing at once cannot collide and a scanner holding the file open
  is not fatal.
- `doctor` checks launchers for staleness and exits non-zero when problems
  remain after `--fix` rather than reporting success.

### Fixed

- `shims --path` never extended `PATH`. The directory was passed as a trailing
  argument to `powershell -Command`, which appends it to the command text
  instead of binding it to `$args`, so the script wrote an empty entry while
  reporting success. It now goes in via `-EncodedCommand`, writes through the
  registry and keeps the existing value kind, so an existing
  `%USERPROFILE%\bin` entry is not frozen into an absolute path.
- The Windows running-process probe matched codex-homes' own node process —
  `codex-homes` contains `codex` — so every `use` warned and then aborted off a
  TTY. The probe now walks up from our own pid and skips that chain.
- `init`'s placeholder cleanup removed a registered profile's directory when
  `config.toml` was its only entry, destroying a hand-edited config. Only a
  byte-identical copy of the config being migrated counts as a placeholder now,
  and the decision moves ahead of the printed Plan.
- The reserved-name guard only ran at creation, so a `codex` profile from
  v0.1.0 kept its self-calling launcher — an infinite loop once the shim
  directory goes on the front of `PATH`. `writeShims` now skips those names and
  deletes the launcher.
- `setLink` deleted the existing link before the replacement could fail,
  leaving `~/.codex` nonexistent when a symlink was refused. It now builds the
  replacement beside the old link and swaps it in.
- Launchers `call codex` and forward its exit code; without `call`, batch files
  chain and `endlocal` never runs. Percent signs in the profile path are
  escaped and the POSIX variant quotes the path.
- `PATH` lookup unwraps quoted entries, so a quoted `"C:\Program Files\..."`
  entry no longer hides codex.
- The running-Codex check matches `codex*.exe` rather than only `codex.exe` and
  falls back to inspecting node command lines.
- A damaged `registry.json` made every command fail with an error telling the
  user to run `doctor --fix` — including `doctor --fix`, which read the same
  file. Doctor now reads the registry tolerantly, moves a damaged one aside as
  `registry.json.corrupt` and re-registers the profile directories on disk.
- `doctor --fix` restores the active profile from where the link points, so a
  registry rebuilt from disk does not leave the setup in link mode with no
  active profile. `doctor` no longer reports that the link "points at the
  active profile" when there is no active profile at all.
- The `init` next-step lines aligned their descriptions with padding written
  into the string, which only fitted the default profile names — `--main` and
  `--reserve` pushed the columns apart. The column is measured now.

## [0.1.0] - 2026-08-15

Initial release.

### Added

- Account switching via fully isolated `CODEX_HOME` profiles under
  `~/.codex-homes/profiles/<name>` — each profile keeps its own `auth.json`,
  `config.toml`, `sessions/`, `history.jsonl`, MCP configuration and skills.
- `~/.codex` becomes a directory junction (Windows) or symlink (macOS/Linux) to
  the active profile, so a switch takes effect immediately in every shell and
  IDE without shell integration or elevated privileges.
- `init` — migrate an existing `~/.codex` into a profile, with rollback if
  linking fails.
- `list` / `ls` — show profiles, accounts and plans (`--json` for scripting).
- `use` / `switch` — make a profile active everywhere.
- `run` — run codex once under a profile via `CODEX_HOME`, so two accounts can
  be used side by side.
- `login` / `logout` — run `codex login` / `codex logout` inside a profile.
- `add` / `new` (`--from`, `--note`) and `remove` / `rm` (`--purge`).
- `config-sync` — copy `config.toml` between profiles.
- `shims [--path]` — per-profile launchers, optionally added to the user PATH.
- `status` — active profile, link health and codex version.
- `doctor [--fix]` — detect a stray `CODEX_HOME` env var, broken links and
  orphaned profile directories.
- `restore` — turn `~/.codex` back into a plain directory.
- `path` — print a profile's `CODEX_HOME` directory.
- `CODEX_HOMES_ROOT`, `CODEX_HOMES_LINK`, `CODEX_HOMES_DEBUG` and `NO_COLOR`
  environment variables.
- Test suite on `node:test`, running entirely against temporary directories.
- CI across Ubuntu / Windows / macOS on Node 18, 20 and 22.

### Security

- No runtime dependencies and no network requests.
- Tokens are never printed; `auth.json` is read only to display account, plan
  and expiry, and the `id_token` payload is decoded locally.

[Unreleased]: https://github.com/ArasHuseyin/codex-homes/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ArasHuseyin/codex-homes/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ArasHuseyin/codex-homes/releases/tag/v0.1.0

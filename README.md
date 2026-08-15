# codex-homes

[![tests](https://github.com/ArasHuseyin/codex-homes/actions/workflows/ci.yml/badge.svg)](https://github.com/ArasHuseyin/codex-homes/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/codex-homes)](https://www.npmjs.com/package/codex-homes)
[![license](https://img.shields.io/npm/l/codex-homes)](./LICENSE)

Switch between multiple Codex / ChatGPT accounts using **fully isolated `CODEX_HOME` profiles**.

Built for the common case of a work machine that is logged into a company ChatGPT account
where you also want to use your personal one — without re-running `codex login` every time.

```
$ codex-homes list

   PROFILE        ACCOUNT                PLAN      STATE
*  codex-main     you@company.com        business  logged in
   codex-reserve  you@personal.com       plus      logged in

codex home  C:\Users\you\.codex -> C:\Users\you\.codex-homes\profiles\codex-main
```

## Why another one?

The existing tools ([`codex-profiles`](https://www.npmjs.com/package/codex-profiles),
[`codex-account`](https://www.npmjs.com/package/codex-account)) swap `auth.json` in and out of a
single `~/.codex`. That works, but all accounts then share one config, one session history and one
set of memories — and only one account can be active at a time.

`codex-homes` takes the other approach: **each account gets its own complete `CODEX_HOME`**.

|                                   | auth.json swapping | codex-homes |
| --------------------------------- | ------------------ | ----------- |
| Separate login                    | yes                | yes         |
| Separate `config.toml`            | no                 | yes         |
| Separate sessions / history       | no                 | yes         |
| Separate MCP servers, skills      | no                 | yes         |
| Both accounts usable side by side | no                 | yes         |
| Refresh-token rotation hazards    | possible           | none        |

If you *want* a shared history and only need the identity swapped, `codex-profiles` is the simpler
choice. Use `codex-homes` when you want the two accounts to stay genuinely separate.

## Install

```sh
npm install -g codex-homes
```

Requires Node.js 18.17+ and the [Codex CLI](https://www.npmjs.com/package/@openai/codex) on your PATH.

## Quick start

```sh
codex-homes init                    # migrate the existing ~/.codex into a profile
codex-homes use codex-reserve       # switch to the second (empty) profile
codex login                         # log in with your other account
codex-homes use codex-main          # switch back
codex-homes list                    # see who is who
```

`init` is the only step that touches existing data, and it shows you exactly what it will do
before doing it.

## How it works

Profiles live in `~/.codex-homes/profiles/<name>`. Each one is a complete `CODEX_HOME`:
its own `auth.json`, `config.toml`, `sessions/`, `history.jsonl`, MCP configuration and skills.

`~/.codex` becomes a **directory junction** (Windows) or **symlink** (macOS/Linux) pointing at the
active profile:

```
~/.codex  ──►  ~/.codex-homes/profiles/codex-main
                                        codex-reserve
```

Two consequences that matter:

- **A switch is instant and global.** Every shell, editor and IDE that runs `codex` follows the
  link — no environment variables, no shell integration, no reopening terminals.
- **No elevated privileges needed.** Windows directory junctions do not require admin rights or
  Developer Mode, unlike true symlinks.

For one-off use without switching, `run` sets `CODEX_HOME` for a single invocation, so both
accounts can be used at the same time in two terminals:

```sh
codex-homes run codex-reserve -- "review this diff"
```

## Commands

| Command                        | Description                                                |
| ------------------------------ | ---------------------------------------------------------- |
| `init`                         | Migrate `~/.codex` into a profile and create the link       |
| `list` (`ls`)                  | Show profiles, accounts and plans (`--json` for scripting)  |
| `use <profile>`                | Make a profile active everywhere                            |
| `run <profile> [args...]`      | Run codex once under a profile, without switching           |
| `login` / `logout <profile>`   | Run `codex login` / `codex logout` inside a profile         |
| `add <profile>`                | Create a profile (`--from <profile>` copies `config.toml`)  |
| `remove <profile>`             | Unregister a profile (`--purge` also deletes its files)     |
| `config-sync <from> [to...]`   | Copy `config.toml` between profiles                         |
| `shims [--path]`               | Generate `codex-main` / `codex-reserve` launchers           |
| `status`                       | Active profile, link health, codex version                  |
| `doctor [--fix]`               | Diagnose and repair the setup                               |
| `restore [profile]`            | Undo everything: `~/.codex` becomes a real directory again  |
| `path [profile]`               | Print a profile's `CODEX_HOME` directory                    |

Profile names are yours to choose; `init` defaults to `codex-main` and `codex-reserve`
(`--main` / `--reserve` override them).

### Shims

`codex-homes shims --path` writes a small launcher per profile into `~/.codex-homes/bin` and adds
that directory to your user PATH. You then get one command per account:

```sh
codex-reserve "explain this repo"   # runs codex under the reserve profile
```

## Gotchas

**A `CODEX_HOME` variable set in your environment wins over everything.** If you exported it at
some point, Codex will use that path and ignore the link entirely. `list`, `status` and `doctor`
all warn about this — unset it to let `codex-homes` do its job.

**Close Codex before switching.** A running session holds state; `use` and `init` warn when they
detect a running `codex` process.

**Profiles must live on the same drive as `~/.codex`.** `init` moves the directory rather than
copying it. Set `CODEX_HOMES_ROOT` to a path on the same volume if your home directory is unusual.

## Leaving

```sh
codex-homes restore codex-main
```

turns `~/.codex` back into an ordinary directory containing that profile's account. Remaining
profiles stay in `~/.codex-homes/profiles/` and can be moved or deleted by hand. Then
`npm uninstall -g codex-homes`.

## Security notes

- `codex-homes` makes **no network requests** and has **zero runtime dependencies**.
- It never prints tokens. `auth.json` is read only to show the account email, plan and expiry; the
  `id_token` payload is base64-decoded locally for display and never sent anywhere.
- Profile directories contain OAuth refresh tokens in plain text, exactly as Codex stores them.
  Keep `~/.codex-homes` out of any synced or backed-up folder you do not control.

## Environment variables

| Variable            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `CODEX_HOMES_ROOT`  | Override `~/.codex-homes`                                    |
| `CODEX_HOMES_LINK`  | Override the managed `~/.codex` path (used by the test suite) |
| `CODEX_HOMES_DEBUG` | Print stack traces on error                                  |
| `NO_COLOR`          | Disable coloured output                                      |

## Development

```sh
npm test          # node:test, no dependencies
```

The test suite runs entirely against temporary directories via `CODEX_HOMES_ROOT` /
`CODEX_HOMES_LINK` and never touches a real `~/.codex`.

## License

MIT

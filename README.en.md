# magpie-agent-codex-cli

Repository: https://gitee.com/mengdj/magpie-agent-codexcli

Connects the **Codex CLI** (`codex` TUI and `codex exec`) to magpie's Agents page:
pick a model for the Codex CLI row in magpie, then run `codex-magpie` from your
terminal and the requests go through magpie's gateway using the subscription
you are already logged into.

> Full usage instructions live in [docs/使用说明.md](docs/使用说明.md):
> installation steps, command reference, the two integration modes, how model
> changes are kept in sync, FAQ, and platform differences.

## Why not write config.toml directly

magpie's agent plugins can only write model and connection info into
**JSON / YAML / ENV** files. Codex CLI's config is **TOML**
(`~/.codex/config.toml`), and magpie rejects that:

```
agent.format "toml": json, yaml or env
```

So this plugin does the conversion and the backup/restore itself:

```
magpie ──(can write)──> ~/.codex/magpie-codex-cli.env   CODEX_MODEL / CODEX_BASE_URL / CODEX_API_KEY
                               │
                               │  plugin converts
                               ▼
              codex-magpie  ──>  codex -c model=... -c model_providers.magpie.base_url=...
```

magpie owns the env file (model selection, account switching, restoring the
lines wholesale when the row is turned off); the plugin turns that into
something Codex understands.

## Installation

```bash
magpie plugin add ./magpie-agent-codexcli
# or
magpie plugin add git+https://gitee.com/mengdj/magpie-agent-codexcli.git
```

After installation magpie's **Agents** page gets a `Codex CLI` row; on the
command line you can also see it:

The row has its own icon: a dark terminal background, a white `>` prompt and a
green cursor, matching the Codex CLI console. The icon is an inline SVG (from
`icon.svg`, stored as a data URI in `package.json` under `magpie.icon`); it
needs no network and no external link. magpie stores it as
`~/.config/magpie/icons/<hash>.svg`.

```bash
magpie ls                 # lists the Codex CLI row
magpie codex-cli auto/hy3 # pick a model for it
```

### Put codex-magpie on PATH

`magpie plugin add` does **not** run npm install and does **not** create a
global command (it only registers the plugin with magpie itself). To get a
command you can type directly in your terminal, run this once:

```bash
node bin/setup.mjs              # writes a few shims into npm's global bin dir
node bin/setup.mjs --uninstall  # deletes only the files it wrote
node bin/setup.mjs --print-dir  # just shows where they would go
```

This does **not** add the package to the global npm registry listing
(`npm ls -g` will not show it). It just drops three tiny forwarding files
(`codex-magpie` / `codex-magpie.cmd` / `codex-magpie.ps1`) that point to this
directory's `bin/codex-magpie.mjs`; if you move the directory, run it again.

You can also skip installation and call it directly:

```powershell
node D:\magpie\magpie-agent-codexcli\bin\codex-magpie.mjs
```

## Usage

```bash
codex-magpie                # open the Codex interactive console on magpie's model
codex-magpie exec "..."     # non-interactive; arguments pass through to codex
codex-magpie status         # what magpie picked and what Codex currently reads
codex-magpie install        # write into config.toml (journaled, restorable)
codex-magpie restore        # restore config.toml from the journal
codex-magpie which          # print the actual codex executable that would run
```

### Everything else is passed through as-is

Only the 5 subcommands above are recognized. Any other argument is appended
after magpie's `-c` args and handed to codex, so all of codex's own flags work:

```bash
codex-magpie --yolo                 # same as codex --yolo, but via magpie's model
codex-magpie resume --last
codex-magpie exec --skip-git-repo-check "run the tests"
codex-magpie -m auto/deepseek-v4.1-flash   # temporarily use another magpie model
```

Arguments with spaces and quotes are preserved intact (on Windows the `.cmd`
wrapper re-quotes them when it goes through the shell). Your own `-c` / `-m`
come last and override the injected values, which is handy for experiments.

### Switching models on either side is not overwritten

There are two places to change the model: the magpie Agents page, and Codex's
own `/model`. The plugin decides **whoever changed last wins** (comparing
mtime between `magpie-codex-cli.env` and `config.toml`) and syncs the result to
the other side, so "I changed a model and next launch it reverted" cannot
happen:

```
in magpie ──> env updates ──> on launch, config.toml model is aligned too
in TUI /model and Enter ──> config.toml updates ──> on launch, env is updated, Agents page follows
```

The launcher prints one line when a sync happens, and `codex-magpie status`
shows `in effect <model> (<who wins>)`. Note: in the TUI `/model` picker,
pressing `s` only affects the current session; press Enter to write the default.

### Default: no file changes

`codex-magpie` starts Codex with `-c key=value` overrides and never touches
`config.toml`, so going back is simply typing `codex`. This is the recommended
way.

```bash
codex-magpie                      # via magpie
codex                             # still your original config
```

### Optional: write into config.toml

Some setups (IDE plugins, `codex app-server`, or other tools that start codex
for you) cannot see command-line arguments. In those cases use `install`:

```bash
codex-magpie install
codex-magpie status
codex-magpie restore
```

`install` only changes the 6 keys this plugin owns; everything else, comments
and ordering is preserved:

| Key | Value |
|---|---|
| `model` | model selected in magpie |
| `model_provider` | `magpie` |
| `model_providers.magpie.name` | `magpie` |
| `model_providers.magpie.base_url` | gateway `/v1` address |
| `model_providers.magpie.wire_api` | `responses` |
| `model_providers.magpie.experimental_bearer_token` | this agent's gateway key |

Before writing, it records every original value (including trailing comments)
into `~/.codex/magpie-codex-cli.journal.json`; `restore` puts each line back
from the journal and deletes keys that did not exist before, so it restores
byte-for-byte.

## Environment variables

| Variable | Purpose |
|---|---|
| `CODEX_HOME` | Codex config directory, default `~/.codex` (same as Codex CLI) |
| `CODEX_MAGPIE_CODEX` | specify the codex executable to call; default is found on PATH |

## Conventions

- It does not modify the Codex binary nor proxy its requests: `codex-magpie`
  just passes magpie's model and gateway to Codex in Codex's own way; Codex
  sends requests straight to the magpie gateway.
- `install` only recognizes the keys it wrote; other settings you change by
  hand are not affected by `restore`.
- Every request is billed to the key of that agent, so magpie's Usage page can
  distinguish `Codex CLI`.
- To change models, change it on the magpie Agents page or run
  `magpie codex-cli <provider>/<model>`; `codex-magpie` re-reads on every
  launch, no reinstall needed.

## Platforms

Windows, Linux and macOS are supported with **no extra dependencies** (just
Node 18+ and a working `codex`).

| Item | Windows | Linux / macOS |
|---|---|---|
| Find `codex` | `codex.exe` → `codex.cmd` → `codex.bat` → `codex` | first `codex` on PATH (excluding this plugin's shim) |
| Launch | `.cmd`/`.bat` via shell, others direct spawn | direct spawn, no shell |
| Ctrl-C | forwards `SIGINT` to child | same, returns `128+N` (130/143/129) |
| `setup.mjs` target | `npm prefix -g` (usually `%APPDATA%\npm`) | `npm prefix -g` + `/bin`; falls back to `~/.local/bin` |
| Generated shims | `codex-magpie` + `.cmd` + `.ps1` | a single `codex-magpie` (`0755`) |

`~` expansion comes from `os.homedir()`; `CODEX_HOME` matches Codex CLI itself,
so `~/.codex` resolves correctly on all three platforms. TOML handling is
implemented in-repo and preserves `\n`/`\r\n` line style.

Known difference: on Windows `process.kill(pid, 'SIGTERM')` maps to
`TerminateProcess`, so the exit code is `1` instead of `143`; that is only an
echo difference and the process does not hang.

---

## Sponsor

[Aliyun OSS promotional offer](https://dashi.aliyun.com/activity/oss?userCode=8ub608qu) — new and existing customers can renew at the same price; OSS from 118.99 yuan/year.

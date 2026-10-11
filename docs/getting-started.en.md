# Getting Started

[Documentation index](README.md) · [简体中文](getting-started.md)

## Prerequisites

- Node.js `^22.19 || >=24`; CI uses Node 24.
- The official DeepSeek Harness CLI: `@deepseek-ai/dsh`.
- `pnpm` **10 or newer** (CI uses 11). `dsh plugin` delegates profile
  installation to pnpm; pnpm 9 hoists transitive dependencies differently,
  leaving `dsh-working-activity` unresolvable inside the profile — the TUI
  then exits right after startup with almost no error output (issue #60, see
  Troubleshooting below).
- An interactive terminal TTY. `dsh-cli` cannot start with stdout redirected.
- `DEEPSEEK_API_KEY`. Set `DEEPSEEK_BASE_URL` as well when using a compatible
  custom endpoint.

macOS/Linux:

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

Never commit a real credential. A normal profile launch reads the environment
variable directly.

## Install

```sh
# Install the official CLI
npm install -g @deepseek-ai/dsh

# Install pnpm if needed (or use: corepack enable pnpm)
npm install -g pnpm

# Add dsh-cli to the dsh-cli profile
dsh plugin --profile dsh-cli add @askdkc/dsh-cli
```

From a checkout, the repository helper wraps the profile command:

```sh
sh install.sh /path/to/askdkc-dsh-cli-<version>.tgz
```

`install.sh` checks for `dsh` and `pnpm` and installs the specified tarball through
the profile plugin command. It does not copy source files.

## Optional Kiokuko Lisp workflow

Install Kiokuko into the **same** profile as dsh-cli:

```sh
dsh plugin --profile dsh-cli add github:askdkc/kiokuko-dsh
```

In the profile's patch, configure the existing `kiokuko-dsh` row, then restart:

```yaml
- id: kiokuko-dsh
  config:
    enabled: true
    lisp:
      enabled: true
      sbclPath: sbcl
    typedDecisions:
      mode: auto
      provider: typesafe
      typesafe:
        model: jev-latest
```

A working SBCL is required; Linux also requires Bubblewrap with namespaces
available. Configure Jev's credentials through Kiokuko, or select and configure
an already-running Laya worker as described in
[Kiokuko's decision guide](https://github.com/askdkc/kiokuko-dsh/blob/main/docs/typed-decisions.md).
No runtime or worker is installed automatically.

Enter a normal request such as `検索機能を実装して`. When Jev/Laya accepts a
coding classification, the existing question panel asks whether to use Lisp.
Choose **Lispモードを使う（通常実行）**, **Lispモードを使わない**, or
**取消・作業を保持**. Coding starts only after an answered choice and successful
startup. Free text is a discussion or correction. Enable/decline is retained
within the session; later turns do not repeat the question. Ambiguous requests
retain the ordinary intake questions.

`/kioku-lisp` (status), `status`, `diagnostics`, `hot`, `cancel`, and `recover`
run through the command handler even while the model is working. To stop a Lisp
operation, enter `/kioku-lisp cancel`; recover explicitly with `/kioku-lisp recover`.
`enable`, `enable-task`, `disable`, `abandon`, and `restore` wait until the current
turn finishes; their drafts remain editable. Keyboard send, completion click,
and the expanded editor follow the same rules. Manual `/kioku-lisp enable` is
also available. File changes still require Kiokuko's approval flow.

Both packages must contain this integration change. A GitHub install reads
committed source; it cannot install uncommitted local edits.

## Migrate from the former package

Earlier releases used the unscoped `dsh-cc-tui` package and a `cc-tui` profile:

- `CC_TUI_*`/`DSH_CC_*` environment variables.
- a `~/.dsh-cc` data directory.

This fork uses `dsh-cli` in a `dsh-cli` profile, with `DSH_CLI_*` variables
and the `~/.dsh-cli` data directory.

If that profile already contains `@deepseek-harness-tui/dsh-cli`, remove the
old package before adding `dsh-cli`; `plugin update` does not rename a package:

```sh
dsh plugin --profile dsh-cli remove @deepseek-harness-tui/dsh-cli
```

Install `dsh-cli` with:

```sh
dsh plugin --profile dsh-cli add @askdkc/dsh-cli
dsh --profile dsh-cli
```

The current release no longer reads the old names and does not migrate data
automatically. After first launch, copy themes, configuration and history
files from the old data directory (`~/.dsh-cc`) into `~/.dsh-cli` yourself.

Once the new profile works:

- `$DSH_HOME/profiles/cc-tui` and the old data directory are just
  former-installation leftovers and may be removed when convenient.
- Do not add both packages to the same profile.

## What installation does

On the first `dsh plugin --profile dsh-cli add @askdkc/dsh-cli`, the official CLI:

1. Initializes `$DSH_HOME/profiles/dsh-cli/`. When `DSH_HOME` is unset, the
   default root is normally `~/.dsh`.
2. Uses `@deepseek-ai/dsh-base` as the first profile bundle.
3. Installs `dsh-cli` inside the profile with pnpm.
4. Reads the package's `dsh.bundle.patch` metadata and adds its
   `cordis.patch.yml` as a composition layer.

The important startup order is:

```text
dsh-base -> other bundles -> dsh-cli patch -> user profile patch
```

- The base supplies agent, model, session, filesystem, shell, policy, and
  registry services.
- The plugin patch overrides or inserts the TUI, agent-preset roster, SQLite
  session persistence, and live activity row.

`dsh-working-activity` is already a dependency of this package and is inserted
by the `dsh-cli` patch. Do not separately add `dsh-working-activity` to the
same profile or duplicate rows may be mounted.

## Start the TUI

```sh
dsh --profile dsh-cli
```

The process starts in the current directory, which is also the Agent's default
workspace. Change into the target project before starting it.

On Windows, the checkout also provides:

```bat
dsh-cli.cmd
dsh-cli.cmd --resume
```

- `--resume` reads `%USERPROFILE%\.dsh-cli\resume.txt` and restores the
  session last selected by the TUI.
- Set `DSH_CLI_WORKSPACE` to override the working directory used by the batch
  launcher.

## CLI subcommands

`dsh-cli help` (or `dst help`) prints the full usage; the `dst` alias accepts
the same commands:

| Command | Purpose |
| --- | --- |
| `dsh-cli update` | Update the profile to the latest release and align the launcher (same install logic as the in-TUI `/update`, without restarting into the TUI) |
| `dsh-cli doctor` | Environment checks: dsh/pnpm, profile install and version alignment, whether the API key is set (state only, never the value), config file presence; complements the in-TUI `/doctor` session diagnostics |
| `dsh-cli safe` | Safe mode: read-only diagnostics, inventory, repair guidance (`safe --rescue` also creates/verifies the clean rescue profile) |
| `dsh-cli version` | Show the launcher and profile versions (`--version`/`-v` are equivalent) |
| `dsh-cli help` | Show usage (`--help`/`-h` are equivalent) |

`help`/`version` work even when dsh is missing or the profile is not
initialized; every other argument is forwarded verbatim to
`dsh --profile dsh-cli`.

## Safe mode (`dsh-cli safe`)

When dsh exits unexpectedly, safe mode provides read-only environment
diagnostics, a profile plugin inventory, and repair guidance.

- **Two entries**: run `dsh-cli safe` manually; or accept the prompt after
  dsh exits with a non-zero code.
  - The prompt only appears in interactive terminals; scripts and pipes get
    a single hint line and keep the exit code.
  - It covers only a non-zero exit of the final dsh child process, not a
    startup hang (a spawn failure counts as exit code 1).
- **Read-only**: diagnostics, inventory, and guidance never change state. Two
  exceptions:
  - Retry normal startup.
  - Create/reuse the rescue profile, writing only to
    `$DSH_HOME/profiles/dsh-cli-safe/`.
  Note: every dsh launch writes `$DSH_HOME/profiles/node_modules` fallback
  links and the pnpm global store (not introduced by safe mode).
- **The rescue profile must be clean, or it refuses to start**. Each check
  blocks startup if it fails:
  - The candidate directory exists but is not a recognizable profile.
  - The existing profile's root manifest declares third-party plugins.
  - `$DSH_HOME/cordis.patch.yml` (home layer): **rejects if it exists**.
  - `dsh-cli-safe/cordis.patch.yml` (profile layer): **rejects only if it has
    entries**; the default "comments + `[]`" does not count as entries.
  Before deleting or rebuilding a rescue profile, it checks the top-level
  entries by **name and shape**; any other name or shape makes it refuse and
  list them — never silently deleting your files.
- **Non-interactive**: `dsh-cli safe --rescue` runs the same gate plus
  create/reuse and only reports the verdict (exit 0 when ready, 1 when
  refused).
- **Outdated launcher**: upgrade first when the profile copy is unreadable or
  too old:
  `npm install -g --legacy-peer-deps @askdkc/dsh-cli@<version>`.
- **Run repair commands yourself** (safe mode only lists them):
  - `dsh plugin --profile dsh-cli remove <third-party plugin>` removes
    suspects one by one;
  - `dsh plugin --profile dsh-cli add @askdkc/dsh-cli@<version>`
    reinstalls/aligns;
  - `dsh-cli doctor` runs environment diagnostics.

## Running in VS Code / Herdr

- **VS Code**: run directly in the integrated terminal, or use the
  `dsh-tui-vscode` companion extension on the Marketplace (real terminal
  sessions, session history, specific-session resume, IDE selection channel).
  See [VS Code guide](vscode.en.md).
- **Herdr**: run `dsh-cli` directly in a [Herdr](https://herdr.dev) pane with
  no extra setup; dsh-cli reports `idle` / `working` / `blocked` through
  Herdr's local integration API (questionnaires and tool approvals count as
  `blocked`), and stays completely inactive outside Herdr.

## Update to the latest version

The project moves fast. Updating reuses the install command with an explicit
`@latest`:

```sh
dsh plugin --profile dsh-cli add @askdkc/dsh-cli@latest
```

- Without `@latest`, pnpm resolves within the version range already recorded
  in the profile's `package.json` (for example `^0.1.4`), so it may stay on an
  old line. That is the usual reason "re-running the install command" appears
  to change nothing.
- To confirm: the startup banner shows the running version
  (`✦ dsh-CLI vX.Y.Z`).
- Your `cordis.patch.yml` override layer survives updates untouched.
- Session storage may move between versions (since 0.3.7, `/resume` uses the
  JSONL session store shared with dsh web), so older sessions missing from the
  list after a major update is expected — the underlying data is not deleted.

### pnpm install-script blocks and foreign-platform natives

If `dsh plugin` fails with `ERR_PNPM_IGNORED_BUILDS` (pnpm ≥11 blocks
dependencies that carry install scripts by default, e.g. `@google/genai` and
`protobufjs` — none of these scripts is needed at runtime, so they can safely
be ignored), add to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

`/update` and `dsh-cli update` seed this configuration automatically — no
manual step needed.

Updates also maintain `ignoredOptionalDependencies` covering foreign-platform
`@img/sharp-*` natives:

- sharp ships as all-platform optional dependencies, and an untouched
  `pnpm update` downloads every platform's binaries (about 200MB measured).
- The list is recomputed for the running platform on every update. Foreign
  natives are skipped while this platform's own and the platform-agnostic wasm
  fallbacks stay.
- Move the profile to another platform or musl container and the next update
  there refreshes it.
- An existing profile's lockfile still lists every platform, so its first
  update downloads them once more before the filter takes effect.
- Entries outside those two platform tables (a user's `fsevents`, a
  hand-written `@img/sharp-wasm32` exemption) are left as they are. This needs
  a pnpm that supports the key; one that does not fails nothing — it merely
  loses the saving.

## Profile configuration

The user override file is:

```text
$DSH_HOME/profiles/dsh-cli/cordis.patch.yml
```

When overriding a row, its `config` block is replaced as a whole rather than
deep-merged. Repeat every key you want to keep. See
[Configuration](configuration.en.md) for examples.

The root `cordis.yml` is a bare-composition example. A normal npm/profile
installation uses `cordis.patch.yml`; do not copy the root configuration into
the profile.

## Develop from source

```sh
git clone --recurse-submodules https://github.com/askdkc/dsh-cli.git
cd dsh-cli
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

The repository has two submodules; `vendor/dsh-std` is required to install:

- `vendor/dsh-std`: its `packages/*` are listed as workspace packages in
  `pnpm-workspace.yaml`.

The `dsh-auth/` source is tracked here and pulled in through `link:`.

Without `--recurse-submodules`, the required `vendor/dsh-std` directory stays
empty and `pnpm install --frozen-lockfile` fails outright. For a checkout that was
already cloned:

```sh
git submodule update --init --recursive
```

`pnpm build` cleans the ignored `lib/` directory, compiles `src/` into
`lib/types/`, and runs the build gates.

- **Git URL installs are not supported** (workspace deps / submodule / pnpm
  ≥11 prepare allowlist).
- The publish workflow performs an explicit clean compilation and
  package-surface check before packing.

For an integration test of the current source, run this once after initial
setup or whenever the normal model/key configuration changes:

```sh
pnpm dev:copy-config
```

After each source change, build, pack, install in isolation, and launch with:

```sh
pnpm dev
```

`pnpm dev:copy-config` copies only `~/.dsh/settings.yaml` and
`~/.dsh/.credentials.yaml`. Files are set to mode `0600` on Unix; Windows uses
the OS-managed file ACL.

`pnpm dev` uses isolated `HOME`, `DSH_HOME`, and session directories, leaving
the normal `~/.dsh/profiles/dsh-cli`, `~/.dsh-cli`, and sessions untouched. The
test root defaults to:

- `$XDG_CACHE_HOME/dsh-cli-dev` on Unix (`~/.cache/dsh-cli-dev` when unset).
- `%LOCALAPPDATA%\dsh-cli-dev` on Windows.
- Override it with `DSH_CLI_DEV_ROOT`.

To verify only the build, pack, and install path without launching the TUI,
run:

```sh
pnpm dev:test
```

CI also runs three rendering regressions:

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

The `pnpm tui` script invokes `scripts/run.ts`, which directly composes
DeepSeek Harness source patches and assumes a Harness monorepo `packages/*`
layout by default. A standalone checkout must set `DSH_CLI_DEV_WORKSPACE` to
the Harness root. To test only this repository's current source, prefer
`pnpm dev`; it uses the same profile installation path as an end-user install.

## Troubleshooting

### `dsh-cli requires an interactive terminal`

stdout is not a TTY. Start the process directly in a terminal rather than
redirecting its main output to another command or file.

dsh-cli detects two things: stdout is not a TTY, and the process was not
started by the `dsh-cli` launcher. When both hold, it silently skips the TUI
frontend (no error, the host keeps booting). That is the case when dsh-cli is
only installed in a profile and a non-terminal host (Web / Tauri / GUI, stdout
piped or null) starts the DSH composition.

The error above only appears when `dsh-cli` (or the standalone portable build)
was explicitly launched without a TTY.

### `dsh` or `pnpm` cannot be found

Make sure the global npm bin directory is on `PATH`, then open a new terminal.
`install.sh` checks both commands before installation.

On the first interactive `dsh --profile dsh-cli` launch, this plugin also
registers `dsh-cli` in `~/.local/bin` (Windows:
`%LOCALAPPDATA%\dsh-cli\bin`). It adds that directory to the user PATH for
zsh, bash, fish, or Windows when needed. Open a new terminal before using
`dsh-cli`. Registration failures do not stop the TUI; follow the startup
warning. `DSH_CLI_AUTO_REGISTER_CLI=0` disables registration. To undo it,
remove the generated command and `dsh-cli managed PATH` block (Windows: the
user PATH entry).

When registering from a built Harness source checkout, the managed command saves
that checkout's path as its `DSH_CLI_DSH_ROOT` default. It can then start from a
different directory without a global DSH install or reloading a shell setting.
Harness `plugin add` refreshes this default in existing managed commands after a
successful install. A nonempty `DSH_CLI_DSH_ROOT` in your environment takes
precedence; custom commands and symlinks are preserved.

### The TUI exits right back to the shell with almost no error (pnpm 9)

In a profile installed by pnpm 9, the transitive dependency
`dsh-working-activity` is not hoisted where the loader can resolve it; the
failed module resolution tears down the whole plugin tree, and the TUI prints
the resume hint and exits (issue #60). Upgrade pnpm to 10+ and reinstall:

```sh
npm install -g pnpm@latest
dsh plugin --profile dsh-cli add @askdkc/dsh-cli@latest
```

### The model reports missing credentials

Confirm that `DEEPSEEK_API_KEY` is set in the same shell that starts `dsh`.
Check `DEEPSEEK_BASE_URL` too when using a custom endpoint.

### The activity row appears twice

Check whether `dsh-working-activity` was added separately to the profile. Keep
the row inserted by the dsh-cli patch and remove the duplicate bundle entry.

### The TUI is misaligned or leaves terminal state behind

Run `/doctor`, record the terminal and mode, then consult
[Interaction and commands](interaction.en.md) and
[Architecture and limitations](architecture.en.md). `DSH_CLI_RENDER_LOG` can
capture raw frames for rendering bugs, but those frames may contain visible
conversation content and should be handled as sensitive data.

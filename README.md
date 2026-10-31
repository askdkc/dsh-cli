<p align="center">
  <img src="docs/assets/readme/logo-en.svg" alt="dsh-cli animated whale logo" width="560">
</p>

<p align="center">
  <strong>English</strong> | <a href="README_ZH.md">简体中文</a> | <a href="README_JA.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/askdkc/dsh-cli/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/askdkc/dsh-cli?style=flat-square&color=4b6fff"></a>
</p>

# dsh-cli

> An interactive terminal UI plugin for DeepSeek Harness.

This is dkc's independently developed fork of [dsh-TUI by chimney](https://github.com/ccch1mneyyy/dsh-TUI).

## Run without Kiokuko for one launch

```sh
dsh-cli --ignore-kiokuko
dsh-cli --ignore-kiokuko --resume <session-id>
```

`dsh-cli` works independently; Kiokuko is optional. `--ignore-kiokuko` prevents
`kiokuko-dsh` and its subpath plugins (including model integration) from loading
for this launch, before their imports, services, tools or hooks run. It omits
Kiokuko's bundle effects while preserving explicit profile, home and `--patch`
overrides and other plugins. Kiokuko-provided providers/tools are unavailable.
Existing session history remains; resuming does not re-enable the plugin.

The option does not uninstall anything or save an opt-out setting. Temporary
composition files are removed after use; the next launch without the flag uses
the ordinary profile again. It is a startup option, not an unload command for an
already-running session. `--dump-config` shows the effective startup tree;
schema/default-only dumps and profile replacement cannot be combined with this
option. If the host cannot safely compose the exclusion, startup fails with a
diagnostic rather than silently loading Kiokuko. Normal host startup housekeeping
and explicit in-session settings edits still follow the host's normal behavior.

## Preview

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-en-mobile.svg">
    <img src="docs/assets/readme/preview-en.svg" alt="Recorded dsh-cli session with an animated pixel whale." width="78%">
  </picture>
</div>

## Highlights

- Streaming Markdown, tool cards, images, Mermaid diagrams, and keyboard completion.
- A pixel whale, live work status, context bar, TPS gauge, and clickable timeline.
- Session management with resume, fork, rewind, background work, and export.
- DSH presets, skills, MCP, goals, subagents, provider authentication, and extensions.
- Authentication for OpenAI, Claude, OpenCode, OpenRouter, Hermes Agent, and Infron.
- Virtualized rendering and bounded caches for long sessions.
- Optional scoped code analysis through the separate LSP provider; see
  [code-analysis setup and current acceptance limits](docs/code-intelligence.en.md).
- Optional Common Lisp mode through the separate `kiokuko-dsh` plugin, which
  must be installed in the same profile; see
  [Kiokuko Lisp setup](#optional-kiokuko-lisp-mode).

## Quick Start

Requires [Node.js](https://nodejs.org/en) `>=22.19.0`, pnpm 11, a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) source
checkout with dependencies installed, and `DEEPSEEK_API_KEY`. We aim to support
current DSH APIs. Compatibility is checked against installed packages and the
upstream default branch, without a release allowlist; see [ADAPTER.md](ADAPTER.md).

Clone recursively to fetch submodules. In an existing checkout, run
`git submodule update --init --recursive` before installation.

```sh
git clone --recurse-submodules https://github.com/askdkc/dsh-cli.git
cd dsh-cli
pnpm install --frozen-lockfile
pnpm build
node scripts/with-publish-manifest.mjs npm pack --ignore-scripts
TARBALL="$PWD/askdkc-dsh-cli-$(node -p "require('./package.json').version").tgz"

cd ~/DIR/TO/deepseek-harness
pnpm dsh plugin --profile dsh-cli add "@askdkc/dsh-cli@file:${TARBALL}"
pnpm dsh --profile dsh-cli
```

Replace `~/DIR/TO/deepseek-harness` with your checkout path. The first interactive
launch registers `dsh-cli`; open a new shell, then run it from your project directory.
The managed command saves the built Harness checkout path, so a separate global
DSH installation is unnecessary. Harness `plugin add` refreshes an existing managed
command during updates; no manual registration is needed. An explicit
`DSH_CLI_DSH_ROOT` overrides the saved path.
To update this fork, rebuild and reinstall the tarball. `/update` uses the registry.

Use the named `@askdkc/dsh-cli@file:...` form for local tarball updates. A bare
tarball path can fail with `ENOENT` when pnpm resolves a previous `file:` dependency
whose archive has been deleted. `TARBALL` holds the archive's absolute path; pass
it to the install command instead of executing it.

For PATH setup and install issues, see [Getting started](docs/getting-started.en.md).

## Optional Kiokuko Lisp mode

Lisp mode is provided by the separate
[`kiokuko-dsh`](https://github.com/askdkc/kiokuko-dsh) plugin. dsh-cli supplies
the terminal prompt and `/kioku-lisp` command handling, but the plugin must be
installed in the same DSH profile:

```sh
cd ~/DIR/TO/deepseek-harness
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
```

Enable Lisp in the profile's `cordis.patch.yml` (by default
`~/.dsh/profiles/dsh-cli/cordis.patch.yml`), then restart `dsh-cli`:

```yaml
- id: kiokuko-dsh
  config:
    enabled: true
    lisp:
      enabled: true
      sbclPath: sbcl
```

A working SBCL is required; Linux also needs Bubblewrap with user, PID, and
network namespaces. Profiles are isolated, so adding the plugin to another
profile, such as `web`, does not enable Lisp mode in `dsh-cli`. Without the
plugin, `/kioku-lisp` is unavailable and no Lisp-mode choice appears. With the
plugin enabled, startup waits for it, and activation that exceeds 30 seconds
stops startup with a diagnostic.

After restart, `/kioku-lisp status` reports whether Lisp is available. A coding
request can then offer the Lisp choice, or `/kioku-lisp enable` turns it on for
the session. See [Getting started](docs/getting-started.en.md#optional-kiokuko-lisp-workflow)
for consent, managed operations, and command timing.

## Use

`Enter` sends, `Tab` completes, `Ctrl+Enter` interrupts and sends, and double
`Esc` rewinds. Press `?` for shortcuts.

The working-status line follows each accepted request in English, Japanese, or
Chinese. Ambiguous short requests keep that session's previous progress language;
`/lang` controls the rest of the interface separately.

`/resume` opens the session manager; `/auth` connects providers and `/model`
selects a model. `/bg` keeps a session running until the TUI exits. See
[Interaction and commands](docs/interaction.en.md) for the full reference.

`/model` opens a centered picker with Favorites, Recent, and provider sections.
`/model seek deep` opens it with an order-independent search; an exact
`/model provider/model-id` switches directly. In the picker, use `Ctrl+F` to
toggle a favorite, `Ctrl+A` to connect a provider, and `Esc` to close.

To import Claude Code, Codex, OMP, zcode, or Grok Build conversations, run
`dsh-cli migrate` to see available histories, then
`dsh-cli migrate <agent> [--dry-run]`. Tool traffic is not imported.
See [Session migration](docs/migrate.en.md).

## Documentation

- [Getting started](docs/getting-started.en.md) · [VS Code](docs/vscode.en.md)
- [Interaction](docs/interaction.en.md) · [Configuration](docs/configuration.en.md) · [Themes](docs/themes.en.md)
- [Architecture and limitations](docs/architecture.en.md) · [All docs](docs/README.md)
- [Plugin development](docs/plugins.en.md) · [Contributing](docs/contributing.en.md)

## Acknowledgments

The pixel whale's 22 hand-drawn frames and idle animations come from
[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale) by [@lhh010](https://github.com/lhh010)
(BSD-3-Clause). Thank you for the art and inspiration 🐋💜

Community projects and companion tools: [Friends' links](docs/links.md).

## License

[MIT](LICENSE). The original copyright notice for chimney is retained; dkc's
copyright notice covers the fork's independent development.

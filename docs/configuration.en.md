# Configuration

[Documentation index](README.md) · [简体中文](configuration.md)

## Profiles and patch layers

After an npm/profile installation, user configuration lives at:

```text
$DSH_HOME/profiles/dsh-cli/cordis.patch.yml
```

When `DSH_HOME` is unset, it normally defaults to `~/.dsh`. The file is a
top-level YAML array and may use the `!!js` expressions supported by DSH.

Profile startup layers, in order:

- `dsh-base`
- Installed bundles
- The package's `cordis.patch.yml`
- The user patch (applied last)

A user configuration normally overrides an existing row by `id`; use `insert`
only for a genuinely new service.

> When a row is overridden, its `config` block is replaced as a whole. It is
> not deep-merged, so repeat every key that must remain active.

## TUI configuration

`/settings` writes plugin Config fields to the active profile's
`cordis.patch.yml`. Language and layout preferences update live;
fullscreen and image previews require `/restart`.

A complete common override looks like this:

```yaml
- id: dsh-cli
  config:
    provider: deepseek-official
    model: deepseek-flash
    # Prefer leaving cwd unset — the default resolves to the git worktree
    # root containing the launch directory. To pin a fixed workspace, use an
    # absolute path (e.g. cwd: /repo/packages/app), NOT `!!js process.cwd()`
    # (that pins the workspace to the launch subdirectory, issue #96).
    effort: max
    activity: true
    activityFrames: moon8
    contextBar: true
    fullscreen: false
    terminalImages: true
    preset: !!js process.env.DSH_CLI_PRESET ?? undefined
    workspace: !!js process.env.DSH_CLI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_CLI_RESUME_SESSION ?? undefined
```

| Field | Default/source | Meaning |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-official` | DSH model route; provider and model must both be set to form an explicit route |
| `model` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-flash` | Startup model; `/model` can switch through a session fork |
| `cwd` | git worktree root containing the launch directory (`process.cwd()` when outside any worktree; a dotfiles repo at `$HOME` does not count) | TUI-side session workspace: agent meta, `@` completion/mention expansion, /resume filtering, statusline; resuming an existing session adopts that session's persisted cwd. Note the bash/fs-policy/sandbox roots are still owned by the composition layer's cordis config (default: the launch directory, governed by dsh-base) and may differ from this session-side cwd |
| `workspace` | unset | Startup workspace target: a local path, `file://` URL, or plugin-provided URI; takes precedence over `cwd` |
| `effort` | normally `max` in the bundle | Reasoning effort applied to every request (validated against the runtime model's levels; invalid levels silently fall back to the adapter default), also shown in the header at startup. Precedence: /settings `effortDefault` (`auto` defers) > this field > the persisted `/effort` choice (`~/.dsh-cli/effort.json`) > the model default |
| `effortDefault` | unset | Default reasoning effort for new sessions; `auto` defers to `effort`; editable through `/settings` |
| `whale` / `whaleIdle` | `true` / `true` | Header whale and welcome-page idle animation |
| `minimal` | `false` | Reduce header decoration and colors |
| `modes` | built-in trio | Shift+Tab session-mode cycle (plan/sandbox/approval atom bundles); defaults to default → plan → full-access |
| `activity` | `true` | Show the live activity row |
| `activityFrames` | `moon8` | Activity animation preset; `/activity` changes it at runtime. A legacy saved value of `claude` is read as `moon8`, and the picker no longer offers that legacy preset |
| `contextBar` | `true` | Segmented context-usage bar below the input box; `false` hides the row. Both this and `/settings → statusBar.contextBar` (also on by default) must be on for it to render |
| `fullscreen` | `true` (factory default since 0.9.0) | `true` uses the alternate screen, app scrolling, and mouse selection; `false` uses inline mode |
| `terminalImages` | `true` | Allow previews in supported terminals; `false` keeps text metadata and skips image probing and preview decoding. Restart to apply changes |
| `preset` | roster default `standard` | Agent preset for new sessions; explicit configuration wins over persisted preference |
| `sessionId` | unset | Session to resume, normally injected by the Windows `--resume` launcher |

### Precedence and force-off

- `/settings → Terminal image previews` overrides `config.terminalImages`.
- Without a saved choice, the config value applies and defaults to on.
- Enabling still needs Kitty graphics support and a display mode that allows
  image rendering.
- `DSH_CLI_DISABLE_TERMINAL_IMAGES=1` always forces previews off.
- Disabled previews do not read or decode image data or send image rendering
  commands; sending images to the model is unaffected.
- The checkbox edits the preview preference; an environment override is shown
  separately as “Image previews (forced off)” in the settings list.

### Restart

- This switch is read at startup.
- Use `/restart` after changing it to restart the TUI and resume the current
  session; `/reload` does not apply it.
- If a turn is running, wait for it to finish or stop it with `Ctrl+C` before
  restarting.

## Diagnostic environment variables

The following variables are for diagnostics or experimental terminal
integration. They are all off by default and take effect only when explicitly
set:

| Variable | Purpose |
| --- | --- |
| `DSH_CLI_DEBUG_REPAINTS=1` | Record repaint diagnostics |
| `DSH_CLI_COMMIT_LOG=1` | Record render-commit diagnostics |
| `DSH_CLI_ACCESSIBILITY=1` | Enable accessibility related display paths |
| `DSH_CLI_TMUX_TRUECOLOR=1` | Enable the truecolor detection path in tmux |
| `DSH_CLI_TAB_STATUS=1` | Experimental terminal tab-status opt-in; off by default, with no guarantee of support in every terminal |

Diagnostic output does not change session events or model routing. Enable
only the variable needed for the terminal or rendering issue being
investigated.

## Live activity row

`dsh-working-activity` is installed with the package and inserted by its
patch. The working line reads the plugin's `workingActivity` session
projection, which requires `dsh-working-activity` ≥ 0.5.0 — that release
replaced the old `activity/status` event outlet with the projection, so
older plugin versions produce no working line. Override only the existing
ID when tuning it:

```yaml
- id: working-activity
  config:
    publishIntervalMs: 500
```

Do not insert a second row and do not separately run
`dsh plugin ... add dsh-working-activity` for the same profile.

## Agent presets

Each session composes its model-visible tools and prompt through the official
preset registry, `@deepseek-ai/dsh-agent-preset-registry`:

| ID | Name | Capability |
| --- | --- | --- |
| `standard` | Standard (default) | Editing, shell, search, skills, planning, goals, subagents, and workflows |
| `ptc` | PTC | Standard plus the PTC SDK presentation for composing operations in TypeScript |
| `minimal` | Minimal | Persistent Bash and `str_replace_editor` only, without compaction |
| `cordis` | Creation | Standard plus runtime inspection and plugin-experimentation tools |
| `liangshen` | Liangshen mode | Minimal's two-tool surface first for root and delegated agents, the full catalog after the first tool call, and a fresh anchor after compaction |

### Selecting and switching

- `/preset` opens the picker.
- `/preset <id>` selects directly; `/preset status` reports the current state.
- Picker names and descriptions come from registry declarations.
- Under the `en` UI language (`/lang en`), the built-in presets show localized
  English names and descriptions.
- Built-in presets: `standard` / `minimal` / `ptc` / `cordis` / `liangshen`;
  custom presets are shown as-is.
- A blank session can switch in place. Once a conversation has started, the
  official blank-only rule stores the choice as the new default for `/new` or
  the next launch.

### Default and precedence

- The default is stored in `~/.dsh-cli/agent-preset.json`.
- Precedence: explicit `config.preset` or `DSH_CLI_PRESET`, then persisted
  preference, then the roster default `standard`.
- Resuming a session restores the preset recorded in that session's log and
  does not overwrite it with the current default.

### Liangshen mode

- Liangshen mode ships with dsh-cli. It registers with the official
  registry; an existing profile declaration with the same id takes precedence.
- The first-round `bash` on Windows runs an auto-discovered Git Bash, trying
  in order:
  - The installation tree of a `git.exe` found on PATH (covers installer,
    portable, and Scoop layouts; Scoop shims are followed)
  - Conventional install roots and Scoop's conventional directories
  - Bare `bash` on PATH (final fallback)
  - It never accepts the System32 WSL launcher as Git Bash
- Set `DSH_CLI_LIANGSHEN_BASH_PATH` to an absolute `bash.exe` path to pin it.
- The pin is the only candidate; a miss warns and skips registration, exposing
  the full tool catalog on the first round.

### Custom presets

Declare `@deepseek-ai/dsh-agent-preset` through a profile/bundle with
`id`, `name`, and `plugins` in its config.

Since 0.3, model-side tools, planning, compaction, and delegation are owned by
the preset. Profile mode no longer uses the old `DSH_CLI_COMPACT_RATIO`,
`DSH_CLI_COMPACT_RETAIN`, or the former TUI's subagent-depth customization; configure
those policies in the preset instead.

## MCP

The official `@deepseek-ai/dsh-mcp-client` supports both stdio and streamable
HTTP. Mounted tools are registered as `mcp__<server>__<tool>` and enter the
model tool set automatically.

Insert servers in the user `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers:
          Authorization: !!js process.env.MCP_TOKEN
```

Run `/mcp` to inspect connected servers and tool counts. Consult the
[DeepSeek Harness configuration catalog](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
for the complete field reference.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VISUAL` / `EDITOR` | External editor opened by `Ctrl+G` (`VISUAL` wins; arguments like `code --wait` are allowed; with neither set the TUI prompts you to configure one — no `vi` fallback) |
| `DEEPSEEK_API_KEY` | Required DeepSeek credential |
| `DEEPSEEK_BASE_URL` | Override the compatible DeepSeek API endpoint |
| `DSH_HOME` | Harness home (profiles, sessions, credentials, attachments); falls back to the upstream default `~/.dsh` |
| `DSH_CLI_PERSONA` | Override the Agent persona injected by the composition |
| `DSH_CLI_PRESET` | Override the default Agent preset for new sessions |
| `DSH_CLI_THEME` | Pin a built-in (`auto`/`light`/`dark`/`dark-ansi`), static theme, or registered plugin theme ahead of persisted selection |
| `DSH_CLI_DISABLE_MOUSE` | Temporarily disable mouse handling in fullscreen mode |
| `DSH_CLI_DISABLE_TERMINAL_IMAGES` | Set to `1` to force Kitty/Sixel probing, preview reads/decoding, and terminal image rendering off, overriding config and /settings; text metadata remains visible |
| `DSH_CLI_IMAGE_PROTOCOL` | `auto` (default), `kitty`, `sixel`, or `none`; override protocol selection without bypassing the preview preference, disable switch, non-fullscreen, accessibility or multiplexer guards |
| `DSH_CLI_RESUME_SESSION` | Resume a session at startup, normally set by a launcher |
| `DSH_CLI_WORKSPACE_TARGET` | Workspace path or URI resolved at startup, normally set by `dsh-cli <target>` |
| `DSH_CLI_SESSION_ROOT` | Override the JSONL session root; profile default `$DSH_HOME/sessions`, bare `cordis.yml` default `~/.dsh-cli/sessions` |
| `DSH_PERMISSION_MODE` | Override non-Windows sandbox policy, such as `workspace-write` or `danger-full-access` |
| `DSH_CLI_WORKSPACE` | Working directory used by the Windows `dsh-cli.cmd` launcher |
| `DSH_CLI_DEBUG` | Enable dsh-cli diagnostics on stderr |
| `DSH_CLI_RENDER_LOG` | File path for raw ANSI frame capture |

The old `CC_TUI_*` and `DSH_CC_*` names come from earlier release naming and
are no longer read as of this release; use the `DSH_CLI_*` prefix.

Two directories are involved and neither substitutes for the other:

- **Harness home**: `$DSH_HOME`, falling back to the upstream default `~/.dsh`.
  Holds profiles, sessions, credentials, and attachments. Early releases pinned
  it to `~/.dsh-cc`.
- **TUI data directory**: `~/.dsh-cli` (a fixed path, independent of
  `$DSH_HOME`). Holds `/model` (persisted at `~/.dsh-cli/model.json`, surviving
  restart and `/new`), `/lang`, `/theme` and similar preferences plus
  `resume.txt`. Early releases wrote these under `$DSH_HOME` instead.

`DSH_CLI_RENDER_LOG` may capture visible prompts, tool arguments, and output.
Do not attach it to a public issue without reviewing and redacting it.

## `/provider`: manage model providers at runtime

`/provider` opens an interactive wizard to add, edit, or delete model
providers without a restart.

- Sources: built-in catalog routes or custom API endpoints.
- Only providers written by the **user settings layer** can be edited or
  deleted; ones inherited from the composition base cannot be removed.
- Keys are written to `~/.dsh/.credentials.yaml` (mode 0600) and render as
  `••••••`.
- Only non-environment keys are written to the store; a key shared with
  another provider is kept on delete.

Where it writes:

| Artifact | Location |
| --- | --- |
| Provider profile | `llm-pi-ai.providers.<route>` in the active profile config; the route registers on write and unregisters on delete |
| API key | `~/.dsh/.credentials.yaml` (mode 0600), referenced as `<ROUTE>_API_KEY` |

With the bundled dsh-auth plugin mounted, the add branch offers **provider
authentication**. ChatGPT / Claude / Grok use OAuth; OpenCode Zen / Go
and Infron accept API keys; OpenRouter offers OAuth PKCE or an API
key; Nous offers device-code OAuth or a manual Bearer compatibility path.
`/auth status|login|logout` uses the same credential store at
`$DSH_HOME/dsh-auth/credentials.json`. Sign in, then choose a model with
`/model`; sign-in does not switch the active model. The manual Nous Bearer
path has not been validated with a real account.

## Composition constraints

- `user-interaction` normally comes from `dsh-base`. The plugin creates a
  fallback in a bare composition, but the profile patch must not insert a
  duplicate.
- When manually inserting a subagent provider, mount the core `subagent`
  service first.
- A custom `plan-mode` override requires a non-empty `section`.
- Profile mode uses the base JSONL persistence row rooted at the shared
  `~/.dsh/sessions`, allowing TUI and Web to read the same history.
- `cordis.yml` is a bare-composition example and may have a different service
  topology. Normal installation and user overrides should follow
  `cordis.patch.yml`.

`DSH_CLI_SESSION_ROOT` always names a JSONL root. `dsh --profile dsh-cli`
defaults to `$DSH_HOME/sessions` (normally `~/.dsh/sessions/`); direct
`dsh --config cordis.yml` defaults to `~/.dsh-cli/sessions/`.

See [Architecture and limitations](architecture.en.md#permissions-and-security-boundary)
for permission behavior and platform differences.

# Optional code analysis

The CLI consumes the public `CodeIntelligenceServiceV1` from the separate
`@askdkc/dsh-lsp-server` plugin. The plugin owns parsers, WASM grammars,
snapshots, coordinate conversion and language-server processes. Installing the
CLI alone does not install or activate this provider.

## Current acceptance status

The implementation is not yet accepted for release across all three target
operating systems. The published provider `0.1.13` has a reproducible packaging
failure: its runtime requests `lib/parser-worker.mjs`, while its tarball ships
`lib/structure/parser-worker.mjs`. Native `lsp_extra` structure queries and the
public V1 structure query both fail. Do not copy workers or grammars into the CLI
or hand-edit the installed provider to work around this failure.

Local evidence obtained on macOS arm64 with Node `26.5.0`, CLI source `0.14.6`,
Cordis `4.0.4`, DSH host services `0.2.1-alpha.1`, and provider `0.1.13`:

| Check | Result |
| --- | --- |
| Public bundle activation and native tool registry | Passed in an isolated real Loader |
| TypeScript server handshake, diagnostics, definition and bounded completion | Passed; fixture file unchanged |
| Traversal/symlink rejection, stale snapshot, disable/re-enable and teardown | Passed in the host fixture |
| Explicit user preset with isolated tools and scoped native invocation | Passed in the host fixture and clean tarball consumer |
| Tree-sitter outline, enclosing/span and combined structure/semantic acceptance | Blocked by the provider worker path |
| `standard`, `ptc`, `cordis` and arbitrary user preset catalogs in a full DSH profile | Not accepted by this fixture |
| Managed launcher registration, update and interactive launch from another project | Not yet exercised for this integration |
| Ubuntu 26.04 / Arch Linux clean consumer acceptance | Not run |
| Optional Kiokuko protected bridge and actual OS sandbox | Not run |

The actual CLI/provider tarballs install in a clean consumer and reproduce the
same semantic/preset/lifecycle successes followed by the structure failure.

The host fixture uses an explicit model-free agent identity and actual services;
it does not claim that a paid model or a full interactive profile was tested.
The strict host test remains in the build gate and fails on the provider defect.
A successful CLI package-surface check does not override that failure.

## Profile and preset composition

Add the provider as a separate plugin to the **same** `dsh-cli` profile, using
the existing named package installation form:

```sh
pnpm dsh plugin --profile dsh-cli add '@askdkc/dsh-lsp-server@0.1.13'
pnpm dsh --profile dsh-cli
```

This is the profile installation path, not a claim that version `0.1.13` passes
structure acceptance. Use a provider release that passes the strict test before
publishing a supported combination.

The provider's own bundle supplies `lsp`, `lsp-webstack-provider`, `tool-lsp` and
`tool-lsp-extra`. Do not duplicate those host rows in the CLI bundle. An existing
`lsp` row or a second provider must be resolved explicitly in the profile.
The CLI reports `duplicate_provider` instead of silently choosing between two
enabled rows with the provider's canonical module identity.

Preset realms may own their own `tools` and `systemPrompt` registries. Package
installation and host activation therefore do not imply that an agent can call
`lsp` or `lsp_extra`. An explicitly composed user preset can add these tool rows
inside its existing tool realm while inheriting the single host provider:

```yaml
# Entries in the user preset's existing plugin list, after its tools registry.
- id: tool-lsp
  name: '@askdkc/dsh-lsp-server/tool-lsp'
- id: tool-lsp-extra
  name: '@askdkc/dsh-lsp-server/extra-tool'
```

Retain the preset's existing realm isolation and permission services. Check the
agent's actual tool catalog after mounting it. The CLI does not add these tools
to every preset; `minimal` retains its two-tool contract. `standard`, `ptc` and
`cordis` need individual catalog/execution acceptance with the chosen host.
The manual `/code` path resolves the active agent's service scope independently
of whether its model-facing catalog exposes native tools.

## Manual reads and capability display

Use `/status` or `/code status` to inspect the cached/explicitly refreshed
provider schema, workspace, language support and semantic readiness. `/doctor`
also includes this information. There is no background polling.

```text
/code diagnostics src/example.ts
/code definition src/example.ts 2 1
/code completion src/example.ts 2 1
/code outline src/example.ts
/code query declarations src/example.ts
/code enclosing src/example.ts 0 20
/code span src/example.ts 0 20
/code cancel
```

`/code` positions are **zero-based UTF-16**, and ranges are half-open. Paths
may contain spaces; the final two numbers are the cursor coordinates. Inputs
are disk snapshots, not an editor's unsaved buffer. A supported grammar is not
proof that its worker loaded. An available executable is not proof of an LSP
handshake. Per-language provider failures do not disable the ordinary CLI.

The status vocabulary preserves `ok`, `partial`, `unsupported`, `unavailable`,
`stale`, `cancelled`, `timeout` and `limit_exceeded`. A truncated completion can
legitimately be `partial`. Refresh/retry after an explicit stale result; the CLI
does not perform an unbounded retry loop.

Native model-facing examples use the provider's existing schema:

```json
{"operation":"status"}
{"operation":"diagnostics","file_path":"src/example.ts"}
{"operation":"completion","file_path":"src/example.ts","line":3,"character":2}
{"operation":"snapshot","action":"open","file_path":"src/example.ts"}
{"operation":"structure","action":"outline","handle":"<returned opaque handle>","limit":20}
{"operation":"semantic","action":"definition","handle":"<same handle>","position_line":2,"position_character":1}
{"operation":"snapshot","action":"release","handle":"<same handle>"}
```

These are `lsp_extra` calls. Legacy `completion` uses one-based UTF-16;
`semantic`/`structure` use zero-based UTF-16. Never infer a handle's contents,
reuse it in another session, or save it as configuration. Ordinary native `lsp`
retains `goToDefinition`, `findReferences`, `goToImplementation` and `hover`
with one-based coordinates.

Completion candidates never apply `textEdit`, `additionalTextEdits` or commands.
Tool details are sanitized and capped at 32 KiB; previews use 240 terminal cells.
Manual output has a 200-line cap. Live results and transcript replay use the
same presenter; folding discards the bounded details and restores them from the
existing session events without contacting the provider again.

## Authority and cleanup

The trusted host binds each request to the active session's actual canonical cwd,
agent/session identity, checkout and visible filesystem/subprocess services.
Model input cannot supply these authorities. A remote workspace without a
supported backend is `workspace_backend_unsupported`; it is not interpreted as
a similarly named local directory.

Each bounded operation gets a fresh lease. Structure and semantic reads within
one operation share its snapshot/version. Cancellation, binding changes,
provider reload and owner disposal invalidate old results. Snapshot release and
lease disposal run through bounded cleanup even after cancellation; cleanup
failure is reported separately. Server/worker teardown remains the provider's
responsibility. A read-only API is not an OS sandbox.

## macOS

Use the repository's existing recursive-clone, frozen-lockfile, build and named
tarball procedure in [Getting started](getting-started.en.md). The local host
fixture above was executed on macOS arm64. Full install → activation → agent
tool → update → disable acceptance and the protected Lisp sandbox remain
unverified for this integration. No unverified Homebrew commands are supplied.

## Ubuntu 26.04

Use the same Node/pnpm/DSH and named tarball workflow after verifying those
prerequisites on a clean Ubuntu 26.04 machine. The host and tarball verifiers
below must pass there before this combination is marked supported. No apt
package names or protected Lisp support are claimed without that run.

## Arch Linux

Verify the exact Node/pnpm/DSH versions and run the same clean consumer workflow
on Arch independently. No pacman package names or protected Lisp support are
claimed without that run. A passing Ubuntu test does not substitute for Arch.

For PHPantom and rust-analyzer, use the chosen provider's documented explicit
path/PATH configuration and verify their versions separately. CLI capability
display follows what that provider advertises; it does not infer Rust semantic
support from a Rust grammar. Missing external servers must be diagnosed per
language. Mixed-language parsing and untested grammars remain unverified.

## Optional Kiokuko

Install Kiokuko and the provider in the same profile only when that combination
has passed the bridge and sandbox acceptance. Follow the installed Kiokuko
package's Node engine requirement and its SBCL / macOS Seatbelt / Linux
Bubblewrap+seccomp requirements. This integration does not activate Lisp, alter
its allowlist or bypass approval. Existing `/kioku-lisp status`, `diagnostics`,
`hot`, `cancel` and `recover` retain their input-holding behavior.
Native LSP remains independently usable. An absent or incompatible protected
bridge is an optional unavailable capability. No OS/configuration is newly
advertised as protected by this change.

## Verification and remaining blockers

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:code-intelligence
pnpm verify:code-intelligence-host
pnpm verify:package
node scripts/with-publish-manifest.mjs npm pack --ignore-scripts
TARBALL="$PWD/askdkc-dsh-cli-$(node -p "require('./package.json').version").tgz"
# Obtain the actual provider tarball, preserving its absolute path as LSP_TARBALL.
npm pack @askdkc/dsh-lsp-server@0.1.13 --ignore-scripts
LSP_TARBALL="$PWD/askdkc-dsh-lsp-server-0.1.13.tgz"
pnpm verify:code-intelligence-package "$TARBALL" "$LSP_TARBALL"
```

The package verifier installs actual archives into a disposable consumer with
explicit installed host versions and no checkout overrides. It repeats a frozen
install and exercises the compiled CLI consumer and published provider bundle.
It is separate from the package-surface check. Its strict structure acceptance
is expected to fail while the worker-path defect remains.

Before declaring the plan complete, fix and publish the provider artifact, pass
the full tarball test, test real preset catalogs and managed launcher update,
and reproduce the workflow on all three operating systems. Protected Lisp needs
additional actual sandbox, permission-denial, cancellation and lease-release
evidence. Do not add guessed disable/remove/update subcommands to these steps;
verify the chosen DSH version's syntax first. The host fixture exercises disable
and re-enable through the real Loader API, not the full profile-manager CLI.

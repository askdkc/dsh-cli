# @askdkc/dsh-auth

English | [日本語](README.ja.md)

> Provider authentication for [dsh-cli](https://github.com/askdkc/dsh-cli) and
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

Use **ChatGPT, Claude, SuperGrok, OpenCode Zen/Go, OpenRouter,
Nous Portal, and Infron** as model providers with OAuth, device code, or an
API key according to the provider. No dsh source patch is needed. This plugin is developed alongside (and
bundled into) [dsh-cli](https://github.com/askdkc/dsh-cli), the
terminal front door for DeepSeek Harness; it also installs
standalone into any dsh profile.

```
dsh-cli → /provider → Provider authentication → sign in
          /auth login openai-codex                     ← the plugin command
          /model → OpenAI Codex → gpt-5.6-sol          ← routes & models
```

**Status: experimental.** Catalog OAuth flows are
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)'s shipped
implementations (device-code and loopback callback included); this plugin
adds the hosting: credential storage, automatic token refresh, adapter
registration, and a login surface over the `userQuestions` seam that works in
the TUI, the web client, and refuses cleanly on headless hosts.

## Install

**With dsh-cli** — nothing to do: dsh-auth ships inside the dsh-cli package
(bundled dependency). Update dsh-cli and the `/provider` wizard gains its
provider authentication branch automatically.

**Standalone, into any dsh profile:**

```sh
dsh plugin --profile <name> add @askdkc/dsh-auth
```

Then restart the host; `/` lists `auth`, and every model picker gains the
signed-in providers' catalogs (credential-gated — see below).

## What it does

- Mounts pi-ai catalog providers as `llm` registry routes:
  `openai-codex`, `anthropic`, `xai`, and `openrouter`. OpenCode Zen/Go use an owned DSH adapter with bundled Messages, Responses, Chat Completions and Google transports.
  **Models appear in a picker
  only after that provider is signed in** (credential-gated listing) — sign
  in and the catalog appears, sign out and it disappears. Verified current
  models stay resolvable after logout; retired models fail explicitly and
  never trigger an automatic switch.
- Loads those Provider objects from the exact pi-ai dependency owned by the
  installed `dsh-llm-pi-ai`. rc and alpha hosts therefore keep their supported
  pi-ai versions without passing Provider objects across package instances.
- `/auth login [provider]` runs the selected authentication method interactively. The
  waiting panel behaves the way pi's host does: the authorization URL is
  **opened in your browser automatically** (never hand-copied — the URL is
  hundreds of characters and wrap artifacts corrupt its `redirect_uri`),
  and the panel offers *Copy authorization link* / *Open browser again* /
  *Cancel sign-in*. Device-code flows open the verification page and make
  the short code the copy target. OpenAI Codex also offers a device-code
  login method — the most robust path on headless or locked-down machines
  (no localhost:1455 callback needed).
- OpenCode Zen/Go accept API keys. OpenRouter offers pi-ai's OAuth PKCE flow
  or a manual API key. `nous` and `infron` use Chat Completions;
  their `/models` listings must provide capacity and pricing metadata before
  a model is selectable. `nous` offers device-code OAuth and an explicitly
  selected manual Bearer token compatibility path. The latter has not been
  validated against a real Nous account.
- Stored access tokens refresh automatically before each request, serialized
  per provider under the credential store's lock — concurrent requests never
  double-refresh a rotated token.
- `/auth status` / `/auth logout <provider>`; the `ctx.dshAuth` service
  exposes the same api for UIs (the dsh-cli `/provider` wizard and `/login`
  ride it).

## Usage

```
/auth                          # status: which providers are signed in
/auth login                    # pick a provider interactively
/auth login openai-codex       # ChatGPT (Plus/Pro)
/auth login anthropic          # Claude (Pro/Max)
/auth login xai                # SuperGrok / X Premium
/auth login opencode           # OpenCode Zen API key
/auth login opencode-go        # OpenCode Go API key
/auth login openrouter         # OAuth PKCE or API key
/auth login nous               # device code or manual Bearer
/auth login infron             # Infron API key
/auth logout anthropic
/auth models opencode          # source, last success, excluded models
/auth refresh opencode         # immediate catalog refresh
```

Model requests against a provider you have not signed in to fail loudly with
the `/auth login <provider>` hint — never silently.

## Configuration

```yaml
- id: dsh-auth
  name: '@askdkc/dsh-auth'
  config:
    providers: [openai-codex, anthropic, xai, opencode, opencode-go, openrouter, nous, infron]
    nous:
      clientId: hermes-cli
    # infron:
    #   serviceTier: flex       # standard or flex; omit for gateway defaults
    # credentialsFile: /secure/path/credentials.json
```

- `credentialsFile` defaults to `$DSH_HOME/dsh-auth/credentials.json`
  (`~/.dsh/dsh-auth/credentials.json`), overridable with the
  `DSH_AUTH_CREDENTIALS` environment variable. The directory is created
  `0700`, the file `0600` (best-effort on Windows), and every write is
  atomic (temp file + rename).
- Aliases `opencode-zen`, `hermes`, and `infron.ai` resolve to `opencode`,
  `nous`, and `infron`. Credentials are stored under canonical IDs.
- The Nous client ID defaults to `hermes-cli`; third-party reuse of this ID is
  not guaranteed by Nous. Set `nous.clientId` if your deployment has its own.
- Set `infron.serviceTier` to `standard` or `flex` to select the routing tier for
  all Infron models, including `z-ai/glm-5.3`. Requests send
  `{"provider":{"service_tier":"flex"}}` at the body root; there is no
  `extra_body` wrapper on the wire. Omit the setting to keep gateway defaults.
  Flex may fall back to Standard when unavailable; see the
  [Infron API reference](https://models.infron.ai/models/z-ai/glm-5.3/api-reference).
- A route another adapter family already owns — an `llm-pi-ai` settings
  profile naming the same provider — is refused by the registry; the plugin
  logs the refusal and mounts the remaining routes. Keep one provider on one
  adapter.
- OpenCode Zen/Go own their catalog and transports independently of the host's
  pi version. Official `/models` rosters and exact-route models.dev metadata
  refresh hourly. Startup uses the verified cache or bundled snapshot immediately.
  `/auth models [provider]` shows freshness and excluded model reasons;
  `/auth refresh [provider]` requests an update. Failed updates keep the last
  verified catalog. Unsupported or incomplete models are excluded individually;
  no sibling metadata or another route's prices are guessed.
- Public catalog caches live at `$DSH_HOME/dsh-auth/catalog-v1/` and contain no
  credentials. Existing provider IDs, API keys and capacity overrides are retained.
  A new wire protocol requires a package update; new IDs on supported protocols
  do not require a pi update.
- In auth 0.2, pi-specific construction helpers are internal to `pi-routes`;
  consumers should use `DshAuthApi` and the DSH adapter contract.

## Security notes

- The credential file holds **API keys and long-lived refresh tokens**. It is never
  logged, never echoed through status surfaces (`/auth status` shows expiry
  metadata only), and a corrupt file fails loudly instead of being
  overwritten.
- dsh-cli masks API-key input and redacts it from questionnaire summaries.
- Login refuses to run where no interactive surface is registered (no
  browser/GUI assumptions — remote and headless hosts get a clear error,
  per the ecosystem spec's remote-determinism rule, TUI-RUN-001).
- Subscription authentication and API-key access are different products:
  ChatGPT Codex and Claude Pro/Max use their subscription backends; the new
  API-key routes use each service's API backend.

## Development

```sh
pnpm install
pnpm verify     # build + headless smoke (credential store, refresh
                # serialization, prompt bridging, gating, service api)
```

The smoke suite runs without cordis or a harness: the pure modules are
exercised directly. Real end-to-end login needs an interactive host
(dsh-cli) and is verified manually per release. The plugin is developed in
the [dsh-cli repository](https://github.com/askdkc/dsh-cli) in the tracked
`dsh-auth/` directory. Auth and CLI changes can be committed together.
The initial in-repository snapshot came from
[dsh-auth-fork](https://github.com/askdkc/dsh-auth-fork) commit
`a48e59ec502fa0a3238c78955ffcffdfa8ae5abb`.
Development and releases of this copy are now managed in dsh-cli.

## Roadmap

- **M2** *(landed)* — dsh-cli integration: `/provider` OAuth branch, `/login`
  account section, two-level `/model` picker with a pinned recently-used
  group.
- **M3** — `dsh-ecosystem-spec` conformance (manifest validation, admission
  fixtures) plus the remaining pi-ai OAuth providers (GitHub Copilot,
  Kimi); community list entry.
- **M4** — Gemini: a custom Google device-code flow (pi-ai ships none; this
  is the one wheel this project plans to build itself).

## License

[MIT](LICENSE). The original ccch1mneyyy copyright notice is retained; dkc is
listed for the fork's independent development.

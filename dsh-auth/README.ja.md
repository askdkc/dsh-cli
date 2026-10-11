# @askdkc/dsh-auth

[English](README.md) | 日本語

> [dsh-cli](https://github.com/askdkc/dsh-cli) と
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 向けのプロバイダー認証

**ChatGPT、Claude、SuperGrok、OpenCode Zen/Go、OpenRouter、
Nous Portal、Infron** をモデルの提供元として利用できます。プロバイダーに応じて
OAuth、デバイスコード、API キーで認証します。dsh 本体のソース修正は不要です。
このプラグインは DeepSeek Harness のターミナル UI である
[dsh-cli](https://github.com/askdkc/dsh-cli) とともに開発され、dsh-cli に同梱されています。
任意の dsh プロファイルへ単独でインストールすることもできます。

```
dsh-cli → /provider → Provider authentication → sign in
          /auth login openai-codex                     ← the plugin command
          /model → OpenAI Codex → gpt-5.6-sol          ← routes & models
```

**現状は実験段階です。** カタログの OAuth フローには
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) に同梱された実装を使います。
デバイスコード認証とループバック・コールバックを使う認証も含まれます。
このプラグインが担うのは、認証情報の保存、トークンの自動更新、
アダプターの登録、`userQuestions` を通したログイン画面です。
TUI と Web クライアントで使えます。対話画面のないホストでは明示的に拒否します。

## インストール

**dsh-cli と一緒に使う場合** — 追加作業は不要です。dsh-auth は dsh-cli パッケージに
依存関係として同梱されています。dsh-cli を更新すると、`/provider` のウィザードに
プロバイダー認証の項目が追加されます。

**任意の dsh プロファイルへ単独でインストールする場合：**

```sh
dsh plugin --profile <name> add @askdkc/dsh-auth
```

インストール後にホストを再起動してください。`/` に `auth` コマンドが表示され、
各モデル選択画面にはログイン済みプロバイダーのカタログが追加されます。
モデルの表示は認証情報の有無で制御されます（後述）。

## 主な機能

- 対応するプロバイダーを `llm` レジストリのルートとして登録します：
  `openai-codex`、`anthropic`、`xai`、`opencode`、`opencode-go`、`openrouter`。
  **モデル選択画面に表示されるのは、そのプロバイダーにログインした後だけです。**
  ログインするとカタログが現れ、ログアウトすると消えます。
  ログアウト後も、現在の検証済みカタログにあるモデル ID は解決できます。
  提供終了したモデルへは送信せず、別モデルへ自動切替もしません。
- OpenCode 以外の Provider オブジェクトは、インストール済みの `dsh-llm-pi-ai` が使う
  **同じ pi-ai 依存関係**から読み込みます。これにより、rc 版や alpha 版のホストでも
  対応する pi-ai のバージョンを使え、別々のパッケージインスタンス間で
  Provider オブジェクトを受け渡さずに済みます。
- `/auth login [provider]` で選んだ認証方法を対話的に実行します。
  認証 URL は**ブラウザーで自動的に開きます**。URL は数百文字と長く、
  手でコピーすると折り返しによって `redirect_uri` が壊れるためです。
  待機画面には *Copy authorization link*、*Open browser again*、
  *Cancel sign-in* も表示されます。デバイスコード認証では検証ページを開き、
  短いコードをコピー対象にします。OpenAI Codex ではデバイスコード認証も選べます。
  localhost:1455 のコールバックを必要としないため、ヘッドレス環境や
  制限のある環境ではこの方法が最も確実です。
- OpenCode Zen/Go は API キーに対応します。OpenRouter では pi-ai の OAuth PKCE
  フローか API キーの手入力を選べます。`nous`、`infron` は
  Chat Completions を使います。各プロバイダーの `/models` 一覧に
  コンテキスト容量と価格のメタデータがなければ、モデルは選択できません。
  `nous` はデバイスコード OAuth に加え、明示的に選択する手入力の Bearer トークン
  互換経路にも対応します。後者は実際の Nous アカウントでは未検証です。
- 保存済みのアクセストークンは、リクエスト前に自動更新されます。
  更新は認証情報ストアのロックでプロバイダーごとに直列化されるため、
  並行するリクエストが更新済みトークンを重複して更新することはありません。
- `/auth status` と `/auth logout <provider>` を使えます。`ctx.dshAuth` サービスも
  UI 向けに同じ API を公開しており、dsh-cli の `/provider` ウィザードと
  `/login` はこのサービスを利用します。

## 使い方

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
/auth models opencode          # 情報源・更新日時・除外理由
/auth refresh opencode         # 即時更新
```

未ログインのプロバイダーにモデルを要求すると、`/auth login <provider>` の案内を添えて
明示的に失敗します。

## 設定

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

- `credentialsFile` の既定値は `$DSH_HOME/dsh-auth/credentials.json`
  （`~/.dsh/dsh-auth/credentials.json`）です。`DSH_AUTH_CREDENTIALS` 環境変数で
  変更できます。ディレクトリは `0700`、ファイルは `0600` で作成します
  （Windows では可能な範囲で適用）。書き込みは毎回、一時ファイルを作ってから
  rename で置き換えるため、更新はアトミックです。
- `opencode-zen`、`hermes`、`infron.ai` は、それぞれ `opencode`、
  `nous`、`infron` の別名です。認証情報は正規の ID で保存します。
- Nous のクライアント ID の既定値は `hermes-cli` です。Nous が第三者による
  この ID の再利用を認めるとは限りません。独自の ID がある環境では
  `nous.clientId` を設定してください。
- `infron.serviceTier` に `standard` または `flex` を指定すると、
  `z-ai/glm-5.3` を含む Infron の全モデルで使うルーティング階層を選べます。
  リクエスト本文の直下に `{"provider":{"service_tier":"flex"}}` を送り、
  通信時には `extra_body` で包みません。省略するとゲートウェイの既定値を使います。
  Flex が使えない場合は Standard に切り替わることがあります。詳しくは
  [Infron の API リファレンス](https://models.infron.ai/models/z-ai/glm-5.3/api-reference)を参照してください。
- 同じプロバイダーを別のアダプター群がすでに使っている場合
  （`llm-pi-ai` の設定プロファイルなど）、レジストリはそのルートの登録を拒否します。
  プラグインは拒否をログに記録し、残りのルートを登録します。
  1 つのプロバイダーには 1 つのアダプターを割り当ててください。
- `opencode` / `opencode-go` は dsh-auth の専用アダプターを使います。
  モデルと通信方式は pi のカタログを参照せず、公式一覧と models.dev の
  同じルート・同じ ID の情報から確定します。オフライン起動に対応し、
  期限切れの情報はバックグラウンドで更新します。
  `pnpm --dir dsh-auth sync:models` は配布用スナップショットを更新します。

## セキュリティ上の注意

- 認証情報ファイルには**API キーと長期有効の更新トークン**が保存されます。
  内容をログやステータス画面に出すことはありません
  （`/auth status` に表示するのは有効期限の情報だけです）。
  ファイルが壊れている場合は、上書きせず明示的に失敗します。
- dsh-cli は API キーの入力をマスクし、質問への回答の要約からも伏せます。
- 対話画面が登録されていない環境ではログインを拒否します。
  ブラウザーや GUI があるとは仮定しません。リモート環境やヘッドレス環境では
  明確なエラーを返します（エコシステム仕様のリモート決定性規則 TUI-RUN-001）。
- サブスクリプション認証と API キーによるアクセスは別の製品です。
  ChatGPT Codex と Claude Pro/Max は各サブスクリプションのバックエンドを使い、
  新しい API キーのルートは各サービスの API バックエンドを使います。

## 開発

```sh
pnpm install
pnpm verify     # build + headless smoke (credential store, refresh
                # serialization, prompt bridging, gating, service api)
```

smoke テストは cordis や Harness を起動せずに、純粋なモジュールを直接検査します。
実際のログインを通す E2E 確認には対話可能なホスト（dsh-cli）が必要で、
リリースごとに手動で検証します。このプラグインは
[dsh-cli リポジトリ](https://github.com/askdkc/dsh-cli) 内の通常の
`dsh-auth/` ディレクトリとして開発します。認証側と CLI 側を同じ commit にできます。
このリポジトリへ取り込んだ最初の版は
[dsh-auth-fork](https://github.com/askdkc/dsh-auth-fork) の commit
`a48e59ec502fa0a3238c78955ffcffdfa8ae5abb` です。
この版の開発とリリースは今後 dsh-cli リポジトリで管理します。

## ロードマップ

- **M2** *（実装済み）* — dsh-cli との連携：`/provider` の OAuth 項目、
  `/login` のアカウント欄、最近使ったモデルを固定表示するグループを備えた
  2 階層の `/model` 選択画面。
- **M3** — `dsh-ecosystem-spec` への準拠（マニフェストの検証、
  受け入れテスト用の fixture）、残る pi-ai の OAuth プロバイダー
  （GitHub Copilot、Kimi）への対応、コミュニティ一覧への登録。
- **M4** — Gemini：独自の Google デバイスコード認証フロー。
  pi-ai には実装がないため、この部分だけ独自に実装する予定です。

## ライセンス

[MIT](LICENSE)。元の ccch1mneyyy の著作権表示を残し、独自開発分について
dkc の著作権表示を追加しています。

## OpenCode Zen／Go のモデル更新

Zen／Go は dsh-auth 専用アダプターと同梱 SDK で通信し、ホストの pi の
モデル定義を参照しません。公式 `/models` と対応ルートの models.dev 情報を
1時間ごとに更新します。起動時は検証済みキャッシュまたは同梱情報を使い、
取得失敗時も最後の一覧を維持します。情報不足・非対応モデルは理由付きで
除外し、別モデルの設定や別ルートの料金で補いません。

- `/auth models [provider]`：最終更新日時・情報源・除外理由
- `/auth refresh [provider]`：手動更新
- キャッシュ：`$DSH_HOME/dsh-auth/catalog-v1/`（認証情報を含まない）

既存のキー・プロバイダー ID・容量設定は引き続き利用できます。対応済み
通信方式の新モデルには pi の更新が不要です。新しい通信方式への対応には
パッケージの更新が必要です。auth 0.2 では pi 専用構築ヘルパーを内部に移し、
公開連携には `DshAuthApi` と DSH アダプターを使用します。

<p align="center">
  <img src="docs/assets/readme/logo-en.svg" alt="dsh-cli のピクセルクジラのアニメーションロゴ" width="560">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_ZH.md">简体中文</a> | <strong>日本語</strong>
</p>

<p align="center">
  <a href="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="公開ベータ版" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/askdkc/dsh-cli/stargazers"><img alt="GitHub スター数" src="https://img.shields.io/github/stars/askdkc/dsh-cli?style=flat-square&color=4b6fff"></a>
</p>

# dsh-cli

> DeepSeek Harness 向けの対話型ターミナル UI プラグインです。

このリポジトリは [chimney 氏の dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)
を基に dkc が独自に開発する fork 版です。

## 画面プレビュー

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-en-mobile.svg">
    <img src="docs/assets/readme/preview-en.svg" alt="ピクセルクジラのアニメーションを含む dsh-cli の操作画面。" width="78%">
  </picture>
</div>

## 主な機能

- Markdown のストリーミング表示、ツールカード、画像、Mermaid 図、キー操作による補完。
- ピクセルクジラ、作業状況、コンテキストバー、TPS メーター、クリックできるタイムライン。
- セッションの再開、分岐、巻き戻し、バックグラウンド実行、エクスポート。
- DSH の preset、skill、MCP、goal、subagent、プロバイダー認証、拡張機能。
- OpenAI、Claude、Opencode、Openrouter、Hermes Agennt、Infron認証をサポート。
- 長いセッション向けの仮想化表示と上限付きキャッシュ。

## クイックスタート

[Node.js](https://nodejs.org/en) `^22.19 || >=24`、pnpm 11、依存関係をインストール済みの
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ソース checkout、
`DEEPSEEK_API_KEY` が必要です。基本的にDSH最新版サポートを目指します。
互換性はインストール済みパッケージと上流の既定ブランチで検証し、対応版のリストは設けません。詳細は [ADAPTER.md](ADAPTER.md) を参照してください。

サブモジュール解決のため再帰的に clone してください。既存の checkout では、インストール前に
`git submodule update --init --recursive` を実行してください。

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

`~/DIR/TO/deepseek-harness` は実際の checkout パスに置き換えてください。
初回の対話型起動で `dsh-cli` が登録されます。新しいシェルを開けば、
プロジェクトのディレクトリから起動できます。この fork を更新するときは
tarball を再ビルドして再インストールしてください。`/update` は registry から更新します。

ローカルの tarball を更新するときは、パッケージ名付きの `@askdkc/dsh-cli@file:...` 形式を使ってください。
tarball のパスだけを渡すと、pnpm が以前の `file:` 依存を先に解決し、削除済みのアーカイブを
読み込もうとして `ENOENT` になる場合があります。`TARBALL` はアーカイブの絶対パスを保存する変数です。
直接実行せず、インストールコマンドの引数として渡してください。

PATH の設定やインストール時の問題は[インストールガイド](docs/getting-started.en.md)を参照してください。

## 使い方

`Enter` で送信、`Tab` で補完、`Ctrl+Enter` で中断して送信します。
`Esc` を 2 回押すと巻き戻せます。ショートカットは `?` で確認できます。

作業状況の表示は、受け付けた依頼文に合わせて英語・日本語・中国語に切り替わります。
言語を判別できない短文では、その会話で直前に使った言語を維持します。
画面のほかの部分は `/lang` で切り替えます。

`/resume` でセッション管理画面を開き、`/auth` でプロバイダーに接続、
`/model` でモデルを選びます。`/bg` でバックグラウンドに移したセッションは
TUI の終了時に停止します。詳しくは[操作・コマンド一覧](docs/interaction.en.md)を参照してください。

`/model` はお気に入り・最近使用・プロバイダー別のモデル選択画面を中央に開きます。
`/model seek deep` は語順に依存しない検索で開き、完全な
`/model provider/model-id` は直接切り替えます。選択画面では `Ctrl+F` で
お気に入りを切り替え、`Ctrl+A` でプロバイダーに接続し、`Esc` で閉じます。

Claude Code、Codex、OMP、zcode、Grok Build の会話を取り込むには、
`dsh-cli migrate` で対象を確認し、`dsh-cli migrate <agent> [--dry-run]` を実行します。
ツールの実行履歴は取り込みません。詳しくは[セッション移行ガイド](docs/migrate.en.md)を参照してください。

## ドキュメント

- [インストール](docs/getting-started.en.md) · [VS Code](docs/vscode.en.md)
- [操作](docs/interaction.en.md) · [設定](docs/configuration.en.md) · [テーマ](docs/themes.en.md)
- [アーキテクチャと制限](docs/architecture.en.md) · [ドキュメント索引](docs/README.md)
- [プラグイン開発](docs/plugins.en.md) · [コントリビューション](docs/contributing.en.md)

## 謝辞

ピクセルクジラの手描き 22 フレームと待機中のアニメーションは、
[@lhh010](https://github.com/lhh010) による
[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale) から移植しました
（BSD-3-Clause）。素敵な作品をありがとうございます 🐋💜

関連するコミュニティやツールは[リンク集](docs/links.md)を参照してください。

## ライセンス

[MIT](LICENSE)。原著作者 chimney 氏の著作権表示を残し、独自開発分について
dkc の著作権表示を追加しています。

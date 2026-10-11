<p align="center">
  <img src="docs/assets/readme/logo.svg" alt="dsh-cli 像素鲸鱼标题动画" width="560">
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong> | <a href="README_JA.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/askdkc/dsh-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="公开测试版" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/askdkc/dsh-cli/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/askdkc/dsh-cli?style=flat-square&color=4b6fff"></a>
</p>

# dsh-cli

> 面向 DeepSeek Harness 的交互式终端 UI 插件。

本仓库是 dkc 基于 [chimney 的 dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)
独立开发的 fork。

## 界面预览

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-zh-mobile.svg">
    <img src="docs/assets/readme/preview-zh.svg" alt="带有像素鲸鱼动画的 dsh-cli 操作界面。" width="78%">
  </picture>
</div>

## 功能亮点

- 流式 Markdown、工具卡、图片、Mermaid 图表和键盘补全。
- 像素鲸鱼、实时工作状态、上下文进度条、TPS 仪表和可点击的时间轴。
- 会话恢复、分支、回溯、后台运行与导出。
- DSH 预设、技能、MCP、目标、子代理、提供商认证和扩展。
- 支持 OpenAI、Claude、OpenCode、OpenRouter、Hermes Agent、Infron 认证。
- 为长会话提供虚拟化渲染和有界缓存。

## 快速开始

需要 [Node.js](https://nodejs.org/zh-cn) `^22.19 || >=24`、pnpm 11、
已安装依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
源码检出，以及 `DEEPSEEK_API_KEY`。目标是支持最新版本的 DSH。
兼容性通过已安装包和上游默认分支验证，不维护发布版本白名单；详见 [ADAPTER.md](ADAPTER.md)。

请递归克隆以获取子模块；已有检出应在安装前运行
`git submodule update --init --recursive`。

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

将 `~/DIR/TO/deepseek-harness` 换成实际检出路径。首次交互启动会注册
`dsh-cli`；打开新终端后，即可从项目目录运行。更新本 fork 时，请重新构建
并安装 tarball。`/update` 会从 registry 更新。

更新本地 tarball 时，使用带包名的 `@askdkc/dsh-cli@file:...` 格式。只传入 tarball
路径时，pnpm 可能先解析旧的 `file:` 依赖；若旧归档已删除，就会报 `ENOENT`。
`TARBALL` 保存归档的绝对路径，应传给安装命令，不要直接执行它。

PATH 设置与安装问题见[安装指南](docs/getting-started.md)。

## 使用

`Enter` 发送、`Tab` 补全、`Ctrl+Enter` 打断并发送；连按两次 `Esc` 回溯。
按 `?` 查看快捷键。

工作状态行会根据每次已接受的请求自动使用英语、日语或中文。无法判断语言的短句
沿用当前会话上一次的状态语言；`/lang` 单独控制界面其他部分。

`/resume` 打开会话管理界面，`/auth` 连接提供商，`/model` 选择模型。
通过 `/bg` 转入后台的会话会在 TUI 退出时停止。完整说明见[交互与命令](docs/interaction.md)。

`/model` 打开居中的模型选择界面，按收藏、最近使用和提供方分组显示。
`/model seek deep` 使用不依赖词序的搜索；完整的 `/model provider/model-id`
直接切换。选择界面中按 `Ctrl+F` 收藏、`Ctrl+A` 连接提供方、`Esc` 关闭。

要导入 Claude Code、Codex、OMP、zcode 或 Grok Build 的对话，先运行
`dsh-cli migrate` 查看可导入的记录，再运行 `dsh-cli migrate <agent> [--dry-run]`。
工具调用不会导入。详见[会话迁移](docs/migrate.md)。

## 文档

- [安装](docs/getting-started.md) · [VS Code](docs/vscode.md)
- [交互](docs/interaction.md) · [配置](docs/configuration.md) · [主题](docs/themes.md)
- [架构与限制](docs/architecture.md) · [文档索引](docs/README.md)
- [插件开发](docs/plugins.md) · [贡献指南](docs/contributing.md)

## 致谢

像素鲸鱼的 22 帧手绘图和待机动画移植自
[@lhh010](https://github.com/lhh010) 的
[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)（BSD-3-Clause）。
感谢这些作品与灵感 🐋💜

相关社区与工具见[友情链接](docs/links.md)。

## 许可证

[MIT](LICENSE)。保留原作者 chimney 的版权声明，并为本 fork 的独立开发
加入 dkc 的版权声明。

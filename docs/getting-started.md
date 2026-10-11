# 安装与快速开始

[文档索引](README.md) · [English](getting-started.en.md)

## 前置条件

- Node.js `^22.19 || >=24`。CI 使用 Node 24。
- 官方 DeepSeek Harness CLI：`@deepseek-ai/dsh`。
- `pnpm` **10 或更高**（CI 使用 11）。`dsh plugin` 把 profile 内的包安装
  交给 pnpm；pnpm 9 的传递依赖提升行为不同，会让 `dsh-working-activity`
  解析不到，表现为启动后立刻退出且几乎无报错（issue #60，见下方常见问题）。
- 支持交互输入的终端 TTY。`dsh-cli` 不支持把 stdout 重定向后启动。
- `DEEPSEEK_API_KEY`。用自定义兼容端点时还可设置 `DEEPSEEK_BASE_URL`。

macOS/Linux：

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

不要把真实密钥提交到仓库。正常的 profile 启动直接读取环境变量。

## 安装

最快路径（全局安装后自带 `dsh-cli` 直达命令）：

```sh
# 官方 CLI + 本插件
npm install -g @deepseek-ai/dsh @askdkc/dsh-cli

# pnpm 未安装时任选一种方式（首次启动自动初始化 profile 时需要）
npm install -g pnpm
# 或：corepack enable pnpm

# 启动：首次运行自动执行 dsh plugin --profile dsh-cli add @askdkc/dsh-cli@<版本>
dsh-cli
```

手工分步（等价）：

```sh
npm install -g @deepseek-ai/dsh

# pnpm 未安装时任选一种方式
npm install -g pnpm
# 或：corepack enable pnpm

dsh plugin --profile dsh-cli add @askdkc/dsh-cli
dsh --profile dsh-cli   # 或 dsh-cli
```

从仓库检出运行时，也可以执行：

```sh
sh install.sh /path/to/askdkc-dsh-cli-<version>.tgz
```

`install.sh` 检查 `dsh`、`pnpm`，通过 profile 插件命令安装指定的 tarball；
它不会复制源码。

## 可选的 Kiokuko Lisp 工作流

将 Kiokuko 安装到与 dsh-cli **相同**的 profile：

```sh
dsh plugin --profile dsh-cli add github:askdkc/kiokuko-dsh
```

在 profile 的 patch 中配置现有的 `kiokuko-dsh` 条目，然后重启：

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

需要可工作的 SBCL；Linux 还需要启用命名空间的 Bubblewrap。通过 Kiokuko 配置
Jev 凭据，或按[决策指南](https://github.com/askdkc/kiokuko-dsh/blob/main/docs/typed-decisions.md)
选择并配置已运行的 Laya worker。不会自动安装运行时或启动 worker。

输入普通请求，例如 `検索機能を実装して`。Jev/Laya 接受编程分类后，现有问题面板
会询问是否使用 Lisp。选择 **Lispモードを使う（通常実行）**、
**Lispモードを使わない** 或 **取消・作業を保持**。回答后且启动成功才开始编程。
自由输入用于讨论或纠正。启用或拒绝的选择在会话内保留，不会每轮重复询问。
意图不明确时保留原有任务确认流程。

模型运行时，`/kioku-lisp`（状态）、`status`、`diagnostics`、`hot`、`cancel` 和
`recover` 仍直接交给命令处理器。用 `/kioku-lisp cancel` 停止 Lisp 操作，再用
`/kioku-lisp recover` 显式恢复。`enable`、`enable-task`、`disable`、`abandon` 和
`restore` 需等待当前轮结束；输入保留供编辑。键盘发送、补全点击和展开编辑器遵循
相同规则。也可手动执行 `/kioku-lisp enable`。文件变更仍需 Kiokuko 的批准。

两个包都必须包含此集成修改。GitHub 安装读取已提交的源码，无法安装本地未提交的修改。

## 从旧包迁移

早期版本使用无 scope 包 `dsh-cc-tui` 和 `cc-tui` profile：

- 环境变量前缀为 `CC_TUI_*`/`DSH_CC_*`。
- 数据目录为 `~/.dsh-cc`。

此分支使用 `dsh-cli` 包与 `dsh-cli` profile。

如果这个 profile 已安装 `@deepseek-harness-tui/dsh-cli`，先移除旧包。
`plugin update` 不会把旧包重命名为 `dsh-cli`：

```sh
dsh plugin --profile dsh-cli remove @deepseek-harness-tui/dsh-cli
```

然后安装 `dsh-cli`：

```sh
dsh plugin --profile dsh-cli add @askdkc/dsh-cli
dsh --profile dsh-cli
```

新版本只使用 `DSH_CLI_*` 环境变量与 `~/.dsh-cli` 数据目录，旧名不再被读取，
也不自动迁移数据。首次启动后，请把旧数据目录（`~/.dsh-cc` 等）中的主题、
配置与历史文件自行复制到 `~/.dsh-cli`。

确认新 profile 正常后：

- 旧的 `$DSH_HOME/profiles/cc-tui` 与旧数据目录残留可按需删除。
- 不要把旧包和新包同时添加到同一个 profile。

## 安装命令做了什么

首次执行 `dsh plugin --profile dsh-cli add @askdkc/dsh-cli` 时，
官方 CLI 会：

1. 在 `$DSH_HOME/profiles/dsh-cli/` 初始化 profile。未设置 `DSH_HOME` 时，
   默认根目录通常是 `~/.dsh`。
2. 让 profile 的第一层 bundle 使用 `@deepseek-ai/dsh-base`。
3. 在 profile 内通过 pnpm 安装 `dsh-cli`。
4. 读取包内 `dsh.bundle.patch` 元数据，将 `cordis.patch.yml` 追加为组合层。

启动时的主要顺序是：

```text
dsh-base -> 其他 bundle -> dsh-cli patch -> 用户 profile patch
```

- base 提供 Agent、模型、会话、文件、Shell、策略和注册表等服务。
- 本插件的 patch 覆盖或插入 TUI、Agent preset 名册、SQLite 会话持久化与
  工作状态行。

`dsh-working-activity` 已经是本包依赖，并由 `dsh-cli` 的 patch 自动插入。
不要对同一个 profile 再单独执行 `add dsh-working-activity`，否则可能出现重复行。

## 启动

```sh
dsh --profile dsh-cli
```

命令从当前目录启动，因此 Agent 的默认工作区也是当前目录。进入目标项目目录后再
启动即可。

Windows 仓库检出还提供：

```bat
dsh-cli.cmd
dsh-cli.cmd --resume
```

- `--resume` 会读取 `%USERPROFILE%\.dsh-cli\resume.txt`，恢复 TUI 最近选择的
  会话。
- 设置 `DSH_CLI_WORKSPACE` 可以覆盖批处理启动器采用的工作目录。

## CLI 子命令

`dsh-cli help`（或 `dst help`）打印完整用法，`dst` 别名接受相同命令：

| 命令 | 作用 |
| --- | --- |
| `dsh-cli update` | 更新 profile 到最新版本并对齐启动器（与 TUI 内 `/update` 同一安装逻辑，不进入 TUI） |
| `dsh-cli doctor` | 环境检查：dsh/pnpm、profile 安装与版本对齐、API key 是否设置（只报状态不读值）、配置文件存在性；与 TUI 内 `/doctor` 会话诊断互补 |
| `dsh-cli safe` | 安全模式：只读诊断、插件清单与修复指引（`safe --rescue` 还会创建/校验干净的救援 profile） |
| `dsh-cli version` | 显示启动器与 profile 版本（`--version`/`-v` 等价） |
| `dsh-cli help` | 显示用法（`--help`/`-h` 等价） |

`help`/`version` 在 dsh 缺失或 profile 未初始化时也能用；其余参数原样转发给
`dsh --profile dsh-cli`。

## 安全模式（`dsh-cli safe`）

dsh 意外结束时，安全模式提供只读的环境诊断、profile 插件清单与修复指引。

- **两个入口**：手动运行 `dsh-cli safe`；或 dsh 非零退出后按提示进入。
  - 提示仅出现在交互终端；脚本/管道只加一行提示、退出码不变。
  - 只覆盖最终 dsh 子进程的非零退出码，不含启动挂起（启动失败按退出码 1）。
- **只读边界**：诊断/清单/指引不改状态。两个例外：
  - 重试正常启动。
  - 创建/复用救援 profile，只写 `$DSH_HOME/profiles/dsh-cli-safe/`。
  注：每次 dsh 启动仍会写 `$DSH_HOME/profiles/node_modules` 回退链接与
  pnpm 全局 store（非安全模式引入）。
- **救援 profile 必须干净，证不出就拒绝**。逐条校验，任一不成立即拒绝：
  - 候选目录已存在，但不是可识别的 profile。
  - 既有 profile 的根 manifest 声明了第三方插件。
  - `$DSH_HOME/cordis.patch.yml`（home 层）**存在即拒绝**。
  - `dsh-cli-safe/cordis.patch.yml`（profile 层）**有条目即拒绝**；dsh 默认
    生成的「注释 + `[]`」不算条目。
  删除/重建救援 profile 前会**按名字与形态核对顶层条目**，发现别的名字或
  形态不符就拒绝并列出，**不会静默删你的文件**。
- **非交互**：`dsh-cli safe --rescue` 跑同一套门禁与创建/复用，只报结论
  （就绪退出 0，拒绝退出 1）。
- **旧全局启动器**：profile 副本不可读或过旧时，先升级：
  `npm install -g --legacy-peer-deps @askdkc/dsh-cli@<版本>`。
- **修复命令需自行执行**（安全模式只列出）：
  - `dsh plugin --profile dsh-cli remove <第三方插件>` 逐个移除可疑插件；
  - `dsh plugin --profile dsh-cli add @askdkc/dsh-cli@<版本>`
    重装对齐；
  - `dsh-cli doctor` 环境诊断。

## 在 VS Code / Herdr 中运行

- **VS Code**：可在集成终端直接运行，或用已上架 Marketplace 的 companion 扩展
  `dsh-tui-vscode`（真实终端会话、会话历史、指定会话恢复、IDE 选区通道）。
  见 [VS Code 使用指南](vscode.md)。
- **Herdr**：直接在 [Herdr](https://herdr.dev) 窗格中运行 `dsh-cli`，无需额外
  配置；dsh-cli 经 Herdr 本地集成 API 报告 `idle` / `working` / `blocked`
  （问卷与工具审批记为 `blocked`），在 Herdr 之外不做任何事。

## 更新到最新版本

项目迭代很快，更新复用安装命令，显式指定 `@latest`：

```sh
# 更新 Profile runtime（TUI 内 /update 做的就是这件事）
dsh plugin --profile dsh-cli add @askdkc/dsh-cli@latest
```

通过全局 `dsh-cli` 命令启动时，还需要让 Launcher 对齐（TUI 内的
`/update` 只更新 profile，不会动全局安装）：

```sh
npm install -g @askdkc/dsh-cli@latest
# 或（原本用 pnpm 全局安装时）
pnpm add -g @askdkc/dsh-cli@latest
```

- 不带 `@latest` 时 pnpm 会按 profile `package.json` 里已记录的版本范围
  （如 `^0.1.4`）就地解析，可能停留在旧的主线上——这是"重复执行安装命令
  但版本没变"的常见原因。
- 修复"版本不一致"时，优先使用启动器打印的"精确版本"命令（例如
  `npm install -g @askdkc/dsh-cli@0.8.3`）；日常主动升级才
  使用 `@latest`。
- 确认生效：启动横幅右上角显示当前版本（`✦ dsh-CLI vX.Y.Z`）。
- 用户覆盖层 `cordis.patch.yml` 在更新中原样保留。
- 会话数据的存放位置可能随版本变化（如 0.3.7 起 `/resume` 改用与 dsh web
  共享的 JSONL 会话库），跨大版本更新后旧会话不在列表属预期，原数据不会被删除。

### pnpm 安装脚本拦截与异平台原生包

若 `dsh plugin` 安装时报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥11 默认阻止带
安装脚本的依赖，如 `@google/genai`、`protobufjs`——这些脚本运行时不需要，
忽略即可），在 profile 的 `pnpm-workspace.yaml` 里加入：

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

`/update` 与 `dsh-cli update` 会自动写入这份配置，无需手工处理。

更新时还会维护 `ignoredOptionalDependencies`（忽略异平台的 `@img/sharp-*`
原生包）：

- sharp 以全平台可选依赖分发，不处理时 `pnpm update` 会把各平台二进制一起
  下载（实测约 200MB）。
- 名单每次更新按当前平台重算，异平台原生包不再下载（当前平台原生包与无平台
  归属的 wasm 回退包保留）。
- 把 profile 搬到别的平台或 musl 容器后，在那台机器上跑一次更新即可刷新。
- 老 profile 的 lockfile 里仍写着全平台条目，第一次更新会照旧下载一遍，之后
  才被忽略。
- 块内不属于这两张平台表的条目（`fsevents`、自己写的 `@img/sharp-wasm32`
  豁免）原样保留；需要 pnpm 支持该键，不认识的版本不会因此报错，只失去这项
  收益。

## Profile 配置

用户覆盖文件位于：

```text
$DSH_HOME/profiles/dsh-cli/cordis.patch.yml
```

配置一个节点时，`config` 块是整段替换，不是逐字段深合并。复制示例时需要保留
仍然有效的字段。完整说明见[配置参考](configuration.md)。

仓库根目录的 `cordis.yml` 是裸组合示例；正常的 npm/profile 安装以
`cordis.patch.yml` 为准，不需要把根配置复制到 profile。

## 从源码开发

```sh
git clone --recurse-submodules https://github.com/askdkc/dsh-cli.git
cd dsh-cli
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

本仓库有两个子模块，其中 `vendor/dsh-std` 是安装必需：

- `vendor/dsh-std`：`pnpm-workspace.yaml` 把 `vendor/dsh-std/packages/*` 列为
  workspace 包。

`dsh-auth/` 源码由本仓库直接跟踪，并经 `link:` 引入。

漏掉 `--recurse-submodules` 会让必需的 `vendor/dsh-std` 目录为空，
`pnpm install --frozen-lockfile` 直接失败。已经克隆过的检出补一条：

```sh
git submodule update --init --recursive
```

`pnpm build` 会清理忽略入库的 `lib/`，把 `src/` 编译到 `lib/types/`，再运行
构建门禁。

- **Git URL 安装不受支持**（workspace 依赖/子模块/pnpm ≥11 prepare 白名单
  三重阻断）。
- 发布 workflow 也会在打包前显式执行干净编译和包面验证。

真实测试当前源码时，首次使用或正式模型/密钥配置变化后运行：

```sh
pnpm dev:copy-config
```

以后每次修改源码后，一条命令构建、打包、隔离安装并启动：

```sh
pnpm dev
```

`pnpm dev:copy-config` 只复制 `~/.dsh/settings.yaml` 与
`~/.dsh/.credentials.yaml`。Unix 上文件权限设为 `0600`；Windows 使用系统管理的
文件 ACL。

`pnpm dev` 使用独立的 `HOME`、`DSH_HOME` 和会话目录，不覆盖正式
`~/.dsh/profiles/dsh-cli`、`~/.dsh-cli` 或正式会话。默认测试目录：

- Unix：`$XDG_CACHE_HOME/dsh-cli-dev`（未设置时为 `~/.cache/dsh-cli-dev`）。
- Windows：`%LOCALAPPDATA%\dsh-cli-dev`。
- 可通过 `DSH_CLI_DEV_ROOT` 覆盖。

不启动 TUI、只验证构建、打包和安装流程时运行：

```sh
pnpm dev:test
```

CI 还会运行三条渲染回归：

```sh
node --import tsx/esm scripts/repro-askpanel.tsx
node --import tsx/esm scripts/verify-askpanel-layout.tsx
node --import tsx/esm scripts/repro-toolcards.tsx
```

`pnpm tui` 调用的 `scripts/run.ts` 直接组合 DeepSeek Harness 源码 patch，默认
假设包位于 Harness monorepo 的 `packages/*` 布局中；独立 checkout 需要另外
设置 `DSH_CLI_DEV_WORKSPACE` 指向 Harness 根目录。只测试本仓库当前源码时，
优先使用上述 `pnpm dev`，它会走与用户安装一致的 profile 路径。

## 常见问题

### Git URL 安装报错

Git URL（如 `https://github.com/askdkc/dsh-cli`）安装不受支持，报以下错误码：

- `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`
- `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`

三重阻断：

- 源 manifest 的 `@dsh-std/*` 是 workspace 依赖（git tarball 原样保留，
  profile 内无法解析）。
- `vendor/dsh-std` 是 git 子模块（依赖抓取不带子模块内容，编译必败）。
- pnpm ≥11 默认拒绝 git 依赖执行 `prepare` 构建脚本。

请安装 registry 包：

```sh
dsh plugin --profile dsh-cli add @askdkc/dsh-cli
```

### `dsh-cli requires an interactive terminal`

stdout 不是 TTY。请直接在终端中启动，不要把主进程输出管道到文件或其他命令。

如果 dsh-cli 只是装在某个 profile 里、而实际由 Web / Tauri / GUI 等非终端
宿主启动 DSH，dsh-cli 会检测到 stdout 不是 TTY 且并非由 `dsh-cli` launcher
启动，自动跳过 TUI 前端（不报错、不影响宿主启动）。

只有显式执行 `dsh-cli`（含 standalone 便携版）却没有 TTY 时，才会报上面的
错误。

### 找不到 `dsh` 或 `pnpm`

首次交互运行 `dsh --profile dsh-cli` 时，还会把 `dsh-cli` 注册到
`~/.local/bin`（Windows：`%LOCALAPPDATA%\dsh-cli\bin`），必要时自动将该目录
加入 zsh、bash、fish 或 Windows 的用户 PATH。打开新终端后再运行 `dsh-cli`。
注册失败不会阻止 TUI 启动；按启动警告修复。设置
`DSH_CLI_AUTO_REGISTER_CLI=0` 可关闭注册。撤销时删除生成的命令与
`dsh-cli managed PATH` 区块（Windows 删除用户 PATH 条目）。

从已构建的 Harness 源码 checkout 注册时，生成的命令会保存该 checkout 路径，
作为 `DSH_CLI_DSH_ROOT` 的默认值。之后可从其他目录启动，无需单独全局安装 DSH
或重新加载 Shell 配置。Harness 的 `plugin add` 安装成功后会更新已有管理命令中的
默认路径。环境中非空的 `DSH_CLI_DSH_ROOT` 优先；自定义命令和符号链接会保留。

确认全局 npm bin 目录在 `PATH` 中，并重新打开终端。`install.sh` 会在安装前
检查这两个命令。

### 启动后立刻退回 shell，几乎没有报错（pnpm 9）

pnpm 9 安装的 profile 里，传递依赖 `dsh-working-activity` 不会被提升到
loader 可解析的位置，模块解析失败导致整棵插件树被回收，TUI 打印 resume
提示后直接退出（issue #60）。升级 pnpm 到 10+ 后重装即可：

```sh
npm install -g pnpm@latest
dsh plugin --profile dsh-cli add @askdkc/dsh-cli@latest
```

### 模型启动失败或提示没有凭证

确认启动 `dsh` 的同一个 Shell 中存在 `DEEPSEEK_API_KEY`。自定义端点同时检查
`DEEPSEEK_BASE_URL`。

### 工作状态行重复

检查 profile 是否曾单独添加 `dsh-working-activity`。保留本包 patch 自动插入的
`working-activity` 行，移除重复 bundle 配置。

### TUI 显示错位或终端退出后状态异常

先运行 `/doctor`，记录终端类型和模式，再参考[交互文档](interaction.md)与
[架构文档](architecture.md)。渲染问题可使用 `DSH_CLI_RENDER_LOG` 采集原始帧，
但日志可能包含会话可见内容，应妥善处理。

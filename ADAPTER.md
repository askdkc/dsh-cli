# Adapter 边界与上游契约

## 边界规则

官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import。
UI 层(`screens/`、`components/`、`ink/`、`hooks/`、`utils/`、`terminal-utils/`)
一律通过 adapter 的 facade(`src/dsh-adapter/types.ts` 的类型 re-export、
`channel.ts`/`plugin.ts` 等运行期服务)间接接触上游。

门禁:`pnpm run verify:boundary`(扫描全部源码,发现越界 import 即失败;
已挂进 `build`)。

## 上游契约

- DSH peer 范围为 `*`；dev 和 standalone host 跟随可移动的 `alpha` 发布通道，不维护版本白名单。
  pnpm 的 frozen-lockfile 检查不允许 `*` 对应 prerelease，所以获取依赖使用 dist-tag。
  兼容性由实际 API、类型和 patch 所有权验证。
- `verify:contract` 检查 blessed list 中的开发依赖是否存在；Cordis/Schemastery 保留各自的 major 契约。
- 新旧 DSH 版本号本身不触发启动警告或降级提示。缺失 API 仍由 adapter 和集成测试报告。

## Patch Surface

`cordis.patch.yml` 里对官方行的干预已快照到 `patch-surface.snapshot.json`:

- **disabled overrides**：23 行，全部按当前 preset 所有权禁用。
- **config overrides**：8 行，包含 TUI persona、DeepSeek 默认值与隐私设置。
- **inserts**：16 行。共享 host 服务使用 TUI 作用域 id，在官方同 id/name 行
  已启用时自行禁用。preset 使用当前声明式 registry；PTC runtime 由 base 提供。
  不再插入旧目录 roster 或旧 code-runtime 行，不做包版本/缺失 API 分派。

`verify:patch-surface` 的快照只记录 TUI 自己的 inserts/config overrides。
Web 的 insert ID 冲突、禁用所有权和 TUI 与 Web 的有意差异按结构验证，
不按版本索引；上游只改版本号时无需更新快照。
只有 TUI 自己的 surface 有意变化时，审阅后运行
`node --import tsx/esm scripts/verify-patch-surface.ts --snapshot`。
`verify:web-coexistence` 还验证官方服务启用时 TUI 让出所有权，禁用或缺失时由 TUI 提供。

## 上游更新

- manifest 不钉住 DSH 版本；lockfile 记录实际解析结果，普通安装与构建使用 frozen lockfile。
  npm `latest` 标签可能滞后于预发布；更新到 alpha 通道时可用
  `pnpm update:dsh`，保持 peer 的 `*` 和 dev 的 `alpha`，
  再执行 `pnpm install --frozen-lockfile --ignore-scripts` 并提交通过验证的 lockfile。
  同捆插件用 `pnpm --dir dsh-auth update '@deepseek-ai/dsh-*'`，portable 模板用
  `pnpm --dir standalone update @deepseek-ai/dsh`。无需逐版改写 manifest。
- CI `upstream-contract` 检出上游默认分支并记录 commit SHA；源码类型声明来自该 checkout，
  不借用旧 npm 发布版的声明。`DSH_HARNESS_SOURCE_ROOT` 优先，否则使用相邻的
  `deepseek-harness`。显式指定或 CI 必需的源码缺失时失败。
- 旧 SQLite 迁移工具的依赖闭包继续隔离在 `vendor/sqlite-island`，不限制当前 host。
- 上游实际 API 变化在 `src/dsh-adapter/` 内修复；不因版本更新增加旧版分支。
- standalone 从实际安装的 DSH manifest 取得版本和 CLI 入口，使用官方 base + TUI bundle。
  自动生成的旧 patch 可迁移；用户编辑的 patch 和 profile 字段不会被覆盖。

## 当前 API 接缝

前台 shell 使用 `execute(resolve(spec)).result()`，失败不重复执行。
工具结果直接读取 V4 消息的 `content`、`isError` 和 call-ID。
Live Session 使用 `snapshotEvents()`、exclusive `seq` 与 `inheritedEventCount`。
持久化通过 `open(id, 'read')` 读取，并始终关闭 handle；列表消费 `list({ signal })` 的 snapshot。

Loader 行只调度 TUI runtime，Config 仍由原 Loader 行拥有。
设置使用 Config 的 volatile 字段、owner 的 Loader ID 和更新事件，写入当前 profile。
不注册旧 settings.yaml scope。当前 TUI 自定义事件仍在严格读取前注册；
旧 DSH 格式转换由官方 format catalog 负责，TUI 不自带旧 packed-row decoder。

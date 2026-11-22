# pi-subagent

给 pi 补上 **subagent**：模型把一个边界清楚的子任务交给一个拥有独立上下文窗口的子 agent，
子 agent 做完只把最终报告交回来。可以前台等结果，也可以丢到后台、完成时自动唤醒。

> **当前状态：Phase 1（前台）和 Phase 2（后台、续话、HUD 交互）已实现。** Phase 3（fork 上下文、verifier、worktree）还是设计
> （见 [docs/08-implementation.md](./docs/08-implementation.md) §3）。

## 做什么

- `agent` 工具：模型传 `description`（给用户看的短标签）、`prompt`（自包含的任务）和可选的 `agent_type`，
  插件在**同一进程**里用 pi SDK 起一个全新的子会话跑完任务，只把最后一条 assistant 消息作为结果交回
- 一条回复里调用多次 `agent` 就是并行；所有调用共用一个上限 4 的 FIFO 队列，超出的显示 `queued (n)`
- `background: true`：立刻返回 `ag-N`，完成时以 `<subagent-notification>` 唤醒模型（投递策略同 pi-background-shell：
  空闲时 3 秒合并窗口，忙时在轮次边界一次排出，Esc 中断后不自动起新一轮）。父 agent 被 Esc 中断不影响后台 agent
- `agent_send`：给运行中的 agent 追加指令（下一轮之前送达）、给排队中的拼到任务末尾、把已结束的从会话文件重新打开再跑一轮（上下文完整）
- `agent_stop`：停掉运行中或排队中的 agent，返回部分报告；模型自己停掉的不再通知
- 子会话只加载 `childExtensions` 白名单里的扩展（默认只有 pi-dsweb），工具只给类型 `tools` 里列出的；子会话里根本没有 `agent`，所以只有 1 层
- 内置两个类型：`explore`（只读：`read, grep, find, ls`）和 `general`（`read, bash, edit, write, grep, find, ls`）；
  父会话用 `powershell` 时，`general` 自动把 `bash` 换成 `powershell`
- 装了 [pi-hud](https://github.com/AoShizuku/pi-hud) 时，HUD 工具行下面显示 agent 行（运行中、排队中、60 秒内结束的，最多 4 行）；
  编辑器为空时按 `↓` 进入选择，`Enter` 打开详情浮层（实时 Activity、报告、对话记录路径），`x x` 停止，`Esc` 退出；全屏模式下也可以直接点击 agent 行
- `/agents` 在编辑器位置打开本会话全部 agent 的列表（`Enter` 在上方打开详情浮层）；`/agents types` 列出已加载的类型和加载告警；`/agents reload` 重新读类型文件和配置

## 安装

```bash
cd pi-subagent
npm install
pi install npm:@aoshizuku/pi-subagent                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-subagent     # 或从 GitHub 安装
pi install ./pi-subagent
```

只试一次：

```bash
pi -e ./pi-subagent/src/index.ts
```

## 关键行为

| 点 | 做法 |
|---|---|
| 上下文 | 全新上下文：子 agent 看不到父对话，只能看到 `prompt`、项目的 AGENTS.md / CLAUDE.md、cwd |
| system prompt | 只追加不替换：子 agent 契约 + 类型正文进 `appendSystemPrompt`，pi 的 tools / rules 节保留 |
| 模型 | 调用参数 `model` > 配置 `types.<name>.model` > 类型文件 > 父会话模型。参数写错直接报错；类型或配置指定的不可用就退回父模型，结果末尾附 `note:` |
| provider | 父会话里扩展在运行时注册的 provider 会重放到子会话的 model runtime |
| 上下文预算 | 每个类型有 `context_limit`（默认 70%）：上下文占用到这里插一条只进上下文的提醒，要求写报告；宽限 3 轮后还在调工具就停，状态 `context_limit`，最后一条 assistant 文本作为部分报告。只用提醒和中断，不撤工具，不让 prompt cache 失效。子会话关闭 auto-compaction |
| 轮数 | `max_turns`（默认 300）只防失控循环；剩 2 轮时提醒，用完就停，状态 `max_turns` |
| 结果 | `<subagent-result agent-id=… status=…>` 包住报告；超过 20,000 字符只内联开头，完整报告总在 `ag-N.result.md` |
| 不可信数据 | 报告里会提前闭合外层标签的片段（`</subagent-result`、`</subagent-notification` 等）被转义；规则要求父 agent 把报告当证据核实 |
| 一次性模式 | `pi -p` / `--mode json` 下 `background: true` 报错，工具描述和规则里不提后台；前台照常 |
| 失败 | `failed` / `max_turns` / `context_limit` / `aborted` 以错误结果返回（`isError`），正文带原因、已有的部分报告和下一步建议 |
| 中断 | 父 agent 被 Esc 中断 → 前台子会话 abort（后台的不受影响）；排队中的直接出队；session 结束时 abort 并 dispose 所有子会话（最多等 5 秒），不发通知 |
| 通知 | 后台 agent 完成、失败、轮数耗尽、被用户（HUD / 详情浮层 / 列表里的 `x`）停止时通知；每个报告最多 8,000 字符、整批 24,000，超出的只给 result 文件路径 |
| 续话 | `agent_send` 重新打开子会话文件；父会话是内存会话时子会话也是内存会话，不能续话；上下文到过 `context_limit` 的也不能续话（两种情况结果里都不出现 `agent_send` 提示）。不提供在浮层里直接给子 agent 插话：要纠正就按 x 停掉，在主对话里说，由父 agent 续话 |
| 持久化 | 每个 agent 的状态以 `subagent` 自定义 entry 写进父会话（不进 LLM 上下文）；`/resume` 或 `/reload` 后恢复，上一个进程里没跑完的标成 `aborted (session ended)`，编号接着往后排 |
| 文件 | 子会话文件和结果文件在 `<sessionDir>/subagents/<parentSessionId>/`，不会出现在 `/resume` 列表；父会话是内存会话时结果文件放到系统临时目录。其他父会话的目录超过 `retentionDays`（14 天）没有更新就整个删掉 |

## 自定义类型

Markdown + YAML frontmatter，放在 `~/.pi/agent/agents/*.md`（用户）或 `<项目>/.pi/agents/*.md`（项目，仅在项目受信任时加载）。
同名时项目 > 用户 > 内置，名字不区分大小写。

```markdown
---
name: api-tracer
description: Traces how an HTTP endpoint is handled, from route registration to the database call.
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: low
context_limit: 60
---

You trace a single HTTP endpoint through the codebase. ...
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 文件名 | `[a-z0-9][a-z0-9_-]*` |
| `description` | 必填 | 一行，进 `agent` 工具描述 |
| `tools` | `read, bash, edit, write, grep, find, ls` | pi 内置工具，或 `childExtensions` 里的扩展注册的工具（如 `web_search`；扩展没加载时忽略）；`none` 表示不给工具 |
| `model` / `thinking` | 继承父会话 | |
| `context_limit` | 70 | 10–95，窗口百分比 |
| `max_turns` | 300 | ≥ 2，防失控的兜底 |
| `context_files` | `true` | 是否加载 AGENTS.md / CLAUDE.md |
| `skills` | `false` | 是否加载 skills |
| `background` | `false` | 调用方没传 `background` 时的默认值（`print` / `json` 模式下不生效） |
| `enabled` | `true` | `false` 可以禁用同名的低优先级类型 |

类型列表只在 session 开始时读一次（改了文件用 `/agents reload`），避免会话中途改动工具描述打掉 prompt cache。

## 配置

`~/.pi/agent/pi-subagent.json`（可选，只有全局配置）：

```json
{
  "types": { "explore": { "model": "deepseek/deepseek-flash", "thinking": "low", "context_limit": 60 } },
  "maxConcurrent": 4,
  "resultMaxChars": 20000,
  "notifyMaxChars": 8000,
  "notifyBatchMaxChars": 24000,
  "retentionDays": 14,
  "childExtensions": ["pi-dsweb"],
  "confirmStop": true
}
```

`confirmStop`：HUD 焦点模式、`/agents` 列表和详情浮层里，`x` 要按两次才停止 agent（类似 vim 的 `dd`）。
第一次 `x` 让选中行变成红色竖标加错误底色，提示行换成 `press x again to stop`；再按 `x` 才停，按其他任何键都只取消。
默认 `true`，设为 `false` 回到按一次就停。

`childExtensions`：子会话可以加载的扩展（包名，如 `"pi-dsweb"`，或扩展目录的绝对路径）。不带 scope 的名字按末段匹配，`"pi-dsweb"` 同时认得 `npm:@aoshizuku/pi-dsweb`、`git:github.com/AoShizuku/pi-dsweb` 和本地目录。默认是 `["pi-dsweb"]`，
写 `[]` 则子会话不加载任何扩展。非空时 pi 会先加载所有已安装的扩展再按名单过滤（被过滤掉的扩展的工厂函数仍会执行一次）；
本插件、pi-ask-user、pi-autotitle、pi-hud、pi-bettertui、pi-background-shell 无论怎么写都会被剔除。

扩展加载进来**不等于**工具给了子 agent：一个类型只拿到它的 `tools` 里写了名字的扩展工具。内置的 `explore` 和 `general`
都列了 `web_search, web_fetch`，所以装了 [pi-dsweb](https://github.com/AoShizuku/pi-dsweb) 时它们能搜网页、读网页；没装时这两个名字被忽略。

## 键盘与鼠标（需要 pi-hud）

| 位置 | 按键 | 作用 |
|---|---|---|
| 编辑器为空、HUD 有 agent 行 | `↓` | 进入 agent 行选择（选中行左栏出现 accent 竖标、铺满主题的选中底色，下方出现提示行） |
| 选择中 | `↑` / `↓` | 移动；在第一行按 `↑` 退出 |
| 选择中 | `Enter` | 打开详情浮层，关闭后回到选择 |
| 选择中 | `x` `x` | 第一次进入确认（红色竖标 + 错误底色，提示行变成 `press x again to stop`），第二次停止选中的 agent（会通知模型） |
| 确认中 | `↑` / `↓` | 取消确认并移动 |
| 确认中 | 其他任何键（`Esc`、`Enter`、打字） | 只取消确认，按键被吞掉，留在选择里 |
| 选择中 | `Esc` | 退出选择（**不会**中断主 agent） |
| 选择中 | 其他键 | 退出选择，按键照常进编辑器 |
| 详情浮层 | `↑↓` / `PgUp` `PgDn` / 滚轮、`e`、`x x`、`c`、`Esc` | 滚动、展开 prompt、停止、复制 `pi --session <对话记录>` 命令、关闭 |
| `/agents` 列表（底部） | `↑↓`、`Enter`、`x x`、`Esc` / `q` | 选择、在列表上方打开详情浮层（关闭后回到列表）、停止、关闭 |

列表和详情浮层里的确认规则和选择模式一样：移动键取消并移动，其他键只取消（`Esc` 不会顺带关掉列表或浮层）。
`confirmStop: false` 时 `x` 按一次就停。
| 全屏模式 | 点击 agent 行 / `+N more` | 打开详情浮层 / 底部列表 |

选择模式在这些情况下自动退出：没有 agent 行了、`/hud off`、编辑器里有文字、对话框或选择器拿走了键盘、30 秒没有按键。

## 开发

```bash
npm install
npm run check   # tsc --noEmit + vitest
```

单元测试用假的子会话工厂，不调用模型；`src/child.integration.test.ts` 用真实的 pi SDK 加 pi-ai 的 faux provider
跑完整的子会话（工具集、system prompt、会话文件、轮数预算、abort、后台通知、`agent_send` 续话、`agent_stop`），全部在临时目录里，不碰 `~/.pi`。
全屏模式下的鼠标点击和真实 TUI 里的焦点行为只能手动验证（清单见 docs/08 §5）。

## 文档

| 文档 | 内容 |
|---|---|
| [DESIGN.md](./DESIGN.md) | 总览：目标、核心结论、架构、分阶段、不做什么、待定问题 |
| [docs/01-research.md](./docs/01-research.md) | 上游调研：Claude Code、codex、minimax-code、pi 官方 example、两个 pi-subagents |
| [docs/02-runtime.md](./docs/02-runtime.md) | 子会话运行时：同进程 SDK 会话、资源加载、扩展、模型、递归防护、abort |
| [docs/03-tools-and-prompts.md](./docs/03-tools-and-prompts.md) | 工具面（`agent` / `agent_send` / `agent_stop`）、返回格式、写给模型的规则 |
| [docs/04-agent-types.md](./docs/04-agent-types.md) | agent 类型定义：文件格式、发现、内置类型、能力只减不增 |
| [docs/05-context-and-results.md](./docs/05-context-and-results.md) | 上下文交接（fresh / fork）、结果回传、截断、不可信数据 |
| [docs/06-lifecycle-and-notify.md](./docs/06-lifecycle-and-notify.md) | 状态机、并发、后台、通知投递、持久化与恢复、清理 |
| [docs/07-ui.md](./docs/07-ui.md) | 工具卡片、通知渲染、pi-hud 里的 agent 行、↓ 键盘选择、鼠标点击、详情浮层、`/agents` |
| [docs/08-implementation.md](./docs/08-implementation.md) | 模块划分、实现清单、测试计划 |

## 许可

MIT

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# 01 · 上游调研

> 调研对象都是根仓库里锁定版本的 submodule（2026-11-09）。行号引用相对于各仓库根目录。
> Claude Code 部分只描述公开可见的行为。

## 1. 一张表看全貌

| | 子 agent 怎么跑 | 后台 | 子 agent 拿到的上下文 | 层数 | 结果回传 | 体量 |
|---|---|---|---|---|---|---|
| **Claude Code** | 进程内 | 有，完成后推送 `<task-notification>` | 默认全新；`fork` 类型继承完整上下文 | 1 | 最终报告；父 agent 用 `SendMessage` 续话 | — |
| **pi 官方 example** | 子进程 `pi --mode json -p --no-session` | 无 | 全新 | 1 | 最终文本 | 约 1.2k 行 |
| **gotgenes/pi-subagents** | 同进程 SDK 会话 | 有，FIFO 队列（上限 4） | 默认全新；`inherit_context` 把父对话拍平成文本 | 1 | 最终文本，不截断 | 约 1.27 万行 + 89 个测试文件 |
| **nicobailon/pi-subagents** | 前台同进程；后台单独起 runner 进程 | 有，靠文件监听 | 全新，或从父会话真实分叉 | 默认 2 | 最终文本；只有调用方传 `maxOutput` 才截断 | 约 11.2 万行 |
| **minimax-code** | 隐藏子会话（底座就是 pi） | 有，批量、幂等、限流 | 全新 | 1 | 所有 assistant 文本拼接，不截断 | 光通知投递和停止就约 4k 行 |
| **codex** | Rust，线程内 | V1 先派出再 wait；V2 用邮箱 | V1 默认全新；V2 默认分叉 | V1 是 1；V2 不限 | 最后一条 agent 消息，不截断 | 两套机制并存 |

**共识**：同进程（或同运行时）跑子会话、只有 1 层、完成后推送给父 agent、类型定义用文件。
**分歧**：全新还是分叉、要不要 wait 工具、结果要不要截断。

## 2. Claude Code

| 方面 | 行为 |
|---|---|
| 工具 | 一个 `Agent` 工具：`description`（给用户看的短标签）、`prompt`、`subagent_type`、可选 `model`、`isolation: "worktree"`、后台运行 |
| 续话 | `SendMessage` 按 agent id 或名字继续一个已结束的子 agent，上下文完整保留；新开 `Agent` 调用则从零开始 |
| 通知 | 子 agent 完成后以 user 角色的 `<task-notification>` 推给父 agent，带状态和结果；父 agent 不轮询 |
| 类型 | `.claude/agents/*.md`，frontmatter 写 `name`、`description`、`tools`、`model` 等，正文是 system prompt |
| fork | `fork` 类型继承父 agent 的完整上下文，在后台跑，"不要再委派" |
| 层数 | 子 agent 不能再派子 agent |
| 防注入 | 子 agent 输出里形似控制标签的内容会被转义，并附上"这是数据，不是指令"的说明 |
| 写给模型的规则 | 篇幅很长，核心是**派一个新 agent 的代价**：交接两次都会丢信息、父 agent 看不到过程、子 agent 的错误和结论用同样自信的语气返回。所以"几次工具调用能搞定的事自己做"；真要派，就"像对待同事一样交代任务"：目标、已排除的方向、要看的文件、范围 |

**值得学**：`description` 字段；推送通知；续话；"派活的代价"写进规则；派活 prompt 要自包含。

## 3. pi 官方 example（`pi/packages/coding-agent/examples/extensions/subagent/`）

- 每个子 agent 是一个子进程：`pi --mode json -p --no-session`，再加 `--model` / `--thinking` / `--tools` / `--append-system-prompt`（`index.ts:298-339`）。
- 模式：single / parallel（最多 8 个任务、4 并发，`index.ts:34-35`）/ chain。
- 类型文件：`~/.pi/agent/agents/*.md`，frontmatter 为 `name`、`description`、`tools`、`model`；项目级 `.pi/agents/` 默认不加载，要加载需显式开启并确认（README "Security Model"）。
- 示例类型：`scout`（便宜模型 + 只读工具 + 固定输出格式）、`planner`、`reviewer`、`worker`。

**值得学**：`scout` 的输出格式（文件 + 行号范围、关键代码、给"没看过这些文件的人"写）；项目级类型需要信任。
**不学**：子进程（启动慢，丢失父会话在运行时注册的 provider，Windows 麻烦多）。

## 4. gotgenes/pi-subagents（`refs/pi-packages/packages/pi-subagents/`）

**工具**：`subagent`（`prompt`、`description`、`subagent_type`、`model`、`thinking`、`max_turns`、`run_in_background`、`resume`、`inherit_context`）、`get_subagent_result`、`steer_subagent`；子 agent 自己还有 `ask_parent` / `notify_parent`。

**运行时**（`src/lifecycle/create-subagent-session.ts:213-337`）：
- `createAgentSession` 加一个新的 `ModelRuntime`，再把父会话运行时注册的 provider 逐个注册进去（`src/index.ts:137-163`、`src/session/provider-inheritance.ts`）。
- `DefaultResourceLoader` 关掉 context files、prompt templates、themes，用 `systemPromptOverride` 覆盖 system prompt。
- **父会话的所有扩展都会在子会话里重新实例化**，只排除 `excludedExtensionPackages`。文档承认 4 个子 agent 就撑爆过 V8 堆。
- 递归防护：用 SDK 的 `excludeTools` 把自己的三个工具排除掉（`create-subagent-session.ts:44-50`）。

**通知**：`pi.sendMessage` 带 `deliverAs: "followUp"`、`triggerTurn: true`；父会话忙时先压着，等 `agent_settled` 再发；用 claimed / consumed 两个标志保证只投递一次（`src/observation/notification.ts:221-398`）。

**轮数预算**（`turn-limits.ts`）：剩 2 轮时给子 agent 注入一条只进上下文的提醒，到上限再 `session.abort()`。

**用量**：input + output + cacheWrite，**不算 cacheRead**，否则每一轮都会把缓存前缀重复计一次（`usage.ts`）。

**踩过的坑**（直接影响本设计）：

| 坑 | 本设计的对策 |
|---|---|
| 子会话重新实例化所有扩展 → 堆爆 | 默认 `noExtensions`（02 §5） |
| 子会话里重新加载的本插件可能覆盖或删掉父会话挂在 `globalThis` 上的服务（调研报告从代码推断，没有实际验证） | 本插件不挂 `globalThis`；子会话也不加载本插件 |
| `systemPromptOverride` 之后上游还会拼回 AGENTS.md / APPEND_SYSTEM | 不用 override；显式传 `appendSystemPrompt`，已核实这会取代 APPEND_SYSTEM.md 的自动发现（`resource-loader.ts:695-701`） |
| provider 报错不抛异常，只把 `stopReason` 记成 `"error"` | 跑完检查最后一条 assistant 消息的 `stopReason`（02 §7） |
| `session.abort()` 在 run 开始之前调用没有效果 | prompt 前先检查 `signal.aborted`（02 §8） |
| 前台调用被设成串行（"Foreground calls run sequentially"，`agent-tool.ts:198`） | 不设 `executionMode`（03 §2） |
| `inherit_context` 把父对话拍平成文本，丢工具结果 | fork 用真实会话分支（05 §2） |

**值得学**：provider 重放；轮数预算加收尾提醒；只投递一次；用量口径；"born-complete"（工厂返回时会话已完全就绪）；父会话状态在派出时快照，排队的子 agent 不会读到过期状态。

## 5. nicobailon/pi-subagents（`refs/pi-subagents/`）

- 12 个顶层参数 + 一个约 60 字段的不透明 `options` 包；60 多个管理 action；chain 和依赖关系用模型写的 JS 脚本表达，脚本跑在 `--permission` 子进程加两个 `vm` 上下文组成的沙箱里。
- 前台在同一进程（`src/runs/shared/child-session.ts:490-767`）：`noExtensions`、`noSkills`、`noContextFiles`，`bindExtensions({mode: "print"})`。
- 后台每次运行起一个分离的 runner 进程；用文件做控制收件箱（因为 Windows 上 `process.kill` 发 `SIGUSR2` 会抛 `ENOSYS`）；用 `PI_SUBAGENT_CHILD=1` 让子进程里加载的本扩展什么都不做。
- fork：从父会话当前叶子节点生成真实的分支会话文件，原样发送父会话的 system prompt 和工具列表以命中 cache。
- `subagents_enable`：会话开始时只暴露一个很小的加载器工具，模型调用它之后才激活大 schema，避免大 schema 一直挂在 prompt 里。
- 默认不截断内联结果；状态放在 `os.tmpdir()`；每次派出都会调用 `setToolsExpanded(false)`，覆盖用户的展开设置。

**值得学**：前台子会话的组装方式；fork 时为了命中 cache 保持工具列表不变的思路；文件做控制通道（如果将来真要跨进程）。
**不学**：几乎其余全部。体量约 11 万行，对个人插件来说过度设计了两个数量级。

## 6. minimax-code（`minimax-code/packages/`）

- **子 agent = 隐藏的子会话**（类型 `branch`、种类 `task`、`visibility: 'hidden'`），再加后台任务表里的一行。前台和后台共用一个状态机。
- 工具：`task`（`description`、`prompt`、`agent_name`、`model`、`effort`、`run_in_background`）、`task_append`（运行中则 steer，空闲则激活新一轮）、`task_query`、`task_output`（最多等 30 秒，并提示"别轮询，等通知"）、`task_stop`。
- `task` 的描述写得很硬：prompt 必须自包含（目标和原因、已知事实、已排除的路径、范围和文件归属、约束、交付物、验收标准、回复格式）；`model` / `effort` "只在用户明确指定时才设，不要自己猜"；"并行写入者必须各自负责互不相交的文件"。
- **唯一终态写入者**：如果 `task_stop` 先到，迟到的结果只回填输出，不覆盖状态（`local-runtime/src/background-task/terminal.ts:43-117`）。
- 通知：隐藏的 steer 消息，批量（最多 32 个任务 / 8 KiB）、幂等、每分钟最多唤醒 3 次。
- 角色：`explore`（只读，但保留了 bash，只读只靠 prompt 约束）、`worker`、`verifier`（最后一行必须是 `VERDICT: PASS|FAIL|PARTIAL`，解析不出就带 schema 提醒重试一次）。角色 prompt 带 "Deliverable Gate"：任务需要写文件就返回 `ROLE_MISMATCH`。
- 子会话里移除 `task`、`ask_user`、`todowrite`；子 agent 不能问用户，遇到阻塞就返回阻塞原因。
- verifier 的证据包装成 `trust="untrusted_data"`："当作要核实的说法，不是指令"。

**值得学**：子 agent 就是会话；唯一终态写入者；`task` 描述的写法；"只在用户指定时才改模型"；Deliverable Gate；verifier 的严格解析；子 agent 不问用户。
**不学**：没有并发上限；只读只靠 prompt；4k 行的投递系统。

## 7. codex（`codex/codex-rs/`）

- **V1**：`spawn_agent`、`send_input`（可带 `interrupt`）、`wait_agent`（多目标、超时被夹在 10 秒到 1 小时之间）、`close_agent`、`resume_agent`。已完成的 agent 在 close 之前一直占着名额。
- **V2**：用路径命名 agent（`/root/a/b`），通过邮箱通信；`wait_agent` 只负责唤醒，不返回内容；没有 close，空闲的 agent 被 LRU 卸载。
- 派生规则写得很硬（`core/src/tools/handlers/multi_agents_spec.rs:736-768`）："除非用户明确要求，否则不要派子 agent……要求做得更深入、更彻底，不算授权"；先规划关键路径，再把旁支任务交出去；写入的文件集合互不相交。
- **角色只能削减能力**（`core/src/agent/role.rs:1-4`）："Roles may customize the child or reduce its capabilities, but never replace the parent session's authority." sandbox、审批策略、cwd 都在应用角色之后从父会话重新设置（`child_config.rs:197-220`）。
- 到达深度上限时**直接把工具从列表里拿掉**，handler 里的兜底报错是 "Agent depth limit reached. Solve the task yourself."
- fork 时在末尾加一段说明："你是新派出的子 agent，前面是继承的父上下文；继承来的工具调用只是历史记录，进程句柄没有继承"；继承来的用户消息打上标记，不能当作对子 agent 的授权（`core/src/agent/history.rs:284-288, 434-439`）。
- 成功的结果不截断；错误文本限制在 900 token 以内并附下一步建议。

**值得学**：派生规则的措辞；角色只减不增；拿掉工具而不是报错；fork 末尾的说明；继承的用户消息打标记；错误文本附下一步建议。
**不学**：两套系统并存；wait 和 close；邮箱、消息板。

## 8. 借鉴清单

| 做法 | 来源 | 借鉴？ | 本设计中的位置 |
|---|---|---|---|
| 同进程 SDK 子会话 | gotgenes、nicobailon（前台） | ✅ | 02 §1 |
| 子会话不加载扩展 | nicobailon（前台） | ✅ | 02 §5 |
| 重放 provider 注册 | gotgenes | ✅ | 02 §3 |
| 拿掉工具实现深度上限 | codex、gotgenes | ✅ | 02 §6 |
| 推送通知，不 wait | Claude Code、gotgenes、minimax | ✅ | 06 §5 |
| 唯一终态写入者 | minimax | ✅ | 06 §1 |
| 只投递一次 | gotgenes、minimax | ✅ | 06 §5 |
| `description` 参数 | Claude Code、minimax、gotgenes | ✅ | 03 §1 |
| 派活 prompt 必须自包含 | Claude Code、minimax | ✅ | 03 §5 |
| 不主动派、深入不等于授权 | codex | ✅ | 03 §5 |
| 写入文件互不相交 | codex、minimax | ✅ | 03 §5 |
| 只在用户指定时改模型 | minimax | ✅ | 03 §1 |
| 角色只减不增 | codex | ✅ | 04 §4 |
| 只读靠工具白名单，不靠 prompt | （minimax 的反例） | ✅ | 04 §3 |
| 轮数预算加收尾提醒 | gotgenes | ✅ | 02 §9 |
| 子 agent 不问用户，带阻塞原因返回 | minimax | ✅ | 02 §4 |
| 结果上限加落盘 | （codex、nicobailon 的反例） | ✅ | 05 §3 |
| 报告当作不可信数据 | Claude Code、minimax | ✅ | 05 §4 |
| 用量不算 cacheRead | gotgenes | ✅ | 07 §3.5 |
| 子会话 = 会话文件，续话 = 重新打开 | minimax | ✅ | 06 §6 |
| fork 末尾说明 + 继承消息打标记 | codex | 🕐 Phase 3 | 05 §2 |
| verifier + VERDICT 严格解析 | minimax | 🕐 Phase 3 | 04 §3 |
| worktree 隔离 | gotgenes、Claude Code | 🕐 Phase 3 | 08 §4 |
| `ask_parent` / `notify_parent` | gotgenes | ❌ | 子 agent 带阻塞原因返回即可，父 agent 再用 `agent_send` 续话 |
| wait / poll / get_result | codex、minimax、gotgenes | ❌ | 推送通知 |
| chain / workflow 脚本 | nicobailon | ❌ | |
| 邮箱、消息板 | codex V2 | ❌ | |
| 后台单独起 runner 进程 | nicobailon | ❌ | |
| 子进程跑子 agent | pi 官方 example | ❌ | |
| 把父对话拍平成文本 | gotgenes | ❌ | 用真实分支 |
| 延迟暴露的加载器工具 | nicobailon | ❌ | 3 个工具 schema 很小，不值得 |

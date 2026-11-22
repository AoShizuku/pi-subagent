# 06 · 生命周期、并发、通知与持久化

## 1. 状态机

```
            ┌───────── agent_stop / 用户停止 / 父 agent 中断（前台）────────┐
            │                                                              ▼
 queued ──> running ──> completed | failed | max_turns | context_limit  aborted
   │                                                                       ▲
   └──────────────── 排队中被取消 ──────────────────────────────────────────┘

 终态 ──agent_send──> queued（同一个 agent id，runs + 1；上下文到过阈值的除外，§6）
```

```ts
type AgentStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "max_turns" | "context_limit";

interface AgentRecord {
  agentId: string;              // ag-1、ag-2…，§9
  type: string;
  description: string;
  background: boolean;          // 本轮是否后台
  status: AgentStatus;
  reason?: string;              // 非 completed 时的原因：provider error 文本、stopped by parent、session ended…
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  model: string;                // 实际使用的 provider/id
  runs: number;                 // 第几轮（agent_send 续话 +1）
  sessionFile?: string;
  resultFile?: string;
  stats: { turns: number; toolCalls: number; usage: Usage };   // 本轮
  totalUsage: Usage;            // 所有轮累计，07 §3.5
  notified: boolean;            // 只在内存里，不持久化
}
```

**唯一终态写入者**（minimax `terminal.ts:43-117`）：所有进入终态的路径都经过 `manager.finish(agentId, outcome)`，它只生效一次。
例子：`agent_stop` 先把状态写成 `aborted`，之后 `prompt()` 返回时 `stopReason` 也是 `aborted`，第二次 `finish` 直接忽略，
只把结果文本回填进 record（如果之前还没有）。

## 2. 观察者：子会话事件 → 进度

对每个运行中的子会话 `session.subscribe(observer.onEvent)`，维护：

| 字段 | 来源事件 |
|---|---|
| `turns` | `turn_end` 计数（也驱动轮数预算，02 §9.2） |
| `context` / `contextLimited` | 每个非流式增量事件读一次 `getContextUsage()`；到过 `context_limit` 就置 `contextLimited`（驱动上下文预算，02 §9.1） |
| `toolCalls` | `tool_execution_start` 计数 |
| `activeTools` | `tool_execution_start` / `tool_execution_end`：`name` + 参数摘要（路径、pattern、命令前 60 字符） |
| `recentText` | `message_update` 的 `text_delta`，只留最后 200 字符，给 UI 显示"正在写什么" |
| `usage` | `message_end` 时累加 assistant 消息的 `usage` |
| `lastEventAt` | 任意事件 |

前台：节流后（每 100ms 最多一次）调用工具的 `onUpdate`，把 `ProgressSnapshot` 放进 `details.progress`（07 §1）。
后台：只更新 record，并在状态或轮数变化时发一次 `subagent:state`（07 §3.3）；详情浮层打开时直接订阅观察者（07 §6）。

观察者额外保留最近 200 条工具调用记录（名字、参数摘要、开始 / 结束时间、结果摘要），供详情浮层的 Activity 区块使用。

## 3. 并发

- **一个 FIFO 队列，上限 `maxConcurrent` = 4，前台和后台共用**。→ 待定问题 Q6
  - 子会话在父进程的堆里，总量必须有上限；gotgenes 让前台绕过队列，等于前台不设上限。
  - 一条回复里调用 6 次 `agent`：4 个立刻跑，2 个排队，工具卡片显示 `queued (2)`。
- 排队中的前台调用照常响应 abort：父 agent 被中断时直接移出队列。
- 后台 agent 排队时，启动结果里写明位置（03 §4.3）。
- 运行中修改 `maxConcurrent`（改配置后 `/agents reload`）立即对新的出队生效，不打断在跑的。

## 4. 执行流程

### 4.1 前台

```
execute(toolCallId, params, signal, onUpdate, ctx)
  1. 解析类型、模型（02 §3）；失败 → throw（模型能看到错误并改正）
  2. 快照父会话（02 §2）
  3. manager.launch(record) → 入队；onUpdate({ status: "queued", position })
  4. 等待出队；期间 signal 触发 → 出队并 throw
  5. createChildSession → subscribe → prompt（02 §7）
  6. finish → 写 result 文件 → appendEntry → dispose
  7. 按状态返回结果或 throw（03 §4.1、§4.2）
```

前台 agent 永远不发通知：结果就是这次工具调用的返回值。

### 4.2 后台（Phase 2）

```
execute(...)
  1–3 同上，但入队后立刻返回启动信息（03 §4.3）
  4. 在工具调用之外继续：出队 → 创建 → 运行 → finish
  5. finish 之后按 §5 投递通知
```

后台运行**不**挂在本次工具调用的 `signal` 上：父 agent 被 Esc 中断不影响后台 agent，与 bg-shell 一致。

## 5. 通知投递（Phase 2）

### 5.1 格式

```
<subagent-notification>
<agent agent-id="ag-2" type="explore" status="completed" turns="5" tool-calls="11" duration="48s">
<description>查找鉴权相关代码</description>
<result>
…最后一条 assistant 消息（上限见 05 §3.2）…
</result>
</agent>
<agent agent-id="ag-3" …>
…
</agent>
</subagent-notification>

Subagent ag-2 "查找鉴权相关代码" completed.
Subagent ag-3 "检查迁移脚本" failed: provider error: 529 overloaded.
```

- 实现里非 completed 的 agent 在 `<description>` 后多一个 `<reason>…</reason>`，note 写成 `<note>…</note>`；`<description>` / `<reason>` 做 XML 转义，报告正文按 05 §4 转义。
  批次里只要有一个 agent 可续话，末尾加一行 `Use agent_send with an agent id to ask a follow-up; the subagent keeps its context.`
- 被截断时 `<result>` 之后加 `<result-file>…</result-file>`。
- 整批超限时，后面的 agent 只有属性和 `<result-file>`，没有 `<result>`（05 §3.2）。
- 摘要行每个 agent 一行，状态文案各不相同：`completed` / `failed: <reason>` / `ran out of turns (300)` / `filled its context window before writing a report` / `was stopped by the user`。
- 以 `custom_message` 送达，`customType: "subagent-notification"`，进 LLM 时是 user 角色（同 bg-shell DESIGN §1.1）。
- TUI 里用 `registerMessageRenderer` 渲染成一行（07 §2）。

### 5.2 哪些结束要通知

| 结束方式 | 通知？ | 理由 |
|---|---|---|
| completed / failed / max_turns / context_limit | ✅ | |
| 用户停止（HUD 焦点模式的 `x`、详情浮层、`/agents` 列表，07 §4–§7） | ✅ | 模型可能还在等它的结果 |
| 模型用 `agent_stop` 停止 | ❌ | 它自己做的，`agent_stop` 的返回里已经有结果 |
| `session_shutdown` | ❌ | 没有人可以通知了 |
| 前台 agent 的任何结束 | ❌ | 结果已经作为工具返回值交付 |

每个 agent 每一轮只通知一次：投递时置 `notified`；`finish` 本身也只执行一次。

### 5.3 投递策略：照搬 bg-shell

bg-shell 的 `NotificationBatcher`（`pi-background-shell src/batcher.ts`）和三个钩子原样适用，只是元素类型从 `BgTask` 换成 `AgentRecord`：

| agent 状态 | 行为 |
|---|---|
| 空闲，且没有其他后台 agent 在跑或排队 | 立刻发：`pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })` |
| 空闲，还有其他后台 agent 在跑 | 3 秒固定窗口；窗口内结束的并入同一批；最后一个在跑的也结束了就提前发 |
| 忙 | 只进缓冲 |
| `turn_end`（outcome 为 `completed`）/ `agent_before_settle` | 缓冲非空 → 返回 `{ entries: [...event.entries, custom_message], continue: true }` |
| `agent_settled` | 缓冲仍非空 → `sendMessage`；这次 run 是 Esc 中断的就用 `triggerTurn: false`，只记入会话 |

实现上把 `NotificationBatcher` 抽成泛型 `NotificationBatcher<T>`：现在的代码除了 import 的 `BgTask` 类型外没有任何 bg-shell 专属逻辑。
两个插件各自持有一份副本（插件是分别安装的，不共享运行时模块），见 08 §2。

3 秒窗口对子 agent 同样合理：子 agent 通常跑几十秒到几分钟，一起派出的几个 explore 经常在几秒内先后结束。

### 5.4 与 bg-shell 的通知如何合并

| 路径 | 是否天然合并 | 依据 |
|---|---|---|
| 忙 → 边界排出 | ✅ | pi 的边界处理器是链式的：每个扩展拿到的 `event.entries` 是前一个扩展返回的结果（`pi/packages/coding-agent/src/core/extensions/runner.ts:1043-1073`）。bg-shell 和本插件在同一个 `turn_end` 里各追加一条 `custom_message`，下一次 LLM 请求一起看到 |
| 空闲 → 立即或窗口到期后发送 | ❌ | 两个插件各自 `sendMessage(triggerTurn)`。先到的那条起一轮；后到的那条发现 `!ctx.isIdle()`，于是进缓冲，在第一轮的 `turn_end` 排出。最坏情况多一次 LLM 请求 |

空闲路径不合并的代价是"两边几乎同时在空闲状态下完成"时多一次请求，概率低、代价小。Phase 2 不做跨插件协调。→ 待定问题 Q5

如果实测需要，Phase 3 的方案：通过 `pi.events` 加一个"还有没有在跑的"查询频道，两个批处理器的 `hasRunning()` 都把对方算进去，
窗口就会等到双方都结束（`pi.events` 是同步分发的，见 bg-shell DESIGN §1.1）。

## 6. 续话（Phase 2）

- 子 agent 进入终态后**立刻 `dispose()`**，内存里不留空闲会话。
- `agent_send` 到一个已结束的 agent：用 `SessionManager.open(record.sessionFile)` 重新打开（`session-manager.ts:1777`），
  按 02 §2 重新组装（类型、模型按**当前**解析结果；类型文件改过就用新的），入队，`prompt(message)`。
- 子会话文件里有完整历史，续话的子 agent 上下文完整。
- 父会话是内存会话（`--no-session`）时子会话也是内存会话，dispose 后无法续话。此时结果里不出现 `agent_send` 提示（03 §4.1），
  `agent_send` 报错（03 §6）。
- 上下文到过 `context_limit` 的 agent（`contextLimited`，02 §9.1）同样不能续话，不论它以什么状态结束：续话从已经过阈值的上下文开始，
  第一轮就会再被提醒收尾。结果和通知里都不出现 `agent_send` 提示，`agent_send` 报错（03 §6）。
- 不做 codex V2 那样的 LRU 驻留：重新打开一个会话文件只是读一个 JSONL，比常驻内存简单，且没有"空闲会话占着名额"的问题（codex V1 的坑）。

## 7. 会话生命周期

| 事件 | 行为 |
|---|---|
| `session_start` | 加载类型（04 §6）；从 entries 恢复 records（§8）；清理旧数据（§8）；发布 `subagent:state`、请求 `subagent:hud`（07 §3.3） |
| 父 agent 被 Esc 中断 | 前台 agent：随 `signal` abort。后台 agent：不受影响 |
| `agent_stop` / 用户停止（07 §4–§7） | `abort()` → `finish(aborted)` |
| `session_shutdown`（quit / reload / new / resume / fork） | 清空队列；对所有在跑的子会话 `abort()` 后 `dispose()`；不发通知；清空批处理器；之后不再碰旧的 `pi` / `ctx` |
| pi 进程退出 | 子会话在同一进程里，随进程结束。没有需要清理的外部进程，不需要 `process.on("exit")` |
| `pi -p` / `--mode json` | 后台不可用（02 §12）；前台照常 |

`session_shutdown` 里不 `await` 子会话的 abort 超过 5 秒：卡住的 provider 请求不能拖住 pi 退出。

## 8. 持久化、恢复与清理

**双写**（同 bg-shell DESIGN §3.3）：

- 内存：`Map<agentId, AgentRecord>`。
- 持久化：`pi.appendEntry("subagent", snapshot)`，在入队、开始运行、子会话建好、进入终态时各写一条；**不进 LLM 上下文**。

**恢复**（`session_start`）：

- 扫 `ctx.sessionManager.getEntries()`（不是 `getBranch()`：子 agent 是进程级事实，不随分支变化），每个 agent id 取最后一条。
- 还是 `queued` / `running` 的：上一个 pi 进程已经没了 → 改成 `aborted`（reason: `session ended`）并补写一条 entry。
- 编号从最大的 `ag-<n>` 之后继续。
- 恢复出来的已结束 agent 可以用 `agent_send` 续话（§6），`contextLimited` 的除外。

**清理**（`session_start` 时异步执行，所有文件系统错误忽略）：

- 扫 `<sessionDir>/subagents/` 下**其他会话**的目录，目录里最新文件的 mtime 早于 `retentionDays`（默认 14 天）的整个删掉。→ 待定问题 Q7
- 当前会话的目录不动。
- 比 bg-shell 的 3 天长：bg-shell 的输出文件看完就没用了，子会话文件是续话的依据。

## 9. id

- `ag-<n>`，按父会话递增，恢复后接着编号（同 bg-shell 的 `bg-<n>`）。
  起点取两个来源的最大值：result 目录里已有的 `ag-<n>.result*.md`（Phase 1 的做法，内存会话也适用）和 entries 里最大的 `ag-<n>`（Phase 2）。
  这样 `/reload` 之后不会复用编号、覆盖旧对话里引用过的 result 文件。
- 短、好念，模型在 `agent_send` / `agent_stop` 里写它不容易出错。
- 子会话本身的 session id 由 pi 生成，只出现在文件名和 record 里。

## 10. 实现备注（Phase 2）

和上文不同或上文没写的地方：

- **record 字段**：比 §1 多 `prompt`（本轮任务；续话时是 `agent_send` 的消息）、`maxTurns`、`stoppedBy`（`parent` / `user`，决定是否通知）、
  `context`（最后已知的上下文占用）、`contextLimited`（到过 `context_limit`，不能续话）、
  `activity`（工具调用列表，只在内存里）、`text`（报告正文，只在内存里，持久化的只有 result 文件路径）。
- **持久化时机**：入队、开始运行、子会话建好、进入终态、续话重新入队时各一条 `subagent` entry；进入终态时先写 result 文件再写 entry，所以终态 entry 里有 `resultFile`。
  "开始运行"那条写在子会话创建之前，还没有 `sessionFile`；子会话建好后再补一条 `running` entry 带上它。
  否则父进程在运行中途崩溃时，恢复出的记录没有转录路径，`agent_send` 会误报"transcript is no longer available"，明明子会话文件还在。
  运行中 `contextLimited` 第一次置上时也补写一条，理由相同：崩溃后恢复出的记录不能被当成可续话。
  `session_shutdown` 之后不再写（被 shutdown 中止的 agent 在下次恢复时由"running → aborted"补上）。
- **`agent_stop` / 用户停止**：abort 后最多等 5 秒拿部分报告；5 秒内 run 没返回（provider 请求卡住），也直接把 record 置为 `aborted`，之后 run 返回时只回填报告文本。
  停止发生在子会话还在创建时，会话建好后立即 abort。
- **`agent_send` 给运行中的 agent**：子会话已经开始 `prompt` 时用 `AgentSession.steer`（`agent-session.ts:2296`）；会话还在创建、还没开始 `prompt` 时按"排队中"处理，拼到任务末尾。
  已知窗口：steer 恰好落在 agent 循环最后一轮结束之后、`prompt()` 返回之前时，这条消息不会被处理（pi 只在循环内的轮次边界取 steering 队列）。
- **续话的结果判定**只看本轮新增的消息：重新打开的会话里有上一轮的 assistant 消息，不能让它被当成本轮的结果。
- **续话也可能通知**：`agent_send` 带 `background: true` 时，这一轮结束照常走批处理器；前台续话不通知。
- **清理**也扫 `<os.tmpdir()>/pi-subagent/`（内存会话父会话的 result 文件），规则相同；单位是"整个父会话目录"，目录本身和里面文件的最新 mtime 都早于保留期才删。
- 后台 agent 启动时如果马上拿到了并发名额，工具结果里的状态记为 `running`（真正的状态切换晚一个 tick）。

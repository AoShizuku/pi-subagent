# 02 · 子会话运行时

本篇回答：子 agent 在哪里跑、怎么组装、继承什么、怎么结束。

## 1. 同进程 SDK 会话，不起子进程

| | 子进程（`pi --mode json -p`） | 同进程（`createAgentSession`） |
|---|---|---|
| 启动开销 | 每个子 agent 都要启动一次 Node 并加载 pi（Windows 上明显更慢） | 几十毫秒组装 |
| 运行时注册的 provider | 丢失（只能读 `models.json` / `auth.json`） | 可以重放（§3） |
| Windows | 命令行引号、控制台窗口、杀进程树（bg-shell 已经踩过一遍） | 无 |
| 事件流 | 解析 stdout 上的 JSONL | `session.subscribe` 直接拿对象 |
| 隔离 | 进程级：崩了不连累父进程 | 共享堆：要控制并发和扩展加载（§5、§11） |
| abort | 发信号 | `session.abort()` |

选同进程。隔离性的损失靠"不加载扩展 + 并发上限 + 跑完立刻 dispose"补回来。

后台模式也在同一进程里跑：pi 进程退出时子 agent 跟着结束，与 bg-shell 的取舍一致（bg-shell DESIGN §3.7）。

## 2. 组装

```ts
// src/child.ts（示意，非最终代码）
import {
  createAgentSession, DefaultResourceLoader, getAgentDir,
  ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

async function createChildSession(spec: ChildSpec, parent: ParentSnapshot): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  replayProviders(parent.modelRegistry, new ModelRegistry(modelRuntime));        // §3

  const settingsManager = SettingsManager.create(parent.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: parent.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,                                   // §5
    noPromptTemplates: true,
    noThemes: true,
    noSkills: !spec.type.skills,                          // 04 §2
    noContextFiles: !spec.type.contextFiles,              // §4，默认 false
    appendSystemPrompt: [spec.contract, spec.type.body],  // §4：只追加，不替换
  });
  await resourceLoader.reload();

  const sessionManager = spec.resumeFile
    ? SessionManager.open(spec.resumeFile)
    : SessionManager.create(parent.cwd, spec.sessionDir, { parentSession: parent.sessionFile });

  const { session } = await createAgentSession({
    cwd: parent.cwd,
    agentDir,
    modelRuntime,
    model: spec.model,                                    // §3
    thinkingLevel: spec.thinking,
    tools: spec.type.tools,                               // 显式白名单，04 §3
    excludeTools: SELF_TOOLS,                             // §6，双保险
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  await session.bindExtensions({ mode: "print" });        // 没有扩展时近似空操作，保持流程统一
  session.setSessionName(spec.description);               // 会话名 = description（03 §1）
  return session;
}
```

代码事实：

| 事实 | 位置 |
|---|---|
| `createAgentSession` 支持 `modelRuntime` / `model` / `thinkingLevel` / `tools` / `excludeTools` / `resourceLoader` / `sessionManager` / `settingsManager` | `pi/packages/coding-agent/src/core/sdk.ts:48-110` |
| 没给 `modelRuntime` 时会新建一个 `ModelRuntime` | `sdk.ts:197` |
| `tools` 是白名单，`excludeTools` 在其后生效 | `sdk.ts:72-93`、`sdk.ts:279-291` |
| `DefaultResourceLoader` 支持 `noExtensions` / `noSkills` / `noPromptTemplates` / `noThemes` / `noContextFiles` / `appendSystemPrompt` / `extensionsOverride` | `resource-loader.ts:304-341` |
| `SessionManager.create(cwd, sessionDir, { parentSession })` | `session-manager.ts:1766`、`session-manager.ts:52-55` |
| 以上都从包入口导出 | `pi/packages/coding-agent/src/index.ts:8, 236, 250, 263, 304, 321` |

**父会话快照**：派出时（而不是真正开跑时）记下 `cwd`、`model`、`thinkingLevel`、`sessionFile`、`modelRegistry`。
排队中的子 agent 用快照，不会因为用户中途切了模型而跑在另一个模型上（gotgenes 的 `parent-snapshot.ts`）。

## 3. 模型与 provider

**provider 重放**：`ModelRuntime` 上运行时注册的 provider（扩展调用 `pi.registerProvider` 注册的）不写进
`models.json`。子会话新建的 runtime 拿不到它们，会报 "No API key found for <provider>"（gotgenes #812）。
`ModelRegistry` 公开了枚举接口，可以逐个重放：

| 方法 | 位置 |
|---|---|
| `getRegisteredProviderIds()` | `model-registry.ts:241` |
| `getRegisteredNativeProvider(id)` | `model-registry.ts:237` |
| `getRegisteredProviderConfig(id)` | `model-registry.ts:233` |
| `registerProvider(provider)` / `registerProvider(id, config)` | `model-registry.ts:210-219` |

父会话的 registry 从 `ctx.modelRegistry` 拿（`extensions/types.ts:357`）。为什么不直接共用父会话的
`ModelRuntime`：`ModelRegistry` 把 runtime 存成私有字段（`model-registry.ts:49`），拿不到。
重放时直接调子会话 `ModelRuntime` 的 `registerNativeProvider` / `registerProvider`（`model-runtime.ts:899`、`:936`），不需要再包一层 `ModelRegistry`。

扩展注册的**虚拟模型**（`registerVirtualModel`）没有枚举接口，重放不了。父会话选的是虚拟模型时，子会话改用父 registry 里的模型对象；
路由要靠注册它的 runtime，所以这种组合可能跑不通，Phase 1 不特殊处理。

**模型解析顺序**：

1. 调用参数 `model`（规则要求只在用户明确指定时才填，03 §5）
2. 本插件配置 `types.<name>.model`（04 §5）：存在的意义就是不复制类型文件也能覆盖它
3. agent 类型文件的 `model`
4. 父会话快照里的模型

格式接受 `provider/id`；只给 `id` 时在可用模型里按 id 精确匹配，唯一就用，否则报错并列出候选。
找不到模型或没有凭据时：调用参数指定的 → 报错（模型自己写错了，应该让它知道）；类型或配置指定的 →
退回父模型，并在结果末尾附一行 `note: model X unavailable, used Y`。

**thinking 解析顺序**：调用参数 → 配置 → 类型文件 → 父会话的 thinking level。`max_turns` / `context_limit` 同理（没有调用参数，也没有父会话这一层，最后落到默认值）。传给 `createAgentSession` 后，
pi 会按模型能力夹紧（`sdk.ts:270-276`）。

## 4. System prompt 的组成

### 4.1 只追加，不替换

pi 的 system prompt 是分节构建的（`system-prompt.ts:128-196`）：

```
preamble → tools → rules → docs → addendum(appendSystemPrompt) → project_context → skills → cwd
```

**有自定义 system prompt 时，`tools`、`rules`、`docs` 三节整段消失**（`system-prompt.ts:152-169`）。
所以角色正文一律放进 `appendSystemPrompt`（成为 `addendum` 节），不提供 `prompt_mode: replace`。

已核实的两个副作用：

- 显式传 `appendSystemPrompt` 会**取代** `APPEND_SYSTEM.md` 的自动发现（`resource-loader.ts:695-701`）。
  这是想要的：用户写给主 agent 的追加提示不应该原样带给子 agent。
- 没传 `systemPrompt` 时，loader 仍会发现用户的 `SYSTEM.md`（`resource-loader.ts:689`）。
  如果用户配了 `SYSTEM.md`，子 agent 和父 agent 一样被替换掉 preamble。这符合"子 agent 和父 agent 是同一个 harness"的直觉，不特殊处理。

### 4.2 追加内容

`appendSystemPrompt` 的两段：

**第一段：子 agent 契约**（所有类型共用，英文，因为是写给模型的）：

```
<subagent_contract>
You are a subagent. Another agent (your parent) delegated one bounded task to you. The user is not watching this conversation and cannot answer questions.
- Do the task in the first user message and stay within its scope.
- You cannot delegate and cannot ask the user. If you are blocked by missing information, a decision only the user can make, or a failed precondition, stop and report the blocker precisely instead of guessing.
- Your final message is your whole deliverable. The parent sees only that message, not your tool calls or earlier text. Lead with the answer or outcome, then the evidence: file paths with line numbers, commands you ran and what they returned. Keep it as short as the task allows.
- Report verification honestly: say what you ran and what you did not run. Never claim a check passed that you did not run.
- Other agents may be working in the same directory at the same time. Modify only files your task assigns to you.
</subagent_contract>
```

**第二段：类型正文**，包成 `<agent_type name="explore">…</agent_type>`。内容见 04。

### 4.3 项目上下文（AGENTS.md / CLAUDE.md）

默认继承（`noContextFiles: false`），类型可以用 `context_files: false` 关掉（04 §2）。理由：子 agent 干的就是这个项目的活，
需要项目的约定；只读的 `explore` 也需要知道目录约定。代价是每个子 agent 多出与父会话相同的那几百到几千 token。→ 待定问题 Q2

### 4.4 skills

默认不加载（`noSkills: true`）。skills 目录会进 system prompt，子 agent 很少需要；类型可以用 `skills: true` 打开。

## 5. 扩展

### 5.1 默认不加载任何扩展

`noExtensions: true`。理由：

| 如果加载父会话的扩展 | 后果 |
|---|---|
| pi-hud、pi-bettertui | 拿不到 UI（子会话没有 `uiContext`），白白初始化；最坏情况下误用 `ctx.ui` |
| pi-autotitle | 子会话第一轮结束后会给子会话生成标题，白花一次 LLM 调用 |
| pi-ask-user | 子 agent 拿到 `ask_user_question` 工具，违背"子 agent 不问用户" |
| pi-background-shell | 子 agent 能起后台任务，但完成通知要唤醒的是子会话，而子会话跑完就 dispose 了 |
| pi-memory | 每个子 agent 都注入 MEMORY.md 索引；子 agent 还可能写记忆 |
| 本插件自身 | 递归；可能干扰父会话的状态 |
| 任意第三方扩展 | 堆内存乘以并发数（gotgenes 实测 4 个子 agent 撑爆堆） |

已核实：`noExtensions` 只影响从设置和目录发现的扩展，CLI 用 `-e` 显式指定的扩展仍会合并进来
（`resource-loader.ts:610`、`resource-loader.ts:722`）。子会话不经过 CLI，没有这条路径。

SDK 会话本来就不加载 codemode / tool_search / MCP 这几个内置扩展（`docs/sdk.md` "Inline extension factories" 一节），
所以子 agent 也没有 MCP 工具。

### 5.2 白名单（Phase 2）

配置项 `childExtensions: string[]`（扩展的包名或路径）。实现：`noExtensions: false` 加
`extensionsOverride: (base) => filter(base, allowlist)`（`resource-loader.ts:323`），按 `Extension.path` /
`sourceInfo` 匹配（`extensions/types.ts:2292-2308`）。

无论白名单怎么写，以下扩展一律剔除：本插件自身、pi-ask-user、pi-autotitle、pi-hud、pi-bettertui、
pi-background-shell。原因见上表。

实现备注（Phase 2，`src/child.ts`）：

- 白名单为空时仍是 `noExtensions: true`，什么都不加载。非空时 pi 会先**加载（执行）所有已配置的扩展**，
  再由 `extensionsOverride` 过滤（`resource-loader.ts:628` 在加载之后才调用 override），所以被过滤掉的扩展的工厂函数仍会跑一次；
  这是 pi 的 API 决定的，白名单只控制"留下谁"，不能省掉加载成本。
- 匹配规则：条目含 `/` 且不以 `@` 开头时当路径，和 `path` / `resolvedPath` / `sourceInfo.baseDir` / `sourceInfo.source` 做前缀比较；
  否则当包名，等于 `source`、`npm:<名字>`，或者是路径里连续的段（`@scope/name` 也按段比较）。大小写和 `\` / `/` 不敏感。强制剔除的名字用同一套包名规则。
- 子会话用了工具白名单，SDK 的白名单会让没列出的扩展工具保持不激活（`sdk.ts:72-87`）。
  **扩展工具不会自动加给任何类型**：类型必须在 `tools` 里写出工具名（如 `web_search`），并且注册它的扩展在 `childExtensions` 里，
  两个条件都满足才激活（`activeChildTools`，`src/types.ts`）。这样"加载哪些扩展"（全局配置）和"哪个类型能用哪些工具"（类型文件）分开，
  只读的 `explore` 不会因为白名单里多了一个会写文件的扩展而获得写能力。
- 默认 `childExtensions: ["pi-dsweb"]`，内置 `explore` / `general` 列了 `web_search, web_fetch`：装了 pi-dsweb 时子 agent 能搜网页、读网页。
  pi-dsweb 在子会话里通过 `ctx.modelRegistry.getApiKeyForProvider("deepseek")` 取 key，子会话的 registry 读同一份 `auth.json`，所以不需要额外配置。

MCP 的开启方式另议：需要用 `extensionFactories` 加 `createMcpExtension()`（`docs/sdk.md`），
并且 MCP 会在 `session_start` 时连接服务器，每个子 agent 都连一遍。Phase 2 不做，有需求再说。

## 6. 工具与递归防护

- 子会话的工具 = 类型的 `tools` 白名单 ∩（pi 内置工具 ∪ 白名单扩展注册的工具）（§5.2）。内置集合是
  `read, bash, powershell, edit, write, grep, find, ls`（`tools/index.ts:95`）。
  注意 pi 默认只激活 `read, bash, edit, write`（`settings-manager.ts:85`），`grep` / `find` / `ls` 要显式列出。
- 递归防护是**结构性**的：子会话不加载本插件，所以根本没有 `agent` / `agent_send` / `agent_stop`。
  `excludeTools: ["agent", "agent_send", "agent_stop", "ask_user_question"]` 再兜一层，防止白名单把它们带进来。
- 因为工具根本不存在，不需要"深度上限"的报错文案。

## 7. 运行与结果判定

```ts
const unsubscribe = session.subscribe(observer.onEvent);   // 06 §2、07 §1
try {
  if (signal?.aborted) return aborted();
  await session.prompt(taskText, { expandPromptTemplates: false });
} finally {
  unsubscribe();
}
const last = lastAssistantMessage(session.messages);
```

| 判定 | 依据 |
|---|---|
| `completed` | 最后一条 assistant 消息的 `stopReason` 是 `"stop"` |
| `failed` | `stopReason === "error"`（provider 错误**不会**抛异常，只记在消息上），或 `prompt()` 抛异常（没有模型、没有凭据、压缩进行中，见 `agent-session.ts:2104-2135`） |
| `aborted` | `stopReason === "aborted"`，或我们自己调用了 `abort()`；后者区分原因：父 agent 被中断、`agent_stop`、用户停止（07 §4–§7） |
| `max_turns` | 我们因轮数预算调用了 `abort()`（§9） |
| `context_limit` | 我们因上下文预算调用了 `abort()`：提醒之后宽限的轮数用完还在调工具（§9） |
| `length` | `stopReason === "length"`：照常当 completed 返回，结果后附 `note: the final message hit the output token limit` |

`StopReason` 的取值：`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`
（`pi/packages/ai/src/types.ts:497`）。

- **结果文本**：取最后一条 assistant 消息的文本部分。不用 `getLastAssistantText()` 的回退逻辑，也不把所有
  assistant 文本拼起来（minimax 的做法会把中途的自言自语也交给父 agent）。
  唯一的例外是 abort 留下的空壳：run 被中断时 pi 会追加一条没有文本的 assistant 消息，并为它单独发一次 `turn_end`
  （`pi/packages/agent/src/agent.ts:542-558` 的 `handleRunFailure`）。末尾这种空的 `aborted` 消息跳过；我们自己发起的停止
  （`max_turns`、`context_limit`、父 agent 中断、session 结束）之后，末尾任何空的 assistant 消息都跳过，因为请求还没开始流式输出就被 abort 时，
  `stopReason` 可能是 `"error"`（faux provider 实测：`errorMessage: "This operation was aborted"`）。这些空壳也不计入轮数。
- 我们自己发起的停止决定状态（`max_turns` / `context_limit` / `aborted`），不看最后一条消息的 `stopReason`。
- 最后一条 assistant 文本为空（例如模型以一次工具调用结束后被中断）：结果写成 `(no final report)`，状态照实写。
- `prompt()` 在整个 run 结束之后才 resolve，包括自动重试（`docs/sdk.md` "Prompting"）。

## 8. abort

| 来源 | 行为 |
|---|---|
| 前台：父 agent 的工具 `signal`（用户按 Esc） | `signal` 触发 → `session.abort()`；状态 `aborted`（reason: `parent interrupted`） |
| `agent_stop` / 用户停止（HUD 焦点模式、详情浮层、`/agents` 列表） | `session.abort()`；状态 `aborted`（reason: `stopped by parent` / `stopped by the user`） |
| 排队中被取消 | 直接移出队列，不创建会话 |
| `session_shutdown` | 对所有在跑的子会话 `abort()` 然后 `dispose()`，不发通知 |

- `session.abort()` 在 run 开始前调用没有效果（gotgenes 的记录），所以 `prompt()` 前先检查 `signal.aborted`，
  并在 `prompt()` 开始后再挂监听。
- `abort()` 会等会话变为空闲（`agent-session.ts:2519`），所以 abort 之后可以安全地读消息、写结果、dispose。

## 9. 上下文预算与轮数预算

**问题**：轮数衡量不了一个子 agent 用掉了多少。60 轮 grep 和 60 轮读大文件，消耗能差十倍；真正伤质量和成本的是上下文：
越接近满推理越差，满了还会触发压缩，把任务细节压掉。所以长任务的收尾按上下文占用触发，轮数只留作防失控的兜底。

**硬约束：不能让 prompt cache 失效。** 1M 窗口下 70% 的上下文重新 prefill 一次就是几十美元。所以只用两种手段，都只在转录末尾追加，
前缀不变：插一条 steer 提醒，和 `abort()`。考虑过但否决的：

- 到阈值时撤掉子会话的全部工具（`setActiveToolsByName([])`，下一次请求前 `declareToolChanges` 会把差异写成一条带 `toolsRemoved` 的
  system 消息）。只有 Anthropic 原生的 `tool_removal` 能原地表达移除；`"additions"` / `"none"` 两类传输要重算顶层 tools 列表，前缀失效一次；
  `"changes"` 类传输只能文字告知、工具仍在声明里。按传输而定的缓存失效不可接受。
- hook 掉工具调用、一律返回错误。不伤缓存，但模型指令遵循足够好，提醒就会停；不停的直接中断更简单。

### 9.1 上下文预算（主要的收尾机制）

- 每个类型有 `context_limit`（窗口的百分比，默认 70，可配置，10–95，04 §2）。调用参数里不暴露。
- 读数：`AgentSession.getContextUsage()`，observer 在每个非流式增量事件上刷新（07 §6 标题里的 `ctx 42%` 用的是同一个读数）。
  比较用精确比例 `tokens / window ≥ limit`。模型没有已知的 context window 时读不到，上下文预算不生效，只剩轮数兜底。
- 第一次在**以工具调用结束的轮**之后看到占用 ≥ 阈值：注入一条只进上下文的提醒（`customType: "subagent-context-budget"`）：

  ```
  Your context window is 72% full. Stop exploring and write your final report now. If you keep calling tools, the run will be stopped and your last message will be used as the report.
  ```

- 提醒之后宽限 3 轮（`CONTEXT_GRACE_TURNS`）：前两轮还可以调工具（比如做一次核实），第 3 轮仍以工具调用结束就 `abort()`，
  状态 `context_limit`，把最后一条有文本的 assistant 消息当部分报告返回。
- 占用到过阈值的 agent 记 `contextLimited`，**不能续话**（06 §6）：续话会从已经过阈值的上下文开始，第一轮就再被提醒。
  这与它怎么结束无关：收到提醒后按时写完报告的 `completed` 也一样；最终回答那一轮才越过阈值、没来得及提醒的也一样。
  这个标记一出现就持久化，父进程中途崩溃后恢复出来的记录同样不能续话。
- 子会话关闭 auto-compaction（`settingsManager.applyOverrides({ compaction: { enabled: false } })`，只在内存里，不写回 settings.json）。
  有了上下文预算，压缩在子会话里没有用处，只剩代价：一次全价 prefill，和被压掉的任务细节。用户把压缩阈值配得比 70% 还低时，
  不关的话子 agent 会先被压缩、再收到汇报提醒，白付一次。注意 `resourceLoader.reload()` 会重读 settings 文件、冲掉内存里的覆盖，
  所以覆盖必须放在它之后；之后只有 settings 写入或 `/reload` 会再冲掉它，子会话两者都不做。
  关掉之后上下文真的溢出时，provider 报错，状态 `failed`。

### 9.2 轮数预算（兜底）

- 每个类型都有 `max_turns`，默认 300，可配置（04 §2）。它只防失控循环（比如反复跑一个报错的短命令，每轮只涨几百 token，
  很久才到上下文阈值）和读不到 context window 的模型，正常的长任务应该先碰到上下文预算。调用参数里**不**暴露 `max_turns`：模型没有依据去估算这个数字。
- 计数：订阅子会话的 `turn_end`。
- 剩余 2 轮时注入一条只进上下文的提醒：

  ```ts
  session.sendCustomMessage(
    { customType: "subagent-turn-budget", content: "You have 2 turns left. Stop exploring and write your final report now.", display: false },
    { deliverAs: "steer" },
  );
  ```

  流式中调用 `sendCustomMessage` 会走 steer 队列（`agent-session.ts:2391-2396`）。进 LLM 时它是一条 user 消息，会话文件里仍是隐藏的 custom 消息。
- 提醒和 abort 都只在**以工具调用结束的轮**（`stopReason === "toolUse"`）之后触发：这时 agent 循环本来就要开下一轮。
  在最终回答那一轮之后插 steer 消息会让 pi 多跑一轮（`pi/packages/agent/src/agent-loop.ts:304-306` 在 `turn_end` 之后取 steering 消息，
  有就继续）；在最终回答之后 abort 会把一次正常完成标成 `max_turns`。剩余轮数用 `≤ 2` 判断，`max_turns: 2` 时提醒文案写实际剩余的轮数。
  这条规则对 §9.1 的上下文提醒和中断同样适用。两个预算在同一轮都触发时，先发起的停止决定状态。
- 到上限：`abort()`，状态 `max_turns`，仍然把最后一条 assistant 文本当结果返回（通常已经是收尾报告）。
- 不设时间超时（Phase 1）。前台有 Esc，后台有 `agent_stop` 和用户手动停止（07 §4.2）。如果实际使用中遇到卡死，再加 `timeout`。

## 10. 会话文件放在哪

```
~/.pi/agent/sessions/<encoded-cwd>/                    ← 父会话文件所在（按 cwd 共享）
  <timestamp>_<parentSessionId>.jsonl
  bg-tasks/<parentSessionId>/…                          ← pi-background-shell
  subagents/<parentSessionId>/
    <timestamp>_<childSessionId>.jsonl                  ← 子会话文件（SessionManager 写）
    ag-1.result.md                                      ← 完整最终报告（05 §3）
```

- 目录从 `ctx.sessionManager.getSessionDir()` 和 `getSessionId()` 推出（`session-manager.ts:1145-1155`），和 bg-shell 一致。
- **不会混进 `/resume` 列表**：会话列表只扫 `sessions/<encoded-cwd>/*.jsonl` 这一层
  （`session-manager.ts:946-956` 的 `listSessionsFromDir`、`session-manager.ts:1969-1980` 的全局列表、`findMostRecentSession` 在 `:750-758`），不递归进子目录。
- 子会话头部写 `parentSession`，指向父会话文件，便于追溯。
- 父会话是内存会话（`--no-session`）时：`getSessionFile()` 为空，子会话也用 `SessionManager.inMemory()`；
  此时 `agent_send` 在子 agent dispose 之后不可用（06 §6）。result 文件仍然要写（截断时要给路径），放在 `<os.tmpdir()>/pi-subagent/<parentSessionId>/`。
- 子会话文件在第一条 assistant 消息落盘时才创建（`session-manager.ts:1173-1186` 的 `_persist`）。子会话还没回过话就失败时文件不存在，
  结果里就不给 `transcript:` 行。

## 11. 内存

- 子 agent 一跑完就 `dispose()`，不在内存里留空闲会话；续话时从会话文件重新打开（06 §6）。
- 并发上限 4（前台和后台共用，06 §3）。
- `ModelRuntime` 每个子 agent 新建一个，跑完随会话一起释放。
- 不修改 `process.env`（nicobailon 会在启动子 agent 时改环境变量）。

## 12. 一次性模式

`ctx.mode` 为 `print` / `json` 时，后台模式不可用：pi 跑完这一轮就退出，通知不可能送达。
做法与 bg-shell 相同：`background: true` 直接报错，并在工具描述里不提后台（03 §3）。前台照常可用。

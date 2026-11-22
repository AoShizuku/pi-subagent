# 04 · agent 类型定义

## 1. 文件格式

Markdown 文件 + YAML frontmatter，正文是追加给子 agent 的角色说明（02 §4.2）。用 pi 导出的 `parseFrontmatter` 解析
（`pi/packages/coding-agent/src/index.ts:497`）。

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

### 1.1 发现位置与优先级

| 优先级（低 → 高） | 位置 | 条件 |
|---|---|---|
| 1 | 内置（插件目录 `agents/*.md`） | 总是 |
| 2 | 用户：`~/.pi/agent/agents/*.md` | 总是 |
| 3 | 项目：`<cwd>/.pi/agents/*.md` | `ctx.isProjectTrusted()` 为真（`extensions/types.ts:370`） |

- 同名时高优先级覆盖低优先级，名字比较不区分大小写。
- 不递归子目录。
- 目录与 pi 官方 example、gotgenes、nicobailon 相同。它们的文件可以直接被本插件读取：我们只解析下表中的字段，
  其余字段忽略。反过来，我们的文件也只用这个公共子集，它们也能读。
- 项目目录不受信任时跳过项目类型，并在 `/agents types` 里显示"已跳过 N 个项目类型（项目未受信任）"。
- 用 `cwd` 而不是 `process.cwd()` 找项目目录（gotgenes 的 bug：`index.ts:73` 用了 `process.cwd()`）。

## 2. frontmatter 字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | 文件名（去掉 `.md`） | 只允许 `[a-z0-9][a-z0-9_-]*`，否则跳过并告警 |
| `description` | string | **必填** | 一行，进 `agent` 工具描述里的类型列表。缺失则跳过并告警 |
| `tools` | 逗号分隔字符串或 YAML 列表 | `read, bash, edit, write, grep, find, ls` | pi 内置工具，或白名单扩展注册的工具（§4）；`none` 表示不给工具 |
| `model` | string | 继承（02 §3） | `provider/id` |
| `thinking` | ThinkingLevel | 继承 | 非法值忽略并告警 |
| `context_limit` | 整数 10–95 | 70 | 上下文占用到窗口的这个百分比时提醒收尾，宽限 3 轮后还在调工具就停（02 §9.1） |
| `max_turns` | number ≥ 2 | 300 | 防失控的兜底，正常的长任务先碰到 `context_limit`（02 §9.2） |
| `context_files` | boolean | `true` | 是否加载 AGENTS.md / CLAUDE.md（02 §4.3） |
| `skills` | boolean | `false` | 是否加载 skills（02 §4.4） |
| `background` | boolean | `false` | Phase 2：调用方没传 `background` 时的默认值 |
| `enabled` | boolean | `true` | `false` 可以在用户或项目层禁用同名的内置类型 |

**不支持**的字段及原因：

| 字段 | 出现在 | 不支持的原因 |
|---|---|---|
| `prompt_mode: replace` / `systemPromptMode` | gotgenes、nicobailon | 替换会丢掉 pi 的 tools / rules 节（02 §4.1） |
| `extensions` | nicobailon | 扩展只走全局白名单（02 §5.2），不让单个类型文件（尤其是项目里的）决定加载什么代码 |
| `cwd` | — | 类型不能改 cwd（§4） |
| `allowNestedSubagents` / `maxSubagentDepth` | nicobailon | 只有 1 层 |
| `locked` | gotgenes | 调用方能覆盖的字段本来就只有 `model` / `thinking`，而且规则限定"只在用户指定时"使用，不需要再锁 |

## 3. 内置类型

Phase 1 只内置两个。

### 3.1 `explore`

```yaml
name: explore
description: Read-only search. Finds code, traces call paths and reports file paths with line numbers. Cannot edit files or run commands.
tools: read, grep, find, ls, web_search, web_fetch   # 后两个来自 pi-dsweb，没加载时忽略
thinking: low
```

正文：

```
You are a read-only search agent. You can read files and search the codebase; you cannot edit files or run commands.

How to work:
- Start with grep and find to locate candidates, then read only the line ranges that matter. Follow imports and call sites when the task asks how something works.
- Stop as soon as you can answer the task. Do not read files just to be thorough.

Report format:
1. The direct answer, in a few sentences.
2. Evidence: one line per location, as `path:start-end` followed by what is there. Quote code only when the exact lines matter, and keep quotes short.
3. What you could not find or are unsure about.

If the task requires editing files or running commands, reply with one line saying so and stop; the parent will use a different agent type.
```

- **只读靠工具白名单保证**：没有 `bash`、`edit`、`write`、`powershell`。`web_search` / `web_fetch` 只读外部网页，不改本地任何东西。minimax 的 `explore` 保留了 bash，"只读"只是 prompt 约定。→ 待定问题 Q8
- 最后一段相当于 minimax 的 Deliverable Gate：任务越界时快速失败，而不是硬着头皮做一半。
- 没有写死模型。写死某个 provider 的模型，在没有那个 key 的机器上会直接失败。用配置指定便宜模型（§5）。→ 待定问题 Q4

### 3.2 `general`

```yaml
name: general
description: Same tools as you. Use for bounded tasks that change files or run commands.
tools: read, bash, edit, write, grep, find, ls, web_search, web_fetch
```

两个内置类型都不写 `max_turns` / `context_limit`，用默认值（300 轮、70%）。

正文：

```
You have the same built-in tools as your parent. Complete the task end to end within its stated scope.

Before you finish:
- If the task changed code and the project has a relevant check (type check, tests, linter), run the narrowest one that covers your change.
- Re-read your diff for unintended edits.

Report format:
1. Outcome in one or two sentences: done, partly done, or blocked.
2. Files changed, one per line, with a short note on each.
3. Verification: the commands you ran and their results, and what you did not verify.
4. Anything the parent must decide or follow up on.
```

Windows 上 `general` 的 `tools` 是否要换成 `powershell`：跟随用户 pi 的 shell 设置。实现时读父会话激活的工具里有没有
`powershell`，有就把 `bash` 换成 `powershell`。只对**内置**的 `general` 做（配置覆盖不影响）；用户或项目里同名的 `general` 写了什么就用什么。用户的 pi-bettertui 会覆盖 bash / powershell 以添加 `description` 参数，
但子会话不加载扩展，用的是 pi 原生的 bash，这不影响功能，只影响子会话对话记录的显示。

### 3.3 `verifier`（Phase 3）

```yaml
name: verifier
description: Independent check of a finished change. Runs the relevant checks, reads the diff and returns a verdict. Does not fix anything.
tools: read, grep, find, ls, bash
```

正文要点（参考 minimax 的 verifier）：

- 被验证的说法放在 prompt 里，标注为"要核实的说法"。
- 不修复任何东西，只报告；bash 只用来跑检查（这一点只能靠 prompt 约束，因为要跑测试就得给 bash）。
- 最后一行必须是 `VERDICT: PASS`、`VERDICT: FAIL` 或 `VERDICT: PARTIAL`；FAIL / PARTIAL 前面用 `- ` 列出差距。
- 插件解析最后一行：严格匹配，有歧义当作没有 verdict；没有 verdict 时带格式提醒用 `agent_send` 机制重试一次；
  还是没有就状态 `completed` 并附 `note: no verdict`。
- 解析出的 verdict 放进结果头部属性：`<subagent-result … verdict="FAIL">`。

## 4. 能力只减不增

codex 的原则（`core/src/agent/role.rs:1-4`）："Roles may customize the child or reduce its capabilities, but never replace the parent session's authority."

在本插件里具体是：

| 项 | 规则 |
|---|---|
| 工具 | pi 内置工具 `read, bash, powershell, edit, write, grep, find, ls`（`tools/index.ts:95`），或扩展工具名（如 `web_search`）。扩展工具只有在注册它的扩展列在全局 `childExtensions` 里时才激活，否则忽略；类型文件自己不能让任何扩展加载（02 §5.2）。名字不合法（`^[a-z][a-z0-9_]*$` 以外）→ 该类型加载失败并告警 |
| 扩展 | 类型不能指定（§2） |
| cwd | 永远是父会话快照的 cwd |
| 项目信任 | 项目类型只在项目受信任时加载 |
| 模型 | 类型可以指定模型，这不算扩权 |

pi 目前没有父会话的权限系统，所以"权限继承"在本插件里就是上面这张表。将来接 pi-permission-system 一类的扩展时再补。

## 5. 插件配置

文件：`~/.pi/agent/pi-subagent.json`（只有全局配置，没有项目配置：项目不应该能改并发上限、扩展白名单这类东西）。

```jsonc
{
  // 覆盖内置或自定义类型的部分字段，不用复制整个类型文件
  "types": {
    "explore": { "model": "deepseek/deepseek-flash", "thinking": "low" }
  },
  "maxConcurrent": 4,          // 06 §3
  "resultMaxChars": 20000,     // 05 §3
  "notifyMaxChars": 8000,      // 05 §3：每个 agent
  "notifyBatchMaxChars": 24000,
  "retentionDays": 14,         // 06 §8
  "childExtensions": ["pi-dsweb"],  // 默认值，02 §5.2
  "confirmStop": true          // 07 §4.4：x 要按两次才停止
}
```

- `types.<name>` 可以覆盖 `model`、`thinking`、`max_turns`、`context_limit`。优先级：调用参数 > 本配置 > 类型文件 > 父会话（02 §3）。
- Phase 2 起所有字段都生效（Phase 1 只读 `types`、`maxConcurrent`、`resultMaxChars`）。`notifyMaxChars` / `notifyBatchMaxChars` 最小 1000，`retentionDays` 最小 1。
- 类型的 `background: true` 在一次性模式（`print` / `json`）下不生效，调用退回前台；只有调用参数显式写 `background: true` 才报错。
  非法的值（例如 `maxConcurrent: 0`）忽略该字段并告警。
- 文件不存在 → 全用默认值；JSON 解析失败 → 全用默认值并在 `session_start` 时 `ctx.ui.notify` 一次。

## 6. 加载时机

- `session_start` 时加载一次，拼出 `agent` 的工具描述。实现：扩展加载时先用内置类型注册一次 `agent`（工具在 `session_start` 之前就存在），
  `session_start` 和 `/agents reload` 时描述有变化才用同名重新 `registerTool`。重新注册已存在的工具不会把用户关掉的它重新激活
  （`agent-session.ts:3576-3667` 的 `_refreshToolRegistry` 只激活新出现的名字）。
- **会话中途不自动重新加载**：工具描述变了会打掉 prompt cache（工具定义在缓存前缀里）。
- `/agents reload` 命令手动重新加载，并提示"工具描述已更新，下一次请求不会命中缓存"。
- pi 的 `/reload` 会重新加载扩展，自然也会重新读类型文件。
- 调用时用 `agent_type` 查找的是**这份已加载的快照**，不会读到磁盘上新加的文件；新文件在 reload 之前不可用，
  报错信息会提示 `/agents reload`。

## 7. 校验与告警

加载时对每个文件：

| 问题 | 处理 |
|---|---|
| 缺 `description` | 跳过该文件，告警 |
| `name` 不合法 | 跳过，告警 |
| `tools` 含不合法的工具名 | 跳过，告警 |
| `thinking` / `max_turns` / `context_limit` 非法 | 忽略该字段，告警 |
| 正文为空 | 允许（只用契约） |
| 文件读不出来 | 跳过，告警 |

告警汇总成一条，在 `session_start` 时 `ctx.ui.notify(…, "warning")`，`/agents types` 里可以再看。

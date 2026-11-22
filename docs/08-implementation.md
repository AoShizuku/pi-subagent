# 08 · 实现计划

## 1. 模块划分

```
pi-subagent/
├── package.json            pi.extensions: ["./src/index.ts"]；peerDependencies 同 pi-background-shell
├── agents/
│   ├── explore.md          内置类型（04 §3）
│   └── general.md
└── src/
    ├── index.ts            接线：注册工具、命令、渲染器、事件钩子；session_start / session_shutdown
    ├── config.ts           读取 ~/.pi/agent/pi-subagent.json，填默认值（04 §5）
    ├── types.ts            类型发现、frontmatter 解析与校验、合并配置（04）
    ├── prompts.ts          子 agent 契约、工具描述、promptGuidelines、fork 说明（02 §4.2、03 §3、§5）
    ├── child.ts            createChildSession：runtime、provider 重放、loader、SessionManager（02 §2–§6）
    ├── models.ts           模型 / thinking 解析（02 §3）
    ├── observer.ts         子会话事件 → 进度和统计；上下文预算与轮数预算（06 §2、02 §9）
    ├── run.ts              一次运行：prompt → 判定状态 → 取结果（02 §7、§8）
    ├── manager.ts          records、队列、唯一终态写入者、持久化与恢复（06 §1、§3、§8）
    ├── result.ts           截断、写 result 文件、格式化结果和通知、标签转义（05 §3、§4，03 §4）
    ├── batcher.ts          泛型 NotificationBatcher<T>（06 §5.3，Phase 2）
    ├── cleanup.ts          清理旧会话目录（06 §8，Phase 2）
    ├── render.ts           renderCall / renderResult / 通知渲染（07 §1、§2）
    ├── tool-line.ts        子 agent 工具调用的单行格式（工具卡片和详情浮层共用，07 §8）
    ├── hud-state.ts        HUD 行的选取、排序、开窗；subagent:state / subagent:hud / subagent:open 协议（07 §3.2–§3.3，Phase 2）
    ├── focus.ts            onTerminalInput 键盘焦点状态机（07 §4，Phase 2）
    ├── detail.ts           详情浮层（07 §6，Phase 2）
    └── list.ts             /agents 底部列表（07 §7，Phase 2）

pi-hud src/         （Phase 2 的配套改动，07 §3.4）
├── index.ts                订阅 subagent:state；发 subagent:hud；footer 组件的 handleMouse 和每秒重绘
├── agents.ts               renderAgentRows、点击映射（纯函数，便于测试）
└── render.ts               第二行加 agents 用量（第一行本来就没有 agent 计数）
```

**依赖注入**：`manager` 和 `run` 只依赖一个窄接口 `ChildSessionFactory`（创建 → 返回 `{ subscribe, prompt, abort, steer, messages, dispose, sessionFile, model }`，
定义在 `run.ts`；Phase 1 的 `steer(customType, content)` 是只进上下文的 `sendCustomMessage(…, { deliverAs: "steer" })`，用于轮数提醒），
测试里用假会话替换，不需要真的调用模型。这是 gotgenes 唯一值得照搬的工程做法（它的 89 个测试文件都建立在这上面）。

## 2. 与 pi-background-shell 共享代码

`NotificationBatcher` 抽成泛型后，两个插件各自持有一份副本，而不是建一个共享包：

- 插件是用 `pi install <路径>` 分别安装的，各自有独立的模块图；跨插件 import 相对路径能用，但会把两个插件的安装和版本绑在一起。
- 这个类只有 78 行，复制的代价小于共享包的维护代价。
- 改 bg-shell 时同步改本插件的副本：在两份文件头部注释里写明"另一份在哪"。

如果之后出现第三个需要它的插件，再抽成 `pi-shared/`。

## 3. 实现清单

### Phase 1：前台最小可用

- [x] `package.json`、`tsconfig.json`、`vitest.config.ts`（照 pi-background-shell）
- [x] `config.ts`：默认值、读取、解析失败时提示
- [x] `types.ts`：三层发现、frontmatter 字段、校验告警；内置 `explore` / `general`
- [x] `models.ts`：`provider/id` 与裸 id；解析顺序；不可用时的回退和 note
- [x] `child.ts`：provider 重放；`noExtensions`；`appendSystemPrompt`；`tools` / `excludeTools`；`SessionManager.create` 到 `subagents/<parentId>/`
- [x] Windows：父会话激活了 `powershell` 时，`general` 用 `powershell` 替换 `bash`
- [x] `observer.ts`：轮数、工具数、当前工具、recentText、usage；剩 2 轮时的提醒；到上限时 abort
- [x] `run.ts`：`signal.aborted` 预检；`prompt`；按 `stopReason` 判定；取最后一条 assistant 文本
- [x] `manager.ts`：record、FIFO 队列（上限 4，前台也排队）、`finish` 只生效一次
- [x] `result.ts`：截断、result 文件、标签转义、`<subagent-result>` 格式、按状态的下一步建议
- [x] `index.ts`：`agent` 工具（不设 `executionMode`）、描述在 `session_start` 时拼一次、`promptSnippet`、`promptGuidelines`
- [x] `render.ts`：`renderShell: "self"`；运行中 3 行；结束折叠和展开
- [x] `/agents types`、`/agents reload`
- [x] `session_shutdown`：abort 并 dispose 所有子会话（最多等 5 秒）

### Phase 2：后台与续话

- [x] `agent` 的 `background` 参数；一次性模式下报错；类型的 `background` 默认值（一次性模式下类型默认值不生效，退回前台）
- [x] `batcher.ts`（从 bg-shell 泛型化复制）；`turn_end` / `agent_before_settle` / `agent_settled` 三个钩子
- [x] 通知格式、批次上限、通知渲染器
- [x] `agent_send`：运行中 steer、排队中拼接、已结束重新打开会话文件
- [x] `agent_stop`；模型停掉的不通知
- [x] `appendEntry` 双写；`session_start` 恢复；编号续接（取 result 文件和 entries 两个来源的最大值）
- [x] `cleanup.ts`：14 天（`retentionDays`）
- [x] 扩展白名单 `childExtensions`（02 §5.2）
- [x] 上下文预算（02 §9.1）：`context_limit`（类型字段与配置覆盖，默认 70）、到阈值提醒一次、宽限 3 轮后中断为 `context_limit`、
  `contextLimited` 持久化且不可续话、子会话关闭 auto-compaction；`max_turns` 默认改为 300，内置类型不再写它

UI（顺序即建议的实现顺序，每一步都能单独验证）：

- [x] **先验证**：pi-hud 的 footer 组件实现 `handleMouse`。已按代码核对全屏下的分发路径（见 07 §5 的"已核对"），点击映射有单元测试；**真实全屏会话里的手动验证仍待做**
- [x] `hud-state.ts`：平时最多 4 行 + `+N more`；焦点模式全部、8 行窗口、按 agentId 跟踪选中（07 §3.2）
- [x] 协议：`subagent:state` / `subagent:state:request` / `subagent:hud` / `subagent:hud:request` / `subagent:open`（07 §3.3）
- [x] pi-hud：`renderAgentRows`、选中行的左栏竖标和主题选中底色、提示行、点击映射、每秒重绘、用量行（07 §3.4；渲染在 `pi-hud/src/agents.ts`）
- [x] `focus.ts`：进入条件、按键表、Esc 吞掉、释放事件过滤、全部退出条件（07 §4.2–§4.3），外加"编辑器失去焦点"退出条件
- [x] `detail.ts`：浮层、自己实现的滚动（不是 ScrollView，原因见 07 §6）、自动滚到底与手动滚动后停止、节流重绘、`e` / `x` / `c`、关闭后回到来源（07 §6）
- [x] `list.ts`：`/agents` 列表，放在编辑器位置（不是浮层），自己限高；`Enter` 在列表上方打开详情浮层、列表不关；HUD 的 `+N more` 点击也打开它（07 §7）

### Phase 3：增强

- [ ] 先验证 fork 的 prompt cache 行为（05 §2.2），再决定是否做以及怎么做
- [ ] `verifier` 类型与 VERDICT 解析、一次重试（04 §3.3）
- [ ] worktree 隔离（§4）
- [ ] 若实测需要：与 bg-shell 的空闲唤醒协调（06 §5.4）

## 4. worktree 隔离（Phase 3 草案）

参考 gotgenes 的 `pi-subagents-worktrees`：

- `agent` 加参数 `isolation: "worktree"`（与 Claude Code 同名），或者类型字段 `isolation: worktree`。
- 运行开始时（出队后）`git worktree add --detach <tmp>/pi-agent-<id> HEAD`，子会话的 cwd 指向它。
- 结束时：没有改动 → 删除 worktree；有改动 → `add -A`、commit，建分支 `pi-agent-<id>`，删除 worktree，
  结果末尾附 `Changes are on branch pi-agent-<id>. Merge with: git merge pi-agent-<id>`。不自动合并。
- **已知坑**：从 `HEAD` 建 worktree，子 agent 看不到父会话里**未提交**的改动。要么在工具描述里写明，要么先 `git stash create` 把工作区快照成一个 commit 再从它建。后者更符合直觉，需要验证 Windows 下的行为。
- 不在 git 仓库里时报错，不静默退化成无隔离运行。

## 5. 测试计划

单元测试（vitest，假会话工厂）：

| 模块 | 关键用例 |
|---|---|
| `types.ts` | 三层覆盖；大小写；缺 description；非内置工具；项目未受信任时跳过；`enabled: false` |
| `models.ts` | `provider/id`；裸 id 唯一 / 不唯一；调用参数不可用 → 报错；类型指定的不可用 → 回退并带 note |
| `observer.ts` | 计数；剩 2 轮时恰好注入一次提醒；到上限 abort 一次；上下文到阈值提醒一次、宽限 3 轮后中断一次、宽限内写完不中断、最终回答那轮越过阈值只标记不提醒、没有阈值或读不到窗口时不生效 |
| `run.ts` | `stop` / `length` / `error` / `aborted`；`prompt` 抛异常；开始前已 abort；最后一条 assistant 没有文本 |
| `manager.ts` | 队列上限；排队中 abort；`finish` 重入（stop 先到、run 后到）；恢复时 running → aborted；编号续接 |
| `result.ts` | 截断点退到换行；result 文件轮转；标签转义；批次上限 |
| `batcher.ts` | 沿用 bg-shell 的 `batcher.test.ts` |
| `hud-state.ts` | 60 秒保留；4 行上限与 `+N more`；焦点窗口在首尾的行为；选中的 agent 在重新排序后仍被选中；选中的 agent 消失时选中相邻行 |
| `focus.ts` | 编辑器非空时 ↓ 不进入；HUD 未渲染时不进入；每个按键的处理与是否吞掉；可打印字符退出且不吞；释放事件；行数变 0 自动退出；30 秒超时 |
| pi-hud `renderAgentRows` | 窄终端截断顺序；模型简称只在不同时出现；点击映射与实际输出的行一一对应（包括降级后行数变化） |

集成测试（真实 pi SDK，不调用模型）：

- 用 pi 的假 provider 或 `--model` 指向一个本地桩，跑一次完整的前台调用，检查子会话文件的位置、`parentSession` 头、`/resume` 列表里看不到它。
- `noExtensions` 下子会话的激活工具集合恰好等于类型的 `tools`。
- system prompt 里有 `tools` / `rules` 节和契约节（验证 02 §4.1 的结论）。

Phase 1 已实现为 `src/child.integration.test.ts`：pi-ai 导出的 `fauxProvider` 通过 `ModelRegistry.registerProvider` 注册到一个"父" registry，
再由 provider 重放进入子会话的 runtime，所以同时验证了重放；`PI_CODING_AGENT_DIR` 指向临时目录，不碰 `~/.pi`。
覆盖：激活工具集 = 类型的 `tools`（含 powershell 替换和 `none`）、system prompt 的节与顺序、`context_files: false`、
完整前台运行（会话文件位置、`parentSession` 头、`session_info` 会话名、`/resume` 列表看不到）、`max_turns` 与提醒、provider 错误、父 agent 中断、
经扩展的 `agent` 工具端到端跑一次。

Phase 1 未覆盖的表格项：`manager.ts` 的"恢复时 running → aborted"和 `result.ts` 的"批次上限"属于 Phase 2（恢复、通知）。

Phase 2 的覆盖：

| 文件 | 内容 |
|---|---|
| `manager.test.ts` | 恢复（每个 id 取最后一条、running/queued → aborted、编号续接）、持久化顺序、`stop`（排队 / 运行 / 会话建好之前 / 卡住时 5 秒后强制结束）、`send`（steer / 拼接 / 已结束）、`reopen` 与累计用量、实时统计和 Activity、`contextLimited` 运行中持久化且拒绝 `reopen` |
| `batcher.test.ts` | 沿用 bg-shell 的用例 |
| `result.test.ts` | 通知格式、每个 agent 的上限、整批上限、转义、摘要行措辞、后台启动文案、`agent_send` 提示只在可续话时出现（含上下文到过阈值时不出现） |
| `hud-state.test.ts` | 60 秒保留、4 行上限与 `+N more`、焦点窗口首尾、重新排序后仍选中同一 agent、用量口径 |
| `focus.test.ts` | 进入条件；每个按键是否吞掉；释放事件；鼠标序列；07 §4.3 的每一个退出条件（行数为 0、HUD 不渲染、shutdown、编辑器非空、编辑器失去焦点、30 秒、详情浮层后恢复）；选中的 agent 消失时选相邻行 |
| `detail.test.ts` | 详情内容、滚动跟随、框的宽高、`x` / `e` / esc、滚轮；`/agents` 列表 |
| `index.test.ts` | 后台启动与空闲 / 忙 / Esc 中断三条投递路径、一次性模式、类型默认值、shutdown 不通知、`agent_stop` / `agent_send` 状态转换、恢复、HUD 协议、↓ / Esc / x / Enter、`subagent:open`、列表或浮层打开时焦点不抢键、列表与详情叠放（列表开着时 agent 行点击开详情、`+N more` 忽略）、关闭 / 拒绝 / 会话关闭后标记复位 |
| `child.test.ts` | 扩展白名单匹配与强制排除 |
| `child.integration.test.ts` | 子会话的 auto-compaction 关闭而磁盘上的 settings 不变；经扩展用真实 SDK：后台运行经批处理器通知；`agent_send` 重新打开会话文件续话（子会话看到第一轮完整对话、同一个文件）；`agent_stop` 停掉后台运行且不通知 |
| pi-hud `agents.test.ts` / `render.test.ts` | 行格式、窄终端截断顺序、选中行左栏竖标与选中底色（含截断后底色不断、图标列不动、弱化色升级）、点击映射与输出行一一对应（各种宽度）、`agents` 用量段、第一行没有 agent 计数 |

无法自动化的：全屏模式下的鼠标点击（需要真实终端）、真实 TUI 里的焦点 / Esc 行为与 HUD 布局，见下方手动验证。

手动验证（Windows + Git Bash，与 bg-shell 同一台机器）：

- 一条回复里 3 个 explore 并行；Esc 中断；通知与 bg-shell 通知在同一个边界合并。
- 全屏模式：HUD 出现 agent 行；↓ 进入、↑↓ 移动、Enter 打开详情并实时刷新、Esc 退出时**不会**中断主 agent、`x` 停止后台 agent；鼠标点击行打开详情；滚轮滚动详情。
- 普通模式：键盘路径全部可用；点击不生效但也不报错。
- `/hud off` 之后 ↓ 不再进入焦点模式，`/agents` 仍可用。
- 父会话 `/resume` 后续话一个旧 agent。
- 用 `pi --session <子会话文件>` 打开子会话查看完整过程。注意这会以普通交互会话的方式继续它，新的消息也会写进这个文件。

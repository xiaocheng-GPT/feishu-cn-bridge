# Claude Agent SDK 后端 —— 过夜自治进度

> 这是跨循环的唯一记忆。每轮开工先读这里 + `git log --oneline -15` + `git status`。
> 状态标记：未到 ALL DONE 前不要停。所有「完成」必须有工具结果佐证。

## 当前状态：代码 + 安全已实现并通过 LIVE 集成实证；飞书可视化验收待早上（见末尾 runbook）

### 已完成（均有工具结果佐证）
- ✅ 安装 `@anthropic-ai/claude-agent-sdk@0.3.178`（进 package.json deps）。
- ✅ 实现 `src/agent/claude-agent/{event-map,permission,thread,backend}.ts`，注册 index.ts + catalog.ts。
- ✅ `npm run typecheck` / `npm run build` / `npm test`（706 passed, 4 LIVE skipped）全绿。
- ✅ **LIVE 集成测试**（`CLAUDE_LIVE=1 npx vitest run test/claude-agent.live.test.ts`，真实计费）：
  full 档流式+done ✅、⏹中断后线程续用 ✅、qa 只读（逼模型禁沙箱写盘也写不进）✅；
  多轮上下文 run1 通过(6.8s) + spike7 复刻(10s,T1「好的」T2「菠萝蜜」) ✅。
  注：多轮 LIVE 用例今晚偶发超时——经查是 **API 端 529 Overloaded 过载**（多次撞到）导致 SDK 内部重试拉长，
  **非代码缺陷**（spike7 同机制同 prompt 10s 通过，是决定性反证）；该用例放宽到 240s，过载窗口外稳过。
- ✅ **安全模型已实证（spike4/5/6，macOS）**：
  - full → `permissionMode:'bypassPermissions'`，无沙箱（= danger-full-access）。
  - write → `bypassPermissions` + `sandbox{enabled, failIfUnavailable:true, autoAllowBashIfSandboxed:true,
    allowUnsandboxedCommands:false}`：Bash 写 /tmp 被内核拒、写 cwd 成功 → 写入锁在工作区，OS 级。
  - qa → write 配置 + `filesystem.denyWrite:[cwd]` + `disallowedTools:[Write,Edit,NotebookEdit]`：
    spike6 逼模型用 Bash/Write/禁沙箱多手段写盘，**文件始终未生成** → 真只读。
  - **关键发现**：默认 `allowUnsandboxedCommands:true` 会让模型用 Bash 的 `dangerouslyDisableSandbox` 逃逸；
    必须置 false 才是硬边界（已置）。`failIfUnavailable:true` → 沙箱起不来则报错（fail-closed，绝不静默放行）。
  - 放弃了 canUseTool 方案（加 filesystem 后回调返回值被 SDK union 校验拒 → ZodError）；纯沙箱更稳。

### 与 Codex 的安全差异（如实）
- write 写限 cwd：OS 级、与 Codex 对齐。qa 写禁绝：OS 级、与 Codex 对齐（甚至堵了 Codex 没有的禁沙箱逃逸面）。
- **qa 读取尚未硬限在 cwd**（Codex 的 qa 在 macOS/Win 连读也锁 cwd）：本实现 Read 工具/Bash 读仍可越界读取。
  → 已知缺口，后续可加 `filesystem.denyRead` 收紧。外部群 qa 若要求「连读也不外泄」，暂以 Codex 为准。
- 网络：network=off 时移除 WebFetch/WebSearch 工具 + 沙箱默认网络隔离；Bash 网络的细粒度开关未逐一实证。
- Claude 沙箱支持 macOS(Seatbelt)/Linux(bubblewrap)，比 Codex 的 Linux fail-closed 覆盖更广。



---

## 目标
新增 `claude-agent` 后端，让飞书机器人能像 Codex 后端一样跑 Claude Code，体验与安全尽量一致。
不改任何基础设施逻辑（run-card-stream / run-state / watchdog / session-store / handle-message）——
只实现 `src/agent/claude-agent/{backend,thread,event-map}.ts` 并注册。

## 环境事实（第 1 轮实测）
- SDK **未安装**：`@anthropic-ai/claude-agent-sdk` 不在 deps，也不在 node_modules。→ 本轮安装。
- claude CLI 在：`2.1.178`，但 PATH 里是 shell 函数 `safe-claude-wrapper.sh`（不是裸二进制）。
  Agent SDK 自带 cli.js，默认不依赖全局 claude；若需要可用 `pathToClaudeCodeExecutable` 指定。
- `ANTHROPIC_API_KEY` 未设；`~/.claude/.credentials.json` **不存在** → 凭据疑在 macOS Keychain。
  **鉴权能否起来必须用最小 spike 实跑验证**（这是头号风险）。

## 关键 API 事实（调研，待 spike 实证）
- 入口是 `import { query } from '@anthropic-ai/claude-agent-sdk'`，`query({ prompt, options }) => Query`。
  （注意：调研里出现的 `new Agent().query()` 写法与官方 `export function query` 矛盾，以真实 .d.ts 为准。）
- `Query` 继承 `AsyncGenerator<SDKMessage, void>`，可 `for await`；有 `interrupt()`、`setModel()`、
  `setPermissionMode()`、`initializationResult()`。
- 多轮：`prompt` 传 `AsyncIterable<SDKUserMessage>`（流式输入），持续 yield 新 user 消息。
  `SDKUserMessage = { type:'user', message: MessageParam, parent_tool_use_id: string|null, ... }`。
- 恢复：`options.resume = '<sessionId>'`（与 `continue` 互斥）。sessionId 取自 system(init) 或 result 消息的 `session_id`。
- 中断：`query.interrupt()`（仅流式输入模式可用）或 `options.abortController`。中断后 query 不可续用 → 需重建。
- 增量：`options.includePartialMessages = true` → 收到 `{ type:'stream_event', event: BetaRawMessageStreamEvent }`，
  text delta 在 `content_block_delta` 的 `delta.type==='text_delta'`，thinking delta 同理。
- 结果：`{ type:'result', subtype:'success'|..., usage, total_cost_usd, session_id, ... }`。
- 权限：`options.permissionMode ∈ default|acceptEdits|bypassPermissions|plan|dontAsk|auto`；
  `canUseTool(toolName, input, opts) => {behavior:'allow',updatedInput?}|{behavior:'deny',message}`；
  `allowedTools/disallowedTools: string[]`（Bash 不能按命令细分，需在 canUseTool 里看 input）。
- 沙箱：`options.sandbox: SandboxSettings { enabled, filesystem:{allowRead,allowWrite,denyRead,denyWrite},
  network:{allowedDomains,...}, failIfUnavailable, bwrapPath }` —— **SDK 直接暴露 OS 级沙箱**（macOS / Linux bwrap）。
  这点若属实，安全可与 Codex 对齐，是首选。**必须 spike 实证 sandbox 真的生效**。
- 模型/深度：`options.model`、`options.effort ∈ low|medium|high|xhigh|max`、`options.thinking`。
- 目录：`options.cwd`、`options.additionalDirectories`。
- 鉴权：自动复用本机已登录凭据，否则 `ANTHROPIC_API_KEY`，或 `options.env`。

## 契约要点（来自 types.ts，必须遵守）
- 实现 `AgentBackend`（id/displayName/capabilities/supportedModes/isAvailable/doctor/listModels/
  listThreads/readHistory/startThread/resumeThread）和 `AgentThread`（sessionId/runStreamed/runGoal/
  clearGoal/steer/abort/compact/isAlive/close）。
- `runStreamed` 返回 `AgentRun { events: AsyncIterable<AgentEvent>, turnId(), lastActivity?() }`。
  `lastActivity()` 必须在**每条** raw SDK 消息上刷新（含被 event-map 丢弃的），watchdog 靠它区分忙/挂死。
- event-map：把 SDK 消息映射成 `AgentEvent`（system/turn_started/text_delta/text/thinking_delta/
  thinking/tool_use/tool_result/usage/context_usage/context_compacted/done/error）。未知事件返回 null。
- 注册两处且必须一致：`src/agent/index.ts` 的 REGISTRY + `src/agent/catalog.ts` 的 BACKEND_CATALOG
  （有测试断言两者 id 集合相等）。
- 不支持的能力用 `capabilities` 声明 false，且对应方法必须抛清晰「不支持」错误（不可静默半实现）。
- 权限档 fail-closed：`supportedModes` 只是 UI 预拦截，硬守卫永远在 startThread/resumeThread。

## 安全/沙箱决策（待定，spike 后敲定）
- 首选：用 SDK `options.sandbox` 的 OS 级隔离对齐 Codex 三档：
  - full → sandbox 关闭 + permissionMode 'bypassPermissions'（danger-full-access 等价）
  - write → sandbox.enabled，filesystem.allowWrite=[cwd]，network 按开关
  - qa → sandbox.enabled，只读（无 allowWrite 或 denyWrite 全部），permissionMode 限制写工具
- 若 sandbox 实测不生效/不可用：退化为 canUseTool + allowedTools/disallowedTools 软边界，
  **并在 PROGRESS 和代码注释如实标注「弱于 Codex 的 OS 沙箱」**，绝不假装一致。
- Linux 与 Codex 一致 fail-closed（非 darwin/win 的受限档若沙箱不可用则拒绝启动）。

## 验收清单（x=已证实, ~=代码级已证/飞书可视化待确认, []=未做）
- [x] claude-agent 后端注册成功（REGISTRY+catalog 配对单测过；projectCreatableBackends 含它）
- [~] 新建会话 + 流式增量（text_delta/thinking/tool/done 已由 LIVE+spike 实证；飞书卡片渲染走**未改动**的
      run-card-stream，吃的是同一套 AgentEvent，故卡片观感应与 Codex 一致——待飞书肉眼确认）
- [x] 多轮上下文保持（LIVE run1 + spike7 + spike2 resume 三证）
- [x] 重启 resume + **/resume 历史卡双向发现**：listThreads/readHistory 读 SDK 的本地会话存储
      （~/.claude/projects，与 `claude -r` 同源）→ 飞书 /resume 能列出本机 `claude` 手开的会话；
      桥建的会话（默认 persistSession + 设 cwd）也出现在 `claude -r`（spike9 实证双向可见）。
      capabilities.resume 已开为 true；新增 history.ts 纯映射 + 单测 + 容错冒烟。
- [x] ⏹ 优雅中断（LIVE interrupt 每次过 + spike3）
- [x] 三档权限 + 沙箱/安全说明完整（spike4/5/6 实证，见上「安全模型」）
- [~] model + effort：已接 options.model/effort（per-turn model 用 setModel；effort 仅建线程时生效，已注明）
      ——待飞书选模型实测 + 卡片模型显示
- [x] npm run typecheck / build / test 全绿（706 passed）
- [ ] 真实飞书群端到端 + computer use 截图：**未做**（原因见下「飞书验收 runbook / 为何没自动做」）

---

## 飞书验收 runbook（给早上的人 / 下一轮）

### 为何没在过夜自动做（重要）
本机有**生产 bridge 正在运行**（全局安装版 `/opt/homebrew/.../@modelzen/feishu-CN-bridge`，
带多个生产 bot：cli_aaa40b82… / cli_aa81b50… / cli_aa93e16b…）。要在飞书测 claude-agent 必须用**本 worktree
代码**为某个 bot 起 bridge，但同一 bot 起第二实例会与生产抢「单实例锁 / WS 长连」→ **必然干扰生产**。
这与你「绝不碰我已有的群/项目/配置」冲突，故我**没有冒险动生产**，把可视化验收留给你确认环境后再做。
（新建群本身是安全的，但新群仍由生产 bridge 接收，跑不到我的新后端——技术上绕不过「得用我的代码起 bot」。）

### 安全的飞书验收三选一
A. **本地另起隔离实例（最稳）**：用一个**非生产**的飞书测试 bot（或临时停掉某生产 bot 再起），
   在本 worktree 跑 `npm start`（或 `node bin/feishu-CN-bridge.mjs run --bot <appId>`），
   新建群「【CC验收】Claude」，新建/绑定项目时后端选 **Claude**（picker 已含），权限选 full。
B. **合并后升级生产**：把本分支并入并 `npm i -g` 升级全局版，再在生产里建测试群选 Claude 后端。
C. 我下一轮在你确认「可安全占用某 bot」后再自动跑（告诉我哪个 bot 可用 / 是否可临时停某实例）。

### 逐项怎么验（建好群、后端=Claude 后）
1. 发「你好，简单介绍下自己」→ 看卡片**逐字流式** + 思考折叠面板 + 末尾 done（观感对比 Codex）。
2. 发「读一下 package.json 的 name 字段」→ 看**工具块**（读取 …/package.json）+ 结果。
3. 追问「我第一句问的啥」→ 验**多轮记忆**。
4. 跑个长任务（「数到 50」）中途点 **⏹** → 验优雅中断、卡片停在「已中断」。
5. 切 qa 档的群里发「在当前目录建个 a.txt」→ 应被拒（只读）。
6. 设置卡选不同 model/effort → 发消息看卡片模型显示。
（computer use 可在飞书桌面端逐项截图佐证。）

### 复跑 LIVE 集成测试（不依赖飞书，随时可验代码链路）
`CLAUDE_LIVE=1 npx vitest run test/claude-agent.live.test.ts`
（会真实计费；多轮用例若超时多半是 API 529 过载，过段时间重试即可。）

## 下一步（按序）
1. 安装 `@anthropic-ai/claude-agent-sdk`，读真实 .d.ts 锁定 API。
2. 写最小 spike（scripts 或临时 .mjs）：实跑一次 query，验证 **鉴权能起来**、拿到 session_id、
   收到 stream_event 增量、interrupt 生效、sandbox 选项生效。把结论写回这里。
3. 实现 event-map.ts → thread.ts → backend.ts；注册 index.ts + catalog.ts。
4. typecheck/build/test 绿。
5. 飞书端到端 + computer use 验收。

## Spike 实证结论（第 1 轮，node _spike-claude.mjs）
- ✅ **鉴权无需 API key**：`apiKeySource=none` 仍成功出文（$0.189）。SDK 自带 cli.js 复用本机登录态
  （疑 Keychain）。`isAvailable`/`doctor` 不需要查 API key，跑一次轻量探测即可。
- ✅ 流式：`includePartialMessages:true` → `stream_event`：`message_start` → `content_block_start`
  (block.type) → `content_block_delta`(delta.type='text_delta'|'thinking_delta'|'input_json_delta')
  → `content_block_stop` → `message_delta` → `message_stop`。`idx` = content block index。
- ✅ 完整 `assistant` 消息（BetaMessage）随后到，`message.content[]` 是 {type:'text'|'thinking'|'tool_use',...}，
  tool_use 块有 `id`+`name`。text/thinking 块无 id → itemId 用 `${assistantMsgOrdinal}:${blockIndex}`。
- ✅ `result`：subtype/is_error/num_turns/total_cost_usd/usage(input_tokens,output_tokens,cache_*)/result(最终文本)。
- 噪声消息（map→null 但刷 lastActivity）：system/hook_started|hook_response|status、rate_limit_event。
- ⚠️ 冷启动延迟 ~22s（init→首 token）：进程 spawn + MCP + 大 system prompt 缓存创建。每轮 resume 新起进程都付此成本。
  → 体验对策待定：要么持久化 streaming-input query（一进程多轮，省冷启动），要么接受 per-turn + 加载提示。
  先用 **持久 streaming-input** 方案对齐 Codex 常驻进程模型（首选）。

## 架构决策（基于 spike）
- ClaudeThread = 一个常驻 `query()`（streaming-input：prompt 传可 push 的 AsyncIterable）。
  - startThread：起 query，后台循环消费消息；首个 system/init 给 session_id → resolve ready，再返回 thread。
  - runStreamed：push 一条 user 消息；后台路由把本轮消息映射成 AgentEvent 投到「当前轮 channel」，
    见到 `result` 即本轮 done。turns 串行（上一轮 result 后才开下一轮），单 channel 足够。
  - abort：`query.interrupt()`（仅 streaming-input 模式可用，spike3 验证中断后能否续用）。
  - resumeThread：query options.resume=sessionId，同样常驻。
  - steer：push 一条 user 消息（priority?）——能力位 steer 先标 false，spike 验证后再开。
  - compact：✅ 已支持。Claude Code 原生 /compact 斜杠命令——thread.compact() 发 "/compact" 文本经 CLI
    拦截执行，排空到 result；compact_boundary(manual) ⇒ compacted=true。capabilities.compact=true。
    （spike11 实证：supportedCommands 含 compact，发 "/compact" 返回「Not enough messages to compact.」即生效。）
  - /context：✅ 已修。原 result 消息无 model → 窗口显示「未知」。现 turn 末调 query.getContextUsage()
    取权威 totalTokens/maxTokens（= 原生 /context，1M 窗口），event-map 回退也改用 init 的 model 取窗口。
  - 自动压缩：event-map 把 system/compact_boundary → context_compacted 通知。
  - runGoal：✅ goal-like 已实现。Claude 无 codex 目标引擎，但其 agent loop 能在「一个 query turn」内
    自主多步跑完目标 → runGoal 当作「一个自主轮」：发带自主提示的目标 → 流式跑 → 合成 goal_update
    （active 起、complete/blocked/budgetLimited 收）。capabilities.goal=true。
    ⏹/🎯 终止：clearGoal() 用 abortController 硬停（spike14：工具中途 abort ~2s 停、且 abort 后 resume 续聊 OK；
    比工具执行中途 interrupt() 可靠——interrupt 在工具中会卡，spike12 实测 120s 没返回）。
    LIVE 实证：自主建文件跑到 complete；跑到一半 clearGoal → 线程死 → resume 续聊成功。
    与 codex 差异（如实）：codex 是 N 个自动续跑 turn（N 卡）+ 原生状态机；claude 是 1 个自主 turn（1 卡）
    + 合成状态，无 paused/usageLimited、无 token 预算。
  - listThreads/readHistory：SDK 有 listSessions/getSessionMessages（待查），先返回空 + capabilities.resume 视情况。

## 踩坑记录
- 多次撞 **API 529 Overloaded**（服务端临时过载）：turn-heavy 的 LIVE 用例会因此偶发超时；spike 里加了
  「含 529 则重试」。非代码问题。
- **canUseTool + sandbox.filesystem 同用会触发 SDK `ZodError: invalid_union`**（Bash 从 auto-allow 转走
  canUseTool，返回 `{behavior:'allow'}` 仍被 union 校验拒）→ 已改为纯沙箱、不用 canUseTool。
- **qa 读限 cwd 不可行（spike8 实证）**：`filesystem:{denyRead:['/'], allowRead:[cwd]}` 虽挡住了 /tmp 外部
  机密读取，但 `allowRead:[cwd]` **并未如 schema 注释「优先于 denyRead」那样把 cwd 读回**——结果连项目内
  文件也读不了，qa 直接没法答关于项目的问题。故**不采用**，保留「qa 读未硬限 cwd」为文档化缺口。
  下轮若要再尝试：换思路（如只 denyRead 敏感目录 ~/.ssh /.aws /.config 等做「防机密外泄」的折中，
  而非全盘读限），或查 `allowManagedReadPathsOnly` 语义，别再重试 denyRead:['/']+allowRead:[cwd]。
